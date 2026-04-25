#!/bin/bash
set -e
echo "=== memory-recall 部署脚本 ==="

# 1. 创建 Python venv
echo "[1/3] 创建 Python venv..."
if [ ! -d "$HOME/.memory-recall-venv" ]; then
    python3 -m venv "$HOME/.memory-recall-venv"
fi
VENV_PY="$HOME/.memory-recall-venv/bin/python"
echo "  venv python: $VENV_PY"

# 2. 安装 Python 依赖
echo "[2/3] 安装 Python 依赖..."
$VENV_PY -m pip install -q lancedb pyarrow jieba networkx httpx
echo "  Python 依赖安装完成"

# 3. 词表维护 systemd timer（每天凌晨3点运行）
echo "[3/3] 配置词表维护 timer..."
mkdir -p ~/.config/systemd/user
PROJ=$HOME/projects/memory-recall

cat > ~/.config/systemd/user/memory-recall-dict.timer << 'EOF'
[Unit]
Description=Memory Recall Dictionary Maintenance Timer

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > ~/.config/systemd/user/memory-recall-dict.service << 'EOF'
[Unit]
Description=Memory Recall Dictionary Maintenance
After=network.target

[Service]
Type=oneshot
ExecStart=$HOME/.memory-recall-venv/bin/python $HOME/projects/memory-recall/src/dict_maintenance.py
StandardOutput=append:/tmp/memory-recall-dict.log
StandardError=append:/tmp/memory-recall-dict.log
EOF

echo "  Timer 已写入: ~/.config/systemd/user/memory-recall-dict.timer"

# 启用 timer
systemctl --user daemon-reload
systemctl --user enable memory-recall-dict.timer
systemctl --user start memory-recall-dict.timer

echo ""
echo "=== 部署完成 ==="
echo "  TS plugin 通过 child_process.spawn 管理 worker.py 生命周期"
echo "  无需 systemd service（插件自主管理）"
echo ""
echo "=== 词表维护 ==="
echo "  Timer: memory-recall-dict.timer (每天03:00自动运行)"
echo "  手动运行: ~/.memory-recall-venv/bin/python $PROJ/src/dict_maintenance.py --dry-run"
echo "  日志: tail -f /tmp/memory-recall-dict.log"
echo ""
echo "=== 手动测试 worker.py ==="
echo "  cd $PROJ && bash start.sh"
echo "  echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"health\",\"params\":{}}' | python3 src/worker.py"
