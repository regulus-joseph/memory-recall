# OpenClaw Plugin & Hook System 分析文档

## 1. 概述

OpenClaw 的插件系统和 Hook 系统是两个独立但相互关联的核心扩展机制：

- **插件系统（Plugin）**：通过 `openclaw.plugin.json` manifest 声明，通过 `OpenClawPluginApi` 注册工具、Provider、命令、HTTP 路由等
- **Hook 系统（Hook）**：事件驱动的回调机制，用于在 agent 生命周期中注入逻辑
- **工具系统（Tool）**：通过插件注册，由 AI 模型在运行时调用

---

## 2. OpenClawPluginApi 注册方法（完整列表）

插件通过 `index(pluginApi)` 入口函数获得 `OpenClawPluginApi` 对象，可调用的注册方法：

### 2.1 Hook 事件注册

| 方法 | 说明 |
|------|------|
| `api.on(hookName, handler, opts?)` | 强类型 Hook 注册（推荐） |
| `api.registerHook(events, handler, opts?)` | 底层 Hook 注册，支持多事件 |

### 2.2 工具注册

| 方法 | 说明 |
|------|------|
| `api.registerTool(tool, opts?)` | 注册 agent 工具 |

### 2.3 HTTP 路由

| 方法 | 说明 |
|------|------|
| `api.registerHttpRoute(routeParams)` | 注册 HTTP 路由，支持 `gateway` / `plugin` 两种认证模式 |

### 2.4 Provider 注册

| 方法 | 说明 |
|------|------|
| `api.registerProvider(provider)` | 通用 Provider |
| `api.registerSpeechProvider(provider)` | 语音合成 |
| `api.registerRealtimeTranscriptionProvider(provider)` | 实时转录 |
| `api.registerRealtimeVoiceProvider(provider)` | 实时语音 |
| `api.registerMediaUnderstandingProvider(provider)` | 媒体理解 |
| `api.registerImageGenerationProvider(provider)` | 图片生成 |
| `api.registerVideoGenerationProvider(provider)` | 视频生成 |
| `api.registerMusicGenerationProvider(provider)` | 音乐生成 |
| `api.registerWebFetchProvider(provider)` | Web 获取 |
| `api.registerWebSearchProvider(provider)` | Web 搜索 |

### 2.5 其他扩展

| 方法 | 说明 |
|------|------|
| `api.registerChannel(registration)` | 注册 channel 插件 |
| `api.registerAgentHarness(harness)` | 注册自定义 agent harness |
| `api.registerGatewayMethod(method, handler, opts?)` | 注册 gateway RPC 方法 |
| `api.registerService(service)` | 注册后台服务 |
| `api.registerCli(registrar, opts?)` | 注册 CLI 命令 |
| `api.registerCliBackend(backend)` | 注册 CLI 后端 |
| `api.registerCommand(command)` | 注册 gateway 命令 |
| `api.registerTextTransforms(transforms)` | 注册文本转换（input/output） |
| `api.registerReload(registration)` | 注册插件热重载前缀 |
| `api.registerNodeHostCommand(command)` | 注册 Node host 命令 |
| `api.registerSecurityAuditCollector(collector)` | 注册安全审计收集器 |
| `api.registerInteractiveHandler(registration)` | 注册交互式处理器 |
| `api.registerContextEngine(id, factory)` | 注册 context engine 工厂 |
| `api.registerCompactionProvider(provider)` | 注册内存压缩 Provider |
| `api.registerEmbeddedExtensionFactory(factory)` | 注册 Pi 嵌入式扩展工厂（仅 bundled） |
| `api.registerCodexAppServerExtensionFactory(factory)` | 注册 Codex app-server 扩展工厂（仅 bundled） |
| `api.onConversationBindingResolved(handler)` | 注册会话绑定解析处理器 |
| `api.registerDetachedTaskRuntime(runtime)` | 注册 detached task 生命周期运行时 |
| `api.registerMemoryCapability(capability)` | 注册内存能力（仅 memory 插件） |
| `api.registerMemoryPromptSection(builder)` | 注册内存 prompt section（仅 memory 插件） |
| `api.registerMemoryPromptSupplement(builder)` | 注册内存 prompt 补充 |
| `api.registerMemoryCorpusSupplement(supplement)` | 注册内存语料补充 |
| `api.registerMemoryFlushPlan(resolver)` | 注册内存 flush plan 解析器（仅 memory 插件） |
| `api.registerMemoryRuntime(runtime)` | 注册内存运行时（仅 memory 插件） |
| `api.registerMemoryEmbeddingProvider(provider)` | 注册内存嵌入 Provider |

