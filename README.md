# Memory Recall Plugin

> L1/L2/L3 cascade memory recall for OpenClaw: per-agent LanceDB (vector + FTS) + NetworkX graph expansion. Async LLM extraction, Weibull decay, progressive compaction.

## Version

**v0.5.0** · OpenClaw 2026.5.x compatible

---

## Overview

memory-recall is a memory plugin that automatically stores conversation content and recalls relevant memories at the start of each agent turn. It uses a cascade retrieval architecture (L1 vector → L2 FTS → L3 graph expansion) and manages memory lifecycle with Weibull decay and progressive compaction.

**Key differentiator from memory-core**: memory-recall focuses on *recall* (retrieving past memories for current context), while memory-core focuses on *storage* (managing the memory database). Both can coexist; memory-recall is marked as `kind: "utility"` to avoid slot conflicts.

---

## Architecture

```
OpenClaw Gateway (TS plugin)
    └── memory-recall (index.ts)
            ├── 12 tools: recall/search/list/browse/stats/update/extract/reset + store/forget/get
            ├── 5 hooks: message_received / agent_end / before_prompt_build / session_end / gateway_stop
            ├── registerService: decay timer (gateway-managed, every 24h)
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
                              └── LanceDB data: ~/.memory-recall/data/{agent_id}/memories.lance
```

---

## Prerequisites

### 1. Python venv

```bash
python3.12 -m venv ~/.memory-recall-venv
~/.memory-recall-venv/bin/pip install lancedb jieba networkx httpx
```

### 2. Ollama models

```bash
ollama pull bge-m3          # for embeddings
ollama pull qwen2.5:7b       # for LLM extraction (6w + category + confidence)
```

---

## Installation

### 1. Link plugin to OpenClaw

```bash
cd ~/projects/memory-recall
openclaw plugins install --link . --dangerously-force-unsafe-install
```

### 2. Configure openclaw.json

```json
{
  "plugins": {
    "allow": ["memory-recall", "minimax", "browser", "skill-auto-injection", "policy-layer"],
    "bundledDiscovery": "allowlist",
    "slots": {
      "memory": "memory-core"
    },
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

### 3. Restart gateway

```bash
openclaw gateway restart
```

### 4. Verify

```bash
openclaw plugins inspect memory-recall
# Should show: Status: loaded
```

---

## Configuration

### Plugin Config (openclaw.json entries.memory-recall.config)

| Config | Description | Default |
|--------|-------------|---------|
| `autoStore` | Automatically store messages to memory | `true` |
| `autoRecall` | Automatically inject memories into prompt | `true` |
| `autoRecallMaxItems` | Max memories injected per turn | `3` |
| `autoRecallMaxChars` | Max characters injected per turn | `600` |
| `decayEnabled` | Enable decay engine | `true` |
| `decayIntervalHours` | Decay cycle interval (hours) | `24` |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PYTHON_BIN` | Worker Python path | `~/.memory-recall-venv/bin/python` |
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding model | `bge-m3` |
| `OLLAMA_URL` | Ollama generate API | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen2.5:7b` |
| `USE_HTTP_POOL` | Enable HTTP pool mode | `0` (0=stdio, 1=HTTP) |
| `MR_ROUTER_URL` | Pool router address | `http://127.0.0.1:18799` |

### Transport Modes

| Mode | USE_HTTP_POOL | Use Case |
|------|---------------|----------|
| stdio (default) | `0` | Single session, development |
| HTTP pool | `1` | Multi-session concurrency, production |

To enable HTTP pool mode, add to `~/.openclaw/gateway.systemd.env`:

```bash
USE_HTTP_POOL=1
```

---

## OpenClaw Configuration Notes

### Memory Slot Conflict

**Problem**: `Error: memory slot set to "memory-core"` — memory-core owns the memory slot, blocking other memory-kind plugins.

