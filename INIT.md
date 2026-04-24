# memory-recall 项目启动文档

> AI Agent 记忆召回系统 - 让 Agent 能够回忆起过去的对话

---

## 1. 项目概述

### 1.1 目标
通过 L1/L2/L3 三层拦截机制，使 Agent 能够检索历史对话内容，实现跨会话记忆。

### 1.2 核心模块
- **L1 关键词匹配**：正则快速筛选
- **L2 向量相似度**：语义重排序
- **L3 Graph联想**：关联追踪（基于 graphify）

### 1.3 技术栈
| 组件 | 技术选型 |
|------|----------|
| LLM | Ollama (llama3.2) |
| Embedding | bge-m3 (1024维) |
| 向量数据库 | Qdrant |
| 图数据库 | graphify (networkx) |
| 运行环境 | Python + asyncio |

---

## 2. 参考资料

### 2.1 论文
- **Springdrift**: [arXiv:2604.04660](https://arxiv.org/abs/2604.04660)
  - D' gating 机制
  - Sensorium 自感知
  - Case-Based Memory
  - 论文PDF: `./springdrift-paper.pdf`

### 2.2 关键项目
| 项目 | 用途 | 关键Hook |
|------|------|----------|
| [openclaw](https://github.com/openclaw/openclaw) | AI Agent平台 | `before_prompt_build`, `message_received`, `message_sent` |
| [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) | 记忆插件参考 | `before_prompt_build` (auto-recall) |
| [graphify](https://github.com/nicko170/graphify) | 知识图谱构建 | `extract()`, `build_graph()` |

### 2.3 OpenClaw Hooks
```
before_model_resolve  - 模型解析前，可覆盖 provider/model
before_prompt_build   - Prompt构建前，注入上下文 (auto-recall在此)
message_received      - 收到消息时
message_sent          - 发送消息时
```

### 2.4 Springdrift Memory Stores (10个)
| Store | 用途 |
|-------|------|
| Narrative | 周期叙事 |
| Threads | 主题分组 |
| Facts | 键值记忆（可衰减） |
| CBR cases | 案例检索 |
| Artifacts | 大型内容 |
| Tasks | 计划任务 |
| Endeavours | 多任务目标 |
| Comms | 邮件收发 |
| Affect | 情感状态 |
| DAG nodes | 周期遥测 |

---

## 3. Payload Schema

### 3.1 记忆条目
```json
{
  "id": "uuid",
  "conversation_id": "uuid",
  "agent_id": "string",
  "user_id": "string",
  "timestamp": "ISO8601",
  "content": "对话原文",
  "entities": {
    "who": ["人名列表"],
    "what": ["事件列表"],
    "when": ["时间列表"],
    "where": ["地点列表"],
    "why": ["原因列表"],
    "how": ["方式列表"]
  },
  "confidence": "EXTRACTED|INFERRED|AMBIGUOUS",
  "graph_edges": [
    {"source": "id", "target": "id", "relation": "calls|uses|...", "confidence": "EXTRACTED|INFERRED"}
  ],
  "access_count": 0,
  "last_accessed": "ISO8601",
  "importance": 0.5
}
```

### 3.2 分类差异
| 类型 | Payload特点 |
|------|-------------|
| memory-recall | 6W实体 (人/事/时/地/物/因), 因果链 |
| knowledge-sea | 知识性内容, 概念定义 |

---

## 4. 架构设计

### 4.1 Cascade 检索流程
```
用户提问
  → L1 关键词正则匹配 → 候选ID列表
  → L2 向量相似度 → 重排序
  → L3 Graph联想 → 追踪证据 (仅当 L2 置信度 < 0.6)
  → 合并返回结果
```

### 4.2 LLM 后台触发机制
- **阈值触发**：L1+L2 置信度 < 0.6 时触发 L3
- **批量处理**：每小时或每100条对话汇总触发
- **增量更新**：不重复处理已有实体

### 4.3 项目结构
```
memory-recall/
├── src/
│   ├── __init__.py
│   ├── embedder.py       # Ollama embedding
│   ├── storage.py        # Qdrant 存储
│   ├── matcher.py        # L1/L2/L3 匹配逻辑
│   ├── interceptor.py   # OpenClaw hook 拦截
│   ├── extractor.py      # 6W 实体提取
│   ├── graph_builder.py  # graphify 集成
│   └── whitelist.py      # 分词白名单
├── tests/
├── config/
├── examples/
└── README.md
```

---

## 5. 实施计划

### Phase 1: 基础建设
- [ ] 项目骨架搭建
- [ ] Qdrant 连接配置
- [ ] Ollama embedding 集成
- [ ] L1 关键词匹配实现

### Phase 2: 核心功能
- [ ] L2 向量匹配
- [ ] L3 Graph 联想 (graphify)
- [ ] Payload schema 定义

### Phase 3: OpenClaw 集成
- [ ] Plugin 开发
- [ ] Hook 注册 (before_prompt_build)
- [ ] Auto-recall 实现

### Phase 4: 优化
- [ ] LLM 后台批量触发
- [ ] 白名单管理
- [ ] 性能优化

---

## 6. 待补充内容

- [ ] minecraft-bot.md 需求文档
- [ ] news-events-market.md 需求文档
- [ ] qlib-financial-data.md 需求文档
- [ ] 详细API接口设计
- [ ] 测试用例

---

## 7. 相关环境变量

```bash
# MySQL (数据导入)
MYSQL_PASSWORD=SuRu_2026*

# Ollama
OLLAMA_MODELS=/opt/ollama/models

# Qdrant
QDRANT_HOST=localhost
QDRANT_PORT=6333
```

---

*文档版本：0.1*
*创建日期：2026-04-22*
*基于：Springdrift论文 + memory-lancedb-pro + graphify*