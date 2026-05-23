# 部署文档

> 适用环境：Win11 + WSL2 (Ubuntu)
> 目标用户：个人开发者
> 当前版本：v0.8.1 (纯 TypeScript，无 Python worker)

---

## 环境要求

- **WSL2** + Ubuntu（systemd 已启用）
- **Node.js** (openclaw gateway)
- **Ollama**（WSL2 内运行）
  - `bge-m3`（embedding）
  - `qwen3.5:4b`（LLM extraction）

**纯 TypeScript**：无 Python worker、无外部向量数据库，数据存在本地 LanceDB 文件。

---

## 依赖安装

### 1. Build tools（nodejieba 编译需要）

```bash
# Ubuntu/WSL2
apt install build-essential python3

# macOS
xcode-select --install
```

### 2. Ollama 模型

```bash
ollama pull bge-m3
ollama pull qwen3.5:4b
```

---

## 插件安装

```bash
cd ~/projects/memory-recall
npm install
npm run build
openclaw plugins install --link .
```

---

## OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，在 `plugins` 区块添加：

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
      }
    }
  }
}
```

重启：
```bash
openclaw gateway restart
```

---

## CLI 使用

### 编译

```bash
npm run build
```

### 命令

```bash
# 初始化
node dist/cli.js init --agent-id main

# 存储记忆
node dist/cli.js store --agent-id main --content "用户的 futu OpenD 在 ~/FutuOpenD"

# 召回（L1/L2/L3 级联）
node dist/cli.js recall --agent-id main --query "futu OpenD" --max 5

# 搜索（BM25 关键词）
node dist/cli.js search --agent-id main --query "futu OpenD"

# 浏览
node dist/cli.js browse --agent-id main --max 10

# 按 ID 获取单条
node dist/cli.js get --agent-id main --memory-id <id>

# 列出所有记忆
node dist/cli.js list --agent-id main

# 统计面板
node dist/cli.js stats --agent-id main

# 删除记忆
node dist/cli.js forget --agent-id main --memory-id <id>

# 清空所有记忆（需 --force）
node dist/cli.js reset --agent-id main --force
```

---

## 运维

### 启停

```bash
# 重启 gateway
openclaw gateway restart

# 查看插件日志
openclaw logs 2>&1 | grep memory-recall
```

### 衰减引擎日志

```bash
openclaw logs 2>&1 | grep "decay\|compactor"
```

### 数据目录

```
~/.memory-recall/data/{agent_id}/
├── lancedb/              # LanceDB 表（vector + scalar）
└── graph.json            # graphology 图（per-agent）
```

---

## 故障排查

### 服务启动失败

```bash
# 1. 查看详细日志
openclaw logs 2>&1 | grep memory-recall | tail -20

# 2. 检查 npm 依赖
cd ~/projects/memory-recall
npm install
npm run build

# 3. 检查 nodejieba 编译
node -e "require('nodejieba')" 2>&1
```

### 向量检索返回空

```bash
# 检查 Ollama
curl -s http://localhost:11434/api/tags | head -20

# 测试 embedding
curl -s -X POST http://localhost:11434/api/embeddings \
  -d '{"model":"bge-m3","prompt":"hello"}'
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型 | `bge-m3` |
| `OLLAMA_URL` | Ollama generate API | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen3.5:4b` |
| `DATA_DIR` | 数据根目录 | `~/.memory-recall/data` |

覆盖示例：
```bash
# 在 openclaw 启动前设置
export LLM_MODEL=qwen2.5:7b
openclaw gateway restart
```