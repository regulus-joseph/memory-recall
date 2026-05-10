# Memory Recall Plugin

> L1/L2/L3 cascade memory recall for OpenClaw: per-agent LanceDB (vector + FTS) + NetworkX graph expansion. Async LLM extraction, Weibull decay, progressive compaction.

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-04-22 | Initial: Qdrant + Ollama bge-m3 embedding + recall_memories tool |
| 0.2.0 | 2026-04-22 | Added before_agent_start hook auto-injection |
| 0.3.0 | 2026-04-24 | Phase 1: TS plugin + Python server; async LLM extraction; MLP 6-category |
| 0.4.0 | 2026-04-25 | LanceDB migration; worker architecture (stdio JSON-RPC); Weibull decay; Compactor clustering; Tier protection |
| **0.5.0** | 2026-05-10 | **HTTP pool mode (USE_HTTP_POOL=1); session buffer; session_end hook; 12 tools** |

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
                              ├── Graph edges: same_when / same_where (multi-relation)
                              └── LanceDB data: ~/.memory-recall/data/{agent_id}/memories.lance
```

**Ollama Required**: Local Ollama service must be running (bge-m3 + qwen2.5:7b models). No external database dependencies (Qdrant removed).

## Prerequisites

### 1. Python venv (skip if exists)

```bash
python3.12 -m venv ~/.memory-recall-venv
~/.memory-recall-venv/bin/pip install lancedb jieba networkx
```

### 2. Ollama

```bash
# bge-m3 for embeddings
ollama pull bge-m3

# qwen2.5:7b for LLM extraction (6w + category + confidence)
ollama pull qwen2.5:7b
```

## Installation

### 1. Plugin Installation

```bash
cd ~/projects/memory-recall
openclaw plugins install --link . --dangerously-force-unsafe-install
```

### 2. OpenClaw Configuration

Edit `~/.openclaw/openclaw.json`:

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

### 3. Restart and Verify

```bash
openclaw gateway restart
openclaw logs 2>&1 | grep memory-recall
```

## Configuration

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

### HTTP Pool Mode

When enabled, uses `pool_router.py` to manage worker process pool with session affinity:

```bash
export USE_HTTP_POOL=1
openclaw gateway restart
```

Session ID is routed via `_session_id` parameter for multi-session concurrency.

### Transport Mode Comparison

| Mode | USE_HTTP_POOL | Use Case |
|------|---------------|----------|
| stdio (default) | `0` | Single session, development |
| HTTP pool | `1` | Multi-session concurrency, production |

### Hooks

| Hook | Trigger | Function |
|------|---------|----------|
| `message_received` | User message received | Auto-store + trigger recall |
| `agent_end` | Agent reply complete | Store assistant message |
| `before_prompt_build` | Before prompt build | Inject recall cache results |
| `session_end` | Session ends | Flush buffered messages, clear cache |
| `gateway_stop` | Gateway stops | Clean up worker process |

## Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | L1/L2/L3 hybrid retrieval (query, max_results, min_score) |
| `memory_store` | Store memory with auto LLM extraction (6w + category + confidence + temporal_type) |
| `memory_forget` | Delete memory by ID (except core memories) |
| `memory_get` | Get single memory details by ID |
| `memory_browse` | Browse memories by conversation/time range, supports summary mode |
| `memory_list` | Paginated list with category/conversation filter |
| `memory_search` | Fast BM25/jieba keyword search |
| `memory_extract` | Run LLM structured extraction on any text |
| `memory_update` | Update memory content or metadata |
| `memory_reset` | Clear all memories for an agent (dangerous) |
| `memory_stats` | Get memory statistics: count, categories, tiers, temporal types |
| `memory_compact` | Manually trigger clustering compaction (auto-triggered by decay) |

## Schema v0.5 (21 fields)

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `content` | Original content |
| `agent_id` | Owner agent |
| `conversation_id` | Owner conversation |
| `category` | LLM extracted: 6-category MLP |
| `who` | LLM extracted: participants |
| `when` | LLM extracted: time |
| `where` | LLM extracted: location |
| `why` | LLM extracted: purpose |
| `how` | LLM extracted: method |
| `summary` | LLM extracted: summary |
| `importance` | Importance (0~1), core ≥ 0.7 |
| `confidence` | LLM confidence (0~1) |
| `temporal_type` | Time type (static/dynamic) |
| `access_count` | Access count |
| `last_accessed_at` | Last access time |
| `compaction_rounds` | Compaction count |
| `last_compacted_at` | Last compaction time |
| `original_source_count` | Merge source count |
| `created_at` | Creation time |
| `updated_at` | Update time |

## Decay Engine

`composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic`

- **temporal_type** affects half-life: dynamic ÷3, static ×1
- **decay floor** = 0.9 (minimum value)
- **Tier protection**: core memories (importance ≥ 0.7) immune to deletion and compaction
- decay timer managed by gateway via `registerService`, runs every 24h

## Compactor (Clustering Merge)

- Trigger: decay score ≤ 0.3 AND 14 days since last compaction
- Logic: cosine similarity ≥ 0.88 → cluster merge
- Merge rules: dedupe content lines, max importance, plurality category
- Limit: max 4 rounds to prevent over-merging

## Data Directory

```
~/.memory-recall/data/
└── {agent_id}/
    ├── memories.lance/     # LanceDB table (vector + FTS)
    └── graph.json         # NetworkX graph (session/cooccur/category_overlap/same_when/same_where)
