# Memory Recall Plugin

> L1/L2/L3 级联记忆召回 for OpenClaw：per-agent LanceDB（向量 + BM25 + 图谱）+ Weibull 衰减 + 渐进压缩。纯 TypeScript，无 Python Worker。

**v0.8.0** · OpenClaw 2026.5.x 兼容

---

## 它解决什么问题

每次对话，AI 都是"全新"的，看不到之前聊过什么。

memory-recall 做三件事：

1. **自动记住** — 对话内容自动存进 LanceDB，LLM 提取 6w + 分类 + 置信度
2. **自动想起** — 下次对话开始前，根据当前话题从向量 / 关键词 / 图谱三层召回相关记忆，注入 prompt
3. **自动遗忘** — Weibull 衰减 + cosine 相似度压缩合并，低价值记忆自动淘汰，核心记忆（importance ≥ 0.7）受保护

---

## 架构概览

```
OpenClaw Gateway (TypeScript 插件)
└── memory-recall (index.ts)
    ├── 13 个工具: recall / store / forget / get / browse / list / search / extract / update / reset / stats / worker_status / worker_restart
    ├── 5 个 Hooks: message_received / agent_end / before_prompt_build / session_end / gateway_stop
    ├── registerService: 衰减定时器（默认每 24h）
    └── MemoryStore (per-session，纯 TypeScript)
        ├── L1: LanceDB 向量检索（bge-m3，1024 维）
        ├── L2: BM25 重排 + nodejieba 中文分词
        ├── L3: graphology 图谱扩展
        ├── LLM 提取: qwen3.5:4b（6w + category + confidence）
        ├── Decay: Weibull 复合 score（recency × frequency × importance）
        ├── Compactor: cosine 相似度聚类合并
        └── Tier 保护: 核心记忆（importance ≥ 0.7）免疫

数据存储：
  ~/.memory-recall/data/{agent_id}/
    ├── memories.lance/   LanceDB 表（向量 + FTS + 标量索引）
    └── graph.json        graphology 图谱
```

**核心差异 vs memory-core**：memory-recall 专注**召回**（为当前上下文拉取历史记忆），memory-core 专注**存储**（管理记忆数据库）。两者可以共存。

---

## 核心概念

### 6w 提取

每条记忆由 LLM（qwen3.5:4b）自动提取六个维度：

| 字段 | 含义 | 示例 |
|------|------|------|
| `who` | 谁参与的 | "Marlon" |
| `what` | 发生了什么 | "配置了 futu OpenD" |
| `when` | 时间 | "2026-05-17" |
| `where` | 地点/平台 | "webchat" |
| `why` | 原因/目的 | "需要订单簿数据" |
| `how` | 怎么做的 | "openclaw plugins install" |

### 分类（Category）

LLM 将记忆分为六个类别之一：

| Category | 含义 | 示例 |
|----------|------|------|
| `event` | 发生的事 | "Marlon 配置了 OpenD" |
| `fact` | 客观事实 | "OpenD 路径在 ~/FutuOpenD/" |
| `preference` | 用户偏好 | "偏好用 WSL2 作为开发环境" |
| `conversation` | 对话内容 | 聊天记录 |
| `task` | 待办/行动项 | "审查订单管道" |
| `other` | 不属于以上 | 杂项 |

### 时间类型（Temporal Type）

影响 Weibull 半衰期：

| Type | 半衰期 | 含义 |
|------|--------|------|
| `dynamic` | 30 天 | 快速变化（日常决策、进行中任务） |
| `static` | 180 天 | 近乎永久（配置、身份） |
| `recurring` | 90 天 | 周期模式（周回顾、cron 任务） |
| `ephemeral` | 7 天 | 很快过期（临时笔记） |

### 重要性（Importance）

0.0 ~ 1.0 浮点分，由 LLM 评估。≥ 0.7 为核心记忆，受 Tier 保护，衰减和压缩都会跳过。

---

## 级联检索详解（L1 → L2 → L3）

### L1: 向量检索（Vector Search）

用 bge-m3 生成 1024 维向量，基于 cosine similarity 找语义最相近的记忆。

```
用户 query: "Marlon 的 OpenClaw 配置"
    ↓ bge-m3 embedding → [0.12, -0.34, ...] (1024-dim)
    ↓ LanceDB cosine similarity top-20（agent_id filter）
L1 candidates
```

### L2: BM25 重排

L1 结果用 nodejieba 中文分词 + BM25 算法重新打分，补充纯向量搜不到的精确关键词匹配。

```
L1 candidates + query keywords
    ↓ jieba 分词: ["Marlon", "OpenClaw", "配置"]
    ↓ BM25 scoring across L1 candidate set
    ↓ boost: score += bm25_score × 0.3
L2 reranked candidates
```

### L3: 图谱扩展（Graph Expansion）

通过 graphology 构建的记忆网络，从 L2 候选出发，沿着实体节点做 BFS 扩展（depth ≤ 2），拉出相关记忆。

