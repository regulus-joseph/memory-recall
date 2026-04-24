# memory-recall 改造方案

> 文档版本：v1.0
> 最后更新：2026-04-24
> 负责人：marlon-wei
> 源码路径：~/projects/memory-recall

---

## 背景

OpenClaw 支持多 memory 插件，但 `slots.memory` 只能选一个作为默认召回装置。

**插件切换配置：**

```json5
{
  plugins: {
    slots: {
      memory: "memory-recall"  // 选择 memory-recall 作为默认记忆系统
    }
  }
}
```

**官方 memory 插件对照：**
- `memory-core` — 默认内置，工具名：`memory_search` / `memory_get`
- `memory-lancedb` — MLP（memory-lancedb-pro），工具名：`memory_recall` / `memory_store` / `memory_forget` / `memory_update`

**memory-recall 定位：** 成为 MLP 的替代品，工具名兼容 MLP，用户切换 `slots.memory` 即可无缝替换。

---

## 改造分为两个维度

| 维度 | 内容 | 优先级 |
|------|------|--------|
| 维度一 | 软件工程修改：修正错误的接口/注册方式 | P0 |
| 维度二 | 功能改进：L1/L2/L3 逻辑、payload、存储抽象等 | P1 |

---

## 维度一：软件工程修改

### 1.1 现状问题

| 文件 | 问题描述 | 影响 |
|------|----------|------|
| `src/index.ts` | Hook 用错事件（`before_agent_start` 而非 `before_prompt_build`） | Hook 不触发 |
| `src/index.ts` | auto-inject 方向错误：走 Hook 而非 Tool | 与 OpenClaw memory slot 机制不兼容 |
| `src/index.ts` | recall 是简化版实现 | 没有调用 Python L1/L2/L3 cascade |
| `src/core/matcher.py` | 有完整 cascade 但未被 TS 调用 | Python 能力浪费 |
| `src/openclaw/interceptor.py` | Python 侧 Hook interceptor | 未被使用，可删除 |

### 1.2 正确接入方式（参考 MLP）

**MLP 验证过的模式：**

1. 声明 `kind: "memory"` — 让插件可以被 slot 选中
2. 注册 stub `registerMemoryRuntime()` — 让 `openclaw doctor` 检查通过
3. 所有功能通过 **Tool** 提供 — agent 主动调用
4. 不依赖 Hook auto-inject — slot 切换时 tool 行为自动跟随

**关键代码模式（MLP index.ts:2167-2191）：**

```typescript
// Stub Memory Runtime（让 doctor 检查通过）
if (typeof api.registerMemoryRuntime === "function") {
  api.registerMemoryRuntime({
    async getMemorySearchManager(_params) {
      return {
        manager: {
          status: () => ({
            backend: "builtin" as const,
            provider: "memory-recall",
            embeddingAvailable: embedHealth.ok,
            retrievalAvailable: retrievalHealth,
          }),
          probeEmbeddingAvailability: async () => ({ ...embedHealth }),
          probeVectorAvailability: async () => retrievalHealth,
        },
      };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  });
}
```

**不需要实现完整的 `MemoryPluginCapability` 接口**，只需要一个 stub 满足检查即可。

### 1.3 目标架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                             │
├─────────────────────────────────────────────────────────────────┤
│  index.ts (TypeScript Plugin)                                    │
│  ├─ registerMemoryRuntime() → stub                              │
│  ├─ registerTool(memory_recall)                                 │
│  ├─ registerTool(memory_store)                                  │
│  ├─ registerTool(memory_forget)                                 │
│  └─ registerTool(memory_update)                                 │
│       │                                                         │
│       │ fetch() HTTP                                           │
│       ▼                                                         │
│  Python HTTP Service (src/server.py)                            │
│  ├─ GET /recall?query=...&limit=...                            │
│  ├─ POST /store {content, metadata}                            │
│  ├─ GET /ready                                                 │
│  └─ (future) /forget /update                                   │
│       │                                                         │
│       ▼                                                         │
│  src/core/matcher.py (L1/L2/L3 Cascade)                       │
│  ├─ L1: embedding 向量检索                                     │
│  ├─ L2: BM25 关键词检索                                        │
│  └─ L3: Graph 关联扩展                                          │
│       │                                                         │
│       ▼                                                         │
│  Storage Backend (Qdrant / LanceDB)                            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 Step 1：Python HTTP Service

