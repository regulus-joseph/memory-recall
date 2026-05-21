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

## 与 memory-core 的关系

| | memory-recall | memory-core |
|---|---|---|
| **存储形态** | 全文存储（原始内容完整保留） | Compact 压缩存储（摘要化，信息有损耗） |
| **召回能力** | L1/L2/L3 语义级联召回 | 取决于 core 自身实现 |
| **覆盖率** | autoStore 触发点有限，有漏存风险 | 覆盖率可能更全但内容被压缩 |
| **保护机制** | Weibull decay + Tier 分层（importance ≥ 0.7 免疫） | 取决于 core 实现 |

**两者互补但不重叠**。memory-core 的 compact 存储丢失的细节，memory-recall 可以补充（但前提是那段内容被 autoStore 捕获到了）。

---

## 段落一：作为主力核心记忆模块

当 memory-recall 作为主要记忆系统时，核心原则是**主动存储 + 主动召回，不依赖 autoStore 的被动覆盖**。

### 主动存储

autoStore 只在 `message_received` / `agent_end` / `session_end` 这三个 hook 触发。如果某段重要对话从没经过 OpenClaw 的消息流（比如 agent 内部推理的中间结论、你帮用户做的某个决定性操作），就不会被捕获。

**凡是你认为重要的事，主动存：**

```javascript
// 帮用户完成了一个配置，第一时间存
await mr_memory_store({
  content: "Marlon 的 futu OpenD 安装路径是 ~/FutuOpenD/，通过 openclaw plugins install --link 方式链接"
})

// 做了一个关键决策判断，立刻存
await mr_memory_store({
  content: "用户决定用 WSL2 作为 main dev environment，不再折腾 macOS 原生环境"
})

// 用户提到偏好，立刻存（autoStore 可能会漏）
await mr_memory_store({
  content: "用户说他喜欢在 VSCode Remote WSL 里工作，不喜欢本地 terminal"
})
```

### 主动召回——多次差异查询

auto-inject 的 `before_prompt_build` hook 最多注入 3 条、600 字符，限制太死。**不靠它，自己调：**

```javascript
// 同一件事用不同表述查，充分利用 L1→L2 级联
await mr_memory_recall({ query: "Marlon 对 futu OpenD 的配置方式", max_results: 5, min_score: 0.2 })
await mr_memory_recall({ query: "futu OpenD 安装路径 链接方式", max_results: 5, min_score: 0.2 })
await mr_memory_recall({ query: "~/FutuOpenD trade-agents", max_results: 5, min_score: 0.15 })

// 三次不同角度的召回结果并集，比单次查询更全
```

### 精确查找用 BM25，语义召回用向量

```javascript
// 语义理解类需求 → mr_memory_recall（L1 向量 + L2 BM25 rerank + L3 图扩展）
await mr_memory_recall({ query: "用户平时喜欢用什么开发环境" })

// 精确符号/路径/命令 → mr_memory_search（纯 BM25，无向量干扰）
await mr_memory_search({ query: "~/FutuOpenD/openclaw plugins install" })
// BM25 对 exact match 更可靠，向量可能跑偏
```

### importance 分层保护

LLM 自动 extract 的 importance 不一定准确。**核心事实要手动拉高保护：**

```javascript
// 查完发现一条重要事实，importance 只有 0.55，手动设到 0.75 以上（Tier 1 免疫 decay）
await memory_update({
  memory_id: "abc-123",
  metadata: { importance: 0.8 }
})

// 或者存的时候就预判：这是核心事实，强制设高
await mr_memory_store({
  content: "用户的 OpenClaw workspace 在 ~/projects/memory-recall",
  metadata: { importance: 0.85, category: "fact" }
})
```

### 存储前先 extract 预览

```javascript
// 不确定一条内容值不值得存、会不会很快被 decay 掉？先 extract 预览
await memory_extract({ content: "用户的临时调试命令：echo 'debug'" })
// 返回: { temporal_type: "ephemeral", importance: 0.25, confidence: 0.6 }
// → 半衰期只有 7 天，importance 很低，大概率会被 decay 掉
// → 决定：要么不存，要么手动设高 importance 再存
```

---

## 段落二：作为 memory-core 的辅助记忆模块

memory-core 的 compact 摘要会丢失细节，memory-recall 可以填补这个空白。

### 工作流程

```
memory-core: compact 摘要（覆盖广，但细节丢失）
    +
memory-recall: 全文补充（覆盖窄，但细节完整）
    =
完整记忆覆盖
```

### 具体做法

**1. 关闭 memory-recall 的 autoStore，避免重复存储**

两个系统同时 autoStore 会产生大量重复，且 memory-recall 的覆盖率不如 memory-core 全。

```json
{
  "plugins": {
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": {
          "autoStore": false,
          "autoRecall": true,
          "autoRecallMaxItems": 5,
          "autoRecallMaxChars": 800
        }
      }
    }
  }
}
```

**2. 用 memory-recall 存储 memory-core 摘要中缺失的细节**

当你在 memory-core 里看到一条 compact 过的记录，细节不够，主动在 memory-recall 里补全：

```javascript
// memory-core 说："用户配置了 futu OpenD"
// → 细节丢失！去 memory-recall 里查有没有更详细的版本
await mr_memory_search({ query: "futu OpenD 配置" })
// 如果有，拿出来补充到当前 context
// 如果没有，主动补存
await mr_memory_store({
  content: "Marlon 的 futu OpenD 在 ~/FutuOpenD/ 目录，通过 openclaw plugins install --link 链接。运行端口 33336，行情订阅需要先 unlock"
})
```

