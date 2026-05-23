# Deployment Guide

> Environment: Win11 + WSL2 (Ubuntu)
> Target: Individual developer
> Current version: v0.8.1 (Pure TypeScript, no Python worker)

---

## Requirements

- **WSL2** + Ubuntu (systemd enabled)
- **Node.js** (openclaw gateway)
- **Ollama** (running in WSL2)
  - `bge-m3` (embedding)
  - `qwen3.5:4b` (LLM extraction)

**Pure TypeScript**: No Python worker, no external vector DB. Data stored locally in LanceDB.

---

## Installation

### 1. Build tools (nodejieba compilation required)

```bash
# Ubuntu/WSL2
apt install build-essential python3

# macOS
xcode-select --install
```

### 2. Ollama models

```bash
ollama pull bge-m3
ollama pull qwen3.5:4b
```

---

## Plugin Setup

```bash
cd ~/projects/memory-recall
npm install
npm run build
openclaw plugins install --link .
```

---

## OpenClaw Configuration

Edit `~/.openclaw/openclaw.json`, add to `plugins` section:

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

Restart:
```bash
openclaw gateway restart
```

---

## CLI Usage

### Option A: Global `mr` command (recommended)

```bash
# One-time setup
cd ~/projects/memory-recall && npm link

# Then use from any directory
mr init --agent-id main
mr store --agent-id main --content "Marlon's futu OpenD at ~/FutuOpenD"
mr recall --agent-id main --query "futu OpenD" --max 5
mr search --agent-id main --query "futu OpenD"
mr list --agent-id main
mr stats --agent-id main
mr get --agent-id main --memory-id <id>
mr browse --agent-id main --max 10
mr forget --agent-id main --memory-id <id>
mr reset --agent-id main --force
```

Note: `npm run build` may show TypeScript warnings but `dist/` works correctly.

### Option B: Direct node call (no setup required)

```bash
# No npm link needed - use full path
node ~/projects/memory-recall/dist/cli.js <command> [options]

# Examples
node ~/projects/memory-recall/dist/cli.js init --agent-id main
node ~/projects/memory-recall/dist/cli.js store --agent-id main --content "Marlon's futu OpenD"
node ~/projects/memory-recall/dist/cli.js recall --agent-id main --query "futu OpenD" --max 5
```

---

## Operations

### Start/Stop

```bash
# Restart gateway
openclaw gateway restart

# View plugin logs
openclaw logs 2>&1 | grep memory-recall
```

### Decay engine logs

```bash
openclaw logs 2>&1 | grep "decay\|compactor"
```

### Data directory

```
~/.memory-recall/data/{agent_id}/
├── lancedb/              # LanceDB table (vector + scalar)
└── graph.json            # graphology graph (per-agent)
```

---

## Troubleshooting

### Service fails to start

```bash
# 1. Check logs
openclaw logs 2>&1 | grep memory-recall | tail -20

# 2. Check npm dependencies
cd ~/projects/memory-recall
npm install
npm run build

# 3. Check nodejieba compilation
node -e "require('nodejieba')" 2>&1
```

### Vector search returns empty

```bash
# Check Ollama
curl -s http://localhost:11434/api/tags | head -20

# Test embedding
curl -s -X POST http://localhost:11434/api/embeddings \
  -d '{"model":"bge-m3","prompt":"hello"}'
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding model | `bge-m3` |
| `OLLAMA_URL` | Ollama base URL | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen3.5:4b` |
| `DATA_DIR` | Data root directory | `~/.memory-recall/data` |

Override example:
```bash
export LLM_MODEL=qwen2.5:7b
openclaw gateway restart
```