```
L2 candidate memory
    ↓ 提取实体: "trade-agents", "futu", "USA_INVESTMENT"
    ↓ graphology BFS expansion (depth=2)
    ↓ 相关记忆: 同一项目 / 同一标的 / 同一时间段
L3 expanded candidates
```

### 最终融合

```
fusion_score = 0.7 × vector_score + 0.3 × bm25_score
    ↓ top K → 去重 → 注入 prompt
```

> L3 扩展候选池，不直接贡献分数。

---

## Weibull 衰减引擎

每 `decayIntervalHours`（默认 24h），所有非核心记忆按 Weibull 曲线衰减：

```
score = recency_score × frequency_score × importance_score

recency_score    = e^(-elapsed_hours / half_life)   ← Weibull 衰减
frequency_score = log(1 + access_count) / log(1 + max_access_count)
importance_score = importance_field               ← LLM 原始重要性
```

**各 temporal type 半衰期：**

| Type | 半衰期 |
|------|--------|
| `dynamic` | 30 天 |
| `static` | 180 天 |
| `recurring` | 90 天 |
| `ephemeral` | 7 天 |

score 低于 0.15 且 importance < 0.4 的记忆，标记为自动删除。

### Compactor 压缩合并

cosine similarity 聚类合并相似记忆：
- 多个相似记忆 → 聚合成一条（保留所有 6w）
- importance 取最大值（保护核心）
- access_count 累加

---

## Hook 生命周期

```
用户消息
    ↓ message_received
    → autoStore: 提取 6w + category + importance + temporal_type
    → 存储到 LanceDB + 更新 graph.json
    → 触发 L1/L2/L3 级联检索 → 保存到 recall_cache

AI 回复完成
    ↓ agent_end
    → 存储 AI 回复为单独记忆

构建 prompt 前
    ↓ before_prompt_build
    → 读取 recall_cache → 格式化 → 注入到 prompt

[注入格式示例:]
[Relevant Memories]
1. [fact] Marlon 的 futu OpenD 路径：~/FutuOpenD/ (importance=0.8)
2. [preference] 偏好用 WSL2 作为开发环境 (importance=0.75)
3. [project] trade-agents 活跃开发中 (importance=0.85)

会话结束
    ↓ session_end
    → 刷新 session buffer
    → 清理 recall_cache

Gateway 停止
    ↓ gateway_stop
    → 清理所有 worker 进程
```

---

## 工具详解（13 个）

### mr_memory_recall — 级联检索

```
参数: query, agent_id?, max_results?, min_score?
返回: [{memory_id, text, category, importance, who/what/when,
        relevance_score, fusion_score}]
```

### mr_memory_store — 存储 + LLM 提取

```
参数: content, agent_id?, scope?
返回: {memory_id, category, importance, temporal_type,
       confidence, who/what/when/where/why/how}
```

### memory_forget — 删除

```
参数: memory_id, agent_id?, force?
返回: {success, reason}
注: Tier 1（importance ≥ 0.7）受保护，force=false 时拒绝删除
```

### mr_memory_get — 获取单条

```
参数: memory_id, agent_id?
返回: 完整 memory 对象（含所有字段）
```

### memory_browse — 按时间/会话浏览

```
参数: since?, until?, conversation_id?, summary_only?, limit?
返回: [{memory_id, text, category, importance, created_at, summary}]
```

### memory_list — 分页列表

```
参数: category?, limit?, offset?, sort?
返回: {memories: [...], count, offset, limit, agent_id}
```

### mr_memory_search — BM25 关键词搜索

```
参数: query, agent_id?, max_results?
返回: [{memory_id, text, category, relevance_score}]
```

### memory_extract — 预分析文本

```
参数: text
返回: {category, importance, confidence, temporal_type,
       who/what/when/where/why/how, summary}
在存储前先用这个预览会分配什么类别/重要性
```

### memory_update — 更新

```
参数: memory_id, content?, importance?, category?, add_tags?, remove_tags?
返回: 更新后的 memory 对象
```

### memory_reset — 清空

```
参数: agent_id?, scope?, force (必须 true)
返回: {cleared: count}
```

### memory_stats — 统计

```
返回: {total_memories, by_category, by_tier, by_temporal_type,
       decay_progress, oldest_memory, newest_memory}
```

### memory_worker_status — Worker 健康

```
返回: [{session_id, pid, status, last_heartbeat, command_buffer_size}]
```

### memory_worker_restart — 重启 Worker

```
参数: session_id
返回: {new_pid, status}
```

---

## 安装步骤

### 1. 构建工具（nodejieba 需编译）

```bash
# Ubuntu/WSL2
apt install build-essential python3

# macOS
xcode-select --install
```

### 2. Link 插件

```bash
cd ~/projects/memory-recall
npm install
openclaw plugins install --link . --dangerously-force-unsafe-install
```

> 需要 `--dangerously-force-unsafe-install`，因为使用 `child_process.spawn`。

### 3. 配置 openclaw.json

