# 部署文档

> 适用环境：Win11 + WSL2 (Ubuntu)
> 目标用户：个人开发者

---

## 环境要求

- **WSL2** + Ubuntu（systemd 已启用）
- **Python 3.12+**
- **Ollama**（Win11 本地运行）
  - bge-m3（embedding）
  - qwen3.5:9b（可选，当前用规则提取）
- **Qdrant**（Win11 本地运行，端口 6333）
- **Node.js**（openclaw gateway）

---

## 依赖安装

```bash
# 1. Python 依赖
pip install fastapi uvicorn httpx rank-bm25 lark networkx

# 2. Ollama 模型（Win11 PowerShell）
ollama pull bge-m3
ollama pull qwen3.5:9b  # 可选

# 3. Qdrant（Win11）
# 下载 https://github.com/qdrant/qdrant/releases
# 解压后运行 qdrant.exe --storage . --port 6333
```

---

## 安装步骤

### 1. 安装 Python 依赖

```bash
cd ~/projects/memory-recall
pip install fastapi uvicorn httpx rank-bm25 lark networkx
```

### 2. 配置 systemd service

```bash
mkdir -p ~/.config/systemd/user

# 写入 service 文件
cat > ~/.config/systemd/user/memory-recall.service << 'EOF'
[Unit]
Description=Memory Recall Server
After=network.target

[Service]
Type=simple
ExecStart=/home/marlon-wei/bin/python3 /home/marlon-wei/projects/memory-recall/start.sh
Restart=always
RestartSec=3
Environment="PATH=/home/marlon-wei/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
StandardOutput=append:/tmp/memory-recall.log
StandardError=append:/tmp/memory-recall.log

[Install]
WantedBy=default.target
EOF

# 启用
systemctl --user daemon-reload
systemctl --user enable memory-recall.service
```

### 3. 启动

```bash
systemctl --user start memory-recall.service
systemctl --user status memory-recall.service
```

---

## 运维

### 启停

```bash
# 启动
systemctl --user start memory-recall.service

# 停止
systemctl --user stop memory-recall.service

# 重启
systemctl --user restart memory-recall.service

# 查看状态
systemctl --user status memory-recall.service

# 开机自启（默认已 enabled）
systemctl --user enable memory-recall.service
```

### 日志

```bash
# 实时日志
tail -f /tmp/memory-recall.log

# 最近 50 行
journalctl --user -u memory-recall.service -n 50

# 错误日志
journalctl --user -u memory-recall.service -p err -n 20
```

### 数据目录

```
~/.memory-recall/
└── data/
    ├── memory_graph.json   # 图数据（边：session/cooccur/category_overlap/word_overlap）
    ├── bm25_index.json    # BM25 索引
    └── extraction_queue.jsonl  # 待处理队列（当前为空）
```

### 手动重启服务

```bash
# 杀掉当前进程
kill $(ps aux | grep "server.py" | grep -v grep | awk '{print $2}')

# 启动
cd ~/projects/memory-recall
python src/server.py
```

---

## 快速测试

```bash
# 健康检查
curl http://localhost:8765/health

# 存一条记忆
curl -s http://localhost:8765/store -X POST \
  -H "Content-Type: application/json" \
  -d '{"content":"我住在深圳","agent_id":"test"}'

# 召回
curl -s http://localhost:8765/recall -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"住在哪","agent_id":"test","max_results":3}'

# 统计
curl http://localhost:8765/stats

# 图统计
python3 -c "
import json
g = json.load(open('/home/marlon-wei/.memory-recall/data/memory_graph.json'))
from collections import Counter
rels = Counter(e.get('relation') for e in g['edges'])
print('Edge types:', dict(rels))
print('Nodes:', len(g['nodes']))
"
```

---

## 故障排查

### 服务启动失败

```bash
# 1. 查看详细日志
journalctl --user -u memory-recall.service -n 30

# 2. 手动运行看报错
cd ~/projects/memory-recall
python src/server.py

# 3. 常见问题
# - Port 8765 被占用: kill 占用进程
# - Qdrant 未启动: Win11 启动 qdrant.exe
# - Ollama 未启动: ollama serve
```

### 向量检索返回空

```bash
# 检查 Ollama
curl http://localhost:11434/api/tags

# 测试 embedding
curl -X POST http://localhost:11434/api/embeddings \
  -d '{"model":"bge-m3","prompt":"hello"}'
```

### 分词不工作

```bash
# 测试 lark
python3 -c "from lark import Lark; print('OK')"

# 测试分词
cd ~/projects/memory-recall
python3 src/lark_tok.py
```

---

## 词表自动维护

每天凌晨 3:00 自动运行，通过 systemd timer 触发。

**逻辑：**
1. 遍历所有记忆（Qdrant scroll）
2. 每条记忆用当前 tokenizer 提取词
3. 调 Ollama LLM 重新分词
4. 对比：LLM 有但字典无 → 候选新增；LLM 无但字典有 → 候选删除
5. 输出到 `/tmp/memory-recall-dict.log`

**手动触发：**
```bash
# 预览模式（不修改文件）
python3 ~/projects/memory-recall/src/dict_maintenance.py --dry-run

# 完整运行（调 LLM 检查）
python3 ~/projects/memory-recall/src/dict_maintenance.py --limit 20

# 只检查不用 LLM
python3 ~/projects/memory-recall/src/dict_maintenance.py --check
```

**启用/查看 timer：**
```bash
systemctl --user enable memory-recall-dict.timer
systemctl --user start memory-recall-dict.timer
systemctl --user list-timers
journalctl --user -u memory-recall-dict.service -n 20
```
