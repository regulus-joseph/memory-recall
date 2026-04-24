# memory-recall 功能对比分析

> 文档版本：v1.0
> 日期：2026-04-24
> 比对项目：MemPalace、memory-lancedb-pro（MLP）、memory-recall（改造前）

---

## 总览

| 维度 | MemPalace | MLP (memory-lancedb-pro) | memory-recall (现状) |
|------|-----------|--------------------------|-------------------|
| **定位** | Claude Code / Codex MCP 外挂 | OpenClaw 插件，填入 memory slot | OpenClaw 插件，未接入 slot |
| **存储后端** | ChromaDB + SQLite KG | LanceDB + FTS | Qdrant |
| **检索架构** | L0/L1/L2/L3 分层注入 | Hybrid（Vector + BM25 + Rerank） | L1/L2/L3 cascade（实现有 bug） |
| **工具数** | 27 个 MCP tools | ~13 个 tools | 1 个（`recall_memories`） |
| **Hook 数** | 3 个（Claude Code hooks） | 15+ 个（OpenClaw hooks） | 3 个（有 bug） |
| **CLI** | `mempalace` | `openclaw memory-pro` | `python -m memory_recall.cli` |
| **Graph** | 有（SQLite KG + tunnels） | 无独立图谱 | L3 是 stub，graph_edges 未填充 |
| **Entity 提取** | AAAK dialect + 实体检测 | Smart extraction（LLM） | 6W regex（extractor.py，未在 TS 使用） |
| **Agent 隔离** | wing/room/hall 多层 | scope（global/agent/session） | agent_id 字段（未隔离查询） |
| **遗忘机制** | delete + kg_invalidate | forget + archive + compact | delete（Qdrant delete API 有 bug） |

---

## 1. 存储后端对比

| | MemPalace | MLP | memory-recall |
|--|-----------|-----|--------------|
| **向量库** | ChromaDB（hnsw, cosine） | LanceDB（ANN + FTS） | Qdrant（hnsw, cosine） |
| **KG 存储** | SQLite | 无（用 scope 代替） | 无 |
| **Graph 存储** | JSON（tunnels.json） | 无 | payload 内 graph_edges（未填充） |
| ** WAL** | ~/.mempalace/wal/write_log.jsonl | 无 | 无 |
| **批量写入** | bulk upsert | bulkStore + proper-lockfile | 单条 PUT |
| **后端可替换** | 是（BaseBackend 接口） | 否 | 否 |

**memory-recall 问题：**
- Qdrant delete API 用法错误：`points_selector=[memory_id]` 应为 `PointIdsList(points=[memory_id])`
- scroll 返回 payload 丢失 point ID（ID 不在 payload 里）
- 无连接池，每次 recall 新建 QdrantClient

---

## 2. 检索 cascade 对比

### MemPalace（分层加载，非 cascade）

```
wake-up 时：
  L0: ~/.mempalace/identity.txt  → ~100 tokens（始终加载）
  L1: ChromaDB top-15 importance 排序  → ~500-800 tokens（始终加载）
  L2: 按 wing/room 过滤 ChromaDB  → ~200-500 tokens（按需）
  L3: 全文向量检索  → 无限制（按需）

搜索时：BM25 + 向量混合排序
  drawer hits → closet boost
```

### MLP（向量 + BM25 + Cross-Encoder）

```
1. Vector Search (cosine, 20x over-fetch)
2. BM25 Search (LanceDB FTS)
3. RRF Fusion: score = 0.7*vector + 0.3*bm25
4. Cross-Encoder Rerank（可选）
5. Post-processing:
   - recency boost
   - importance weight
   - length norm
   - time decay
   - noise filter
   - MMR diversity
```

### memory-recall（现状 L1/L2/L3 有 bug）

```
当前（错误）：
  L1: keyword Jaccard（从 scroll 全量数据）
  L2: vector cosine（embedding）
  L3: graph edge traversal（条件触发）

计划（改造后）：
  L1: embedding 向量检索
  L2: BM25 关键词检索
  L3: graph 关联扩展（graphify）
```

