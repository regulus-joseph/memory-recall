# Memory Recall Plugin

> L1/L2/L3 cascade memory recall for OpenClaw: per-agent LanceDB (vector + BM25 + graph) + Weibull decay + progressive compaction. Pure TypeScript.

**v0.8.0** · OpenClaw 2026.5.x compatible

---

## Overview

memory-recall automatically stores conversation content and recalls relevant memories at the start of each agent turn. It uses a cascade retrieval architecture:

- **L1**: LanceDB vector search (1024-dim bge-m3 embeddings)
- **L2**: BM25 rerank + nodejieba Chinese tokenization  
- **L3**: graphology graph expansion for related memory discovery

Memory lifecycle is managed with Weibull decay (recency/frequency/intrinsic importance) and progressive compaction clustering.

**Key differentiator from memory-core**: memory-recall focuses on *recall* (retrieving past memories for current context), while memory-core focuses on *storage* (managing the memory database). Both can coexist.

---

## Architecture

```
OpenClaw Gateway (TypeScript plugin)
└── memory-recall (index.ts)
    ├── 13 tools: recall / store / forget / get / browse / list / search / extract / update / reset / stats / worker_status / worker_restart
    ├── 5 hooks: message_received / agent_end / before_prompt_build / session_end / gateway_stop
    ├── registerService: decay timer (every 24h by default)
    └── MemoryStore (per-session, pure TypeScript)
        ├── L1: LanceDB vector search (1024-dim bge-m3)
        ├── L2: BM25 rerank + nodejieba Chinese segmentation
        ├── L3: graphology graph expansion
        ├── LLM extraction: Ollama qwen3.5:4b (6w + category + confidence)
        ├── Decay: Weibull composite score
        ├── Compactor: cosine similarity clustering
        └── Tier protection: core memories (importance ≥ 0.7) immune
```

---

## Installation

### 1. Build tools (nodejieba needs compilation)

```bash
# Ubuntu/WSL2
apt install build-essential python3

# macOS
xcode-select --install
```

### 2. Link plugin

```bash
cd ~/projects/memory-recall
npm install
openclaw plugins install --link . --dangerously-force-unsafe-install
```

### 3. Configure openclaw.json

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

### 4. Restart and verify

```bash
openclaw gateway restart
openclaw plugins inspect memory-recall
# Should show: Status: loaded
```

---

## Configuration

### Plugin Config

| Config | Description | Default |
|--------|-------------|---------|
| `autoStore` | Auto-store messages to memory | `true` |
| `autoRecall` | Auto-inject memories into prompt | `true` |
| `autoRecallMaxItems` | Max memories injected per turn | `3` |
| `autoRecallMaxChars` | Max characters injected per turn | `600` |
| `decayEnabled` | Enable Weibull decay engine | `true` |
| `decayIntervalHours` | Decay cycle interval | `24` |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_URL` | Ollama embedding API | `http://localhost:11434/api/embeddings` |
| `EMBEDDING_MODEL` | Embedding model | `bge-m3` |
| `OLLAMA_URL` | Ollama base URL | `http://localhost:11434` |
| `LLM_MODEL` | Extraction LLM | `qwen3.5:4b` |

---

## Tools

| Tool | Description |
|------|-------------|
| `mr_memory_recall` | L1/L2/L3 hybrid retrieval |
| `mr_memory_store` | Store with auto LLM extraction (6w + category + confidence) |
| `memory_forget` | Delete by ID (core memories protected) |
| `mr_memory_get` | Get single memory by ID |
| `memory_browse` | Browse by conversation/time range |
| `memory_list` | Paginated list with filters |
| `mr_memory_search` | Fast BM25 keyword search |
| `memory_extract` | Run LLM extraction on any text |
| `memory_update` | Update content or metadata |
| `memory_reset` | Clear all memories (requires `force:true`) |
| `memory_stats` | Count, categories, tiers, temporal types |
| `memory_worker_status` | Active session workers health |
| `memory_worker_restart` | Restart worker for a session |

---

## Hooks

| Hook | Trigger | Function |
|------|---------|----------|
| `message_received` | User message arrives | Auto-store + trigger recall |
| `agent_end` | Agent reply complete | Store assistant message |
| `before_prompt_build` | Before prompt build | Inject recall cache results |
| `session_end` | Session ends | Flush buffers, clear cache |
| `gateway_stop` | Gateway stops | Clean up all workers |

---

## Core Concepts

### 6w Extraction

