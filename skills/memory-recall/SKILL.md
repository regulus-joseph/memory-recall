---
name: memory-recall
description: L1/L2/L3 cascade memory recall plugin for OpenClaw. Per-agent LanceDB (vector + BM25 + graphology). Weibull decay. Progressive compaction. Trigger: /memory
trigger: /memory
---

# Memory Recall Skill

Three-layer retrieval cascade (L1 → L2 → L3):
- **L1 (vector)**: bge-m3 embedding via Ollama (1024-dim) — semantic similarity
- **L2 (BM25)**: jieba Chinese tokenization — fast keyword match, no embedding cost
- **L3 (graph)**: graphology expansion from top L1/L2 results — finds related memories via session/category/temporal edges

Storage: LanceDB (vector table per agent/scope) + BM25 index + graphology graph.

Decay: Weibull composite score (recency × frequency × intrinsic importance). Core memories (importance ≥ 0.7) are protected.

---

## 段落一：作为主力核心插件（memory-recall 为主，memory-core 为辅）

**核心原则：主动存储 + 主动召回，不依赖 autoStore 被动覆盖**

### 主动存储策略

autoStore 只在 `message_received` / `agent_end` / `session_end` 触发。OpenClaw 消息流之外的内容（agent 内部推理结论、帮用户做的关键决定）不会被自动捕获。

**凡重要，必主动存：**

```
// 完成了一个配置，第一时间存
mr_memory_store({ content: "Marlon 的 futu OpenD 在 ~/FutuOpenD/，通过 openclaw plugins install --link 链接，端口 33336" })

// 做了一个关键决策，立刻存
mr_memory_store({ content: "用户决定用 WSL2 作为 main dev environment，不再折腾 macOS 原生环境" })

// 用户提到偏好，立刻存
mr_memory_store({ content: "用户说他喜欢在 VSCode Remote WSL 里工作，不喜欢本地 terminal" })
```

### 多次差异查询，充分利用级联

`before_prompt_build` 的 auto-inject 限制死 3 条 / 600 字符。**不靠它，自己调：**

```
// 同一件事用不同表述查，L1→L2 级联结果并集，比单次更全
mr_memory_recall({ query: "Marlon 对 futu OpenD 的配置方式", max_results: 5, min_score: 0.2 })
mr_memory_recall({ query: "futu OpenD 安装路径 链接方式", max_results: 5, min_score: 0.2 })
mr_memory_recall({ query: "~/FutuOpenD trade-agents", max_results: 5, min_score: 0.15 })
```

### BM25 vs 向量分工

| 场景 | 工具 |
|------|------|
| 语义理解、跨 topic 关联 | `mr_memory_recall`（L1 向量 + L2 BM25 rerank + L3 图扩展）|
| 精确符号、路径、命令 | `mr_memory_search`（纯 BM25，无向量干扰）|

```
// 语义类 → mr_memory_recall
mr_memory_recall({ query: "用户平时喜欢用什么开发环境" })

// 精确类 → mr_memory_search
mr_memory_search({ query: "~/.openclaw/plugins install" })
```

### 手动保护核心记忆

LLM extract 的 importance 不一定准。**核心事实手动拉高：**

```
// 查完发现重要事实 importance 只有 0.55，手动设到 0.75+（Tier 1 免疫 decay）
memory_update({ memory_id: "abc-123", metadata: { importance: 0.8 } })

// 存的时候就预判：这是核心 fact，强制设高
mr_memory_store({ content: "用户的 OpenClaw workspace 在 ~/projects/memory-recall", metadata: { importance: 0.85, category: "fact" } })
```

### 存前先 extract 预览

```
// 不确定值不值得存？先 preview
memory_extract({ content: "用户的临时调试命令：echo 'debug'" })
// 返回: { temporal_type: "ephemeral", importance: 0.25 }
// → 半衰期 7 天，大概率被 decay 掉 → 决定：不存 或 手动设高 importance
```

---

## 段落二：作为辅助插件（memory-core 为主，memory-recall 补细节）

**核心原则：关闭 autoStore，用 memory-recall 补 memory-core 丢失的细节**

### 配置

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

### 工作流程

