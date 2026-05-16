# Graph Report - /home/marlon-wei/projects/memory-recall  (2026-04-24)

## Corpus Check
- Corpus is ~16,504 words - fits in a single context window. You may not need a graph.

## Summary
- 283 nodes · 624 edges · 13 communities detected
- Extraction: 69% EXTRACTED · 31% INFERRED · 0% AMBIGUOUS · INFERRED: 192 edges (avg confidence: 0.64)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Graph Store|Graph Store]]
- [[_COMMUNITY_Retrieval Pipeline|Retrieval Pipeline]]
- [[_COMMUNITY_CLI|CLI]]
- [[_COMMUNITY_L3 Graph Matcher|L3 Graph Matcher]]
- [[_COMMUNITY_StorageWorker|Storage/Worker]]
- [[_COMMUNITY_BM25 Index|BM25 Index]]
- [[_COMMUNITY_Dict Maintenance|Dict Maintenance]]
- [[_COMMUNITY_Entity Extractor|Entity Extractor]]
- [[_COMMUNITY_OpenClaw Interceptor|OpenClaw Interceptor]]
- [[_COMMUNITY_Rule Extractor|Rule Extractor]]
- [[_COMMUNITY_Test Hook|Test Hook]]
- [[_COMMUNITY_Index Server|Index Server]]
- [[_COMMUNITY_Smoke Test|Smoke Test]]

## God Nodes (most connected - your core abstractions)
1. `MemoryMatcher` - 27 edges
2. `GraphStore` - 26 edges
3. `KeywordMatcher` - 25 edges
4. `QdrantStore` - 25 edges
5. `BM25Index` - 25 edges
6. `OllamaEmbedding` - 25 edges
7. `MemoryStorage` - 21 edges
8. `LLMExtractor` - 18 edges
9. `VectorMatcher` - 15 edges
10. `store()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Register the before_prompt_build hook with OpenClaw` --uses--> `MemoryMatcher`  [INFERRED]
  /home/marlon-wei/projects/memory-recall/src/openclaw/interceptor.py → /home/marlon-wei/projects/memory-recall/src/core/matcher.py
- `Create the hook handler function` --uses--> `MemoryMatcher`  [INFERRED]
  /home/marlon-wei/projects/memory-recall/src/openclaw/interceptor.py → /home/marlon-wei/projects/memory-recall/src/core/matcher.py
- `Format memories for injection into prompt context` --uses--> `MemoryMatcher`  [INFERRED]
  /home/marlon-wei/projects/memory-recall/src/openclaw/interceptor.py → /home/marlon-wei/projects/memory-recall/src/core/matcher.py
- `L2: Vector similarity matching via Ollama embeddings` --uses--> `OllamaEmbedding`  [INFERRED]
  /home/marlon-wei/projects/memory-recall/src/core/l2_vector.py → /home/marlon-wei/projects/memory-recall/src/utils/ollama_client.py
- `Match query against candidates by vector similarity         Returns: list of (me` --uses--> `OllamaEmbedding`  [INFERRED]
  /home/marlon-wei/projects/memory-recall/src/core/l2_vector.py → /home/marlon-wei/projects/memory-recall/src/utils/ollama_client.py

## Communities

### Community 0 - "Graph Store"
Cohesion: 0.08
Nodes (27): ForgetRequest, _async_extraction_and_update(), update(), Delete a memory from Qdrant, BM25 index, and graph, Background: extract 6w/category and update payload., Memory Graph Store - lightweight graph using networkx File-based persistence: me, LLMExtractor, Build edges to memories with same category within time window. (+19 more)

### Community 1 - "Retrieval Pipeline"
Cohesion: 0.07
Nodes (29): Test L2 vector matching, Test L1 keyword matching, Extract all entity types, setup_test_data(), GraphMatcher, KeywordMatcher, MemoryMatcher, Cascading L1/L2/L3 memory recall (+21 more)

### Community 2 - "CLI"
Cohesion: 0.13
Nodes (20): recall_cmd(), Recall relevant memories, Memory Recall CLI Tool Usage: python -m memory_recall.cli [command], init_cmd(), OllamaEmbedding, store_cmd(), Qdrant-backed memory storage with Ollama embeddings, MemoryStorage (+12 more)

