/**
 * Memory Recall - OpenClaw Plugin
 * L1/L2/L3 memory recall via Qdrant vector storage
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

interface MemoryRecallConfig {
  qdrant?: {
    host?: string;
    port?: number;
    collection?: string;
  };
  embedding?: {
    baseURL?: string;
    model?: string;
    dimensions?: number;
  };
  autoStore?: boolean;
}

interface PluginState {
  config: MemoryRecallConfig;
}

let _singletonState: PluginState | null = null;

function parsePluginConfig(value: unknown): MemoryRecallConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as MemoryRecallConfig;
}

async function getEmbedding(
  text: string,
  baseUrl: string,
  model: string
): Promise<number[]> {
  try {
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.embedding ?? [];
  } catch {
    return [];
  }
}

async function storeMemory(
  content: string,
  metadata: Record<string, unknown>,
  config: MemoryRecallConfig,
  api: OpenClawPluginApi
): Promise<boolean> {
  const qdrantHost = config.qdrant?.host ?? "localhost";
  const qdrantPort = config.qdrant?.port ?? 6333;
  const collection = config.qdrant?.collection ?? "memory_recall";
  const embeddingUrl = "http://localhost:11434/api/embeddings";
  const embeddingModel = config.embedding?.model ?? "bge-m3";

  try {
    const embedding = await getEmbedding(content, embeddingUrl, embeddingModel);
    if (!embedding?.length) {
      api.logger.warn?.(`[memory-recall] storeMemory: empty embedding for content="${String(content).substring(0, 30)}..."`);
      return false;
    }

    const id = Date.now();
    const point = {
      id,
      vector: embedding,
      payload: {
        content: String(content),
        ...metadata,
        stored_at: new Date().toISOString(),
      },
    };

    const url = `http://${qdrantHost}:${qdrantPort}/collections/${collection}/points`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [point] }),
    });

    if (!resp.ok) {
      api.logger.error?.(`[memory-recall] Failed to store memory: ${resp.status}`);
      return false;
    }
    api.logger.info?.(`[memory-recall] Stored memory id=${id}, content="${String(content).substring(0, 30)}..."`);
    return true;
  } catch (err) {
    api.logger.error?.(`[memory-recall] Store memory failed: ${String(err)}`);
    return false;
  }
}

async function recallMemories(
  query: string,
  config: MemoryRecallConfig,
  api: OpenClawPluginApi
): Promise<Array<{
  content: string;
  agent_id?: string;
  timestamp?: string;
  relevance_score?: number;
}>> {
  const qdrantHost = config.qdrant?.host ?? "localhost";
  const qdrantPort = config.qdrant?.port ?? 6333;
  const collection = config.qdrant?.collection ?? "memory_recall";
  const embeddingUrl = "http://localhost:11434/api/embeddings";
  const embeddingModel = config.embedding?.model ?? "bge-m3";

  try {
    const queryEmb = await getEmbedding(query, embeddingUrl, embeddingModel);
    if (!queryEmb?.length) return [];

    const searchUrl = `http://${qdrantHost}:${qdrantPort}/collections/${collection}/points/search`;
    const searchResp = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: queryEmb,
        limit: 5,
        with_payload: true,
      }),
    });

    if (!searchResp.ok) return [];
    const data = await searchResp.json();
    const results = data.result ?? [];

    return results.map((p: { payload: Record<string, unknown>; score: number }) => ({
      content: p.payload.content as string,
      agent_id: p.payload.agent_id as string | undefined,
      timestamp: p.payload.timestamp as string | undefined,
      relevance_score: p.score,
    }));
  } catch (err) {
    api.logger.error?.(`[memory-recall] Recall failed: ${String(err)}`);
    return [];
  }
}

const memoryRecallPlugin = {
  id: "memory-recall",
  name: "Memory Recall",
  description: "L1/L2/L3 memory recall plugin for OpenClaw agents with Qdrant vector storage",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    _singletonState = { config };

    api.logger.info?.("[memory-recall] register called");

    // Register recall_memories as a tool the agent can call on-demand
    api.registerTool({
      name: "recall_memories",
      label: "Memory Recall",
      description: "Search past memories from vector database. Use when user asks about previous conversations, past decisions, or things you remember. Returns relevant memories with relevance scores.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query to find relevant memories" }),
      }),
      async execute(_toolCallId: string, params: { query: string }) {
        api.logger.info?.(`[memory-recall] recall_memories execute called with query: ${params.query}`);
        const results = await recallMemories(params.query, config, api);
        if (!results.length) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0 }
          };
        }
        const formatted = results.map((r, i) =>
          `${i + 1}. [${r.agent_id ?? "unknown"}] ${r.content} (relevance: ${((r.relevance_score ?? 0) * 100).toFixed(0)}%)`
        ).join("\n");
        return {
          content: [{ type: "text", text: `Found ${results.length} relevant memories:\n${formatted}` }],
          details: { count: results.length }
        };
      },
    }, { name: "recall_memories" });

    // Helper to extract plain text from content (handles string, array of blocks, or object)
    function extractText(content: unknown): string | null {
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content
          .filter((b: unknown) => b && typeof b === "object" && "type" in b && (b as Record<string, unknown>).type === "text" && "text" in b)
          .map((b: unknown) => ((b as Record<string, unknown>).text as string) || "")
          .filter(Boolean)
          .join("\n")
          .trim();
      }
      if (content && typeof content === "object" && "text" in content) {
        return (content as Record<string, unknown>).text as string;
      }
      return null;
    }

    // Auto-store: message_received for user input (all channels - TUI, dashboard, channels)
    if (config.autoStore !== false) {
      api.on("message_received", async (event, ctx) => {
        const text = extractText(event.content);
        if (!text) return;
        await storeMemory(text, {
          role: "user",
          sender: event.from,
          channel_id: ctx.channelId,
          conversation_id: ctx.conversationId,
        }, config, api);
      });

      // agent_end for agent replies (has full messages[] including assistant responses)
      api.on("agent_end", async (event) => {
        try {
          const messages = event.messages as Array<{ role?: string; content?: unknown }>;
          for (const msg of messages) {
            if (msg.role === "assistant") {
              const text = extractText(msg.content);
              if (text) {
                await storeMemory(text, { role: "assistant" }, config, api);
              }
            }
          }
        } catch (err) {
          api.logger.error?.(`[memory-recall] agent_end store failed: ${String(err)}`);
        }
      });
    }

    // Auto-recall: inject relevant memories before agent starts
    const autoRecall = (config as Record<string, unknown>).autoRecall;
    if (autoRecall !== false) {
      api.on("before_agent_start", async (event) => {
        const prompt = event.prompt;
        if (!prompt || prompt.length < 5) return;
        try {
          const results = await recallMemories(prompt, config, api);
          if (results.length === 0) return;
          api.logger.info?.(`[memory-recall] injecting ${results.length} memories into context`);
          const formatted = results.map((r, i) =>
            `${i + 1}. [${r.agent_id ?? "unknown"}] ${r.content} (relevance: ${((r.relevance_score ?? 0) * 100).toFixed(0)}%)`
          ).join("\n");
          return {
            prependContext: `<relevant-memories>\n${formatted}\n</relevant-memories>`
          };
        } catch (err) {
          api.logger.warn?.(`[memory-recall] auto-recall failed: ${String(err)}`);
        }
      });
    }
  },
};

export default memoryRecallPlugin;