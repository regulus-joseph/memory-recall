/**
 * Memory Recall - OpenClaw Plugin (Phase 2)
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
}

function parsePluginConfig(value: unknown): MemoryRecallConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as MemoryRecallConfig;
}

const BASE_URL = SERVER_BASE.endsWith("/") ? SERVER_BASE.slice(0, -1) : SERVER_BASE;

async function serverPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
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

const memoryRecallPlugin = {
  id: "memory-recall",
  name: "Memory Recall",
  description:
    "L1/L2/L3 cascade memory recall with async extraction. Stores user/assistant messages and injects relevant memories before LLM response.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const baseUrl = (config.serverUrl ?? BASE_URL).replace(/\/$/, "");

    api.logger.info(`[memory-recall] register, server=${baseUrl}`);

    try {
      const runtimeObj = {
        getMemorySearchManager: async () => ({
          manager: {
            status: () => ({
              backend: "builtin" as const,
              provider: "memory-recall",
              embeddingAvailable: true,
              retrievalAvailable: true,
            }),
            probeEmbeddingAvailability: async () => ({ ok: true }),
            probeVectorAvailability: async () => true,
          },
        }),
        resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const regCap = (api as any).registerMemoryCapability;
      if (typeof regCap === "function") {
        regCap("memory-recall", { runtime: runtimeObj });
        api.logger.info("[memory-recall] memory capability registered");
      }
    } catch (err) {
      api.logger.warn(`[memory-recall] memory capability skipped: ${String(err)}`);
    }

    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memories",
        description:
          "Search past memories using hybrid vector + BM25 + graph cascade. " +
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
            const data = await serverPost<{
              results: Array<{
                id: string;
                content: string;
                category: string;
                agent_id: string;
                relevance_score: number;
              }>;
              count: number;
              layers: { l1: number; l2: number; l3: number };
            }>(`${baseUrl}/recall`, {
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
            api.logger.error(`[memory-recall] recall error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Memory recall failed: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_recall" }
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description:
          "Store a piece of information in long-term memory. " +
          "Automatically extracts 6W (who/what/when/where/why/how), MLP category (profile/preferences/entities/events/cases/patterns), and importance via LLM.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content to store" }),
          agent_id: Type.Optional(Type.String({ description: "Agent identifier" })),
          conversation_id: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId: string, params: { content: string; agent_id?: string; conversation_id?: string; metadata?: Record<string, unknown> }) {
          api.logger.info(`[memory-recall] store_memory execute, content=${params.content}`);
          try {
            const url = `${baseUrl}/store`;
            api.logger.info(`[memory-recall] posting to ${url}`);
            const data = await serverPost<{
              memory_id: string;
              conversation_id: string;
              pending: boolean;
            }>(`${baseUrl}/store`, {
              content: params.content,
              agent_id: params.agent_id,
              conversation_id: params.conversation_id,
              metadata: params.metadata,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Memory stored.\nID: ${data.memory_id}\nPending extraction: ${data.pending}`,
                },
              ],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] store error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to store memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store" }
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description: "Delete a specific memory by its ID.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The memory ID to delete" }),
        }),
        async execute(_toolCallId: string, params: { memory_id: string }) {
          try {
            await serverPost(`${baseUrl}/forget`, { memory_id: params.memory_id });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} deleted.` }],
              details: { memory_id: params.memory_id, deleted: true },
            };
          } catch (err) {
            api.logger.error(`[memory-recall] forget error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to delete memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" }
    );

    api.registerTool(
      {
        name: "memory_update",
        label: "Update Memory",
        description: "Update content or metadata of an existing memory.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The memory ID to update" }),
          content: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId: string, params: { memory_id: string; content?: string; metadata?: Record<string, unknown> }) {
          try {
            await serverPost(`${baseUrl}/update`, {
              memory_id: params.memory_id,
              content: params.content,
              metadata: params.metadata,
            });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} updated.` }],
              details: { memory_id: params.memory_id, updated: true },
            };
          } catch (err) {
            api.logger.error(`[memory-recall] update error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to update memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_update" }
    );

    const autoStore = config.autoStore !== false;
    const autoRecall = config.autoRecall !== false;

    if (autoStore) {
      api.registerHook("message_received", async (event) => {
        const text = extractText(event.content);
        if (!text || text.length < 10) return;
        try {
          await serverPost(`${baseUrl}/store`, {
            content: text,
            agent_id: event.from,
            conversation_id: event.conversationId,
            metadata: {
              role: "user",
              sender: event.from,
              channel_id: event.channelId,
            },
          });
          api.logger.debug(`[memory-recall] auto-stored user message`);
        } catch (err) {
          api.logger.warn(`[memory-recall] auto-store failed: ${String(err)}`);
        }
      }, { name: "memory-recall-autostore" });

      api.registerHook("agent_end", async (event) => {
        const messages = event.messages as Array<{ role?: string; content?: unknown }>;
        for (const msg of messages) {
          if (msg.role === "assistant") {
            const text = extractText(msg.content);
            if (text && text.length > 10) {
              try {
                await serverPost(`${baseUrl}/store`, {
                  content: text,
                  metadata: { role: "assistant" },
                });
              } catch (err) {
                api.logger.warn(`[memory-recall] agent_end store failed: ${String(err)}`);
              }
            }
          }
        }
      }, { name: "memory-recall-agent-end" });
    }

    if (autoRecall) {
      api.registerHook("before_prompt_build", async (event) => {
        const prompt = (event as { prompt?: string }).prompt;
        if (!prompt || prompt.length < 3) return;

        try {
          const data = await serverPost<{
            results: Array<{
              content: string;
              category: string;
              relevance_score: number;
            }>;
            count: number;
          }>(`${baseUrl}/recall`, {
            query: prompt,
            max_results: config.autoRecallMaxItems ?? 3,
          });

          if (!data.results.length) return;

          const maxChars = config.autoRecallMaxChars ?? 600;
          const selected: string[] = [];
          let totalChars = 0;
          for (const r of data.results) {
            if (totalChars + r.content.length > maxChars) break;
            const cat = r.category || "memory";
            const score = ((r.relevance_score ?? 0) * 100).toFixed(0);
            selected.push(`[${cat}][${score}%] ${r.content}`);
            totalChars += r.content.length + 30;
          }

          if (!selected.length) return;

          api.logger.info(`[memory-recall] injecting ${selected.length} memories (${totalChars} chars)`);

          return {
            prependContext: `<relevant-memories>\n${selected.join("\n")}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`[memory-recall] auto-recall failed: ${String(err)}`);
        }
      }, { name: "memory-recall-autorecall" });
    }

    api.logger.info("[memory-recall] all hooks and tools registered");
  },
};

export default memoryRecallPlugin;