---

## 3. Hook 系统架构

### 3.1 两套独立的 Hook 系统

OpenClaw 有两个完全独立的 Hook 实现：

**系统 A：内部插件 Hook**（`src/hooks/internal-hooks.ts`）
- 所有插件 Hook、workspace Hook、legacy 配置 Hook 汇聚于此
- 通过 `triggerInternalHook(event, eventObj)` 触发

**系统 B：外部 HTTP Webhook**（`src/gateway/hooks.ts`）
- 完全独立，HTTP POST 到 `/hooks` 端点
- 通过 `gateway.hooks.webhooks[]` 在 manifest 中声明

### 3.2 内部 Hook 核心实现

```typescript
// 注册
registerInternalHook(event: string, handler: InternalHookHandler, opts?): void
unregisterInternalHook(event: string, handler: InternalHookHandler): void
triggerInternalHook(event: string, eventObj: InternalHookEvent): Promise<void>

// 类型定义
type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void

interface InternalHookEvent {
  type: InternalHookEventType   // "command" | "session" | "agent" | "gateway" | "message"
  action: string               // 动作名称，如 "new", "reset", "stop"
  sessionKey: string           // 会话 key
  context: Record<string, unknown>
  timestamp: Date
  messages: string[]           // Hook 可向此数组推送消息返回给用户
}
```

**关键机制：**
- **去重**：`_hookEventDedup` Set，key = `handlerName:sessionKey:timestamp`，最多 200 条
- **防重入**：`_currentlyFiring` Map，同一 handler 不可重入
- **优先级**：`options.priority`，数字越小越早执行（默认 0）
- **超时**：单个 handler 超时 30000ms
- **全局回滚**：`activePluginHookRegistrations` 全局 Map，存储每个 plugin 的 hook 注册，供热重载时回滚

### 3.3 Hook 事件类型（完整列表，29 个）

基于 `plugin-sdk/src/plugins/hook-types.d.ts` 的 `PluginHookName` 类型定义：

| 分类 | 事件 | 说明 |
|------|------|------|
| **Model** | `before_model_resolve` | 模型解析前，可在此时修改模型选择 |
| **Prompt** | `before_prompt_build` | Prompt 构建前，注入记忆/状态（policy-layer 用这个） |
| **Agent** | `before_agent_start` | Agent 运行前 |
| **Agent** | `before_agent_reply` | Agent 回复前，可拦截或替换回复 |
| **LLM** | `llm_input` | LLM 输入前，可修改 system prompt / history |
| **LLM** | `llm_output` | LLM 输出后，可处理 assistant 文本 |
| **Agent** | `agent_end` | Agent 运行结束，可做存储/反思 |
| **Tool** | `before_tool_call` | 工具调用前，可拦截/审批/修改参数（核心安全 hook） |
| **Tool** | `after_tool_call` | 工具调用后，可处理结果/做 secret redaction |
| **Tool** | `tool_result_persist` | 工具结果持久化前，可修改写入内容 |
| **Message** | `inbound_claim` | 入站消息认领前，可做 channel 级别的权限检查 |
| **Message** | `message_received` | 消息接收后（已去重），可做处理 |
| **Message** | `message_sending` | 消息发送前，可拦截/修改出站内容 |
| **Message** | `message_sent` | 消息发送后 |
| **Message** | `before_message_write` | 消息写入 session 前，可拦截 |
| **Session** | `session_start` | Session 启动 |
| **Session** | `session_end` | Session 结束（含 reason/durationMs） |
| **Subagent** | `subagent_spawning` | Subagent 启动前 |
| **Subagent** | `subagent_delivery_target` | Subagent 投递目标确定时 |
| **Subagent** | `subagent_spawned` | Subagent 启动后 |
| **Subagent** | `subagent_ended` | Subagent 结束时 |
| **Dispatch** | `before_dispatch` | 出站分发前（channel 投递） |
| **Dispatch** | `reply_dispatch` | 回复分发时，可控制 sendPolicy |
| **Compaction** | `before_compaction` | 压缩前 |
| **Compaction** | `after_compaction` | 压缩后 |
| **Reset** | `before_reset` | Session reset 前 |
| **Gateway** | `gateway_start` | Gateway 启动后 |
| **Gateway** | `gateway_stop` | Gateway 停止前 |
| **Install** | `before_install` | 插件/skill 安装前，可做安全扫描 |