**memory-recall L1/L2/L3 关键 bug：**
- `_fetch_all_candidates()` 从 Qdrant scroll 全量拉回数据（无 filter，无 limit）
- scroll 返回 payload 不含 point ID → L1 filter 用 `c["id"]` 永远匹配不上 → **L1 结果永远为空**
- `l1_results` 为空直接传给 L2 → L2 对空列表操作
- L2 embedding 逐条串行调用 Ollama（1000 条 = 1000 次 HTTP）
- L3 条件触发但 graph_edges 未填充 → 几乎不生效

---

## 3. 工具对比

### MemPalace（27 个 MCP tools）

**读取类（15 个）：**
- `mempalace_search` — 语义检索
- `mempalace_get_drawer` / `mempalace_list_drawers` — 按 ID/分页
- `mempalace_traverse` — BFS 图遍历
- `mempalace_find_tunnels` — 找跨 wing 桥梁
- `mempalace_kg_query` / `kg_timeline` / `kg_stats` — 知识图谱查询
- `mempalace_diary_read` — 日记读取
- `mempalace_status` / `list_wings` / `list_rooms` / `get_taxonomy` — 元信息
- `mempalace_graph_stats` / `follow_tunnels` / `check_duplicate` / `memories_filed_away` — 工具

**写入类（8 个）：**
- `mempalace_add_drawer` — 添加记忆抽屉
- `mempalace_delete_drawer` / `update_drawer` — 删除/更新
- `mempalace_kg_add` / `kg_invalidate` — KG 增/删
- `mempalace_diary_write` — 写日记
- `create_tunnel` / `delete_tunnel` — 建/删 tunnel
- `reconnect` — 重连 ChromaDB

### MLP（~13 个 tools）

**核心 tools（始终启用）：**
| 工具 | 功能 |
|------|------|
| `memory_recall` | 混合检索召回 |
| `memory_store` | 存储记忆（含去重/超新版本/6-category） |
| `memory_forget` | 按 ID/查询删除 |
| `memory_update` | 更新记忆内容 |

**管理 tools（enableManagementTools）：**
| 工具 | 功能 |
|------|------|
| `memory_stats` | 统计（数量/分布） |
| `memory_debug` | 检索 pipeline trace |
| `memory_list` | 分页列表 |
| `memory_promote` | 提升为 confirmed/durable |
| `memory_archive` | 归档（state=archived） |
| `memory_compact` | 压缩合并重复记忆 |
| `memory_explain_rank` | 解释排名原因 |

**自我改进 tools：**
| 工具 | 功能 |
|------|------|
| `self_improvement_log` | 记录学习/错误到 .learnings |
| `self_improvement_extract_skill` | 从 learning 提取 skill scaffold |
| `self_improvement_review` | 回顾 governance backlog |

### memory-recall（现状 1 个）

| 工具 | 功能 |
|------|------|
| `recall_memories` | 向量检索（简化版，未调用 cascade） |

**缺失：** 无 store / forget / update / stats / list / debug

---

## 4. Hook 对比

### MemPalace（Claude Code hooks，3 个）

| Hook | 时机 | 功能 |
|------|------|------|
| `mempal_precompact_hook.sh` | context compaction 前 | 自动挖掘 transcript，触发紧急保存 |
| `mempal_save_hook.sh` | 每 15 条人类消息 | 静默模式直接写 MCP，verbose 模式阻塞通知 |
| `hook_session_start` | session 开始 | 初始化 session 跟踪状态 |

### MLP（OpenClaw hooks，15+ 个）

| Hook | 时机 | 功能 | 优先级 |
|------|------|------|--------|
| `message_received` | 收到消息 | 缓存 ingress 映射 | default |
| `before_message_write` | 消息写入前 | 调试日志 | default |
| `before_prompt_build` | prompt 构建前 | **Auto-Recall**（完整 pipeline + adaptive） | 10 |
| `before_prompt_build` | prompt 构建前 | **Reflection-Inheritance** | 12 |
| `before_prompt_build` | prompt 构建前 | **Reflection-Derived** | 15 |
| `session_end` | session 结束 | 清理 recallHistory / reflection 缓存 | 10/20 |
| `agent_end` | agent 结束 | **Auto-Capture**（fire-and-forget） | default |
| `after_tool_call` | tool 调用后 | 捕获错误信号到 reflection | 15 |
| `before_reset` | reset 前 | system session memory 存档 | default |
| `gateway_start` | gateway 启动 | 自动 compaction | default |
| `command:new` | /new 命令 | 完整 reflection pipeline | — |
| `command:reset` | /reset 命令 | 完整 reflection pipeline | — |
| `agent:bootstrap` | agent 启动 | 注入 self-improvement reminder | — |
| `command:new` | /new 命令 | self-improvement 引导 | — |

