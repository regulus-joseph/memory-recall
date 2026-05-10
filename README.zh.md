# Memory Recall Plugin

> L1/L2/L3 级联记忆召回 for OpenClaw: per-agent LanceDB (vector + FTS) + NetworkX 图扩展。异步 LLM 提取, Weibull 衰减, 渐进压缩。

## 版本历史

| 版本 | 日期 | 更新内容 |
|-----|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本: Qdrant存储 + Ollama bge-m3 embedding + recall_memories工具 |
| 0.2.0 | 2026-04-22 | 添加before_agent_start hook自动注入 |
| 0.3.0 | 2026-04-24 | Phase 1: TS plugin + Python server 架构；async LLM extraction；MLP 6-category |
| 0.4.0 | 2026-04-25 | v2.5: LanceDB迁移；worker架构（stdio JSON-RPC）；Weibull decay；Compactor聚类合并；Tier保护 |
| **0.5.0** | 2026-05-10 | **HTTP pool模式(USE_HTTP_POOL=1)；session缓冲；session_end hook；12 tools** |

## 架构

```
OpenClaw Gateway (TS plugin)
    └── memory-recall (index.ts)
            ├── 12 tools: recall/search/list/browse/stats/update/extract/reset + store/forget/get
            ├── 5 hooks: message_received / agent_end / before_prompt_build / session_end / gateway_stop
            ├── registerService: decay timer (gateway托管，每24h)
            └── Two transport modes:
                ├── stdin (default):  TS plugin → worker.py subprocess (stdio JSON-RPC)
                └── http (pool):      TS plugin → pool_router.py (HTTP, port 18799) → worker.py subprocess per session

                              Python Worker (LanceDB + NetworkX)
                              ├── L1: LanceDB vector search (per-agent)
                              ├── L2: LanceDB FTS (jieba tokenize, per-agent)
                              ├── L3: NetworkX graph expansion (per-agent)
                              ├── LLM extraction: 6w + category + confidence + temporal_type (async)
                              ├── Decay: Weibull composite score (recency/frequency/intrinsic)
                              ├── Compactor: cosine similarity clustering (merge → max importance)
                              ├── Tier protection: core memories (importance ≥ 0.7) immune
                              ├── Graph edges: same_when / same_where (multi-relation)
                              └── LanceDB data: ~/.memory-recall/data/{agent_id}/memories.lance
```

**Ollama 依赖**：需要本地运行 Ollama 服务（bge-m3 + qwen2.5:7b 模型）。无 Qdrant 等外部数据库依赖。

## 前置依赖

### 1. Python venv（已有则跳过）

```bash
python3.12 -m venv ~/.memory-recall-venv
~/.memory-recall-venv/bin/pip install lancedb jieba networkx
```

### 2. Ollama

```bash
# bge-m3 for embeddings
ollama pull bge-m3

# qwen2.5:7b for LLM extraction (6w + category + confidence)
ollama pull qwen2.5:7b
```

## 安装

### 1. 插件安装

```bash
cd ~/projects/memory-recall
openclaw plugins install --link . --dangerously-force-unsafe-install
```

### 2. OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "allow": ["memory-recall", "minimax", "browser", "acpx"],
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
      }
    }
  }
}
```

### 3. 重启验证

```bash
openclaw gateway restart
openclaw logs 2>&1 | grep memory-recall
```

## 配置

| 配置 | 说明 | 默认值 |
|------|------|-------|
| `autoStore` | 自动存储消息到记忆 | `true` |
| `autoRecall` | 自动注入记忆到 prompt | `true` |
| `autoRecallMaxItems` | 每次注入最大条数 | `3` |
| `autoRecallMaxChars` | 每次注入最大字符数 | `600` |
| `decayEnabled` | 启用衰减引擎 | `true` |
| `decayIntervalHours` | 衰减周期（小时） | `24` |

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `PYTHON_BIN` | Worker Python 路径 | `~/.memory-recall-venv/bin/python` |
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型 | `bge-m3` |
| `OLLAMA_URL` | Ollama generate API | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen2.5:7b` |
| `USE_HTTP_POOL` | 启用 HTTP pool 模式 | `0` (0=stdio, 1=HTTP) |
| `MR_ROUTER_URL` | Pool router 地址 | `http://127.0.0.1:18799` |

### HTTP Pool 模式

启用后使用 `pool_router.py` 管理 worker 进程池，支持会话亲和性：

```bash
export USE_HTTP_POOL=1
openclaw gateway restart
```

