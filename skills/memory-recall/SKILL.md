---
name: memory-recall
description: L1/L2/L3 cascade memory recall plugin for OpenClaw. Per-agent LanceDB (vector + BM25 + graphology). Weibull decay. Progressive compaction. Use when user mentions past conversations, previous decisions, projects, or asks "do you remember...".
trigger: /memory
---

# Memory Recall Skill

Three-layer retrieval cascade (L1 → L2 → L3):
- **L1 (vector)**: bge-m3 embedding via Ollama (1024-dim) — semantic similarity
- **L2 (BM25)**: jieba Chinese tokenization — fast keyword match, no embedding cost
- **L3 (graph)**: graphology expansion from top L1/L2 results — finds related memories via session/category/temporal edges

Storage: LanceDB (vector table per agent/scope) + BM25 index + graphology graph.

Decay: Weibull composite score (recency × frequency × intrinsic importance). Core memories (importance ≥ 0.7) are protected.

## When to Use

- User asks about past conversations, decisions, or events
- User says "remember when...", "do you recall...", "earlier we talked about..."
- User mentions a project, task, or topic and you need context
- Before starting a new task, check relevant memories with `mr_memory_recall`
- User wants to review project history → `memory_browse`
- Analyzing new info before deciding to store → `memory_extract`

## Tools

### mr_memory_recall
Hybrid L1/L2/L3 recall for natural language queries.
```
query: "what did user say about their deadline"
max_results: 3
min_score: 0.15
```

### mr_memory_store
Store memory with auto LLM extraction (6w + category + confidence + temporal_type).
```
content: "用户计划5月15日去深圳出差3天"
```

### memory_forget
Delete memory (core memories protected, importance ≥ 0.7).
```
memory_id: "abc-123-..."
```

### mr_memory_get
Get exact memory by ID.
```
memory_id: "abc-123-..."
```

### memory_browse
Browse by time range or conversation.
```
since: "2026-04-01T00:00:00"
until: "2026-05-01T00:00:00"
summary_only: true
limit: 50
```

### memory_list
Paginated listing with filters.
```
category: "fact"
sort: "desc"
limit: 20
offset: 0
```

### mr_memory_search
Fast BM25/jieba keyword search (no embedding cost).
```
query: "deadline 深圳"
limit: 20
```

### memory_extract
LLM extraction on any text — preview structured fields before storing.
```
content: "用户告诉我他们下周要去深圳出差"
```

### memory_update
Update content or metadata.
```
memory_id: "abc-123-..."
content: "updated content"
metadata: { "status": "done" }
```

### memory_reset
DANGER: Delete ALL memories for an agent.
```
agent_id: "default"
force: true
```

### memory_stats
Storage stats: count, categories, tiers, temporal types.
```
agent_id: "default"
```

### memory_worker_status
Show all active session workers and health.

### memory_worker_restart
Kill and restart worker for a specific session.

## Categories

| Category | Description |
|----------|-------------|
| `fact` | Objective facts (config, path, version) |
| `preference` | User preferences (style, habit, tool choice) |
| `conversation` | Conversational exchanges |
| `task` | To-do / action items |
| `other` | Anything not fitting above |

## Tier System

| Tier | Importance | Behavior |
|------|------------|-----------|
| **core** | ≥ 0.7 | Immune to decay deletion |
| **working** | 0.4–0.7 | Normal priority |
| **peripheral** | < 0.4 | First to be pruned |

## Temporal Type

| Type | Half-life | Meaning |
|------|-----------|---------|
| `dynamic` | 30 days | Rapidly changing |
| `static` | 180 days | Near permanent |
| `recurring` | 90 days | Cyclic patterns |
| `ephemeral` | 7 days | Soon obsolete |

## Tips

- `sessionKey` is used as conversation_id — stable across gateway restarts
- `memory_extract` before `mr_memory_store` to preview category/importance
- Frequently recalled memories track access_count — resists decay
- `memory_browse` with `summary_only: true` for fast project overviews
- Set `min_score: 0.15` in recall to filter low-relevance noise
- Decay runs every 24h (configurable), core memories protected