# Changelog

All notable changes to memory-recall are documented here.

## v0.6.0 (2026-05-16)

### Architecture
- **Per-session workers**: each session now gets a dedicated Worker process via `getWorker(sessionKey)`, replacing the single shared worker
- Default worker (`_defaultWorker`) for decay/stats operations; session workers (`sessionWorkers` Map) for store/recall
- Session workers are killed on `session_end`; all workers cleaned up on `gateway_stop`

### New Tools
- `memory_worker_status`: show all active session workers and health
- `memory_worker_restart`: kill and restart a specific session's worker

### Bug Fixes
- Fixed `memory_update`, `memory_stats`, `agent_end` store, and decay cycle to use correct worker references
- Fixed `gateway_stop` to kill all session workers

---

## v0.5.0 (2026-05-10)

- HTTP pool mode (`USE_HTTP_POOL=1`) with session affinity via `pool_router.py`
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