**新建文件：** `src/server.py`

**依赖：** `aiohttp`

**端口：** 从 config 读取，默认 `18732`

**端点清单：**

| 端点 | 方法 | 参数 | 返回 |
|------|------|------|------|
| `/ready` | GET | - | `{"status": "ok"}` |
| `/recall` | GET | `query`, `limit` | 召回结果列表 |
| `/store` | POST | `content`, `metadata` | `{id, status}` |
| `/forget` | POST | `query` 或 `memory_id` | `{deleted, count}` |
| `/update` | POST | `memory_id`, `content` | `{id, status}` |

**实现要点：**

```python
# src/server.py
from aiohttp import web
from .matcher import MemoryMatcher

matcher = MemoryMatcher(config)

async def recall_handler(request):
    query = request.query.get("query", "")
    limit = int(request.query.get("limit", 10))
    results = await matcher.recall(query, max_results=limit)
    return web.json_response({"results": results})

async def store_handler(request):
    body = await request.json()
    memory_id = await matcher.store(body["content"], body.get("metadata", {}))
    return web.json_response({"id": memory_id, "status": "ok"})

app = web.Application()
app.router.add_get("/ready", lambda _: web.json_response({"status": "ok"}))
app.router.add_get("/recall", recall_handler)
app.router.add_post("/store", store_handler)
```

**生命周期管理：** 通过 `registerService()` 在 TS 侧管理进程启动/停止。

### 1.5 Step 2：重写 TypeScript 插件

**修改文件：** `src/index.ts`（完全重写）

**删除内容：**
- `before_agent_start` Hook 及 auto-inject 逻辑
- `message_received` / `agent_end` Hook
- 简化版 `recallMemories()` 函数

**新增内容：**

```typescript
// 1. registerMemoryRuntime stub（让 doctor 通过）
api.registerMemoryRuntime({
  async getMemorySearchManager(_params) {
    return { manager: { status: () => ({ backend: "builtin", provider: "memory-recall" }) } }
  },
  resolveMemoryBackendConfig() { return { backend: "builtin" } },
})

// 2. registerService（管理 Python HTTP service）
api.registerService({
  id: "memory-recall-service",
  start: async () => {
    const child = spawn("python", ["-m", "memory_recall.server"], {
      stdio: ["pipe", "pipe", "inherit"]
    })
    await waitForUrl(`${SERVICE_URL}/ready`)
    return child
  },
  stop: async (child) => { child.kill() }
})

// 3. registerTool（4 个核心工具）
api.registerTool(createRecallTool(), { name: "memory_recall" })
api.registerTool(createStoreTool(), { name: "memory_store" })
api.registerTool(createForgetTool(), { name: "memory_forget" })
api.registerTool(createUpdateTool(), { name: "memory_update" })
```

### 1.6 Step 3：工具定义详细设计

#### memory_recall

```typescript
name: "memory_recall"
description: `Search through long-term memories using hybrid retrieval.
Use when:
- User asks about something you discussed before
- User mentions a preference, decision, or fact you should know
- You are unsure about a previous conversation context
- User asks what you remember about X
Do NOT use for general reasoning, current tasks, or facts you should know.`
parameters:
  query: string (required) — "Search query to find relevant memories"
  limit: number (optional, default=5, max=20) — "Max results to return"
  scope: string (optional) — "Specific memory scope to search in"
  category: enum (optional) — preference|fact|decision|entity|reflection|other
execute:
  1. fetch GET /recall?query=...&limit=...
  2. parse results
  3. format output with relevance scores
  4. track access (patch last_accessed_at)
return format:
  Found N memories:
  1. [preference] content... (relevance: 85%)
  2. [decision] content... (relevance: 72%)
```

#### memory_store