```

## Debugging

```bash
# View plugin logs
openclaw logs 2>&1 | grep memory-recall

# Test worker health
cd ~/projects/memory-recall
~/.memory-recall-venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from worker import cmd_health
import asyncio
print(asyncio.run(cmd_health()))
"

# Force run decay cycle (manual trigger)
# Restart gateway to let registerService re-start
openclaw gateway restart

# View LanceDB data
~/.memory-recall-venv/bin/python -c "
import lancedb
db = lancedb.connect('~/.memory-recall/data/main')
print(db.open_table('memories').head())
"
```

## Known Issues

- Plugin installation requires `--dangerously-force-unsafe-install` (because worker architecture needs `child_process.spawn`)
- First decay cycle may timeout (worker cold start), subsequent runs are normal
- LanceDB FTS requires `create_fts_index("tokens")` initialization (automatic)

---

## Pull Request Description

### Summary

memory-recall v0.5.0 adds HTTP pool mode for multi-session concurrency, session buffering, session_end hook, and expands the toolset from 4 to 12 tools — while maintaining full backward compatibility with the existing stdio transport mode.

### Changes

#### New Features
- **HTTP Pool Mode** (`USE_HTTP_POOL=1`): `pool_router.py` manages a pool of worker processes with session affinity via `_session_id` routing. Enables multi-session concurrency in production.
- **Session Buffer**: Buffers messages during a session, flushes on `session_end`. Prevents data loss if `store` fails mid-session.
- **`session_end` Hook**: Triggers buffer flush and cache cleanup when a session ends.
- **`gateway_stop` Hook**: Cleanly terminates worker process on gateway shutdown.

#### Tool Expansion (4 → 12)
| Tool | Description |
|------|-------------|
| `memory_recall` | L1/L2/L3 hybrid retrieval |
| `memory_store` | Auto LLM extraction (6w + category + confidence + temporal_type) |
| `memory_forget` | Delete by ID (core protected) |
| `memory_get` | Get single memory by ID |
| `memory_browse` | Browse by conversation/time range with summary mode |
| `memory_list` | Paginated list with filters |
| `memory_search` | Fast BM25/jieba keyword search |
| `memory_extract` | LLM structured extraction on any text |
| `memory_update` | Update content or metadata |
| `memory_reset` | Clear all agent memories (requires `force:true`) |
| `memory_stats` | Full statistics: count, categories, tiers, temporal types |
| *(internal)* | `compact`, `graph_rebuild`, `decay_scan` available via registerService |

#### Bug Fixes
- Fixed `stats` response: removed non-existent `bm25_doc_count` field (use `memory_count`)
- Fixed `update` timeout on non-existent memory (graceful error response)
- Fixed test suite: all assertions now match actual API response shapes

#### Documentation
- README fully translated to English; Chinese version preserved as `README.zh.md`
- `.gitignore` hardened: excludes `graph.html`, `graph.json`, `.claude/`, `graphify-out/`
- `LICENSE` (MIT) added
- `INIT.md` password sanitized

### Migration Guide

**From v0.4.0 to v0.5.0**: Fully backward compatible. No breaking changes.

```bash
# Existing stdio users: no action needed
openclaw gateway restart

# New HTTP pool users:
export USE_HTTP_POOL=1
# Start pool router first:
~/.memory-recall-venv/bin/python ~/projects/memory-recall/pool_router.py &
openclaw gateway restart
```

### Test Plan

- [x] `tests/worker-smoke.test.mjs` — 10/10 passing (health, store, recall, update, forget, stats, dedup, Chinese text)
- [x] `tests/all.test.mjs` — 25/25 passing (tokenizer, rule_extractor, BM25Index, GraphStore, plugin smoke)
- [x] `tests/bm25-negative-score.test.mjs` — 4/4 passing (negative score edge cases)
- [x] `tests/per-agent-isolation.test.mjs` — 6/6 passing (cross-agent isolation)
- [x] `tests/worker-concurrency.test.mjs` — 5/5 passing (sequential, concurrent writes)

**Total: 50 tests passing**

### Checklist

- [x] Tests added/updated for all new tools
- [x] `bm25_doc_count` field removed from assertions (replaced with `memory_count`)
- [x] `.gitignore` excludes all generated/cache files
- [x] No credentials or secrets in codebase
- [x] README in English + Chinese
- [x] MIT License added