**已废弃/不存在的旧 hook（文档曾错误列出，需删除）：**
- ❌ `after_agent_start`（不存在）
- ❌ `after_agent_end`（不存在，用 `agent_end`）
- ❌ `after_prompt_build`（不存在）
- ❌ `before_command_execute` / `after_command_execute`（不存在）
- ❌ `before_message_process` / `after_message_process` / `after_message_append`（不存在）
- ❌ `after_session_start` / `after_session_reset` / `after_session_stop`（不存在，用 `session_start` / `session_end`）
- ❌ `after_gateway_start`（不存在，用 `gateway_start`）

### 3.4 安全相关 Hook 详解

**`before_tool_call` — 核心安全 hook（Layer 1-3 实现点）**

```typescript
// 参数
{ toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string }

// 返回值
{
  params?: Record<string, unknown>;        // 可修改参数
  block?: boolean;                        // 直接阻止
  blockReason?: string;
  requireApproval?: {                     // 触发人工审批 UI
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    pluginId?: string;
    onResolution?: (decision: PluginApprovalResolution) => Promise<void>;
  };
}

// 审批决议
type PluginApprovalResolution =
  | "allow-once"   // 本次放行
  | "allow-always" // 本 session 永久放行
  | "deny"         // 拒绝
  | "timeout"      // 超时未响应
  | "cancelled";   // 取消
```

**`after_tool_call` — Secret Redaction 实现点（Layer 4）**
```typescript
{ toolName: string; params: Record<string, unknown>; runId?: string;
  toolCallId?: string; result?: unknown; error?: string; durationMs?: number; }
```

**`message_sending` — Channel 出站内容检查实现点**
```typescript
// 可返回 { handled: boolean; } 拦截消息发送
```

**`inbound_claim` — Channel 入站权限验证实现点**
```typescript
// 可做 channel 级别的 sender 权限检查
```

**`before_dispatch` — 出站分发前检查（channel 集成关键）**
```typescript
{ content: string; body?: string; channel?: string;
  sessionKey?: string; senderId?: string; isGroup?: boolean; }
```

**`llm_input` — Prompt 注入实现点**
```typescript
{ runId: string; sessionId: string; provider: string; model: string;
  systemPrompt?: string; prompt: string; historyMessages: unknown[]; imagesCount: number; }
```

### 3.5 插件 Hook 注册流程

```
Plugin: api.on("before_prompt_build", handler, opts)
  │
  ├─ hook-types.ts: api.on() → handlers.registerHook(events, handler, opts)
  │    └─ 内部调用 api.registerHook()
  │
  └─ registry.ts: registerHook() (line 358)
       ├─ 存储到 registry.hooks[] = HookRegistration[]
       │    HookEntry {
       │      hook: { name, description, source="openclaw-plugin", pluginId, filePath, baseDir, handlerPath },
       │      frontmatter: {},
       │      metadata: { events },
       │      invocation: { enabled: true }
       │    }
       ├─ 检查重复 hook name
       ├─ 检查 config?.hooks?.internal?.enabled
       ├─ activePluginHookRegistrations.set(name, nextRegistrations)  ← 跟踪用于回滚
       └─ registerInternalHook(event, handler)  ← 挂载到内部 Hook 引擎
            └─ internalHooks.get(event).push({ handler, options })
```

### 3.6 强类型 Hook vs 底层 Hook