```typescript
name: "memory_store"
description: `Save important information to long-term memory.
Use when:
- User explicitly asks you to remember something
- User corrects you about a preference or fact
- You discover something important about the user or project
- User says "记得..." or "记住..."
Format: clear, concise statements of what to remember.`
parameters:
  text: string (required) — "Information to remember"
  importance: number (optional, default=0.7, range=0-1) — "Importance score"
  category: enum (optional, default=other) — preference|fact|decision|entity|reflection|other
  scope: string (optional) — "Memory scope, defaults to agent scope"
execute:
  1. fetch POST /store {content, metadata}
  2. LLM extraction runs server-side (extract 6W + category if not provided)
  3. store to Qdrant with vector
  4. return confirmation
return format:
  Stored: "content preview..." in scope 'global'
```

#### memory_forget

```typescript
name: "memory_forget"
description: `Delete specific memories.
Use when:
- User asks to forget or delete something
- User corrects a wrong memory
- User says "忘掉..." or "删除..."
Requires either query (search first) or memoryId (direct delete).`
parameters:
  query: string (optional) — "Search query to find memory to delete"
  memoryId: string (optional) — "Specific memory ID to delete"
  scope: string (optional) — "Scope to search/delete from"
execute:
  if memoryId:
    DELETE by id
  if query:
    recall first, then delete by ID
    if single result with score > 0.9: auto-delete
    else: return candidates list
return format:
  Memory {id} forgotten. OR
  Found N candidates. Specify memoryId to delete:
  1. [id] content...
```

#### memory_update

```typescript
name: "memory_update"
description: `Update an existing memory's content.
Use when:
- User asks to update or change something in memory
- A stored fact has changed and needs correction
- User says "更新记忆..." or "修改..."`
parameters:
  memoryId: string (required) — "Memory ID to update"
  text: string (required) — "New content"
  importance: number (optional) — "Updated importance score"
  category: enum (optional) — preference|fact|decision|entity|reflection|other
execute:
  1. fetch POST /update {memory_id, content, metadata}
  2. re-compute embedding
  3. update in Qdrant
return format:
  Updated memory {id}: "new content preview..."
```

### 1.7 Step 4：configSchema 更新

```typescript
// openclaw.plugin.json configSchema 调整
{
  "qdrant": {
    "type": "object",
    "properties": {
      "host": { "type": "string", "default": "localhost" },
      "port": { "type": "integer", "default": 6333 },
      "collection": { "type": "string", "default": "memory_recall" }
    }
  },
  "embedding": {
    "type": "object",
    "properties": {
      "baseURL": { "type": "string", "default": "http://localhost:11434" },
      "model": { "type": "string", "default": "bge-m3" },
      "dimensions": { "type": "integer", "default": 1024 }
    }
  },
  "pythonService": {
    "type": "object",
    "properties": {
      "port": { "type": "integer", "default": 18732 },
      "host": { "type": "string", "default": "localhost" },
      "timeoutMs": { "type": "integer", "default": 10000 }
    }
  },
  "storage": {
    "type": "object",
    "properties": {
      "backend": { "type": "string", "enum": ["qdrant", "lancedb"], "default": "qdrant" }
    }
  },
  "enableTools": {
    "type": "object",
    "properties": {
      "store": { "type": "boolean", "default": true },
      "forget": { "type": "boolean", "default": true },
      "update": { "type": "boolean", "default": true }
    }
  },
  "l1": { "type": "object", "properties": { "enabled": { "type": "boolean", "default": true } } },
  "l2": { "type": "object", "properties": { "enabled": { "type": "boolean", "default": true }, "minScore": { "type": "number", "default": 0.3 } } },
  "l3": { "type": "object", "properties": { "enabled": { "type": "boolean", "default": true }, "triggerThreshold": { "type": "number", "default": 0.6 } } }
}
```

### 1.8 文件改动清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/server.py` | Python HTTP 服务入口 |
| 新建 | `src/storage/interface.py` | 统一存储接口 |
| 新建 | `src/storage/qdrant_impl.py` | Qdrant 实现 |
| 新建 | `src/storage/lancedb_impl.py` | LanceDB 实现（待实现） |
| 新建 | `src/extractor/llm_extractor.py` | LLM 提取 6W + category |
| 重写 | `src/index.ts` | 完全重写，正确的注册方式 |
| 修改 | `openclaw.plugin.json` | 更新 configSchema |
| 删除 | `src/openclaw/interceptor.py` | 不再需要 |

---

## 维度二：功能改进

### 2a. L1/L2/L3 Cascade 调整