```
memory-core: compact 摘要（覆盖广，但细节丢失）
    +
memory-recall: 全文补充（覆盖窄，但细节完整）
    =
完整记忆覆盖
```

### 具体做法

**1. memory-core 摘要中发现缺细节，主动去 memory-recall 补**

```
// memory-core: "用户配置了 futu OpenD"（细节丢失）
// → 去 memory-recall 查有没有更详细的版本
mr_memory_search({ query: "futu OpenD 配置" })

// 如果没有，主动补存
mr_memory_store({
  content: "Marlon 的 futu OpenD 在 ~/FutuOpenD/，openclaw plugins install --link 链接，端口 33336，行情订阅需先 unlock"
})
```

**2. memory-core 精确匹配不够，memory-recall 语义补强**

```
// memory-core 查"深圳出差" → 精确匹配，可能只有一条
// memory-recall 查"用户最近的出行计划" → L1 向量语义召回，把相关但不等价的记忆也拉出来
mr_memory_recall({ query: "用户最近有没有出差或者旅行计划", max_results: 5, min_score: 0.15 })
```

**3. 两边并行查，结果合并**

```
// 先并行
results_recall = mr_memory_recall({ query: "futu 交易", max_results: 5 })
results_core   = memory_core_search({ query: "futu" })

// 合并去重，memory-recall 补全文细节
```

---

## 段落三：CLI / ACP 命令使用范例

### agent 日常对话中触发

**直接问的时候：**
```
用户："你还记得上周我们讨论的 trade-agents 架构吗？"
→ mr_memory_recall({ query: "trade-agents 架构讨论", max_results: 5 })
```

**用户提到项目/工具，但不确定有没有记录：**
```
用户："我之前在 futu OpenD 上遇到过一个问题..."
→ mr_memory_recall({ query: "futu OpenD 问题 报错", max_results: 3 })
→ mr_memory_search({ query: "futu OpenD 错误" })  // 并行，BM25 兜底
```

**用户说"记得上次你帮我配的那个东西吗"：**
```
→ mr_memory_recall({ query: "配置 安装 setup" })
→ mr_memory_search({ query: "配置" })
```

### 做任务前主动回顾

```
// 开始新任务前，先查有没有先例
mr_memory_recall({ query: "用户之前有没有让我做过类似的事" })
memory_browse({ since: "2026-05-01", limit: 10 })

// 查用户偏好
mr_memory_recall({ query: "用户的项目路径配置习惯" })
mr_memory_search({ query: "~/projects ~/source" })
```

### 精确查命令/路径/版本

```
mr_memory_search({ query: "openclaw plugins install --link" })
mr_memory_search({ query: "~/.openclaw/plugins install" })
```

### 用 browse 做时间线回顾

```
// 快速了解某时间段发生了什么
memory_browse({ since: "2026-05-01", until: "2026-05-21", limit: 30 })

// 看某个 category 的全部记忆
memory_browse({ category: "fact", limit: 20 })

// 看某个 project/conversation 的所有记忆
memory_browse({ conversation_id: "project-trade-agents", limit: 20 })
```

### 手动存储重要内容

```
mr_memory_store({ content: "今天帮用户解决了 memory-recall gateway crash 问题，根因是 graphRebuild 里的 await 写在同步 forEachNode 回调里" })
```

### 管理记忆

```
// 查看统计
memory_stats()

// 删除不需要的记忆（Tier 1 保护，需 force:true）
memory_forget({ memory_id: "abc-123" })

// 更新 importance 保护核心记忆
memory_update({ memory_id: "abc-123", metadata: { importance: 0.85 } })
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

**实战原则：** fact / preference 类建议存时设 ≥ 0.75；conversation / ephemeral 类让 LLM 自己判断。

---

## 已知限制

- **autoStore 覆盖率有限**：hook 触发点之外的内容不会被自动存，需要主动 `mr_memory_store`
- **L2/L3 的 agent_id 过滤有已知 bug**：尽量用 L1 向量结果，传 `min_score: 0.15` 以上过滤噪音
- **BM25 vs 向量分工**：精确查找用 `mr_memory_search`，语义关联用 `mr_memory_recall`