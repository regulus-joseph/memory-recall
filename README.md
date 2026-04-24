# Memory Recall Plugin

> L1/L2/L3 memory recall plugin for OpenClaw with Qdrant vector storage

## 版本历史

| 版本 | 日期 | 更新内容 |
|-----|------|---------|
| 0.1.0 | 2026-04-22 | 初始版本: Qdrant存储 + Ollama bge-m3 embedding + recall_memories工具 |
| 0.2.0 | 2026-04-22 | 添加before_agent_start hook自动注入; 修复tools.byProvider配置 |

## 功能特性

- **记忆存储**: 通过 `message_received` 和 `agent_end` hooks 自动存储对话
- **向量检索**: 使用 Ollama bge-m3 embedding (1024维) + Qdrant 向量数据库
- **手动召回**: 提供 `recall_memories` 工具供agent按需调用
- **自动召回**: 支持 `before_agent_start` hook 自动注入相关记忆(默认关闭)

## 项目结构

```
memory-recall/
├── openclaw.plugin.json    # 插件配置
├── package.json            # Node.js包配置
├── config/
│   └── config.json        # 默认配置
├── src/
│   └── index.ts          # 插件入口 (register, hooks, tools)
└── README.md
```

## 安装

```bash
cd ~/projects/memory-recall
npm install
openclaw plugins install --link .
openclaw gateway restart
```

## 配置

### 插件配置 (openclaw.json)

```json
{
  "plugins": {
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": {
          "autoRecall": false,
          "qdrant": {
            "host": "localhost",
            "port": 6333,
            "collection": "memory_recall"
          },
          "embedding": {
            "baseURL": "http://localhost:11434",
            "model": "bge-m3",
            "dimensions": 1024
          }
        }
      }
    },
    "slots": {
      "memory": "memory-recall"
    }
  },
  "tools": {
    "byProvider": {
      "minimax-portal": {
        "alsoAllow": ["recall_memories"]
      }
    }
  }
}
```

### 关键配置说明

| 配置 | 说明 | 默认值 |
|-----|------|-------|
| `autoRecall` | 是否自动注入记忆到上下文 | `false` |
| `qdrant.host` | Qdrant服务地址 | `localhost` |
| `qdrant.port` | Qdrant服务端口 | `6333` |
| `qdrant.collection` | Collection名称 | `memory_recall` |
| `embedding.baseURL` | Ollama API地址 | `http://localhost:11434` |
| `embedding.model` | Embedding模型 | `bge-m3` |
| `embedding.dimensions` | 向量维度 | `1024` |

### 工具可见性配置

插件工具需要通过 `tools.byProvider` 配置才能对特定provider的agent可见:

```json
"tools": {
  "byProvider": {
    "<provider-id>": {
      "alsoAllow": ["recall_memories"]
    }
  }
}
```

Provider ID 从 `agents.defaults.model.primary` 提取,例如:
- `minimax-portal/MiniMax-M2.7` → `minimax-portal`

## 使用

### 1. recall_memories 工具

Agent可以通过工具按需查询记忆:

```
用户: 你之前帮我做过什么?
Agent: 我来查一下记忆...
[调用recall_memories工具]
Agent: 找到了之前帮你做过的几件事...
```

### 2. 自动召回 (autoRecall)

开启后,每次agent启动会自动注入相关记忆到上下文:

```json
"memory-recall": {
  "config": {
    "autoRecall": true
  }
}
```

**注意**: 建议关闭自动召回,通过手动工具调用更可控。

## API

### 插件API

```typescript
// 注册工具
api.registerTool({
  name: "recall_memories",
  label: "Memory Recall",
  description: "...",
  parameters: Type.Object({ ... }),
  async execute(toolCallId, params) { ... }
}, { name: "recall_memories" });

// 注册hooks
api.on("message_received", async (event, ctx) => { ... });
api.on("agent_end", async (event) => { ... });
api.on("before_agent_start", async (event) => { ... });
```

### Qdrant API

```bash
# 查看collection
curl http://localhost:6333/collections/memory_recall

# 搜索记忆
curl -X POST http://localhost:6333/collections/memory_recall/points/search \
  -H "Content-Type: application/json" \
  -d '{"vector": [0.0]*1024, "limit": 5, "with_payload": true}'

# 列出所有记忆
curl -X POST http://localhost:6333/collections/memory_recall/points/scroll \
  -H "Content-Type: application/json" \
  -d '{"limit": 100, "with_payload": true}'
```

## 调试

```bash
# 查看插件日志
openclaw logs 2>&1 | grep memory-recall

# 重启网关
openclaw gateway restart

# 卸载插件
openclaw plugins uninstall memory-recall
```

## 参考

- [OpenClaw Plugin SDK](https://github.com/openclaw/openclaw)
- [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)
- [Qdrant](https://qdrant.tech/)
- [Ollama bge-m3](https://ollama.com/)