**当前设计（错误）：**
```
L1: keyword → L2: vector → L3: graph
```

**调整后（正确）：**
```
L1: vector embedding → L2: BM25 keyword → L3: graph
```

**理由：**
- 向量检索先快速召回语义相关结果（语义相似度高但词不匹配也能召回）
- BM25 在候选集上做精细关键词匹配
- Graph 在 L2 结果置信度低时触发，扩展关联节点

**详细流程：**

```
输入: query string
  │
  ├─ L1: embedding(vector)
  │     用 Ollama bge-m3 生成 query 向量
  │     Qdrant cosine similarity 搜索 top-K
  │     输出: candidate_ids + vector_scores
  │
  ├─ L2: BM25 keyword
  │     jieba 分词 (中文) / nltk word_tokenize (英文)
  │     计算 query 对每个 candidate 的 BM25 得分
  │     合并 L1 + L2 得分: score = α*L1_score + β*L2_score
  │     α=0.6, β=0.4（可配置）
  │     过滤: minScore < 0.3 → 丢弃
  │     输出: ranked candidates + combined_scores
  │
  └─ L3: graph expansion (条件触发)
        触发条件: top-1 score < triggerThreshold (默认 0.6)
        使用记忆节点 graph（6W + category 关系）
        扩展: 相关联的节点加入候选
        重排序后输出
```

**代码位置：** `src/core/matcher.py` 需要大改，从零实现正确的 cascade。

### 2b. Graph Payload 结构

**设计原则：**
- Graph nodes/edges 存储在 Qdrant payload 中（不单独建图库）
- 使用 6W + MLP 6-category 作为节点属性
- Graph 关系通过 payload 中的 `graph_edges` 字段表达

**MLP 6 Category：**

| category | 说明 | 示例 |
|----------|------|------|
| `preference` | 用户偏好 | "用户喜欢用 zsh" |
| `fact` | 事实性陈述 | "服务器在东京" |
| `decision` | 决策结论 | "我们决定用 PostgreSQL" |
| `entity` | 实体 | "张三是项目经理" |
| `reflection` | 反思总结 | "发现这个方案有性能问题" |
| `other` | 其他 | - |

**MR 6W：**

| 字段 | 说明 | 来源 |
|------|------|------|
| `who` | 谁相关 | LLM 提取 |
| `what` | 做了什么/是什么 | LLM 提取 |
| `when` | 时间 | LLM 提取或 auto |
| `where` | 地点 | LLM 提取 |
| `why` | 原因/动机 | LLM 提取 |
| `how` | 方式/方法 | LLM 提取 |

**Qdrant Point Payload 结构：**

```json
{
  "content": "用户偏好使用 zsh 因为它的自动补全功能更强",
  "category": "preference",
  "6w": {
    "who": "用户",
    "what": "偏好使用 zsh",
    "when": "unknown",
    "where": "terminal",
    "why": "自动补全功能更强",
    "how": "配置 .zshrc"
  },
  "agent_id": "main",
  "scope": "global",
  "importance": 0.8,
  "stored_at": "2026-04-24T10:00:00Z",
  "graph_edges": [
    {"source": "uuid_current", "target": "uuid_related", "relation": "caused_by", "relation_type": "preference→decision"}
  ],
  "graph_tags": ["shell", "terminal", "configuration"],
  "state": "confirmed",
  "access_count": 0,
  "last_accessed_at": null,
  "invalidated_at": null,
  "superseded_by": null
}
```

### 2c. LLM 提取 6W + Category

**触发时机：** `memory_store` 时自动调用

**LLM 调用方式：** 通过 `api.runtime.subagent.run()` 调起 OpenClaw 内置 subagent

**具体流程：**

```
TypeScript: memory_store tool execute()
  → HTTP POST /store {content, metadata}
    → Python: store_handler()
      → LLM extraction:
        subagent.run({
          prompt: EXTRACTION_PROMPT,
          disableTools: true,
          timeoutMs: 5000
        })
      → 得到 {category, 6w}
      → 存入 Qdrant
```

**Extraction Prompt：**

