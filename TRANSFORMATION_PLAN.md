# memory-recall 改造方案

> 文档版本：v2.5
> 最后更新：2026-04-25
> 负责人：marlon-wei
> 源码路径：~/projects/memory-recall

---

## 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0 | 2026-04-24 | 初始方案，Phase 1/2/3/4 规划 |
| v2.0 | 2026-04-24 | 完成 Phase 1+2，v1 实现状态更新 |
| v2.1 | 2026-04-24 | + 词表自动维护（systemd timer + LLM 对比 + 日志输出） |
| v2.2 | 2026-04-24 | + BM25 增量更新（add/remove/update 不重建）+ jieba 迁移 + venv 隔离 |
| v2.3 | 2026-04-24 | + 测试框架（25 个 node --test）+ 测试通过 |
| v2.4 | 2026-04-25 | + Worker Refactor：server.py → worker.py (stdio JSON-RPC)；TS plugin 用 child_process.spawn 管理 worker；per-agent BM25/Graph 文件隔离；fcntl.flock 文件锁；删除 HTTP 层 |
| v2.5 | 2026-04-25 | + LanceDB 迁移：Qdrant 替换为 per-agent LanceDB（L1 向量 + L2 FTS）；+ 异步 LLM extraction（6w + category + confidence + temporal_type）；+ 衰减引擎（Weibull 拉伸指数，composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic）；+ Compactor（cosine similarity 聚类合并）；+ registerService decay timer（gateway 托管，每24h）；+ Tier 保护（core 禁止删除/合并）；+ 图多关系边（same_when / same_where）；+ 21 字段 schema；+ 全部 50 测试通过 |

---

## 当前实现状态（v2.5）

### 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway (TypeScript)                   │
│  memory-recall plugin → registerMemoryCapability stub             │
│  4 tools: memory_recall / memory_store / memory_forget / update  │
│  Hooks: message_received (auto-store), agent_end (auto-store)   │
│         before_prompt_build (auto-recall)                       │
│  registerService: decay timer (gateway托管, 每24h)              │
└───────────────────────────┬──────────────────────────────────────┘
                             │ child_process.spawn (stdio JSON-RPC)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              Memory Recall Worker (Python stdio JSON-RPC)            │
│                   per-agent LanceDB + NetworkX Graph              │
│                                                                  │
│  store     → 规则提取 category → 异步 LLM extraction → 写 LanceDB │
│  recall    → L1向量(LanceDB) + L2 FTS(LanceDB) + L3 图扩展    │
│  forget    → LanceDB 删除 + Graph 删除 (core 免疫)                │
│  update    → LanceDB 更新 + 重新 LLM extraction                  │
│  compact   → cosine similarity 聚类合并                          │
│  decay_scan → Weibull composite score → 删除/合并低分记忆          │
│  graph_rebuild → same_when / same_where 多关系边                │
│  health    → worker 健康检查                                      │
└───────────────────────────┬──────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────────┐
         ▼                   ▼                       ▼
    LanceDB (vector)     LanceDB (FTS)          NetworkX Graph
    (per-agent .lance)   (per-agent .lance)    (per-agent .json)
                          jieba tokenizer       same_when / same_where
                                                fcntl.flock
```
~/.memory-recall/data/{agent_id}/
   memories.lance/         graph.json
```

### 目录结构

```
memory-recall/
├── src/
│   ├── worker.py           # stdio JSON-RPC server（child_process.spawn 启动）
│   ├── rule_extractor.py  # 规则提取：分词 + category + 6w
│   ├── lark_tok.py        # jieba 分词（venv 隔离，user_dict.txt）
│   ├── dict_maintenance.py # 词表维护（systemd timer，每天 03:00）
│   └── core/
│       ├── bm25_index.py      # BM25 全文索引（rank_bm25），fcntl.flock
│       └── graph_store.py      # NetworkX 图（session/cooccur/category_overlap/same_when/same_where），fcntl.flock
│       ├── lancedb_store.py    # LanceDB 封装（L1 向量 + L2 FTS），per-agent
│       ├── llm_extractor.py    # 异步 LLM extraction（6w + category + confidence + temporal_type）
│       ├── decay_engine.py    # Weibull 衰减引擎（composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic）
│       └── compactor.py       # cosine similarity 聚类合并（阈值 0.88）
├── start.sh                # 手动测试 worker.py（TS plugin 自主管理 worker 生命周期）
├── deploy.sh               # 部署脚本（无 systemd service）
├── DEPLOY.md               # 部署文档
└── TRANSFORMATION_PLAN.md # 本文档
```