Session ID 通过 `_session_id` 参数路由，实现多会话并发。

### 传输模式对比

| 模式 | USE_HTTP_POOL | 适用场景 |
|------|---------------|----------|
| stdio (默认) | `0` | 单会话、开发调试 |
| HTTP pool | `1` | 多会话并发、生产环境 |

### Hooks

| Hook | 触发时机 | 功能 |
|------|----------|------|
| `message_received` | 收到用户消息 | 自动存储 + 触发 recall |
| `agent_end` | Agent 回复完成 | 存储 assistant 消息 |
| `before_prompt_build` | 构建 prompt 前 | 注入 recall 缓存结果 |
| `session_end` | 会话结束时 | 刷新缓冲消息、清理缓存 |
| `gateway_stop` | Gateway 停止时 | 清理 worker 进程 |

## 工具

| 工具 | 说明 |
|------|------|
| `memory_recall` | L1/L2/L3 混合检索，参数: query, max_results, min_score |
| `memory_store` | 存储记忆，自动 LLM 提取 6w + category + confidence + temporal_type |
| `memory_forget` | 按 ID 删除记忆（core 记忆除外） |
| `memory_get` | 按 ID 获取单条记忆详情 |
| `memory_browse` | 按会话/时间范围浏览记忆，支持汇总模式 |
| `memory_list` | 分页列出记忆，支持分类/会话过滤 |
| `memory_search` | BM25/jieba 快速关键词搜索 |
| `memory_extract` | 对任意文本运行 LLM 结构化提取 |
| `memory_update` | 更新记忆内容或 metadata |
| `memory_reset` | 清空指定 agent 的所有记忆（危险操作） |
| `memory_stats` | 获取记忆统计：数量、分类、层级、时间类型分布 |
| `memory_compact` | 手动触发聚类压缩（decay 自动触发） |

## Schema v0.5（21 字段）

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识 |
| `content` | 原始内容 |
| `agent_id` | 所属 agent |
| `conversation_id` | 所属会话 |
| `category` | LLM 提取：6-category MLP |
| `who` | LLM 提取：参与者 |
| `when` | LLM 提取：时间 |
| `where` | LLM 提取：地点 |
| `why` | LLM 提取：目的 |
| `how` | LLM 提取：方式 |
| `summary` | LLM 提取：摘要 |
| `importance` | 重要性（0~1），core ≥ 0.7 |
| `confidence` | LLM 置信度（0~1） |
| `temporal_type` | 时间类型（static/dynamic） |
| `access_count` | 访问次数 |
| `last_accessed_at` | 上次访问时间 |
| `compaction_rounds` | 合并次数 |
| `last_compacted_at` | 上次合并时间 |
| `original_source_count` | 合并来源数 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

## 衰减引擎

`composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic`

- **temporal_type** 影响半衰期：dynamic ÷3，static ×1
- **decay floor** = 0.9（不会低于此值）
- **Tier 保护**：importance ≥ 0.7 的 core 记忆免疫删除和合并
- decay timer 通过 `registerService` 由 gateway 托管，每 24h 执行一次

## Compactor（聚类合并）

- 触发：decay score ≤ 0.3 且 14 天未合并
- 逻辑：cosine similarity ≥ 0.88 的记忆聚类合并
- 合并规则：内容去重行，最大 importance，plurality category
- 限制：最多 4 轮，防止过度合并

## 数据目录

```
~/.memory-recall/data/
└── {agent_id}/
    ├── memories.lance/     # LanceDB 表（vector + FTS）
    └── graph.json         # NetworkX 图（session/cooccur/category_overlap/same_when/same_where）
```

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep memory-recall

# 测试 worker 健康
cd ~/projects/memory-recall
~/.memory-recall-venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from worker import cmd_health
import asyncio
print(asyncio.run(cmd_health()))
"

# 强制运行 decay cycle（手动触发）
# 通过 restart gateway 让 registerService 重新 start
openclaw gateway restart

# 查看 LanceDB 数据
~/.memory-recall-venv/bin/python -c "
import lancedb
db = lancedb.connect('~/.memory-recall/data/main')
print(db.open_table('memories').head())
"
```

## 已知问题

- 插件安装需要 `--dangerously-force-unsafe-install`（因为 worker 架构需要 `child_process.spawn`）
- decay 首次运行可能超时（worker 冷启动），后续正常运行
- LanceDB FTS 需要先调用 `create_fts_index("tokens")` 初始化（自动完成）