```
You are a memory structuring assistant. Extract structured information from the given text.

Input: "${text}"

Output a valid JSON object with this exact structure:
{
  "category": "preference|fact|decision|entity|reflection|other",
  "6w": {
    "who": "extracted who is involved, or 'unknown'",
    "what": "extracted what happened or what is the statement, or 'unknown'",
    "when": "extracted time/date if mentioned, or 'unknown'",
    "where": "extracted location if mentioned, or 'unknown'",
    "why": "extracted reason/motivation if mentioned, or 'unknown'",
    "how": "extracted method/manner if mentioned, or 'unknown'"
  }
}

Rules:
- category must be exactly one of: preference, fact, decision, entity, reflection, other
- 6w fields must be concise (max 50 chars each)
- If information is not available, use "unknown"
- Return ONLY the JSON object, no explanation
```

**Fallback：** 如果 LLM extraction 失败，使用 `category=other`，6w 全为 `unknown`。

**实现位置：** `src/extractor/llm_extractor.py`

### 2d. 存储抽象层

**背景：** 当前硬编码 Qdrant，需要支持切换到 LanceDB。

**统一接口设计：**

```python
# src/storage/interface.py
from abc import ABC, abstractmethod

class StorageBackend(ABC):
    @abstractmethod
    async def init(self, config: dict) -> None:
        """Initialize collection/schema"""
        pass

    @abstractmethod
    async def store(self, point: dict) -> str:
        """Store a memory point, return id"""
        pass

    @abstractmethod
    async def search_vector(self, query_vector: list[float], limit: int, score_threshold: float | None) -> list[dict]:
        """Vector similarity search"""
        pass

    @abstractmethod
    async def search_bm25(self, query: str, limit: int) -> list[dict]:
        """BM25 keyword search"""
        pass

    @abstractmethod
    async def get(self, memory_id: str) -> dict | None:
        """Get by id"""
        pass

    @abstractmethod
    async def update(self, memory_id: str, data: dict) -> bool:
        """Update a memory"""
        pass

    @abstractmethod
    async def delete(self, memory_id: str) -> bool:
        """Delete by id"""
        pass

    @abstractmethod
    async def scroll(self, limit: int, offset: str | None) -> tuple[list[dict], str | None]:
        """Paginate all memories"""
        pass
```

**工厂模式：**

```python
# src/storage/factory.py
from .qdrant_impl import QdrantStorage
from .lancedb_impl import LanceDBStorage

def create_storage(backend: str, config: dict) -> StorageBackend:
    if backend == "qdrant":
        return QdrantStorage(config)
    elif backend == "lancedb":
        return LanceDBStorage(config)
    else:
        raise ValueError(f"Unknown storage backend: {backend}")
```

**配置文件：**

```json5
{
  "storage": {
    "backend": "qdrant",  // "qdrant" | "lancedb"
    "qdrant": {
      "host": "localhost",
      "port": 6333,
      "collection": "memory_recall"
    },
    "lancedb": {
      "path": "~/.openclaw/memory-recall.lancedb",
      "table": "memories"
    }
  }
}
```

### 2e. Graph 更新机制

**触发时机：** OpenClaw `before_compaction` / `after_compaction` Hook

**目的：** 定期更新记忆之间的关联关系（6W + category）

**流程：**

```
OpenClaw compaction 运行
  → index.ts: before_compaction Hook 触发
    → 调用 Python /graph-update 端点
      → 读取近期 N 条记忆（scroll Qdrant）
      → 调用 graphify 构建关系：
        graphify.analyze(memories)
        → 提取实体、关系、因果链
      → 更新 Qdrant 中的 graph_edges 字段
```

**触发策略：**

| 策略 | 条件 | 说明 |
|------|------|------|
| 增量 | 每次 compaction | 只处理上次之后新增的记忆 |
| 全量 | 每 10 次 compaction | 重建完整图谱 |

**graphify 集成：** 使用 `~/vault/graphify/` 的能力，参考其 SKILL.md。

**关键代码：**

```typescript
// index.ts
api.on("before_compaction", async (event) => {
  const resp = await fetch(`${SERVICE_URL}/graph-update`, {
    method: "POST",
    body: JSON.stringify({ mode: "incremental" })
  })
  const result = await resp.json()
  api.logger.info?.(`Graph updated: ${result.updated} nodes`)
})
```