---

## 当前实现详情

### 存储层

**LanceDB (向量 + FTS)** — per-agent `.lance` 文件
- `~/.memory-recall/data/{agent_id}/memories.lance/`
- Schema: 21 字段（见 README.md）
- FTS: jieba 分词，`create_fts_index("tokens")`
- 文件锁: `fcntl.flock` LOCK_EX + LOCK_UN

**Graph (关联)**
- 引擎: NetworkX + JSON 文件持久化
- 图文件: `~/.memory-recall/data/{agent_id}/graph.json`
- 边类型: session, cooccur, category_overlap, **same_when**, **same_where**
- 文件锁: `fcntl.flock` LOCK_EX + LOCK_UN
- 边类型:
  - `session`: 同 conversation_id 的记忆互连
  - `cooccur`: store 时同次 recall 结果互连
  - `category_overlap`: 同 category + 24h 内新记忆互连
  - `same_when`: 同 temporal_type + 时间重叠的记忆互连（LLM 提取）
  - `same_where`: 同 where（地点）字段的记忆互连（LLM 提取）

### 召回流程（L1/L2/L3）

```
输入: query + agent_id + max_results
  │
  ├─ L1: LanceDB 向量搜索
  │     filter: agent_id
  │     limit: max_results * 3
  │     输出: [(id, score), ...]
  │
  ├─ L2: LanceDB FTS (jieba tokenize)
  │     post-filter: agent_id
  │     limit: max_results * 2
  │     输出: [(id, score), ...]
  │
  ├─ Score 融合
  │     score = 0.6*L1 + 0.4*L2
  │     输出: [(id, score), ...]
  │
  └─ L3: Graph 扩展 (NetworkX BFS)
        输入: top-K 候选
        filter: agent_id (批量查 LanceDB payload)
        depth: 2, top_k: max_results
        扩展节点加权: score * 0.5
        输出: [(id, score), ...]

最终: 按 score 排序 → fetch payload → 返回
```

### 提取流程（同步 + 异步）

```
store(content)
  ├─ 规则提取 (rule_extractor.py) — 同步，毫秒级
  │     ├─ category: 关键词匹配 6 类
  │     ├─ 6w: 正则匹配时间/地点/原因
  │     └─ importance: 关键词加权
  │
  ├─ 分词 (lark_tok.py)
  │     ├─ 词典最大正向匹配 (DICT ~200词)
  │     └─ 过滤 STOPWORDS (~50停用词)
  │
  ├─ 去重检查 (LanceDB, agent_id)
  │     └─ content 完全匹配 → 直接返回已有 ID
  │
  ├─ 向量化 (Ollama bge-m3)
  │
  ├─ 写 LanceDB + Graph
  │
  ├─ 异步 LLM extraction (llm_extractor.py)
  │     ├─ 6w + category + confidence + temporal_type
  │     └─ 覆盖 LanceDB 中的字段
  │
  └─ 立即返回 (LLM extraction 后台异步)
```

### Agent 隔离

- LanceDB: filter by agent_id
- L3 Graph: 批量查 LanceDB payload 取 agent_id 过滤

### 衰减引擎

```
decay_scan(limit=50, dry_run=false)
  ├─ 计算 Weibull composite score
  │     ├─ recency: 时间衰减，temporal_type 动态半衰期
  │     ├─ frequency: 指数衰减
  │     └─ intrinsic: 固定 decay floor = 0.9
  │
  ├─ composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic
  │
  ├─ stale ≤ 0.3 → compact(阈值 0.88, 最多4轮)
  ├─ stale ≤ 0.15 → 删除（core 免疫）
  └─ Tier 保护: importance ≥ 0.7 禁止删除/合并

decay_timer: registerService，每 24h 执行一次
```

### Agent 隔离

- LanceDB: filter by agent_id
- Graph: 批量查 LanceDB payload 取 agent_id 过滤

---

## 工具定义（TS Plugin）

| 工具名 | 描述 |
|--------|------|
| `memory_recall` | 混合检索记忆，参数: query, agent_id, max_results, min_score |
| `memory_store` | 存储记忆，参数: content, agent_id, conversation_id, metadata |
| `memory_forget` | 删除记忆，参数: memory_id |
| `memory_update` | 更新记忆，参数: memory_id, content |