**Solution**: memory-recall uses `kind: "utility"` (not `"memory"`) to avoid this conflict. The memory slot is owned by memory-core; memory-recall operates as a utility plugin.

### bundledDiscovery: "allowlist"

When `bundledDiscovery` is set to `"allowlist"` (default), the `plugins.allow` list filters ALL plugins including bundled ones. Make sure all enabled plugins are listed:

```json
"plugins": {
  "allow": ["memory-recall", "skill-auto-injection", "policy-layer", ...]
}
```

### policy-layer AllowPromptInjection

If policy-layer is blocking prompt injection, set:

```json
"entries": {
  "policy-layer": {
    "enabled": true,
    "config": {
      "hooks": {
        "allowPromptInjection": true
      }
    }
  }
}
```

---

## Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | L1/L2/L3 hybrid retrieval (query, max_results, min_score) |
| `memory_store` | Store memory with auto LLM extraction (6w + category + confidence + temporal_type) |
| `memory_forget` | Delete memory by ID (except core memories, importance ≥ 0.7) |
| `memory_get` | Get single memory details by ID |
| `memory_browse` | Browse memories by conversation/time range, supports summary mode |
| `memory_list` | Paginated list with category/conversation filter |
| `memory_search` | Fast BM25/jieba keyword search |
| `memory_extract` | Run LLM structured extraction on any text |
| `memory_update` | Update memory content or metadata |
| `memory_reset` | Clear all memories for an agent (requires `force:true`) |
| `memory_stats` | Get memory statistics: count, categories, tiers, temporal types |
| `memory_compact` | Manually trigger clustering compaction |

---

## Hooks

| Hook | Trigger | Function |
|------|---------|----------|
| `message_received` | User message received | Auto-store + trigger recall |
| `agent_end` | Agent reply complete | Store assistant message |
| `before_prompt_build` | Before prompt build | Inject recall cache results |
| `session_end` | Session ends | Flush buffered messages, clear cache |
| `gateway_stop` | Gateway stops | Clean up worker process |

---

## Data Directory

```
~/.memory-recall/data/
└── {agent_id}/
    ├── memories.lance/     # LanceDB table (vector + FTS)
    └── graph.json         # NetworkX graph (per-agent)
```

---

## CLI

```bash
cd ~/projects/memory-recall
~/.memory-recall-venv/bin/python src/cli.py <command>

Commands:
  init     Initialize collection
  store    Store a memory (--content "text" --agent-id main)
  recall   Recall memories (--query "text" --max 5)
  search   Search by keyword (--query "text" --max 5)
```

---

## Debugging

```bash
# View plugin logs
openclaw logs 2>&1 | grep memory-recall

# Check plugin status
openclaw plugins inspect memory-recall

# Test worker health
~/.memory-recall-venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from worker import cmd_health
import asyncio
print(asyncio.run(cmd_health()))
"

# View LanceDB data
~/.memory-recall-venv/bin/python -c "
import lancedb
db = lancedb.connect('~/.memory-recall/data/main')
print(db.open_table('memories').head())
"
```

---

## Known Issues

- Plugin installation requires `--dangerously-force-unsafe-install` (because worker architecture needs `child_process.spawn`)
- First decay cycle may timeout (worker cold start), subsequent runs are normal
- LanceDB FTS requires `create_fts_index("tokens")` initialization (automatic)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-22 | Initial: Qdrant + Ollama bge-m3 embedding + recall_memories tool |
| 0.2.0 | 2026-04-22 | Added before_agent_start hook auto-injection |
| 0.3.0 | 2026-04-24 | Phase 1: TS plugin + Python server; async LLM extraction; MLP 6-category |
| 0.4.0 | 2026-04-25 | LanceDB migration; worker architecture (stdio JSON-RPC); Weibull decay; Compactor clustering; Tier protection |
| **0.5.0** | 2026-05-10 | **HTTP pool mode (USE_HTTP_POOL=1); session buffer; session_end hook; 12 tools** |