Every stored memory gets auto-extracted into six dimensions by LLM (qwen3.5:4b):

| Field | Meaning | Example |
|-------|---------|---------|
| `who` | Participants | "Marlon" |
| `what` | What happened | "Configured futu OpenD" |
| `when` | Time | "2026-05-17" |
| `where` | Platform/channel | "webchat" |
| `why` | Purpose/reason | "Need order book data" |
| `how` | Method/detail | "openclaw plugins install" |

### Category

Six categories assigned by LLM:

| Category | Meaning |
|----------|---------|
| `event` | Something that happened |
| `fact` | Objective fact (config, path, version) |
| `preference` | User preference (style, habit, tool choice) |
| `conversation` | Conversational exchange |
| `task` | To-do / action item |
| `other` | Anything not fitting above |

### Temporal Type

Four temporal types affecting Weibull half-life:

| Type | Half-life | Meaning |
|------|-----------|---------|
| `dynamic` | 30 days | Rapidly changing (daily decisions, ongoing tasks) |
| `static` | 180 days | Near permanent (config, identity) |
| `recurring` | 90 days | Cyclic patterns (weekly reviews, cron jobs) |
| `ephemeral` | 7 days | Soon obsolete (transient temp notes) |

### Importance

Float 0.0–1.0 scored by LLM. Memories with `importance ≥ 0.7` are **Tier 1 protected** — decay and compaction skip them entirely.

---

## Cascade Retrieval (L1 → L2 → L3)

### L1: Vector Search

```
query text
    ↓ bge-m3 (1024-dim)
vector embedding [0.12, -0.34, ...]
    ↓ LanceDB cosine similarity top-20 (agent_id filter)
L1 candidates
```

### L2: BM25 Rerank

```
L1 candidates + query keywords
    ↓ jieba Chinese tokenization
BM25 scoring across L1 set → boost score += bm25_score × 0.3
L2 reranked candidates
```

### L3: Graph Expansion

```
L2 candidates → extract entity nodes (who/what/where)
    ↓ graphology BFS expansion (depth ≤ 2)
related memories: same project, same symbol, same time window
```

### Final Fusion

```
fusion_score = 0.7 × vector_score + 0.3 × bm25_score
    ↓ top K → dedupe → prompt injection
```

---

## Weibull Decay Engine

Every `decayIntervalHours` (default 24h), non-protected memories decay via:

```
score = recency_score × frequency_score × importance_score

recency_score    = e^(-elapsed_hours / half_life)  ← Weibull
frequency_score  = log(1 + access_count) / log(1 + max_access_count)
importance_score = importance_field                ← LLM original
```

**Half-life by temporal type:**

| Type | Half-life |
|------|-----------|
| `dynamic` | 30 days |
| `static` | 180 days |
| `recurring` | 90 days |
| `ephemeral` | 7 days |

Memories below score threshold (0.15) AND importance < 0.4 are marked for auto-deletion.

### Compactor

Cosine similarity clustering merges groups of similar memories into one (preserving all 6w, keeping highest importance, summing access_count).

---

## Hook Lifecycle

```
user message
    ↓ message_received
    → autoStore: extract 6w + category + importance + temporal_type
    → store to LanceDB + update graph.json
    → trigger L1/L2/L3 recall → save to recall_cache

agent reply complete
    ↓ agent_end
    → store AI reply as a separate memory

before prompt build
    ↓ before_prompt_build
    → read recall_cache → format memories → inject into prompt

[format example:]
[Relevant Memories]
1. [fact] Marlon's futu OpenD path: ~/FutuOpenD/ (importance=0.8)
2. [preference] Prefers WSL2 as main dev environment (importance=0.75)
3. [project] trade-agents active development (importance=0.85)

session ends
    ↓ session_end
    → flush session buffer
    → clear recall_cache

gateway stops
    ↓ gateway_stop
    → cleanup all worker processes
```

---

## Memory Schema (LanceDB)

```
memories.lance table fields:
  memory_id        string  primary key
  text             string  content
  tokens           string  jieba FTS index
  scope            string  global|agent|session
  agent_id         string  agent identifier
  conversation_id  string  session/conversation id
  category         string  event|fact|preference|conversation|task|other
  importance       float32  0.0–1.0
  temporal_type    string  dynamic|static|recurring|ephemeral
  who/what/when/where/why/how  string  extracted 6w
  summary          string  auto-generated summary
  confidence       float32  extraction confidence
  tags             string  JSON array
  created_at       int64   timestamp ms
  stored_at        string  ISO timestamp
  last_accessed_at int64   last recall timestamp
  access_count     int     recall count
  compaction_rounds int    compaction passes
  last_compacted_at int64  last compaction timestamp
  original_source_count int  merged memory count
  vector           vector(1024) bge-m3 embedding

graph.json:
  nodes: { memory_id, scope, category }
  edges: { from, to, weight, relation }
```

