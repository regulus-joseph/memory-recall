# memory-recall 改造方案

> 文档版本：v2.3
> 最后更新：2026-04-24
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

---

## 当前实现状态（v2.0）

### 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway (TypeScript)                   │
│  memory-recall plugin → registerMemoryCapability stub             │
│  4 tools: memory_recall / memory_store / memory_forget / update  │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP (fetch)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│            Memory Recall Server (Python FastAPI)                    │
│                      port: 8765                                    │
│                                                                  │
│  POST /store   → 规则提取 category → 同步返回 (毫秒级)           │
│  POST /recall  → L1向量 + L2 BM25 + L3 图扩展 → 三路融合排序     │
│  POST /forget → Qdrant + BM25 + Graph 三端删除                 │
│  POST /update → payload 更新                                      │
│  GET  /stats  → memory/BM25/Graph/Queue 计数                    │
│  GET  /health → 服务健康检查                                      │
└───────────────────────────┬──────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                       ▼
   Qdrant              BM25 Index             Graph (NetworkX)
   (向量存储)          (JSON文件)              (JSON文件)
   port: 6333        ~/.memory-recall/      ~/.memory-recall/
                       data/bm25_index.json    data/memory_graph.json
```

### 目录结构

```
memory-recall/
├── src/
│   ├── server.py           # FastAPI 服务入口（6个端点）
│   ├── worker.py           # 后台 worker（暂未使用，保留）
│   ├── rule_extractor.py  # 规则提取：分词 + category + 6w
│   ├── lark_tok.py        # lark-based 中文分词（词典驱动最大正向匹配）
│   └── core/
│       ├── qdrant_store.py    # Qdrant 向量存储 + 去重检查
│       ├── bm25_index.py      # BM25 全文索引（rank_bm25）
│       └── graph_store.py      # NetworkX 图（session/cooccur/category_overlap/word_overlap）
├── start.sh                # systemd 启动脚本
├── DEPLOY.md              # 部署文档
└── TRANSFORMATION_PLAN.md # 本文档
```

---

## 当前实现详情

### 存储层

**Qdrant (向量)**
- Collection: `memory_recall`
- 向量维度: 1024 (bge-m3)
- 向量生成: Ollama bge-m3 via `/api/embeddings`，字段用 `prompt`（非 `input`）
- Payload 字段: content, agent_id, conversation_id, category, 6w, importance, stored_at, state, access_count, last_accessed, graph_edges, extraction_done

**BM25 (全文)**
- 引擎: `rank_bm25.BM25Okapi`
- 分词: lark-based 词典最大正向匹配（无外部中文依赖）
- 索引文件: `~/.memory-recall/data/bm25_index.json`
- 字段: corpus 存 `{doc_id: {content, agent_id}}`
- 问题: 每次 store 全量重建（待优化）
- ⚠️ 词表：从 lark FMM 迁移到 jieba，venv 隔离（~/.memory-recall-venv/），用户词典 user_dict.txt 存储 LLM 发现的新词

**Graph (关联)**
- 引擎: NetworkX + JSON 文件持久化
- 边类型:
  - `session`: 同 conversation_id 的记忆互连
  - `recall_cooccur`: store 时同次 recall 结果互连
  - `category_overlap`: 同 category + 24h 内新记忆互连
  - `word_overlap`: 分词共享≥2个实词的记忆互连

### 召回流程（L1/L2/L3）

```
输入: query + agent_id + max_results
  │
  ├─ L1: Qdrant 向量搜索
  │     filter: agent_id
  │     limit: max_results * 3
  │     输出: {id, score}
  │
  ├─ L2: BM25 关键词搜索
  │     post-filter: agent_id
  │     limit: max_results * 2
  │     输出: {id, score}
  │
  ├─ Score 融合
  │     score = 0.7*L1 + 0.3*L2
  │     输出: [(id, score), ...]
  │
  └─ L3: Graph 扩展
        输入: top-K 候选
        filter: agent_id (批量查 Qdrant payload)
        depth: 2, top_k: max_results
        扩展节点加权: score * 0.5
        输出: [(id, score), ...]