### memory-recall（现状 3 个，有 bug）

| Hook | 时机 | 功能 | 问题 |
|------|------|------|------|
| `message_received` | 收到消息 | 存到 Qdrant | TS 未用 extractor，无 6W 提取 |
| `agent_end` | agent 结束 | 存 assistant 消息 | 同上 |
| `before_agent_start` | agent 启动前 | auto-recall | **事件名错误**，应为 `before_prompt_build` |

**另有：** `src/openclaw/interceptor.py` 有 `before_prompt_build` hook（Python），但与 TS 版本并存，未统一。

---

## 5. Payload 结构对比

### MemPalace

```
Drawer (ChromaDB):
{
  content: string,
  wing: string,      // project/person
  room: string,       // aspect/topic
  hall: string,       // corridor category
  source_file: string,
  chunk_index: number,
  added_by: "mcp",
  filed_at: ISO8601,
  date: "YYYY-MM-DD"
}

Drawer ID: drawer_{wing}_{room}_{sha256(wing+room+content)[:24]}

KG Triple (SQLite):
{
  subject, predicate, object,
  valid_from, valid_to,
  confidence, source_closet,
  source_drawer_id
}
```

### MLP

```
MemoryEntry (LanceDB):
{
  id: UUID,
  text: string,
  vector: float[],
  category: preference|fact|decision|entity|reflection|other,
  scope: string,       // global|agent:{id}|session:{id}|...
  importance: 0-1,
  timestamp: ms_epoch,
  metadata: JSON (L0_abstract, L1_overview, L2_content, state, memory_layer, access_count, bad_recall_count, ...)
}
```

### memory-recall

```
Qdrant Point:
{
  vector: float[1024],
  payload: {
    content: string,
    category: "preference"|"fact"|"decision"|"entity"|"other"|"reflection",  // TS 未填
    6w: { who, what, when, where, why, how },  // TS 未填，extractor.py 有但未调用
    agent_id: string,
    scope: string,
    importance: 0-1,
    stored_at: ISO8601,
    graph_edges: [],  // 从未填充
    state: "confirmed",
    access_count: 0,
    last_accessed: ISO8601,
    role: "user"|"assistant",  // TS auto-store 专用
    sender: string,
    channel_id: string,
    conversation_id: string
  }
}
```

---

## 6. Agent 隔离对比

| | MemPalace | MLP | memory-recall |
|--|-----------|-----|--------------|
| **隔离维度** | wing / room / hall 三层 | scope: global / agent:{id} / session:{id} | agent_id 字段（未实现过滤） |
| **访问控制** | wing/room metadata filter | ScopeManager.isAccessible() | 无 |
| **默认 scope** | wing=user-provided | agent:{agentId} | 无 |

---

## 7. 遗忘机制对比

| | MemPalace | MLP | memory-recall |
|--|-----------|-----|--------------|
| **删除** | delete_drawer（物理删除） | delete（物理） | Qdrant delete（有 bug） |
| **软删** | kg_invalidate（valid_to=今天） | archive（state=archived） | 无 |
| **压缩** | compress（AAAK 压缩） | memory_compact（相似度聚类归档） | 无 |
| **去重** | idempotent SHA ID | vector similarity pre-check | 无 |

---

## 8. 关键发现总结

### memory-recall 现状的核心问题