---

## 已解决 & 未解决

### ✅ 已完成
- LanceDB 本地向量 + FTS（无需外部数据库）
- worker.py stdio JSON-RPC 架构（TS plugin 管理生命周期）
- L1/L2/L3 三级召回（LanceDB 向量 + LanceDB FTS + NetworkX 图）
- 规则提取（分词 + category + 6w）同步完成
- LLM extraction 异步（6w + category + confidence + temporal_type）
- Weibull decay 引擎（composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic）
- Compactor cosine similarity 聚类合并（阈值 0.88，最多 4 轮）
- Tier 保护（importance ≥ 0.7 禁止删除/合并）
- same_when / same_where 多关系图边
- registerService decay timer（gateway 托管，每 24h）
- agent_id 隔离（LanceDB + Graph 两层）
- 内容去重（store 时检查完全匹配）
- 21 字段 schema（importance/confidence/temporal_type/access_count/compaction_rounds）
- 词表维护（jieba + user_dict.txt）
- 测试框架：node --test，25 个测试（worker/concurrent/BM25Negative/per-agent），`npm test` 运行

### ⚠️ 待优化
- 旧数据（agent_id="test"）跨 agent 可被召回（legacy 数据问题）
- 词表维护 systemd timer 待配置
- agent-to-agent 记忆传播（child 结果传播到 parent）

---

## 依赖

| 依赖 | 版本 | 用途 | 安装 |
|------|------|------|------|
| Python | 3.12 | 运行环境 | - |
| lancedb | 0.30+ | 本地向量 + FTS | `pip install lancedb` |
| jieba | latest | 中文分词 | `pip install jieba` |
| networkx | latest | 图引擎 | `pip install networkx` |
| Ollama | - | 向量生成 (bge-m3) + LLM extraction | WSL2 本地运行 |

---

## 部署

详见 `DEPLOY.md`

---

## 开发命令

```bash
# 手动测试 worker.py（TS plugin 会自动通过 child_process.spawn 启动）
cd ~/projects/memory-recall
~/.memory-recall-venv/bin/python src/worker.py

# JSON-RPC 测试
echo '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}' | ~/.memory-recall-venv/bin/python src/worker.py

# 存储测试
echo '{"jsonrpc":"2.0","id":2,"method":"store","params":{"content":"我住在深圳","agent_id":"test"}}' \
  | ~/.memory-recall-venv/bin/python src/worker.py

# 召回测试
echo '{"jsonrpc":"2.0","id":3,"method":"recall","params":{"query":"住在哪","agent_id":"test","max_results":3}}' \
  | ~/.memory-recall-venv/bin/python src/worker.py

# 词表维护
~/.memory-recall-venv/bin/python src/dict_maintenance.py --dry-run
```

---

## LanceDB API 注意事项（v0.30.2）

### `.query()` vs `.search()`
- **错误**：`table.query().where(...)` — `query()` 方法不存在
- **正确**：`table.search().where(...)` — 使用 `search()` 作为入口
- `search()` 不传参数时，仅执行过滤查询（无需向量）

### `.add()` vs `.update()`
- `table.add([row])` **追加**新行（不更新已有行），导致重复记录
- `table.update(where=..., values={...})` **原地更新**匹配行的字段
- 用于 `cmd_update`：替换 `table.add()` 为 `table.update(where=f'id = "{memory_id}"', values={...})`
- 用于 `cmd_store` + `cmd_update` 顺序：必须用 `update` 否则产生重复行

### 表目录结构
- 每个 agent 数据库目录：`~/.memory-recall/data/{agent_id}/`
- LanceDB 表存储在：`memories.lance` 子目录
- 图数据：`graph.json`
- **不要**检查 `lance.db` 文件（不存在），检查 `memories.lance` 目录

### 数据目录扫描
- 遍历 `DATA_DIR.iterdir()`，过滤 `subdir.is_dir()` + `(subdir / "memories.lance").exists()`
- agent_id 映射：`subdir.name`（`_dir_to_agent_id`）

### 缓存与跨进程
- `_lance_instances` 是进程内缓存（TS plugin 每次启动新 worker）
- `cmd_update`/`cmd_forget` 需要跨进程查找 agent_id：扫描所有 `memories.lance` 目录
- `_find_agent_for_memory(memory_id)`：先查缓存 `_lance_instances`，再扫描目录
