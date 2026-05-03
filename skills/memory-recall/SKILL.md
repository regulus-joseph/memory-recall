---
name: memory-recall
description: Long-term memory system for OpenClaw agents. Use whenever user mentions past conversations, previous decisions, projects, or asks "do you remember...". Provides store, recall, browse, list, search, get, extract, update, forget, and stats on persistent agent memories.
trigger: /memory
---

# Memory Recall Skill

Persistent, per-agent long-term memory backed by LanceDB (vector + BM25 + graph).

## When to Use

- User asks about past conversations, decisions, or events
- User says "remember when...", "do you recall...", "earlier we talked about..."
- User mentions a project, task, or topic and you need context
- Before starting a new task, check if relevant memories exist with `memory_recall`
- When user wants to review everything about a project → `memory_browse`
- When analyzing new information before deciding to store → `memory_extract`

## Available Tools

### memory_recall
Semantic hybrid recall: vector + BM25 + graph cascade. Best for natural language queries.
```
query: "what did the user tell me about their project deadline"
max_results: 3
```
Returns scored memories with relevance scores. Access count is tracked.

### memory_browse
Browse memories by conversation/project or time range. Best for reviewing a whole project context.
```
conversation_id: "proj-alpha-2026"
# OR time range:
since: "2026-04-01T00:00:00"
until: "2026-05-01T00:00:00"
summary_only: true  # conversation summaries instead of full list
limit: 50
```

### memory_search
Fast BM25/jieba keyword search. No embedding cost — good for quick keyword matches.
```
query: "deadline 深圳"
limit: 20
```

### memory_list
Paginated memory listing with filters.
```
category: "events"  # optional filter
conversation_id: "proj-alpha"  # optional
sort: "desc"  # or "asc"
limit: 20
offset: 0
```

### memory_get
Retrieve exact memory by ID.
```
memory_id: "abc-123-..."
```

### memory_extract
Analyze any text with LLM extraction to get structured fields (category, importance, 6W entities, temporal type) BEFORE deciding to store. Use to pre-filter.
```
content: "用户告诉我他们下周要去深圳出差"
```

### memory_store
Store a memory. Auto-extracts category, importance, 6W entities.
```
content: "用户计划5月15日去深圳出差3天"
conversation_id: "proj-alpha"  # optional
metadata: {}  # optional extra metadata
```

### memory_update
Update content or metadata of an existing memory.
```
memory_id: "abc-123-..."
content: "updated content here"
metadata: { "status": "done" }
```

### memory_forget
Delete a memory permanently.
```
memory_id: "abc-123-..."
```

### memory_stats
Storage statistics: count, categories, tiers, temporal types.
```
agent_id: "default"  # optional, omit for global
```

### memory_reset
DANGER: Permanently delete all memories for an agent.
```
agent_id: "default"
force: true  # required to confirm
```

## Memory Categories

`profile` — user personal info (name, location, job)
`preferences` — likes, dislikes, habits
`entities` — people, products, brands mentioned
`events` — things that happened
`cases` — problems solved, methods tried
`patterns` — recurring habits, schedules
`other` — uncategorized

## Tier System

Memories are auto-classified by importance:
- **core** (importance ≥ 0.7): immune to decay deletion
- **working** (0.4–0.7): normal priority
- **peripheral** (< 0.4): first to be pruned by decay scan

## Architecture

- LanceDB: vector + BM25 storage (`~/.memory-recall/data/{agent_id}/`)
- NetworkX graph: conversation edges, category overlap, temporal links
- bge-m3 embedding via Ollama
- LLM extraction: qwen2.5:7b via Ollama
- Decay engine: Weibull composite score (recency + frequency + importance)
- Compactor: cosine clustering merges similar stale memories

## Tips

- Store memories with conversation_id to enable `memory_browse` by project
- Use `memory_extract` before `memory_store` to preview what category/importance the system assigns
- `memory_recall` tracks access_count — frequently recalled memories resist decay
- `memory_browse` with `summary_only: true` is best for getting project overviews fast
- Decay scan runs every 24h (configurable via decayIntervalHours) and protects core memories