| 优先级 | 问题 | 影响 |
|--------|------|------|
| **P0** | L1 Jaccard 用 `c["id"]` 但 scroll payload 不含 ID | L1 结果永远为空 |
| **P0** | L2 逐条 embedding（1000 candidates = 1000 HTTP） | recall 超慢 |
| **P0** | Qdrant delete API 格式错误 | forget 工具不可用 |
| **P0** | TS 用 `before_agent_start`，应为 `before_prompt_build` | Hook 不触发 |
| **P1** | TS auto-store 未调用 extractor.py | 无 6W / category 字段 |
| **P1** | graph_edges 从未填充 | L3 形同虚设 |
| **P1** | TS 未注册 stub registerMemoryRuntime | doctor 检查不过 |
| **P2** | ID 用 Date.now()（毫秒级冲突） | 多消息可能覆盖 |
| **P2** | TS 硬编码 embedding URL | config.baseURL 被忽略 |

### 功能差距

| 功能 | MLP 有 | memory-recall 缺 |
|------|--------|-----------------|
| 多工具 | ~13 个 | 1 个 |
| store / forget / update | 是 | 缺 |
| BM25 检索 | 是（LanceDB FTS） | TS 缺（Python 有但 L2 是向量） |
| Cross-Encoder Rerank | 是 | 缺 |
| 自我改进 tools | 是 | 缺 |
| compaction / archive | 是 | 缺 |
| reflection pipeline | 是 | 缺 |
| scope 隔离 | 是 | 形同虚设 |
| 管理 CLI | 是 | 缺 |
| 存储抽象层 | 否 | 否（硬编码 Qdrant） |

---

## 9. 最终架构决策（2026-04-24）

### 方案选定：Python HTTP Service + TS Plugin（方案 B）

经过讨论，决定采用 **Python 层** 作为原型路径，原因：
1. **完整性**：Python 有 jieba（中文分词）、rank_bm25、networkx（graphify），TS 无对等替代
2. **可调试**：graphify 提供可视化图，调试 graph 关系直观
3. **LLM extraction**：6W + category 提取在 Python 侧调用 Ollama 更自然
4. **先验证后优化**：原型用 Python 验证 cascade + graph 价值，验证有效后考虑 TS 化

### 最终架构

```
memory-recall (改造后)
  ├── TypeScript plugin (OpenClaw)
  │     ├── 4 核心 tools (recall/store/forget/update)
  │     ├── 3 hooks (message_received / agent_end / before_prompt_build)
  │     └── stub registerMemoryRuntime
  │
  └── Python service (src/server.py)
        ├── L1: vector embedding search (Qdrant)
        ├── L2: BM25 + jieba keyword search
        ├── L3: graphify graph expansion
        ├── BM25 index (file: bm25_index.json)
        ├── graph (file: memory_graph.json)
        └── LLM extraction (Ollama): 6W + category
```

### 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 向量存储 | Qdrant | 用户已有，无需迁移 |
| BM25 + 分词 | Python jieba + rank_bm25 | 中文支持完整 |
| Graph | Python graphify (networkx) | 可视化调试方便 |
| LLM 调用 | Python 调用 Ollama | 6W / category 提取 |
| 插件层 | TS plugin (OpenClaw) | 接入 OpenClaw 生态 |

### 改造优先级

```
v0.2.0（Phase 1 - Python HTTP Service）：
  P0:
    1. 新建 src/server.py（/recall, /store, /forget, /update HTTP API）
    2. 修 Qdrant API bug（delete / scroll ID）
    3. 迁移 src/core/matcher.py 的 L1/L2/L3 到 server.py
    4. 新建 BM25 index（jieba + rank_bm25）
  P1:
    5. 重写 src/index.ts（4 tools 调用 server.py HTTP）
    6. 修 TS hook 事件名 + 注册 stub
    7. 实现 LLM 提取 6W + category（Ollama 调用）

v0.3.0（Phase 2 - Graph + Compaction）：
  8. graphify 集成（L3 graph expansion + 可视化）
  9. 实现 compaction Hook（before_compaction + graph 更新）
  10. graph_edges 填充逻辑（session 共现 + recall 共现）
  11. BM25 index 增量更新

v0.4.0（Phase 3 - 功能完善）：
  12. 管理 tools（stats/debug/list）
  13. scope 隔离实现
  14. agent_id 过滤
  15. CLI 命令完善
```

---

## 10. 改造优先级建议
