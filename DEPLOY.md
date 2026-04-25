# 部署文档

> 适用环境：Win11 + WSL2 (Ubuntu)
> 目标用户：个人开发者
> 当前版本：v2.5 (LanceDB + worker 架构)

---

## 环境要求

- **WSL2** + Ubuntu（systemd 已启用）
- **Python 3.12**
- **Ollama**（WSL2 内运行）
  - `bge-m3`（embedding）
  - `qwen2.5:7b`（LLM extraction）
- **Node.js**（openclaw gateway）

**无外部依赖**：Qdrant 已移除，所有数据存在本地 LanceDB 文件。

---

## 依赖安装

### 1. Ollama 模型

```bash
ollama pull bge-m3
ollama pull qwen2.5:7b
```

### 2. Python venv

```bash
# 如果已有 ~/.memory-recall-venv，跳过此步
python3.12 -m venv ~/.memory-recall-venv
~/.memory-recall-venv/bin/pip install lancedb jieba networkx
```

验证：
```bash
~/.memory-recall-venv/bin/python -c "import lancedb, jieba, networkx; print('all ok')"
```

---

## 插件安装

```bash
cd ~/projects/memory-recall
openclaw plugins install --link . --dangerously-force-unsafe-install
```

---

## OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，在 `plugins` 区块添加：

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

重启：
```bash
openclaw gateway restart
```

---

## 运维

### 启停

Worker 由 TS plugin 通过 `child_process.spawn` 管理生命周期，无需单独启停。

```bash
# 重启 gateway（即重启 worker）
openclaw gateway restart

# 查看 worker 日志
openclaw logs 2>&1 | grep memory-recall
```

### 衰减引擎日志

```bash
openclaw logs 2>&1 | grep "decay\|compactor"
```

首次 decay cycle 可能超时（worker 冷启动），后续正常运行。

### 数据目录

```
~/.memory-recall/data/
└── {agent_id}/
    ├── memories.lance/    # LanceDB 表（per-agent）
    └── graph.json         # NetworkX 图（per-agent）
```

---

## 快速测试

```bash
# 查看插件加载
openclaw logs 2>&1 | grep "memory-recall"

# 手动测试 worker 健康
~/.memory-recall-venv/bin/python -c "
import sys; sys.path.insert(0, '/home/marlon-wei/projects/memory-recall/src')
import asyncio, worker
print(asyncio.run(worker.cmd_health()))
"

# 查看 LanceDB 表
~/.memory-recall-venv/bin/python -c "
import lancedb
db = lancedb.connect('/home/marlon-wei/.memory-recall/data/main')
tbl = db.open_table('memories')
print(f'Rows: {tbl.count_rows()}')
"

# 查看 NetworkX 图
~/.memory-recall-venv/bin/python -c "
import json, networkx as nx
with open('/home/marlon-wei/.memory-recall/data/main/graph.json') as f:
    g = nx.node_link_graph(json.load(f))
print(f'Nodes: {g.number_of_nodes()}, Edges: {g.number_of_edges()}')
"
```

---

## 故障排查

### 服务启动失败

```bash
# 1. 查看详细日志
openclaw logs 2>&1 | grep memory-recall | tail -20

# 2. 手动运行 worker 看报错
cd ~/projects/memory-recall
~/.memory-recall-venv/bin/python src/worker.py

# 3. 检查 Python 依赖
~/.memory-recall-venv/bin/python -c "import lancedb, jieba, networkx; print('deps ok')"
```

### 向量检索返回空

```bash
# 检查 Ollama
curl -s http://localhost:11434/api/tags | head -20

# 测试 embedding
curl -s -X POST http://localhost:11434/api/embeddings \
  -d '{"model":"bge-m3","prompt":"hello"}'
```

### decay cycle 超时

首次运行可能超时（worker 冷启动初始化慢）。这是预期行为，后续运行正常。

```bash
# 手动触发一次看详细日志
openclaw gateway restart
sleep 5 && openclaw logs 2>&1 | grep "decay\|compact"
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `PYTHON_BIN` | Worker Python 路径 | `~/.memory-recall-venv/bin/python` |
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型 | `bge-m3` |
| `OLLAMA_URL` | Ollama generate API | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen2.5:7b` |

覆盖示例：
```bash
# 在 openclaw 启动前设置
export PYTHON_BIN=/custom/path/bin/python
openclaw gateway restart
```
