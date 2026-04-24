/**
 * Memory Recall - OpenClaw Plugin (Phase 1)
 * Architecture: TS plugin → Python server → Qdrant/BM25/Graphify
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

const SERVER_BASE = process.env.MEMORY_RECALL_SERVER || "http://localhost:8765";

interface MemoryRecallConfig {
  serverUrl?: string;
  autoStore?: boolean;
  autoRecall?: boolean;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  l1?: { enabled?: boolean; minScore?: number };
  l2?: { enabled?: boolean; minScore?: number };
  l3?: { enabled?: boolean; triggerThreshold?: number };
}

function parsePluginConfig(value: unknown): MemoryRecallConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as MemoryRecallConfig;
}

async function serverRequest<T>(path: string, body: unknown): Promise<T> {
  const url = `${SERVER_BASE}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Server error ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function serverGet<T>(path: string): Promise<T> {
  const url = `${SERVER_BASE}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Server GET ${path} failed: ${resp.status}`);
  return resp.json() as Promise<T>;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (b) =>
          b &&
          typeof b === "object" &&
          "type" in b &&
          (b as Record<string, unknown>).type === "text" &&
          "text" in b
      )
      .map((b) => ((b as Record<string, unknown>).text as string) || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && "text" in content) {
    return (content as Record<string, unknown>).text as string;
  }
  return null;
}

async function registerMemoryRuntime(_api: OpenClawPluginApi): Promise<void> {}

const memoryRecallPlugin = {
  id: "memory-recall",
  name: "Memory Recall",
  description:
    "L1/L2/L3 cascade memory recall: vector + BM25 (jieba) + graph expansion (graphify). Requires memory-recall-server (Python) running on port 8765.",
  kind: "memory" as const,

  async register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const serverUrl = config.serverUrl ?? SERVER_BASE;

    api.logger.info?.(`[memory-recall] register called, server=${serverUrl}`);

    await registerMemoryRuntime(api);

    api.registerTool(
      {
        name: "recall_memories",
        label: "Recall Memories",
        description:
          "Search past memories using hybrid vector + BM25 + graph cascade. " +
          "Returns relevant memories ranked by relevance score. " +
          "Use when user asks about previous conversations, past decisions, or things you remember.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query" }),
          max_results: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 20, default: 5 })
          ),
          agent_id: Type.Optional(Type.String()),
          min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0 })),
        }),
        async execute(_toolCallId: string, params: { query: string; max_results?: number; agent_id?: string; min_score?: number }) {
          try {
            const data = await serverRequest<{
              results: Array<{
                id: string;
                content: string;
                category: string;
                agent_id: string;
                relevance_score: number;
              }>;
              count: number;
              layers: { l1: number; l2: number; l3: number };
            }>("/recall", {
              query: params.query,
              max_results: params.max_results ?? 5,
              agent_id: params.agent_id,
              min_score: params.min_score ?? 0,
            });

            if (!data.results.length) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const lines = data.results.map((r, i) =>
              `${i + 1}. [${r.category || "memory"}] ${r.content} (score: ${((r.relevance_score ?? 0) * 100).toFixed(0)}%)`
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Found ${data.count} memories (L1=${data.layers.l1} L2=${data.layers.l2} L3=${data.layers.l3}):\n${lines.join("\n")}`,
                },
              ],
              details: { count: data.count, layers: data.layers },
            };
          } catch (err) {
            api.logger.error?.(`[memory-recall] recall error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Memory recall failed: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "recall_memories" }
    );

    api.registerTool(
      {
        name: "store_memory",
        label: "Store Memory",
        description:
          "Store a piece of information in long-term memory. " +
          "Automatically extracts 6W (who/what/when/where/why/how), category, and importance via LLM.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content to store" }),
          agent_id: Type.Optional(Type.String({ description: "Agent identifier" })),
          conversation_id: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId: string, params: { content: string; agent_id?: string; conversation_id?: string; metadata?: Record<string, unknown> }) {
          try {
            const data = await serverRequest<{
              memory_id: string;
              conversation_id: string;
              category: string;
              importance: number;
            }>("/store", {
              content: params.content,
              agent_id: params.agent_id,
              conversation_id: params.conversation_id,
              metadata: params.metadata,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Memory stored successfully.\nID: ${data.memory_id}\nCategory: ${data.category}\nImportance: ${(data.importance * 100).toFixed(0)}%`,
                },
              ],
              details: data,
            };
          } catch (err) {
            api.logger.error?.(`[memory-recall] store error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to store memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "store_memory" }
    );

    api.registerTool(
      {
        name: "forget_memory",
        label: "Forget Memory",
        description: "Delete a specific memory by its ID.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The memory ID to delete" }),
        }),
        async execute(_toolCallId: string, params: { memory_id: string }) {
          try {
            await serverRequest("/forget", { memory_id: params.memory_id });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} deleted.` }],
              details: { memory_id: params.memory_id, deleted: true },
            };
          } catch (err) {
            api.logger.error?.(`[memory-recall] forget error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to delete memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "forget_memory" }
    );

    api.registerTool(
      {
        name: "update_memory",
        label: "Update Memory",
        description: "Update content or metadata of an existing memory.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The memory ID to update" }),
          content: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId: string, params: { memory_id: string; content?: string; metadata?: Record<string, unknown> }) {
          try {
            await serverRequest("/update", {
              memory_id: params.memory_id,
              content: params.content,
              metadata: params.metadata,
            });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} updated.` }],
              details: { memory_id: params.memory_id, updated: true },
            };
          } catch (err) {
            api.logger.error?.(`[memory-recall] update error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to update memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "update_memory" }
    );

    const autoStore = config.autoStore !== false;
    const autoRecall = config.autoRecall !== false;

    if (autoStore) {
      api.on("message_received", async (event, ctx) => {
        const text = extractText(event.content);
        if (!text || text.length < 10) return;
        try {
          await serverRequest("/store", {
            content: text,
            agent_id: event.from,
            conversation_id: ctx.conversationId,
            metadata: {
              role: "user",
              sender: event.from,
              channel_id: ctx.channelId,
            },
          });
          api.logger.debug?.(`[memory-recall] auto-stored user message`);
        } catch (err) {
          api.logger.warn?.(`[memory-recall] auto-store failed: ${String(err)}`);
        }
      });

      api.on("agent_end", async (event) => {
        try {
          const messages = event.messages as Array<{ role?: string; content?: unknown }>;
          for (const msg of messages) {
            if (msg.role === "assistant") {
              const text = extractText(msg.content);
              if (text && text.length > 10) {
                await serverRequest("/store", {
                  content: text,
                  metadata: { role: "assistant" },
                });
              }
            }
          }
        } catch (err) {
          api.logger.warn?.(`[memory-recall] agent_end store failed: ${String(err)}`);
        }
      });
    }

    if (autoRecall) {
      api.on("before_prompt_build", async (event) => {
        const prompt = event.prompt;
        if (!prompt || prompt.length < 5) return;
        try {
          const data = await serverRequest<{
            results: Array<{ content: string; relevance_score: number }>;
            count: number;
          }>("/recall", {
            query: prompt,
            max_results: config.autoRecallMaxItems ?? 3,
          });
          if (!data.results.length) return;

          const maxChars = config.autoRecallMaxChars ?? 600;
          const selected: string[] = [];
          let totalChars = 0;
          for (const r of data.results) {
            if (totalChars + r.content.length > maxChars) break;
            selected.push(`[${((r.relevance_score ?? 0) * 100).toFixed(0)}%] ${r.content}`);
            totalChars += r.content.length;
          }

          if (!selected.length) return;

          api.logger.info?.(`[memory-recall] auto-recall injecting ${selected.length} memories`);
          return {
            prependContext: `<relevant-memories>\n${selected.join("\n")}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn?.(`[memory-recall] auto-recall failed: ${String(err)}`);
        }
      });
    }

    api.logger.info?.("[memory-recall] all hooks and tools registered");
  },
};

export default memoryRecallPlugin;