**3. 用 mr_memory_recall 做 memory-core 的语义补强**

memory-core 可能只能做精确匹配或时间线浏览，语义相关的历史记录找不到。用 memory-recall 补充：

```javascript
// memory-core: 查"深圳出差" → 精确匹配，可能只有一条
// memory-recall: 查"用户最近的出行计划" → L1 向量语义召回，把相关但不等价的记忆也拉出来
await mr_memory_recall({ query: "用户最近有没有出差或者旅行计划", max_results: 5, min_score: 0.15 })
```

**4. 两边并行查，结果合并**

```javascript
// 先并行
results_recall = await mr_memory_recall({ query: "futu 交易", max_results: 5 })
results_core   = await memory_core_search({ query: "futu" })   // memory-core 的搜索工具

// 再合并去重
// memory-recall 的优势：全文、语义关联、L3 图扩展发现
// memory-core 的优势：compact 摘要、可能更全的覆盖
```

---

## 段落三：用户如何使用查询

### 日常对话中主动触发

**直接问的时候：**
```
用户："你还记得上周我们讨论的那个 trade-agents 的架构吗？"
→ 立刻调 mr_memory_recall({ query: "trade-agents 架构讨论", max_results: 5 })
```

**用户提到一个项目/工具/偏好，但你不确定有没有记录：**
```
用户："我之前在 futu OpenD 上遇到过一个问题..."
→ 调 mr_memory_recall({ query: "futu OpenD 问题 报错", max_results: 3 })
→ 同时调 mr_memory_search({ query: "futu OpenD 错误" })  // 并行
```

**用户说"记得之前我们..."类的话：**
```
用户："记得上次你帮我配的那个东西吗"
→ mr_memory_recall({ query: "配置 安装 setup" })  // 宽泛语义查
→ mr_memory_search({ query: "配置" })             // BM25 精确兜底
```

### 做任务前的主动回顾

**开始一个新任务之前，先查相关历史：**

```javascript
// 用户让你做某件事，先查有没有先例
await mr_memory_recall({ query: "用户之前有没有让我做过类似的事" })
await mr_memory_browse({ since: "2026-05-01", limit: 10 })  // 最近记忆总览
```

**查用户偏好（fact/preference 类）：**

```javascript
// 关于路径配置
await mr_memory_recall({ query: "用户的项目路径配置习惯" })
await mr_memory_search({ query: "~/projects ~/source" })

// 关于工具选择偏好
await mr_memory_recall({ query: "用户喜欢用什么 terminal shell 开发工具" })

// 关于之前的决定/结论
await mr_memory_recall({ query: "用户之前决定了什么方案" })
```

### 查特定信息

**精确查命令/路径/版本（BM25 最准）：**
```javascript
await mr_memory_search({ query: "openclaw plugins install --link" })
await mr_memory_search({ query: "~/FutuOpenD 端口" })
```

**跨话题关联发现（图扩展）：**
```javascript
// L3 图扩展会从 conversation_id / category / temporal 邻居扩展
// 比如查"OpenClaw"，可能会通过图扩展发现相邻的"futu OpenD"节点（同一个 project）
await mr_memory_recall({ query: "OpenClaw 配置", max_results: 5, min_score: 0.15 })
// 融合分不够高但图扩展关联强的记忆也会被带出来
```

### 用 browse 做时间线回顾

```javascript
// 快速了解某个时间段发生了什么
await memory_browse({ since: "2026-05-01", until: "2026-05-21", limit: 30 })

// 看某个 category 的全部记忆
await memory_browse({ category: "fact", limit: 20 })

// 看某个 project/conversation 的所有记忆
await memory_browse({ conversation_id: "project-trade-agents", limit: 20 })
```

---

## 工具索引

| 工具 | 用途 | 推荐场景 |
|------|------|----------|
| `mr_memory_recall` | L1/L2/L3 级联召回 | 语义查询、跨 topic 关联发现 |
| `mr_memory_search` | 纯 BM25 关键词搜索 | 精确命令、路径、符号查找 |
| `mr_memory_store` | 全文存储 + auto extract | 主动存重要内容 |
| `memory_extract` | 预览 extract 结果 | 存之前判断值不值得存 |
| `memory_update` | 更新内容/拉高 importance | 保护核心记忆 |
| `memory_browse` | 按时间/conversation 浏览 | 时间线回顾、项目历史 |
| `memory_list` | 分页列表 + 过滤 | 查看某个 category 的全部记忆 |
| `mr_memory_get` | 按 ID 查单条 | 已知 ID，直接拿内容 |
| `memory_stats` | 统计面板 | 检查存储状态和 decay 进度 |
| `memory_forget` | 删除记忆（core 保护） | 清理不需要的记忆 |

---

## Tier 保护速查

| 分值 | 级别 | 行为 |
|------|------|------|
| importance ≥ 0.7 | **Tier 1 core** | 免疫 decay 删除 |
| 0.4 ≤ importance < 0.7 | **Tier 2 working** | 正常优先级 |
| importance < 0.4 | **Tier 3 peripheral** | 首批被 decay 清理 |

**实战原则：** fact / preference 类建议存的时候设 ≥ 0.75；conversation / ephemeral 类让 LLM 自己判断高低。

---

## 已知限制

- **autoStore 覆盖率有限**：hook 触发点之外的内容不会被自动存，需要主动 `mr_memory_store`
- **L2/L3 的 agent_id 过滤有已知 bug**：尽量用 L1 向量结果，传 `min_score: 0.15` 以上过滤噪音
- **BM25 vs 向量分工**：精确查找用 `mr_memory_search`，语义关联用 `mr_memory_recall`