最终: 按 score 排序 → fetch payload → 返回
```

### 提取流程（同步，毫秒级）

```
store(content)
  ├─ 规则提取 (rule_extractor.py)
  │     ├─ category: 关键词匹配 6 类
  │     ├─ 6w: 正则匹配时间/地点/原因
  │     └─ importance: 关键词加权
  │
  ├─ 分词 (lark_tok.py)
  │     ├─ 词典最大正向匹配 (DICT ~200词)
  │     └─ 过滤 STOPWORDS (~50停用词)
  │
  ├─ 去重检查 (Qdrant scroll, agent_id)
  │     └─ content 完全匹配 → 直接返回已有 ID
  │
  ├─ 向量化 (Ollama bge-m3)
  │
  ├─ 写 Qdrant + BM25 + Graph
  │
  └─ 立即返回 (pending: false)
```

### Agent 隔离

- Qdrant search: `filter: {must: [{key: agent_id, match: value}]}`
- BM25: post-filter by agent_id（内存过滤）
- L3 Graph: 批量查 Qdrant payload 取 agent_id 过滤

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
- Python HTTP 服务（FastAPI）
- systemd user service 自启 + 自动重启
- L1/L2/L3 三级召回
- 规则提取（分词 + category + 6w）同步完成，无 LLM 延迟
- lark-based 中文分词，零外部中文依赖
- agent_id 隔离（Qdrant + BM25 + Graph 三层）
- 内容去重（store 时检查完全匹配）
- category_overlap 边（同 category + 24h）
- word_overlap 边（分词共享≥2词）
- Recall 返回去重（dedup 前端显示）

### ⚠️ 待优化
- BM25 每次 store 全量重建（→ 增量更新已完成，add/remove/update 不重建，阈值20次或显式 force_rebuild）
- word_overlap 阈值固定为 2（→ 可配置）
- 旧数据（agent_id="test"）跨 agent 可被召回（legacy 数据问题）
- LLM extraction 备选路径（worker.py）已失效但保留代码
- 词表维护：systemd timer 已配置，每日 03:00 调 LLM 对比 tokenizer 结果，候选增删词到日志
- 测试框架：node --test，25 个测试（lark_tok/rule_extractor/BM25Index/GraphStore/plugin smoke），`npm test` 运行

---

## 依赖

| 依赖 | 版本 | 用途 | 安装 |
|------|------|------|------|
| Python | 3.12 | 运行环境 | - |
| fastapi | latest | HTTP 服务 | `pip install fastapi uvicorn` |
| httpx | latest | HTTP 客户端 | `pip install httpx` |
| rank-bm25 | latest | BM25 算法 | `pip install rank-bm25` |
| lark | 1.3.1 | 中文分词 | `pip install lark` |
| networkx | latest | 图引擎 | `pip install networkx` |
| Ollama | - | 向量生成 (bge-m3) | Win11 本地运行 |
| Qdrant | 1.17+ | 向量数据库 | Win11 本地运行 |

---

## 部署

详见 `DEPLOY.md`

---

## 开发命令

```bash
# 启动服务
cd ~/projects/memory-recall
python src/server.py

# 或通过 systemd
systemctl --user start memory-recall.service
systemctl --user status memory-recall.service

# 重启
systemctl --user restart memory-recall.service

# 日志
tail -f /tmp/memory-recall.log

# 健康检查
curl http://localhost:8765/health

# 存储测试
curl -s http://localhost:8765/store -X POST \
  -H "Content-Type: application/json" \
  -d '{"content":"我住在深圳","agent_id":"test"}'

# 召回测试
curl -s http://localhost:8765/recall -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"住在哪","agent_id":"test","max_results":3}'

# 统计
curl http://localhost:8765/stats
```
