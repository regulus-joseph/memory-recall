/**
 * Memory Recall - OpenClaw Plugin
 * Architecture: TS plugin → Python worker (stdio JSON-RPC) → per-agent LanceDB + NetworkX Graph
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

interface MemoryRecallConfig {
  autoStore?: boolean;
  autoRecall?: boolean;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  decayEnabled?: boolean;
  decayIntervalHours?: number;
}

function parsePluginConfig(value: unknown): MemoryRecallConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as MemoryRecallConfig;
}

const PYTHON_BIN = process.env.PYTHON_BIN || "/home/marlon-wei/.memory-recall-venv/bin/python";

class WorkerClient {
  private proc: ReturnType<typeof spawn>;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private nextId = 1;
  private ready = false;
  private readyPromise: Promise<void>;
  private stderr = "";

  constructor(pythonBin: string, workerPath: string) {
    this.proc = spawn(pythonBin, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });

    this.proc.stdout?.on("data", (d: Buffer) => {
      this.handleLine(d.toString());
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`worker init timeout, stderr: ${this.stderr.slice(0, 200)}`));
      }, 10000);
      this.proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.onceReady = () => {
        clearTimeout(timer);
        this.ready = true;
        resolve();
      };
    });
  }

  private onceReady: () => void = () => {};
  private initPromise: Promise<void> = this.readyPromise;

  private handleLine(data: string) {
    const lines = data.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!this.ready && line.includes('"result"')) {
        this.onceReady();
      }
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const cb = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            cb.resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin?.write(req);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout calling ${method}`));
        }
      }, 30000);
    });
  }

  async health(): Promise<{ status: string }> {
    return this.call("health", {});
  }

  async store(params: {
    content: string;
    agent_id?: string;
    conversation_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ memory_id: string; conversation_id: string; dedup: boolean }> {
    return this.call("store", params);
  }

  async recall(params: {
    query: string;
    agent_id?: string;
    max_results?: number;
    min_score?: number;
  }): Promise<{
    results: Array<Record<string, unknown>>;
    count: number;
    layers: { l1: number; l2: number; l3: number };
  }> {
    return this.call("recall", params);
  }

  async forget(params: { memory_id: string }): Promise<{ memory_id: string; deleted: boolean }> {
    return this.call("forget", params);
  }

  async update(params: {
    memory_id: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ memory_id: string; updated: boolean }> {
    return this.call("update", params);
  }

  async stats(params: { agent_id?: string }): Promise<{
    memory_count: number;
    bm25_doc_count: number;
    graph_node_count: number;
  }> {
    return this.call("stats", params);
  }

  async compact(params: { dry_run?: boolean; limit?: number; scopes?: string[] }): Promise<{
    clusters_found: number;
    memories_deleted: number;
    memories_created: number;
    dry_run: boolean;
  }> {
    return this.call("compact", params);
  }

  async graphRebuild(params: { agent_id?: string }): Promise<{
    agents_rebuilt: number;
    dangling_edges_cleaned: number;
  }> {
    return this.call("graph_rebuild", params);
  }

  async decayScan(params: {
    dry_run?: boolean;
    limit?: number;
    also_compact?: boolean;
    also_graph_rebuild?: boolean;
    agent_id?: string;
  }): Promise<{
    stale_count: number;
    stale_memories: Array<Record<string, unknown>>;
    deleted: number;
    compacted: number;
    dry_run: boolean;
  }> {
    return this.call("decay_scan", params);
  }

  kill() {
    this.proc.kill();
  }
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
    "L1/L2/L3 cascade memory recall with per-agent LanceDB, Weibull decay, and progressive compaction.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);

    const require = createRequire(import.meta.url);
    const pluginDir = require.resolve("./index.ts").replace(/\/index\.ts$/, "");
    const workerPath = require.resolve("./worker.py").replace(/\.py$/, ".py");
    const pythonBin = process.env.PYTHON_BIN || PYTHON_BIN;

    let worker: WorkerClient;
    try {
      worker = new WorkerClient(pythonBin, workerPath);
      worker.health().catch((e) => {
        api.logger.error(`[memory-recall] worker failed to start: ${e.message}`);
      });
    } catch (e) {
      api.logger.error(`[memory-recall] worker spawn failed: ${String(e)}`);
      return;
    }

    api.logger.info(`[memory-recall] register, python=${pythonBin}`);

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
      const regCap = (api as unknown as { registerMemoryCapability: (id: string, rt: unknown) => void }).registerMemoryCapability;
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
          max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
          agent_id: Type.Optional(Type.String()),
          min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0 })),
        }),
        async execute(_toolCallId: string, params: {
          query: string; max_results?: number; agent_id?: string; min_score?: number;
        }) {
          try {
            const data = await worker.recall({
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

            const lines = data.results.map((r: Record<string, unknown>, i: number) =>
              `${i + 1}. [${r.category || "memory"}] ${r.content} (score: ${((r.relevance_score as number ?? 0) * 100).toFixed(0)}%)`
            );
            return {
              content: [{
                type: "text",
                text: `Found ${data.count} memories (L1=${data.layers.l1} L2=${data.layers.l2} L3=${data.layers.l3}):\n${lines.join("\n")}`,
              }],
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
        description: "Store a piece of information in long-term memory.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content to store" }),
          agent_id: Type.Optional(Type.String({ description: "Agent identifier" })),
          conversation_id: Type.Optional(Type.String()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId: string, params: {
          content: string; agent_id?: string; conversation_id?: string; metadata?: Record<string, unknown>;
        }) {
          try {
            const data = await worker.store({
              content: params.content,
              agent_id: params.agent_id,
              conversation_id: params.conversation_id,
              metadata: params.metadata,
            });
            return {
              content: [{
                type: "text",
                text: `Memory stored.\nID: ${data.memory_id}${data.dedup ? " (dedup hit)" : ""}`,
              }],
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
            const data = await worker.forget({ memory_id: params.memory_id });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} deleted.` }],
              details: data,
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
        async execute(_toolCallId: string, params: {
          memory_id: string; content?: string; metadata?: Record<string, unknown>;
        }) {
          try {
            const data = await worker.update({
              memory_id: params.memory_id,
              content: params.content,
              metadata: params.metadata,
            });
            return {
              content: [{ type: "text", text: `Memory ${params.memory_id} updated.` }],
              details: data,
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
          await worker.store({
            content: text,
            agent_id: event.from,
            conversation_id: event.conversationId,
            metadata: { role: "user", sender: event.from, channel_id: event.channelId },
          });
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
                await worker.store({
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
      api.on("before_prompt_build", async (params: { sessionMessages?: string[]; userMessage?: string }) => {
        const userMessage = params?.userMessage || "";
        if (!userMessage || userMessage.length < 3) return { prependContext: "" };

        try {
          const data = await worker.recall({
            query: userMessage,
            max_results: config.autoRecallMaxItems ?? 3,
          });

          if (!data.results.length) return { prependContext: "" };

          const maxChars = config.autoRecallMaxChars ?? 600;
          const selected: string[] = [];
          let totalChars = 0;
          for (const r of data.results) {
            if (totalChars + (r.content as string).length > maxChars) break;
            const cat = r.category || "memory";
            const score = ((r.relevance_score as number ?? 0) * 100).toFixed(0);
            selected.push(`[${cat}][${score}%] ${r.content}`);
            totalChars += (r.content as string).length + 30;
          }

          if (!selected.length) return { prependContext: "" };

          api.logger.info(`[memory-recall] injecting ${selected.length} memories (${totalChars} chars)`);

          return {
            prependContext: `<relevant-memories>\n${selected.join("\n")}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`[memory-recall] auto-recall failed: ${String(err)}`);
          return { prependContext: "" };
        }
      }, { name: "memory-recall-autorecall" });
    }

    api.logger.info("[memory-recall] all hooks and tools registered");

    if (config.decayEnabled !== false) {
      const intervalMs = (config.decayIntervalHours ?? 24) * 60 * 60 * 1000;
      let decayTimer: ReturnType<typeof setInterval> | null = null;
      let stopFn: (() => void) | null = null;

      const runDecayCycle = async (logger: typeof api.logger) => {
        try {
          logger.info("[memory-recall] decay cycle starting...");
          const scanResult = await worker!.decayScan({ dry_run: true, limit: 50 });
          const staleCount = scanResult.stale_count ?? 0;
          logger.info(`[memory-recall] decay scan: ${staleCount} stale memories`);

          if (staleCount > 0) {
            const compactResult = await worker!.compact({ dry_run: false, limit: 200 });
            logger.info(`[memory-recall] compact: ${compactResult.clusters_found} clusters, ${compactResult.memories_deleted} deleted`);
            const decayResult = await worker!.decayScan({
              dry_run: false,
              also_compact: false,
              also_graph_rebuild: false,
              limit: 50,
            });
            logger.info(`[memory-recall] decay delete: ${decayResult.deleted} deleted`);
          }

          const graphResult = await worker!.graphRebuild({});
          logger.info(`[memory-recall] graph rebuild: ${graphResult.dangling_edges_cleaned} dangling edges cleaned`);
        } catch (err) {
          logger.warn(`[memory-recall] decay cycle failed: ${String(err)}`);
        }
      };

      api.registerService({
        id: "memory-recall-decay",
        start: async (ctx) => {
          ctx.logger.info(`[memory-recall] decay service starting (interval: ${intervalMs}ms)`);
          await runDecayCycle(ctx.logger);
          decayTimer = setInterval(() => runDecayCycle(ctx.logger), intervalMs);
          stopFn = () => {
            if (decayTimer) clearInterval(decayTimer);
          };
        },
        stop: () => {
          if (stopFn) stopFn();
        },
      });
    }
  },
};

export default memoryRecallPlugin;