```json
{
  "plugins": {
    "allow": ["memory-recall", "minimax", "browser", "skill-auto-injection", "policy-layer"],
    "bundledDiscovery": "allowlist",
    "slots": { "memory": "memory-core" },
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": {
          "autoStore": true,
          "autoRecall": true,
          "autoRecallMaxItems": 3,
          "autoRecallMaxChars": 600,
          "decayEnabled": true,
          "decayIntervalHours": 24
        }
      },
      "policy-layer": {
        "enabled": true,
        "config": {
          "hooks": { "allowPromptInjection": true }
        }
      }
    }
  }
}
```

### 4. 重启验证

```bash
openclaw gateway restart
openclaw plugins inspect memory-recall
# 输出: Status: loaded
```

---

## 配置项

### 插件配置（openclaw.json）

| 配置 | 说明 | 默认值 |
|------|------|-------|
| `autoStore` | 自动存储消息 | `true` |
| `autoRecall` | 自动注入记忆到 prompt | `true` |
| `autoRecallMaxItems` | 每次最多注入条数 | `3` |
| `autoRecallMaxChars` | 每次最多注入字符数 | `600` |
| `decayEnabled` | 启用 Weibull 衰减 | `true` |
| `decayIntervalHours` | 衰减周期（小时） | `24` |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型 | `bge-m3` |
| `OLLAMA_URL` | Ollama base URL | `http://localhost:11434` |
| `LLM_MODEL` | 提取 LLM | `qwen3.5:4b` |

### 传输模式

| 模式 | `USE_HTTP_POOL` | 适用场景 |
|------|----------------|----------|
| stdio（默认） | `0` | 单 session、开发调试 |
| HTTP pool | `1` | 多 session 并发、生产环境 |

---

## 数据结构

### LanceDB Schema

```
memories.lance 字段：
  memory_id        string  primary key
  text             string  内容
  tokens           string  jieba FTS 索引
  scope            string  global|agent|session
  agent_id         string  agent 标识
  conversation_id  string  会话标识
  category         string  event|fact|preference|conversation|task|other
  importance       float32  0.0–1.0
  temporal_type    string  dynamic|static|recurring|ephemeral
  who/what/when/where/why/how  string  提取的 6w
  summary          string  自动摘要
  confidence       float32  提取置信度
  tags             string  JSON 数组
  created_at       int64   timestamp ms
  stored_at        string  ISO timestamp
  last_accessed_at int64   上次召回时间
  access_count     int     召回次数
  compaction_rounds int   压缩轮次
  last_compacted_at int64  上次压缩时间
  original_source_count int 合并来源数
  vector           vector(1024) bge-m3 向量

graph.json：
  nodes: { memory_id, scope, category }
  edges: { from, to, weight, relation }
```

---

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep memory-recall

# 检查插件状态
openclaw plugins inspect memory-recall

# 运行测试
cd ~/projects/memory-recall
npm run test:unit
npm run test:smoke

# 查看 LanceDB 数据
python -c "
import lancedb
db = lancedb.connect('~/.memory-recall/data/main')
print(db.open_table('memories').search('OpenClaw').limit(5).to_df())
"
```

---

## 已知限制

| 问题 | 说明 | 状态 |
|------|------|------|
| agent_id legacy bug | L2/L3 检索时 agent_id filter 有历史 bug | ⚠️ 已知 |
| 首次衰减可能超时 | Worker 冷启动，后续正常 | ⚠️ 已知 |
| `--dangerously-force-unsafe-install` 必需 | child_process.spawn 被标记 unsafe | ⚠️ 已知 |
| LanceDB FTS 自动初始化 | 首次存储时创建 `create_fts_index("tokens")` | ✅ 已处理 |

---

## 与 memory-core 的关系

| | memory-core | memory-recall |
|--|-------------|---------------|
| **定位** | 记忆存储管理 | 记忆召回 |
| **Kind** | `memory`（占 slot） | `utility`（不占 slot） |
| **核心功能** | MySQL 持久化、跨 session 共享 | L1/L2/L3 级联检索、自动注入 |
| **共存** | 占用 memory slot | 作为 utility 插件运行 |
| **适用场景** | 需要全局共享记忆 | 需要智能召回、衰减 |

---

## 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 0.8.0 | 2026-05-17 | LanceDB field name fix; makeArrowTable; qwen3.5:4b model |
| 0.7.0 | 2026-05-17 | 纯 TypeScript（无 Python worker）; LanceDB + graphology + nodejieba + bm25 |
| 0.6.0 | 2026-05-16 | Per-session workers; worker_status/restart tools |
| 0.5.0 | 2026-05-10 | HTTP pool 模式; session buffer; session_end flush |
| 0.4.0 | 2026-04-25 | LanceDB; Weibull decay; Compactor; Tier protection |
| 0.3.0 | 2026-04-24 | TS plugin + Python server; LLM extraction |
| 0.2.0 | 2026-04-22 | before_agent_start hook |
| 0.1.0 | 2026-04-22 | 初始: Qdrant + bge-m3 |