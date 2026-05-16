# Memory Systems Comparison: MLP vs MemPalace vs memory-recall

> Graphify analysis: 2026-04-24
> Sources: ~/sources/memory-lancedb-pro | ~/sources/mempalace | ~/projects/memory-recall

---

## 1. 规模

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **代码行数** | 18,040 行 TS | 16,776 行 PY | 3,348 行 PY+TS |
| **源文件数** | 45 | 42 | 40 |
| **Graph 节点** | 1,043 | 3,034 | 283 |
| **Graph 边** | 2,118 | 7,014 | 624 |
| **社区数** | 78 | 37 | 21 |
| **定位** | OpenClaw 插件 | Claude Code MCP | OpenClaw 插件 |

MLP 最大最重，mempalace 次之，memory-recall 是最小原型。

---

## 2. 存储后端

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **向量存储** | LanceDB (ANN+FTS) | ChromaDB (hnsw) | LanceDB (ANN+FTS) |
| **全文索引** | LanceDB FTS | ChromaDB | LanceDB FTS + jieba |
| **图谱存储** | 无 | SQLite KG + JSON tunnels | NetworkX → JSON |
| **元数据** | scope / category / importance | wing/room/hall / KG triples | agent_id / 6w / category |
| **后端可替换** | 否 | 是（BaseBackend 接口） | 否 |

---

## 3. 检索架构

### MLP
```
query → query-expander → vector search (LanceDB)
                              ↓
                         BM25 (LanceDB FTS)
                              ↓
                         RRF fusion (0.7*vector + 0.3*bm25)
                              ↓
                         Cross-Encoder rerank (可选)
                              ↓
                         Post: recency + importance + time_decay + noise_filter + MMR
```

### MemPalace
```
wake-up:
  L0: identity.txt (~100 tokens, always)
  L1: ChromaDB top-15 importance (~500-800 tokens)
  L2: wing/room filtered (~200-500 tokens)
  L3: full vector search (unlimited)

search:
  BM25 + vector hybrid → drawer hits boost closet
  BFS graph traversal (mempalace_traverse)
```

### memory-recall
```
recall:
  L1: Qdrant vector search (cosine, agent_id filter)
  L2: BM25 keyword search (jieba, agent post-filter)
  L3: Graph expansion (NetworkX, depth=2, word_overlap)

store:
  rule-extraction (jieba → category/6w) → sync, 0ms
  LLM extraction → disabled (synchronous rule instead)
```

---

## 4. 实体/关键词提取

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **方法** | SmartExtractor (LLM hook) | AAAK dialect + 实体检测 | rule-based (jieba + regex) |
| **分类** | 6 categories (preference/fact/decision/entity/reflection/other) | wing/room/hall 三层 | category + 6w |
| **重要性** | 0-1 浮点 | wing-based | 0-1 浮点 |
| **反思** | reflection pipeline (slices/metadata/ranking) | KG triples | 无 |

---

## 5. Agent 隔离

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **机制** | scope: global/agent:{id}/session:{id} | wing/room/hall 三层 | agent_id 字段 |
| **实现** | ScopeManager.isAccessible() | wing/room metadata filter | Qdrant filter + BM25 post-filter |
| **状态** | ✅ 完整实现 | ✅ 完整实现 | ⚠️ 有 filter 但有 legacy bug |

---

## 6. 自我改进机制

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **自我改进** | ✅ reflection pipeline | ❌ 无 | ❌ 无 |
| **自我学习** | self-improvement tools + .learnings | ❌ 无 | ❌ 无 |
| **压缩合并** | memory_compact | compress (AAAK) | ❌ 无 |
| **衰减机制** | decay-engine | ❌ 无 | ❌ 无 |
| **噪音过滤** | noise-prototypes + noise-filter | ❌ 无 | ❌ 无 |

---

## 7. 工具数

| | MLP | MemPalace | memory-recall |
|--|-----|-----------|---------------|
| **核心检索** | memory_recall | 15 个（search/get/traverse/kg_query/diary/...） | 1 个 |
| **写入** | memory_store | 8 个（add/kg_add/diary_write/tunnel/...） | 1 个 |
| **管理** | 6 个（stats/debug/list/promote/archive/compact） | 4 个 | 4 个 |
| **自我改进** | 3 个 | 0 个 | 0 个 |
| **总计** | ~13 | 27 | 6 |