**强类型 Hook**（`api.on(hookName, handler)`）：
- 使用 `PluginHookName` 类型，自动推断事件参数类型
- 通过 `registerTypedHook()` 注册，存入 `registry.typedHooks[]`
- 支持 `priority` 优先级和 `allowPromptInjection` 策略
- 在 agent 循环中被按优先级顺序执行

**底层 Hook**（`api.registerHook(events, handler, opts)`）：
- 事件名是字符串，支持多事件注册
- 事件对象是扁平的 `InternalHookEvent`

### 3.7 Loader：第三种 Hook 来源

`src/hooks/loader.ts`：`loadInternalHooks(config, workspaceDir)`
- 加载自：workspace 目录、managed hooks、bundled hooks
- 支持 legacy 配置格式（向后兼容）
- 两者都通过 `registerInternalHook()` 注册，汇入同一 Hook 引擎

---

## 4. 工具注册与触发

### 4.1 注册

```typescript
api.registerTool(tool: AnyAgentTool | OpenClawPluginToolFactory, opts?)
```

**工厂函数签名：**
```typescript
type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined
```

**工具上下文（OpenClawPluginToolContext）：**
```typescript
{
  config?: OpenClawConfig            // 静态配置
  runtimeConfig?: OpenClawConfig     // 运行时配置快照
  fsPolicy?: ToolFsPolicy             // 文件系统安全策略
  workspaceDir?: string              // 工作目录
  agentDir?: string                  // agent 目录
  agentId?: string                   // agent ID
  sessionKey?: string                // 会话 key
  sessionId?: string                 // 临时会话 UUID（/new 和 /reset 时重置）
  browser?: {                        // 沙箱浏览器桥接
    sandboxBridgeUrl?: string
    allowHostControl?: boolean
  }
  messageChannel?: string            // 消息通道
  agentAccountId?: string            // 账户 ID
  deliveryContext?: DeliveryContext // 投递上下文
  requesterSenderId?: string         // 信任的发送者 ID（来自入站上下文，非工具参数）
  senderIsOwner?: boolean           // 发送者是否为 owner
  sandboxed?: boolean               // 是否沙箱模式
}
```

**注册结果存入：**
```typescript
registry.tools[] = PluginToolRegistration[]
{
  pluginId, pluginName, factory, names, optional, source, rootDir
}
```

### 4.2 工具实例化时机

工具采用**延迟实例化**策略——工厂函数不在插件加载时调用，而在 agent 每次运行时调用：

```
createOpenClawCodingTools()  ← agent 运行时
  └─ createOpenClawTools()
       └─ resolveOpenClawPluginToolsForOptions()
            └─ resolvePluginTools()  ← 遍历 registry.tools[]
                 └─ entry.factory(context)  ← 调用工厂函数
```

每次 agent 运行都会重新调用 `factory(context)`，确保工具获得最新的上下文信息（sessionId、fsPolicy 等）。

### 4.3 工具元数据追踪

工具元数据通过 WeakMap 关联：

```typescript
const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>()
// PluginToolMeta = { pluginId: string, optional: boolean }
```

**用途 1：** `tools.effective` API — 判断工具来源（`core` / `plugin` / `channel`）
**用途 2：** 策略管道 — `applyToolPolicyPipeline()` 使用 `toolMeta` 回调获取 `pluginId` 用于策略决策

### 4.4 工具 Policy Pipeline

工具组装完成后经过多层过滤：

```
registry.tools[].factory(context)  ← 实例化
  → filterToolsByMessageProvider()        ← 按 channel 过滤
  → applyModelProviderToolPolicy()         ← 按 model provider 过滤（如抑制 web_search）
  → applyOwnerOnlyToolPolicy()            ← owner-only 工具
  → applyToolPolicyPipeline()             ← profile/global/agent/group/sandbox/subagent 策略链
  → normalizeToolParameters()             ← JSON Schema 规范化（Gemini 特殊处理）
  → wrapToolWithBeforeToolCallHook()     ← 包装 before_tool_call / after_tool_call Hook
  → wrapToolWithAbortSignal()            ← 包装 AbortSignal
  → applyDeferredFollowupDescriptions()   ← 延迟描述符
  → 返回最终工具列表给 AI 模型
```

