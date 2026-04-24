# Memory Recall Plugin

> L1/L2/L3 cascade memory recall for OpenClaw: vector (Qdrant) + BM25 + graph expansion (networkx)

## 版本历史

| 版本 | 日期 | 更新内容 |
|-----|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本: Qdrant存储 + Ollama bge-m3 embedding + recall_memories工具 |
| 0.2.0 | 2026-04-22 | 添加before_agent_start hook自动注入; 修复tools.byProvider配置 |
| **0.3.0** | 2026-04-24 | **Phase 1: TS plugin + Python server 架构；async LLM extraction；MLP 6-category；enhanced embedding；移除 blocking warmup** |

## 架构

```
OpenClaw Gateway
    └── memory-recall (TS plugin, index.ts)
            ├── 4 tools: recall_memories / store_memory / forget_memory / update_memory
            ├── 3 hooks: message_received / agent_end / before_prompt_build
            └── HTTP → http://localhost:8765 (Python server)
                        ├── L1: Qdrant vector search
                        ├── L2: BM25 (jieba-free, bigram fallback)
                        ├── L3: graphify (networkx) graph expansion
                        ├── LLM extraction: 6W + MLP category (qwen3.5:9b, async)
                        ├── BM25 index: ~/.memory-recall/data/bm25_index.json
                        └── Graph: ~/.memory-recall/data/memory_graph.json
```

## 前置依赖

### 1. Qdrant

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

### 2. Ollama

```bash
# bge-m3 for embeddings
ollama pull bge-m3

# qwen3.5:9b for LLM extraction (6W + MLP category)
ollama pull qwen3.5:9b
```

### 3. Python 环境

```bash
cd ~/projects/memory-recall
pip install -r requirements.txt

# 启动 Python server
python -m src.server
# 或者后台运行:
# nohup python -m src.server > ~/.memory-recall/server.log 2>&1 &
```

### 4. Node 环境

```bash
cd ~/projects/memory-recall
npm install
```

### 5. OpenClaw 插件安装

```bash
cd ~/projects/memory-recall
openclaw plugins install . --dangerously-force-unsafe-install
```

### 6. OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，确保 `plugins` 区块包含以下内容：

```json
{
  "plugins": {
    "allow": [
      "memory-recall",
      "minimax",
      "browser",
      "acpx"
    ],
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": {
          "serverUrl": "http://localhost:8765",
          "autoStore": true,
          "autoRecall": true,
          "autoRecallMaxItems": 3,
          "autoRecallMaxChars": 600
        }
      },
      "memory-core": {
        "enabled": false
      },
      "memory-lancedb": {
        "enabled": false
      }
    },
    "slots": {
      "memory": "memory-recall"
    }
  }
}
```

> 注意：`plugins.allow` 必须包含 `memory-recall`，否则 plugin 会被忽略。
> `slots.memory` 独占后，`memory-core` 和 `memory-lancedb` 会自动禁用。

重启 gateway：
```bash
openclaw gateway restart
```

验证加载：
```bash
openclaw plugins list | grep memory-recall
openclaw plugins doctor 2>&1 | grep memory-recall
```

## 配置
```

| 配置 | 说明 | 默认值 |
|-----|------|-------|
| `serverUrl` | Python server 地址 | `http://localhost:8765` |
| `autoStore` | 自动存储消息 | `true` |
| `autoRecall` | 自动注入记忆到 prompt | `true` |
| `autoRecallMaxItems` | 每次注入最大条数 | `3` |
| `autoRecallMaxChars` | 每次注入最大字符数 | `600` |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `QDRANT_HOST` | Qdrant 地址 | `localhost` |
| `QDRANT_PORT` | Qdrant 端口 | `6333` |
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型 | `bge-m3` |
| `OLLAMA_URL` | Ollama generate API | `http://localhost:11434/api/generate` |
| `LLM_MODEL` | Extraction LLM 模型 | `qwen3.5:9b` |
| `MEMORY_RECALL_SERVER` | Python server（TS 端） | `http://localhost:8765` |

## 工具

| 工具 | 说明 |
|------|------|
| `recall_memories` | L1/L2/L3 混合检索，参数: query, max_results, min_score |
| `store_memory` | 存储记忆，自动 LLM 提取 6W + category |
| `forget_memory` | 按 ID 删除记忆 |
| `update_memory` | 更新记忆内容，自动重新提取 |

## Server API

Python server 暴露以下 HTTP 端点:

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/stats` | GET | 统计信息 |
| `/recall` | POST | L1/L2/L3 cascade recall |
| `/store` | POST | 存储记忆 + LLM 提取 |
| `/forget` | POST | 删除记忆 |
| `/update` | POST | 更新记忆 |

## 调试

```bash
# Python server 日志
tail -f ~/.memory-recall/server.log

# 重启 Python server
pkill -f "python -m src.server" && python -m src.server &

# 查看插件日志
openclaw logs 2>&1 | grep memory-recall

# Qdrant API 测试
curl http://localhost:6333/collections/memory_recall

# Python server 直接测试
curl -X POST http://localhost:8765/health
curl -X POST http://localhost:8765/stats
curl -X POST http://localhost:8765/store -H "Content-Type: application/json" -d '{"content": "测试记忆", "agent_id": "test"}'
curl -X POST http://localhost:8765/recall -H "Content-Type: application/json" -d '{"query": "测试", "max_results": 5}'
```

## 数据文件

| 文件 | 说明 |
|------|------|
| `~/.memory-recall/data/bm25_index.json` | BM25 倒排索引 |
| `~/.memory-recall/data/memory_graph.json` | 记忆图谱 |

## 已知问题

- LLM extraction 使用 qwen3.5:9b，如果 ollama 未安装会自动 fallback 到 regex 规则
- BM25 index 在首次使用或更新后自动重建（小 corpus 时 BM25 分数接近 0，随数据量增加改善）
- Graph expansion 使用 networkx BFS，如果 networkx 未安装则降级为 cooccurrence 计数
- `register` 必须是同步函数（OpenClaw plugin 规范要求）
- plugin 安装需要 `--dangerously-force-unsafe-install`（因为使用了 `process.env` + `fetch`）
