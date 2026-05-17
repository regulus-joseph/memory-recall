# Changelog

All notable changes to memory-recall are documented here.

## v0.8.0 (2026-05-17)

### MemoryStore Fixes
- **Field name fix**: LanceDB schema uses `memory_id` not `id` (id is reserved by LanceDB internally)
- **makeArrowTable**: Store uses `makeArrowTable()` for proper Arrow typed data instead of plain objects
- **Table creation**: Creates table with dummy row (`Array(1024).fill(0)`) to infer schema, then uses makeArrowTable for all subsequent adds
- **Search/delete/compact**: All use `memory_id` column, not `id`

### Model Update
- **LLM model**: Changed from `qwen2.5:7b` to `qwen3.5:4b` (local standard)

### Hook System
- **message_received**: Works for all channels (feishu, telegram, dashboard, tui)
- **before_prompt_build**: Fixed to use `event.prompt` instead of `params.userMessage`
- **Cache mechanism**: Recall results cached in `recallCache` Map with TTL, injected via `before_prompt_build`

### New Tests
- **TS smoke tests**: 25 unit tests passing
- **Per-agent isolation**, **worker concurrency**, **BM25 negative score** tests

---

## v0.7.0 (2026-05-17)

### Breaking Change: Pure TypeScript (No Python Worker)
- **Removed**: Python worker, `pool_router.py`, `worker.py`, all `src/core/*.py`, `src/utils/*.py`
- **New**: `MemoryStore` class — pure TypeScript implementation using:
  - `@lancedb/lancedb` for vector + scalar storage (per-agent LanceDB)
  - `graphology` for L3 graph expansion
  - `nodejieba` for Chinese word segmentation
  - `bm25` package for L2 BM25 scoring
  - Direct `fetch` to Ollama API for embedding + LLM extraction
- **Installation**: now requires `npm install` (nodejieba needs build tools)
- **No more** `~/.memory-recall-venv` Python venv
- **No more** `USE_HTTP_POOL` env var

### Architecture
- `sessionWorkers` Map stores `MemoryStore` instances per session
- `getSessionWorker(sessionKey)` returns or creates a `MemoryStore`
- All 16 worker methods now in `MemoryStore` class

---

## v0.6.0 (2026-05-16)

### Per-Session Workers
- Each session gets a dedicated `MemoryStore` instance
- Default worker for decay/stats; session workers for store/recall
- Session workers killed on `session_end`; all workers cleaned up on `gateway_stop`

### New Tools
- `memory_worker_status`: show all active session workers
- `memory_worker_restart`: kill and restart a specific session's worker

---

## v0.5.0 (2026-05-10)

- HTTP pool mode (`USE_HTTP_POOL=1`) with session affinity
- Session buffer with `session_end` hook flush
- 12 tools (expanded from 4)
- Gateway-stop hook for clean worker shutdown

---

## v0.4.0 (2026-04-25)

- LanceDB migration (replaced Qdrant)
- Worker architecture (stdio JSON-RPC)
- Weibull decay engine
- Compactor clustering
- Tier protection (core memories with importance ≥ 0.7)

---

## v0.3.0 (2026-04-24)

- TS plugin + Python server architecture
- Async LLM extraction (6w + category + confidence)
- MLP 6-category classification

---

## v0.2.0 (2026-04-22)

- `before_agent_start` hook auto-injection

---

## v0.1.0 (2026-04-22)

- Initial: Qdrant + Ollama bge-m3 embedding
- `recall_memories` tool
- `message_received`/`agent_end` auto-store