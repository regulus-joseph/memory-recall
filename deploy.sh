#!/bin/bash
set -e
echo "=== memory-recall deployment script ==="

# 1. Check Node.js
echo "[1/3] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js not found. Install from https://nodejs.org/"
    exit 1
fi
echo "  Node.js: $(node --version)"
echo "  npm: $(npm --version)"

# 2. Install npm dependencies
echo "[2/3] Installing npm dependencies..."
cd ~/projects/memory-recall
npm install
echo "  npm dependencies installed"

# 3. Build TypeScript
echo "[3/3] Building TypeScript..."
npm run build
echo "  Build complete (dist/ ready)"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "=== Next steps ==="
echo ""
echo "1. Link plugin (optional - for mr global command):"
echo "   cd ~/projects/memory-recall && npm link"
echo ""
echo "2. Install OpenClaw plugin:"
echo "   openclaw plugins install --link ~/projects/memory-recall"
echo ""
echo "3. Configure openclaw.json (see DEPLOY.md)"
echo ""
echo "4. Restart gateway:"
echo "   openclaw gateway restart"
echo ""
echo "=== CLI usage ==="
echo ""
echo "Option A: Global mr command (after npm link)"
echo "   mr init --agent-id main"
echo "   mr store --agent-id main --content 'Marlon config'"
echo "   mr recall --agent-id main --query 'Marlon'"
echo "   mr list --agent-id main"
echo ""
echo "Option B: Direct node call (no setup)"
echo "   node ~/projects/memory-recall/dist/cli.js init --agent-id main"
echo "   node ~/projects/memory-recall/dist/cli.js store --agent-id main --content 'Marlon config'"
echo ""
echo "=== Manual test ==="
echo "   mr stats --agent-id main"
echo "   openclaw plugins inspect memory-recall"