---

## 5. 插件生命周期

### 5.1 加载流程

```
Gateway 启动
  └─ loadInternalHooks(cfg, workspaceDir)  ← 加载 workspace/managed/bundled Hook
  └─ 插件发现（通过 openclaw.plugin.json manifest）
       └─ 验证 contracts 和 capabilities
       └─ createPluginRegistry()  ← 创建本插件 registry
            └─ createApi(record, params)  ← 构建 OpenClawPluginApi
                 └─ buildPluginApi()  ← 组装 API 对象
            └─ 调用 plugin.index(api)  ← 插件执行注册逻辑
                 └─ api.registerTool() / api.on() / api.registerProvider() 等
```

### 5.2 PluginRuntime

每个插件通过 `PluginRuntime` 代理访问核心功能：

```typescript
resolvePluginRuntime(pluginId): PluginRuntime
  // 返回 registryParams.runtime 的 Proxy
  // 对 .subagent 属性的访问自动注入 pluginId scope
  // 其他属性直接透传
```

这确保插件的 subagent 操作自动带上插件 ID 标记。

### 5.3 热重载支持

- `activePluginHookRegistrations` 全局 Map 跟踪每个 hook 的注册
- `registerReload(registration)` 允许插件声明 `restartPrefixes` / `hotPrefixes` / `noopPrefixes`
- 卸载插件时自动回滚所有 hook 注册

---

## 6. 与 MLP / memory-recall 的集成

memory-recall 作为 OpenClaw 插件，通过以下方式使用 Hook 系统：

### 6.1 Hook 注册方式

```typescript
api.on("before_prompt_build", recallHandler, {
  name: "memory-recall-recall",
  description: "Inject relevant memories into prompt",
  priority: 10,  // recall 最先执行
})

api.on("message_received", storeHandler, {
  name: "memory-recall-store",
  description: "Fire-and-forget recall for session cache",
})

api.on("agent_end", storeHandler, {
  name: "memory-recall-agent-end",
  description: "Store assistant messages to memory",
})
```

### 6.2 优先级约定（memory-recall）

| 优先级 | Hook | 功能 |
|--------|------|------|
| 10 | before_prompt_build | recall（从 cache 读记忆，<1ms） |
| — | message_received | fire-and-forget recall（异步预热 cache） |
| — | agent_end | store（等待存储完成） |

### 6.3 memory-recall 不使用工具系统

MLP 通过 Hook 系统实现，无需注册 agent 工具。所有记忆操作（recall / capture / reflection）都在 Hook handler 中完成。

---

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `plugin-sdk/src/plugins/hook-types.d.ts` | **真实 Hook 类型定义（PluginHookName 等）** |
| `plugin-sdk/src/plugins/hook-before-agent-start.types.d.ts` | before_agent_start / before_prompt_build 事件类型 |
| `plugin-sdk/src/plugins/hook-message.types.d.ts` | message_received / message_sending / message_sent 类型 |
| `src/plugins/types.ts` | OpenClawPluginApi 接口定义（~2065 行） |
| `src/plugins/api-builder.ts` | buildPluginApi — 组装 API 对象 |
| `src/plugins/registry.ts` | createPluginRegistry — 插件注册逻辑中心 |
| `src/plugins/registry-types.ts` | 注册类型定义 |
| `src/plugins/tool-types.ts` | OpenClawPluginToolFactory / ToolContext |
| `src/plugins/tools.ts` | resolvePluginTools — 工具解析入口 |
| `src/agents/pi-tools.ts` | createOpenClawCodingTools — 工具组装主函数 |
| `src/agents/openclaw-plugin-tools.ts` | resolveOpenClawPluginToolsForOptions — 插件工具解析入口 |
| `packages/plugin-sdk/src/plugin-entry.ts` | 公共 SDK 导出入口 |

> **注意**：表格中带 `plugin-sdk/` 前缀的文件位于 openclaw 的 `dist/plugin-sdk/` 目录下（npm 发布版），源码路径不同。