---

## Tools Detail

### `mr_memory_recall`
```
args: query, agent_id?, max_results?, min_score?
returns: [{memory_id, text, category, importance, who/what/when,
           relevance_score, fusion_score}]
```

### `mr_memory_store`
```
args: content, agent_id?, scope?
returns: {memory_id, category, importance, temporal_type,
          confidence, who/what/when/where/why/how}
```

### `memory_browse`
```
args: agent_id?, conversation_id?, start_date?, end_date?,
      category?, summary?
returns: [{memory_id, text, category, importance, created_at, summary}]
```

### `memory_list`
```
args: agent_id?, category?, conversation_id?, limit?, offset?, sort?
returns: {memories: [...], count, offset, limit, agent_id}
```

### `mr_memory_search`
```
args: query, agent_id?, max_results?
returns: [{memory_id, text, category, relevance_score}]
```

### `memory_extract`
```
args: text
returns: {category, importance, confidence, temporal_type,
          who/what/when/where/why/how, summary}
```

### `memory_update`
```
args: memory_id, content?, importance?, category?, add_tags?, remove_tags?
returns: updated memory object
```

### `memory_forget`
```
args: memory_id, agent_id?, force?
returns: {success, reason}
note: Tier 1 (importance ≥ 0.7) rejected unless force=true
```

### `memory_reset`
```
args: agent_id?, scope?, force (required true)
returns: {cleared: count}
```

### `memory_stats`
```
returns: {total_memories, by_category, by_tier,
          by_temporal_type, decay_progress,
          oldest_memory, newest_memory}
```

### `memory_worker_status`
```
returns: {workers: [{session_id, pid, status,
                   last_heartbeat, command_buffer_size}]}
```

### `memory_worker_restart`
```
args: session_id
returns: {new_pid, status}
```

---

## CLI

```bash
cd ~/projects/memory-recall

# 初始化
python src/cli.py init

# 存储
python src/cli.py store --content "Marlon 的配置" --agent-id main

# 召回
python src/cli.py recall --query "Marlon" --max 5

# 搜索
python src/cli.py search --query "futu" --max 5

# 查看数据
~/.local/bin/python -c "
import lancedb
db = lancedb.connect('~/.memory-recall/data/main')
print(db.open_table('memories').search('OpenClaw').limit(5).to_df())
"
```

---

## Data Directory

```
~/.memory-recall/data/{scope}/
├── memories.lance/         LanceDB table (vector + FTS + scalar indexes)
└── graph.json              graphology graph (per-agent)
```

---

## Debugging

```bash
# View logs
openclaw logs 2>&1 | grep memory-recall

# Check plugin
openclaw plugins inspect memory-recall

# Run tests
cd ~/projects/memory-recall
npm run test:unit
npm run test:smoke
```

---

## Known Limitations

| Issue | Description | Status |
|-------|-------------|--------|
| `agent_id` legacy filter bug | L2/L3 may not filter correctly on agent_id in some cases | ⚠️ known |
| First decay cycle may timeout | Worker cold start, subsequent cycles normal | ⚠️ known |
| `--dangerously-force-unsafe-install` required | child_process.spawn still marked unsafe | ⚠️ known |
| LanceDB FTS auto-initializes on first store | Creates `create_fts_index("tokens")` automatically | ✅ handled |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.8.0 | 2026-05-17 | LanceDB field name fix (memory_id); makeArrowTable; qwen3.5:4b model |
| 0.7.0 | 2026-05-17 | Pure TypeScript (no Python worker); LanceDB + graphology + nodejieba + bm25 |
| 0.6.0 | 2026-05-16 | Per-session workers; worker_status/restart tools |
| 0.5.0 | 2026-05-10 | HTTP pool mode; session buffer; session_end flush |
| 0.4.0 | 2026-04-25 | LanceDB; Weibull decay; Compactor; Tier protection |
| 0.3.0 | 2026-04-24 | TS plugin + Python server; LLM extraction |
| 0.2.0 | 2026-04-22 | before_agent_start hook |
| 0.1.0 | 2026-04-22 | Initial: Qdrant + bge-m3 |