### 2f. Agent 隔离

**方案：** 使用 `agent_id` 字段隔离，参考 MLP。

**Scope 层级：**

| scope | 说明 | 示例 |
|-------|------|------|
| `global` | 所有 agent 共享 | 系统配置、通用知识 |
| `agent:{id}` | 指定 agent 私有 | `agent:main` |
| `session:{id}` | 指定 session 私有 | `session:2026-04-24-xxx` |

**存储时的隔离：**

```json
{
  "content": "...",
  "agent_id": "main",    // 必填
  "scope": "global"      // 默认 global
}
```

**召回时的过滤：**

```python
def get_accessible_scopes(agent_id: str) -> list[str]:
    return [
        "global",
        f"agent:{agent_id}",
        # session scope 需要从上下文获取
    ]

# 查询时加 filter
filter_by_agent_scopes(get_accessible_scopes(agent_id))
```

### 2g. 遗忘机制

**待讨论。**

可能的方案：
1. **软删除**：标记 `invalidated_at` 时间戳，不物理删除
2. **硬删除**：直接从 Qdrant 删除 point
3. **层级遗忘**：按时间衰减自动降低 importance

---

## 工具 vs Hook 的职责划分

| 功能 | 实现方式 | Hook/端点 | 说明 |
|------|----------|-----------|------|
| recall | Tool | GET /recall | agent 主动调用，核心功能 |
| store | Tool | POST /store | agent 主动存档，含 LLM 提取 |
| forget | Tool | POST /forget | agent 纠错 |
| update | Tool | POST /update | agent 修正 |
| graph 更新 | Hook | `before_compaction` | 触发 graphify 更新图谱 |
| slot 集成 | Stub | `registerMemoryRuntime()` | 让 doctor 通过检查 |
| auto-inject | ~~Hook~~ | ~~before_prompt_build~~ | 暂不实现，tool 方式更可控 |

---

## 风险与注意事项

| 风险 | 影响 | 缓解方案 |
|------|------|----------|
| Python service 启动失败 | gateway 启动不了 | `registerService()` 有超时保护，失败不影响 gateway |
| LLM extraction 超时 | store 变慢 | 5s timeout，失败走 fallback |
| Graph 更新计算量大 | compaction 变慢 | 增量更新策略，只处理新增节点 |
| Qdrant 挂了 | recall/store 全挂 | 返回有意义的错误，LLM 降级回复 |
| 切换 LanceDB | 数据迁移 | 暂不实现，V2 再加 |

---

## 开发顺序

```
Phase 1: 软件工程修复
  1.1 新建 src/server.py（Python HTTP）
  1.2 重写 src/index.ts（正确的注册方式 + 4 个 tool）
  1.3 更新 openclaw.plugin.json

Phase 2: 核心功能
  2.1 调整 L1/L2/L3 cascade（调整 src/core/matcher.py）
  2.2 实现 BM25 L2
  2.3 实现存储抽象层（Qdrant + LanceDB 接口）

Phase 3: 高级功能
  3.1 LLM 提取 6W + category（src/extractor/）
  3.2 Graph 更新机制（before_compaction Hook + graphify）
  3.3 Agent 隔离完善

Phase 4: 完善
  4.1 CLI 命令（stats/list/compact）
  4.2 forget 机制细化
  4.3 文档和测试
```

---

## 依赖项

| 依赖 | 用途 | 安装 |
|------|------|------|
| `aiohttp` | Python HTTP 服务 | `pip install aiohttp` |
| `qdrant-client` | Qdrant Python SDK | `pip install qdrant-client` |
| `jieba` | 中文分词 | `pip install jieba` |
| `nltk` | 英文分词 | `pip install nltk` |
| rank_bm25 | BM25 算法 | `pip install rank-bm25` |
| `openclaw/plugin-sdk` | TS 插件 SDK | `npm install openclaw` |

---

## 参考资料

- MLP 源码：`~/sources/memory-lancedb-pro/index.ts`
- OpenClaw Plugin Hook 系统：`~/vault/OPENCLAW_PLUGIN_HOOK_SYSTEM.md`
- graphify skill：`~/vault/graphify/SKILL.md`
- OpenClaw memory slot：`plugins.slots.memory`