### Community 3 - "L3 Graph Matcher"
Cohesion: 0.11
Nodes (11): Whitelist Manager for keyword filtering, Add multiple keywords, Remove keyword from whitelist, Manages keyword whitelist for memory recall filtering, Graph-based expansion of candidate memories         Returns: list of (memory_id,, Load whitelist from file, Save whitelist to file, Check if keyword is in whitelist (empty whitelist = allow all) (+3 more)

### Community 4 - "Storage/Worker"
Cohesion: 0.2
Nodes (15): client(), Qdrant Storage Module, Memory Recall Worker - consumes extraction tasks from JSONL file queue., read_queue(), update_qdrant(), _tokenize(), process_task(), enqueue() (+7 more)

### Community 5 - "BM25 Index"
Cohesion: 0.26
Nodes (2): BM25 Index with incremental update support. jieba tokenization, file-based persi, BM25Index

### Community 6 - "Dict Maintenance"
Cohesion: 0.27
Nodes (12): main(), check_memory(), get_user_dict_path(), save_user_dict(), tokenize(), Dictionary maintenance - uses LLM to validate and improve the jieba user diction, _get_tokenize(), jieba-based Chinese word segmentation. 内置词典覆盖常用词，用户词典（user_dict.txt）存储 LLM 发现的新词 (+4 more)

### Community 7 - "Entity Extractor"
Cohesion: 0.21
Nodes (7): Extract 6W entities from text, Extract entities using regex patterns, 6W Entity Extractor Extract Who, What, When, Where, Why, How from conversation c, EntityExtractor, Extract 6W entities from conversation text using regex patterns, Extract 'what' entities - action/event keywords, Extract entities from multiple conversation entries

### Community 8 - "OpenClaw Interceptor"
Cohesion: 0.33
Nodes (7): Format memories for injection into prompt context, register_hook(), Create the hook handler function, Register the before_prompt_build hook with OpenClaw, OpenClaw Hook Interceptor for memory-recall Hooks into before_prompt_build to in, create_hook_handler(), format_memory_context()

### Community 9 - "Rule Extractor"
Cohesion: 0.57
Nodes (6): extract(), _extract_6w(), _extract_category(), _tokenize(), _estimate_importance(), Rule-based memory extraction - no LLM, instant, synchronous. Uses lark-based Chi

### Community 10 - "Test Hook"
Cohesion: 0.6
Nodes (2): send(), main()

### Community 11 - "Index Server"
Cohesion: 0.6
Nodes (3): parsePluginConfig(), serverPost(), extractText()

### Community 12 - "Smoke Test"
Cohesion: 0.67
Nodes (1): testPlugin()

## Knowledge Gaps
- **26 isolated node(s):** `Build edges to memories with same category within time window.`, `L3: Graph-based associative matching`, `Graph-based expansion of candidate memories         Returns: list of (memory_id,`, `Check if L3 should be triggered based on L2 score`, `L1: Fast keyword matching using regex` (+21 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `BM25 Index`** (17 nodes): `._load()`, `._tokenize()`, `bm25_index.py`, `._may_rebuild()`, `BM25 Index with incremental update support. jieba tokenization, file-based persi`, `.force_rebuild()`, `._rebuild()`, `BM25Index`, `._fallback_tokenize()`, `.doc_count()`, `.__init__()`, `.remove()`, `.search()`, `bm25_index.py`, `.add()`, `._save()`, `.update_doc()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Test Hook`** (5 nodes): `test-hook.mjs`, `send()`, `.close()`, `test-hook.mjs`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Smoke Test`** (3 nodes): `smoke-test.mjs`, `testPlugin()`, `smoke-test.mjs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `store()` connect `Graph Store` to `CLI`, `L3 Graph Matcher`?**
  _High betweenness centrality (0.163) - this node is a cross-community bridge._
- **Why does `MemoryMatcher` connect `Retrieval Pipeline` to `OpenClaw Interceptor`, `CLI`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Why does `QdrantStore` connect `Graph Store` to `Test Hook`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Are the 17 inferred relationships involving `MemoryMatcher` (e.g. with `Memory Recall CLI Tool Usage: python -m memory_recall.cli [command]` and `Initialize Qdrant collection`) actually correct?**
  _`MemoryMatcher` has 17 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `GraphStore` (e.g. with `StoreRequest` and `UpdateRequest`) actually correct?**
  _`GraphStore` has 10 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `KeywordMatcher` (e.g. with `Memory Recall CLI Tool Usage: python -m memory_recall.cli [command]` and `Initialize Qdrant collection`) actually correct?**
  _`KeywordMatcher` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `QdrantStore` (e.g. with `StoreRequest` and `UpdateRequest`) actually correct?**
  _`QdrantStore` has 10 INFERRED edges - model-reasoned connections that need verification._