#!/bin/bash
# memory-recall 部署脚本
# 用法: bash deploy.sh

set -e

echo "=== memory-recall 部署脚本 ==="

# 1. 安装 Python 依赖
echo "[1/4] 创建 Python venv..."
if [ ! -d "$HOME/.memory-recall-venv" ]; then
    python3 -m venv "$HOME/.memory-recall-venv"
fi
VENV_PY="$HOME/.memory-recall-venv/bin/python"
echo "  venv python: $VENV_PY"

echo "[2/4] 安装 Python 依赖..."
$VENV_PY -m pip install -q fastapi uvicorn httpx rank-bm25 jieba networkx
echo "  Python 依赖安装完成"

# 2. 创建 systemd service
echo "[3/4] 配置 systemd service + timer..."
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/memory-recall.service << EOF
[Unit]
Description=Memory Recall Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME/projects/memory-recall
ExecStart=$HOME/.memory-recall-venv/bin/python $HOME/projects/memory-recall/start.sh
Restart=always
RestartSec=3
Environment="PATH=$HOME/.memory-recall-venv/bin:$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
StandardOutput=append:/tmp/memory-recall.log
StandardError=append:/tmp/memory-recall.log

[Install]
WantedBy=default.target
EOF

echo "  service 文件已写入: ~/.config/systemd/user/memory-recall.service"

# 3. 创建启动脚本
echo "[4/4] 创建启动脚本..."
PROJ=$HOME/projects/memory-recall
cat > $PROJ/start.sh << STARTSCRIPT
#!/bin/bash
cd $PROJ
$VENV_PY src/worker.py &
exec $VENV_PY src/server.py
STARTSCRIPT
chmod +x $PROJ/start.sh
echo "  启动脚本已写入: $PROJ/start.sh"

# 4. 创建词表维护 systemd timer（每天凌晨3点运行）
cat > ~/.config/systemd/user/memory-recall-dict.timer << 'EOF'
[Unit]
Description=Memory Recall Dictionary Maintenance Timer
After=memory-recall.service

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > ~/.config/systemd/user/memory-recall-dict.service << EOF
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

# 启用 service
echo ""
echo "=== 启用服务 ==="
systemctl --user daemon-reload
systemctl --user enable memory-recall.service
systemctl --user enable memory-recall-dict.timer
systemctl --user start memory-recall.service
sleep 2

# 验证
if curl -s http://localhost:8765/health > /dev/null 2>&1; then
    echo ""
    echo "=== 部署成功 ==="
    echo "  服务地址: http://localhost:8765"
    echo "  状态查看: systemctl --user status memory-recall.service"
    echo "  日志: tail -f /tmp/memory-recall.log"
    echo "  统计: curl http://localhost:8765/stats"
    echo ""
    echo "=== 词表维护 ==="
    echo "  Timer: memory-recall-dict.timer (每天03:00自动运行)"
    echo "  手动运行: ~/.memory-recall-venv/bin/python $PROJ/src/dict_maintenance.py --dry-run"
    echo "  日志: tail -f /tmp/memory-recall-dict.log"
else
    echo ""
    echo "=== 部署失败 ==="
    echo "  运行 systemctl --user status memory-recall.service 查看错误"
    echo "  或手动运行: cd $PROJ && ~/.memory-recall-venv/bin/python src/server.py"
fi