---

## 8. Graphify 社区对比

### MLP (78 社区, top 10 节点)
1. `parseSmartMetadata` (35 边)
2. `buildSmartMetadata` (30 边)
3. `MemoryRetriever` (29 边)
4. `MemoryStore` (28 边)
5. `stringifySmartMetadata` (23 边)
6. `_initPluginState` (22 边)
7. `Embedder` (22 边)
8. `SmartExtractor` (21 边)
9. `MemoryScopeManager` (19 边)
10. `registerAllMemoryTools` (16 边)

→ 核心集中在 metadata 处理 + retrieval + embedding，模块化清晰。

### MemPalace (37 社区, top 10 节点)
1. `MempalaceConfig` (279 边) — 配置中枢
2. `ChromaBackend` (218 边)
3. `PalaceDataGenerator` (162 边)
4. `KnowledgeGraph` (160 边)
5. `BaseCollection` (132 边)
6. `Dialect` (121 边)
7. `ChromaCollection` (79 边)
8. `Layer1` (53 边)
9. `_patch_mcp_server` (52 边)
10. `load` (52 边)

→ 配置驱动的后端架构，KG 和 Chroma 是双核心。

### memory-recall (21 社区, top 10 节点)
1. `MemoryMatcher` (27 边)
2. `GraphStore` (26 边)
3. `KeywordMatcher` (25 边)
4. `QdrantStore` (25 边)
5. `BM25Index` (25 边)
6. `OllamaEmbedding` (25 边)
7. `MemoryStorage` (21 边)
8. `LLMExtractor` (18 边)
9. `VectorMatcher` (15 边)
10. `store` (14 边)

→ retrieval pipeline 是核心，但 metadata extraction 节点（LLMExtractor）孤立。

---

## 9. 核心差距分析

### memory-recall vs MLP

| 差距 | MLP 方案 | memory-recall 现状 |
|------|----------|-------------------|
| 检索融合 | RRF + Cross-Encoder rerank | 简单 score 融合，无 rerank |
| 自我改进 | reflection pipeline | 无 |
| 噪音过滤 | noise-prototypes | 无 |
| 时间衰减 | decay-engine | 无 |
| 压缩合并 | memory_compact | 无 |
| 工具数 | 13 个 | 6 个 |
| 隔离机制 | ScopeManager 完整实现 | agent_id filter 有 legacy bug |

### memory-recall vs MemPalace

| 差距 | MemPalace 方案 | memory-recall 现状 |
|------|----------------|-------------------|
| 图谱 | SQLite KG + BFS traversal | NetworkX JSON，边缘有限 |
| 分层注入 | L0/L1/L2/L3 分层加载 | L1/L2/L3 cascade，但 L3 薄弱 |
| 工具数 | 27 个 | 6 个 |
| 后端抽象 | BaseBackend 接口可替换 | 硬编码 Qdrant |
| 多语言 | 中文支持弱 | jieba 中文支持好 |
| MCP Server | mempalace MCP server | 无独立 MCP |

---

## 10. 各系统适用场景

| 系统 | 适合场景 |
|------|---------|
| **MLP** | 需要 OpenClaw 生态、完整自我改进、多 agent 隔离、生产级 |
| **MemPalace** | 需要 KG 图谱、多层分类、Claude Code 原生集成、中文支持不重要 |
| **memory-recall** | 轻量原型、中文优先、快速验证 cascade 价值、无外部依赖 |

---

## 11. 建议路径

```
当前: memory-recall (3,348 行, v2.2)
          ↓
Phase 1: 补齐 MLP 缺失的 rerank + noise filter (v2.3)
          + 修复 agent_id legacy bug
          ↓
Phase 2: 添加 reflection pipeline (MLP 的 self-improvement) (v3.0)
          ↓
Phase 3: 实现 memory_compact + decay (v3.1)
```
