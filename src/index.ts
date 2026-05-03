/**
 * Memory Recall - OpenClaw Plugin
 * Architecture: TS plugin → Pool Worker (HTTP JSON-RPC) → per-agent LanceDB + NetworkX Graph
 *
 * Two transport modes (set USE_HTTP_POOL=1 env to switch):
 *   stdin  (default):  TS plugin → worker.py subprocess (stdio JSON-RPC)
 *   http   (pool):     TS plugin → pool_router.py (HTTP) → worker.py subprocess per session
 *
 * Design: recall is non-blocking via session-level cache.
 * - message_received → fire-and-forget recall → update cache
 * - before_prompt_build → read cache (synchronous, <1ms) → inject
 *
 * Store (agent_end) is awaited since storage must complete before session ends.
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

interface RecallCache {
  query:      string;
  results:    Array<{ content: unknown; relevance_score: unknown; category: unknown }>;
  expire:     number;
}

const RECALL_CACHE_TTL_MS = 30_000;

const recallCache = new Map<string, RecallCache>();

interface SessionBufferEntry {
  content: string;
  metadata: Record<string, unknown>;
}
const sessionBuffers = new Map<string, SessionBufferEntry[]>();

let _worker: WorkerClient | undefined;

class WorkerClient {
  private proc: ReturnType<typeof spawn>;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private nextId = 1;
  private ready = false;
  private dead = false;
  private readyPromise: Promise<void>;
  private stderr = "";
  private pythonBin: string;
  private workerPath: string;
  private cwd: string;

  constructor(pythonBin: string, workerPath: string, cwd: string) {
    this.pythonBin = pythonBin;
    this.workerPath = workerPath;
    this.cwd = cwd;
    this.proc = spawn(pythonBin, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      cwd,
    });
    this._setupProcessHandlers();
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
        this.dead = false;
        resolve();
      };
    });
    this.initPromise = this.readyPromise;
    this._ping().catch(() => {});
  }

  private onceReady: () => void = () => {};
  private initPromise: Promise<void>;

  private _ping(): Promise<void> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v: unknown) => resolve(),
        reject: () => resolve(),
      });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: {} }) + "\n";
      this.proc.stdin?.write(req);
      setTimeout(() => {
        this.pending.delete(id);
        resolve();
      }, 5000);
    });
  }

  private _setupProcessHandlers() {
    this.proc.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });

    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ECONNRESET") {
        console.warn("[memory-recall] worker stdin EPIPE (process died), will restart on next call");
        this.ready = false;
        this.dead = true;
      }
    });

    this.proc.stdout?.on("data", (d: Buffer) => {
      this.handleLine(d.toString());
    });
  }

  private async _restart(): Promise<void> {
    if (!this.dead) return;
    this.proc.kill();
    this.pending.clear();
    this.stderr = "";
    this.nextId = 1;
    this.ready = false;
    this.proc = spawn(this.pythonBin, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      cwd: this.cwd,
    });
    this._setupProcessHandlers();
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`worker restart timeout, stderr: ${this.stderr.slice(0, 200)}`));
      }, 10000);
      this.proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.onceReady = () => {
        clearTimeout(timer);
        this.ready = true;
        this.dead = false;
        resolve();
      };
    });
    this.initPromise = this.readyPromise;
    this._ping().catch(() => {});
  }

  private handleLine(data: string) {
    const lines = data.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (!this.ready && msg.id !== undefined && "result" in msg) {
          this.onceReady();
        }
        if (msg.id !== undefined && this.pending.has(msg.id as number)) {
          const cb = this.pending.get(msg.id as number)!;
          this.pending.delete(msg.id as number);
          if (msg.error) {
            cb.reject(new Error((msg.error as { message?: string }).message || JSON.stringify(msg.error)));
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
    if (this.dead) await this._restart();
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
  }, _sessionId?: string): Promise<{ memory_id: string; conversation_id: string; dedup: boolean }> {
    return this.call("store", params);
  }

  async recall(params: {
    query: string;
    agent_id?: string;
    max_results?: number;
    min_score?: number;
  }, _sessionId?: string): Promise<{
    results: Array<Record<string, unknown>>;
    count: number;
    layers: { l1: number; l2: number; l3: number };
  }> {
    return this.call("recall", params);
  }

  async forget(params: { memory_id: string }, _sessionId?: string): Promise<{ memory_id: string; deleted: boolean }> {
    return this.call("forget", params);
  }

  async get(params: { memory_id: string; agent_id?: string }, _sessionId?: string): Promise<Record<string, unknown>> {
    return this.call("get", params);
  }

  async browse(params: {
    conversation_id?: string;
    agent_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    summary_only?: boolean;
  }, _sessionId?: string): Promise<{
    memories?: Array<Record<string, unknown>>;
    conversations?: Array<Record<string, unknown>>;
    count?: number;
    total_memories?: number;
    conversation_id?: string;
    agent_id?: string;
    error?: string;
  }> {
    return this.call("browse", params);
  }

  async update(params: {
    memory_id: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }, _sessionId?: string): Promise<{ memory_id: string; updated: boolean }> {
    return this.call("update", params);
  }

  async stats(params: { agent_id?: string }, _sessionId?: string): Promise<{
    memory_count: number;
    bm25_doc_count: number;
    graph_node_count: number;
  }> {
    return this.call("stats", params);
  }

  async compact(params: { dry_run?: boolean; limit?: number; scopes?: string[] }, _sessionId?: string): Promise<{
    clusters_found: number;
    memories_deleted: number;
    memories_created: number;
    dry_run: boolean;
  }> {
    return this.call("compact", params);
  }

  async graphRebuild(params: { agent_id?: string }, _sessionId?: string): Promise<{
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
  }, _sessionId?: string): Promise<{
    stale_count: number;
    stale_memories: Array<Record<string, unknown>>;
    deleted: number;
    compacted: number;
    dry_run: boolean;
  }> {
    return this.call("decay_scan", params);
  }

  async list(params: {
    agent_id?: string;
    category?: string;
    conversation_id?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  }, _sessionId?: string): Promise<{
    memories: Array<Record<string, unknown>>;
    count: number;
    offset: number;
    limit: number;
    agent_id: string;
  }> {
    return this.call("list", params);
  }

  async search(params: {
    query: string;
    agent_id?: string;
    limit?: number;
    offset?: number;
  }, _sessionId?: string): Promise<{
    results: Array<Record<string, unknown>>;
    count: number;
  }> {
    return this.call("search", params);
  }

  kill() {
    this.proc.kill();
  }

  async extract(params: { content: string }): Promise<{
    category: string;
    importance: number;
    confidence: number;
    temporal_type: string;
    who: string;
    what: string;
    when: string;
    where: string;
    why: string;
    how: string;
    summary: string;
  }> {
    return this.call("extract", params);
  }

  async reset(params: { agent_id?: string; force?: boolean }): Promise<{
    reset: boolean;
    deleted?: number;
    agent_id?: string;
    error?: string;
  }> {
    return this.call("reset", params);
  }
}

// ─── HTTP Pool Client ───────────────────────────────────────────────────────────────
// Used when USE_HTTP_POOL=1. Talks to pool_router.py (default port 18799).
// Each call passes _session_id for session affinity.

const POOL_ROUTER_URL = process.env.MR_ROUTER_URL || "http://127.0.0.1:18799";

class PoolWorkerClient {
  private routerUrl: string;

  constructor(routerUrl?: string) {
    this.routerUrl = routerUrl || POOL_ROUTER_URL;
  }

  private async _call<T>(method: string, params: Record<string, unknown>, sessionId?: string): Promise<T> {
    const body: Record<string, unknown> = { ...params };
    if (sessionId) body._session_id = sessionId;

    const resp = await fetch(`${this.routerUrl}/mr/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => resp.statusText);
      throw new Error(`pool HTTP ${resp.status}: ${detail}`);
    }

    const data = await resp.json() as T;
    return data;
  }

  async health(): Promise<{ status: string }> {
    return this._call("health", {}, undefined);
  }

  async store(params: {
    content: string;
    agent_id?: string;
    conversation_id?: string;
    metadata?: Record<string, unknown>;
  }, sessionId?: string): Promise<{ memory_id: string; conversation_id: string; dedup: boolean }> {
    return this._call("store", params, sessionId);
  }

  async recall(params: {
    query: string;
    agent_id?: string;
    max_results?: number;
    min_score?: number;
  }, sessionId?: string): Promise<{
    memories: Array<{ content: unknown; relevance_score: number; category: string }>;
    recall_time_ms: number;
  }> {
    return this._call("recall", params, sessionId);
  }

  async forget(params: { memory_id: string }, sessionId?: string): Promise<{ memory_id: string; deleted: boolean }> {
    return this._call("forget", params, sessionId);
  }

  async get(params: { memory_id: string; agent_id?: string }, sessionId?: string): Promise<Record<string, unknown>> {
    return this._call("get", params, sessionId);
  }

  async browse(params: {
    conversation_id?: string;
    agent_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    summary_only?: boolean;
  }, sessionId?: string): Promise<{
    memories?: Array<Record<string, unknown>>;
    conversations?: Array<Record<string, unknown>>;
    count?: number;
    total_memories?: number;
    conversation_id?: string;
    agent_id?: string;
    error?: string;
  }> {
    return this._call("browse", params, sessionId);
  }

  async update(params: {
    memory_id: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }, sessionId?: string): Promise<{ memory_id: string; updated: boolean }> {
    return this._call("update", params, sessionId);
  }

  async stats(params: { agent_id?: string }, sessionId?: string): Promise<{
    memory_count: number;
    bm25_doc_count: number;
    graph_node_count: number;
  }> {
    return this._call("stats", params, sessionId);
  }

  async compact(params: { dry_run?: boolean; limit?: number; scopes?: string[] }, sessionId?: string): Promise<{
    clusters_found: number;
    memories_deleted: number;
    memories_created: number;
    dry_run: boolean;
  }> {
    return this._call("compact", params, sessionId);
  }

  async graphRebuild(params: { agent_id?: string }, sessionId?: string): Promise<{
    agents_rebuilt: number;
    dangling_edges_cleaned: number;
  }> {
    return this._call("graph_rebuild", params, sessionId);
  }

  async decayScan(params: {
    dry_run?: boolean;
    limit?: number;
    also_compact?: boolean;
    also_graph_rebuild?: boolean;
    agent_id?: string;
  }, sessionId?: string): Promise<{
    stale_count: number;
    stale_memories: Array<Record<string, unknown>>;
    deleted: number;
    compacted: number;
    dry_run: boolean;
  }> {
    return this._call("decay_scan", params, sessionId);
  }

  async list(params: {
    agent_id?: string;
    category?: string;
    conversation_id?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  }, sessionId?: string): Promise<{
    memories: Array<Record<string, unknown>>;
    count: number;
    offset: number;
    limit: number;
    agent_id: string;
  }> {
    return this._call("list", params, sessionId);
  }

  async search(params: {
    query: string;
    agent_id?: string;
    limit?: number;
    offset?: number;
  }, sessionId?: string): Promise<{
    results: Array<Record<string, unknown>>;
    count: number;
  }> {
    return this._call("search", params, sessionId);
  }

  async extract(params: { content: string }, sessionId?: string): Promise<{
    category: string;
    importance: number;
    confidence: number;
    temporal_type: string;
    who: string;
    what: string;
    when: string;
    where: string;
    why: string;
    how: string;
    summary: string;
  }> {
    return this._call("extract", params, sessionId);
  }

  async reset(params: { agent_id?: string; force?: boolean }, sessionId?: string): Promise<{
    reset: boolean;
    deleted?: number;
    agent_id?: string;
    error?: string;
  }> {
    return this._call("reset", params, sessionId);
  }

  kill() {} // no-op: pool owns worker lifecycle
}

// ─── Unified Worker Interface ────────────────────────────────────────────────────
// Both WorkerClient and PoolWorkerClient share the same method surface.

type Worker = WorkerClient | PoolWorkerClient;

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

    if (_worker) {
      _worker.kill();
      _worker = undefined;
    }

    const usePool = process.env.USE_HTTP_POOL === "1";

    if (usePool) {
      _worker = new PoolWorkerClient(POOL_ROUTER_URL);
      api.logger.info(`[memory-recall] HTTP pool mode, router=${POOL_ROUTER_URL}`);
      _worker.health().catch((e) => {
        api.logger.error(`[memory-recall] pool health check failed: ${e.message}`);
      });
    } else {
      try {
        _worker = new WorkerClient(pythonBin, workerPath, pluginDir.replace(/\/src$/, ""));
        _worker.health().catch((e) => {
          api.logger.error(`[memory-recall] worker failed to start: ${e.message}`);
        });
      } catch (e) {
        api.logger.error(`[memory-recall] worker spawn failed: ${String(e)}`);
        return;
      }
      api.logger.info(`[memory-recall] stdin mode, python=${pythonBin}`);
    }

    const worker = _worker;

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
        name: "memory_get",
        label: "Get Memory",
        description: "Retrieve a specific memory by its exact ID. Returns full memory details.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The exact memory ID to retrieve" }),
          agent_id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { memory_id: string; agent_id?: string }) {
          try {
            const data = await (worker as unknown as { get: Function }).get({ memory_id: params.memory_id, agent_id: params.agent_id });
            if (!(data as Record<string, unknown>).found) {
              return {
                content: [{ type: "text", text: `Memory ${params.memory_id} not found.` }],
                details: data,
              };
            }
            const d = data as Record<string, unknown>;
            return {
              content: [{
                type: "text",
                text: `[${d.category}][importance: ${d.importance}] ${d.content}\nID: ${d.id} | stored: ${d.stored_at}`,
              }],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] get error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to get memory: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_get" }
    );

    api.registerTool(
      {
        name: "memory_browse",
        label: "Browse Memories",
        description: "Browse memories by conversation/project or time range. Returns conversation-contextual view with summaries — use when user wants to review everything about a project, topic, or time period.",
        parameters: Type.Object({
          conversation_id: Type.Optional(Type.String({ description: "Conversation/project ID to browse" })),
          agent_id: Type.Optional(Type.String()),
          since: Type.Optional(Type.String({ description: "ISO timestamp — fetch memories after this time" })),
          until: Type.Optional(Type.String({ description: "ISO timestamp — fetch memories before this time" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
          summary_only: Type.Optional(Type.Boolean({ description: "If true, return conversation summaries instead of full memories" })),
        }),
        async execute(_toolCallId: string, params: {
          conversation_id?: string; agent_id?: string; since?: string; until?: string; limit?: number; summary_only?: boolean;
        }) {
          try {
            const data = await (worker as unknown as { list: Function }).list({
              conversation_id: params.conversation_id,
              agent_id: params.agent_id,
              since: params.since,
              until: params.until,
              limit: params.limit,
              summary_only: params.summary_only,
            });
            const d = data as Record<string, unknown>;
            if (d.error) {
              return {
                content: [{ type: "text", text: `Browse failed: ${d.error}` }],
                details: data,
              };
            }
            if (params.summary_only && d.conversations) {
              const convs = d.conversations as Array<Record<string, unknown>>;
              const lines = convs.map((c) =>
                `• [${c.conversation_id}] ${c.count} memories | cats: ${JSON.stringify(c.categories)} | last: ${c.last_at}`
              );
              return {
                content: [{
                  type: "text",
                  text: `Found ${convs.length} conversations:\n${lines.join("\n")}`,
                }],
                details: data,
              };
            }
            const mems = (d.memories as Array<Record<string, unknown>>) || [];
            const lines = mems.map((m) =>
              `[${m.category}][${m.stored_at}] ${String(m.content).slice(0, 100)}`
            );
            return {
              content: [{
                type: "text",
                text: `Found ${mems.length} memories:\n${lines.join("\n")}`,
              }],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] browse error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to browse memories: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_browse" }
    );

    api.registerTool(
      {
        name: "memory_list",
        label: "List Memories",
        description: "List all memories with optional category/conversation filter and pagination.",
        parameters: Type.Object({
          agent_id: Type.Optional(Type.String()),
          category: Type.Optional(Type.String()),
          conversation_id: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
          sort: Type.Optional(Type.String({ default: "desc" })),
        }),
        async execute(_toolCallId: string, params: {
          agent_id?: string; category?: string; conversation_id?: string; limit?: number; offset?: number; sort?: string;
        }) {
          try {
            const data = await (worker as unknown as { list: Function }).browse({
              agent_id: params.agent_id,
              category: params.category,
              conversation_id: params.conversation_id,
              limit: params.limit,
              offset: params.offset,
              sort: params.sort,
            });
            const mems = (data.memories as Array<Record<string, unknown>>) || [];
            const lines = mems.map((m) =>
              `[${m.category}][${m.stored_at}] ${String(m.content).slice(0, 80)}`
            );
            return {
              content: [{ type: "text", text: `Listed ${mems.length} memories:\n${lines.join("\n")}` }],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] list error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to list memories: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_list" }
    );

    api.registerTool(
      {
        name: "memory_search",
        label: "Search Memories",
        description: "Fast keyword search across all memories using BM25/jieba tokenization. Use for quick text search without embedding cost.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query text" }),
          agent_id: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        }),
        async execute(_toolCallId: string, params: {
          query: string; agent_id?: string; limit?: number; offset?: number;
        }) {
          try {
            const data = await (worker as unknown as { search: Function }).search({
              query: params.query,
              agent_id: params.agent_id,
              limit: params.limit,
              offset: params.offset,
            });
            const results = (data.results as Array<Record<string, unknown>>) || [];
            const lines = results.map((r) =>
              `[score:${r.score}][${r.category}] ${String(r.content).slice(0, 80)}`
            );
            return {
              content: [{ type: "text", text: `Found ${results.length} results:\n${lines.join("\n")}` }],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] search error: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Failed to search memories: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_search" }
    );

    api.registerTool(
      {
        name: "memory_extract",
        label: "Extract Memory Structure",
        description: "Run LLM extraction on any text to extract structured memory fields (category, importance, 6W entities, temporal type). Use to analyze text before deciding whether to store it.",
        parameters: Type.Object({
          content: Type.String({ description: "Text to analyze and extract memory structure from" }),
        }),
        async execute(_toolCallId: string, params: { content: string }) {
          try {
            const data = await (worker as unknown as { extract: Function }).extract({ content: params.content });
            if ((data as Record<string, unknown>).error) {
              return { content: [{ type: "text", text: `Extract failed: ${(data as Record<string, unknown>).error}` }], details: data };
            }
            const d = data as Record<string, unknown>;
            return {
              content: [{
                type: "text",
                text: `[${d.category}][importance: ${d.importance}][${d.temporal_type}]\n6W: who=${d.who} when=${d.when} where=${d.where} why=${d.why} how=${d.how}\nSummary: ${d.summary}`,
              }],
              details: data,
            };
          } catch (err) {
            api.logger.error(`[memory-recall] extract error: ${String(err)}`);
            return { content: [{ type: "text", text: `Extract failed: ${String(err)}` }], details: { error: String(err) } };
          }
        },
      },
      { name: "memory_extract" }
    );

    api.registerTool(
      {
        name: "memory_reset",
        label: "Reset Memories",
        description: "Permanently delete all memories for an agent. DANGEROUS — requires force:true.",
        parameters: Type.Object({
          agent_id: Type.Optional(Type.String()),
          force: Type.Optional(Type.Boolean({ default: false })),
        }),
        async execute(_toolCallId: string, params: { agent_id?: string; force?: boolean }) {
          try {
            const data = await (worker as unknown as { reset: Function }).reset({ agent_id: params.agent_id, force: params.force });
            if (!(data as Record<string, unknown>).reset) {
              return { content: [{ type: "text", text: `Reset aborted: ${(data as Record<string, unknown>).error || "need force:true"}` }], details: data };
            }
            return { content: [{ type: "text", text: `Reset complete: ${(data as Record<string, unknown>).deleted} memories deleted.` }], details: data };
          } catch (err) {
            api.logger.error(`[memory-recall] reset error: ${String(err)}`);
            return { content: [{ type: "text", text: `Reset failed: ${String(err)}` }], details: { error: String(err) } };
          }
        },
      },
      { name: "memory_reset" }
    );

    api.registerTool(
      {
        name: "memory_stats",
        label: "Memory Statistics",
        description: "Get memory storage statistics: count, category breakdown, tier distribution, temporal types.",
        parameters: Type.Object({
          agent_id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { agent_id?: string }) {
          try {
            const data = await worker.stats({ agent_id: params.agent_id });
            const cats = (data as Record<string, unknown>).categories as Record<string, number> || {};
            const tiers = (data as Record<string, unknown>).tiers as Record<string, number> || {};
            const temp = (data as Record<string, unknown>).temporal_types as Record<string, number> || {};
            const lines = [
              `memories: ${(data as Record<string, unknown>).memory_count} | graph nodes: ${(data as Record<string, unknown>).graph_node_count}`,
              `categories: ${JSON.stringify(cats)}`,
              `tiers: ${JSON.stringify(tiers)}`,
              `temporal: ${JSON.stringify(temp)}`,
              `avg_importance: ${(data as Record<string, unknown>).avg_importance} | avg_confidence: ${(data as Record<string, unknown>).avg_confidence}`,
            ];
            return { content: [{ type: "text", text: lines.join("\n") }], details: data };
          } catch (err) {
            api.logger.error(`[memory-recall] stats error: ${String(err)}`);
            return { content: [{ type: "text", text: `Stats failed: ${String(err)}` }], details: { error: String(err) } };
          }
        },
      },
      { name: "memory_stats" }
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

        const sessionKey = event.sessionKey ?? event.from ?? "default";
        const maxResults = config.autoRecallMaxItems ?? 3;

        const metadata = { role: "user", sender: event.from, channel_id: event.channelId };
        worker.store({
          content: text,
          agent_id: event.from,
          conversation_id: event.conversationId,
          metadata,
        }, sessionKey).catch(err => {
          api.logger.warn(`[memory-recall] auto-store failed: ${String(err)}`);
        });

        if (!sessionBuffers.has(sessionKey)) {
          sessionBuffers.set(sessionKey, []);
        }
        sessionBuffers.get(sessionKey)!.push({ content: text, metadata });

        if (autoRecall) {
          worker.recall({ query: text, max_results: maxResults }, sessionKey)
            .then(data => {
              if (data && (data.results as unknown[]).length > 0) {
                recallCache.set(sessionKey, {
                  query: text,
                  results: data.results as RecallCache["results"],
                  expire: Date.now() + RECALL_CACHE_TTL_MS,
                });
              }
            })
            .catch(() => {});
        }
      }, { name: "memory-recall-autostore" });

      api.registerHook("agent_end", async (event) => {
        const sessionKey = event.sessionKey ?? "default";
        const messages = event.messages as Array<{ role?: string; content?: unknown }>;
        for (const msg of messages) {
          if (msg.role === "assistant") {
            const text = extractText(msg.content);
            if (text && text.length > 10) {
              const metadata = { role: "assistant" };
              worker.store({
                content: text,
                metadata,
              }, sessionKey).catch(err => {
                api.logger.warn(`[memory-recall] agent_end store failed: ${String(err)}`);
              });
              if (!sessionBuffers.has(sessionKey)) {
                sessionBuffers.set(sessionKey, []);
              }
              sessionBuffers.get(sessionKey)!.push({ content: text, metadata });
            }
          }
        }
      }, { name: "memory-recall-agent-end" });
    }

    if (autoRecall) {
      api.on("before_prompt_build", async (params: { sessionMessages?: string[]; userMessage?: string }, ctx) => {
        const userMessage = params?.userMessage || "";
        if (!userMessage || userMessage.length < 3) return { prependContext: "" };

        const sessionKey = ctx?.sessionKey ?? userMessage.slice(0, 80);
        const cached = recallCache.get(sessionKey);

        if (!cached || Date.now() > cached.expire) {
          return { prependContext: "" };
        }

        const maxChars = config.autoRecallMaxChars ?? 600;
        const selected: string[] = [];
        let totalChars = 0;
        for (const r of cached.results) {
          if (totalChars + (r.content as string).length > maxChars) break;
          const cat = r.category || "memory";
          const score = ((r.relevance_score as number ?? 0) * 100).toFixed(0);
          selected.push(`[${cat}][${score}%] ${r.content}`);
          totalChars += (r.content as string).length + 30;
        }

        if (!selected.length) return { prependContext: "" };

        api.logger.info(`[memory-recall] cache hit: injecting ${selected.length} memories (${totalChars} chars)`);

        return {
          prependContext: `<relevant-memories>\n${selected.join("\n")}\n</relevant-memories>`,
        };
      }, { name: "memory-recall-autorecall" });
    }

    api.logger.info("[memory-recall] all hooks and tools registered");

    api.registerHook("session_end", async (event) => {
      const sessionKey = event.sessionKey ?? "default";
      recallCache.delete(sessionKey);
      const buffer = sessionBuffers.get(sessionKey);
      if (buffer && buffer.length > 0) {
        api.logger.info(`[memory-recall] session_end: flushing ${buffer.length} buffered messages for session ${sessionKey}`);
        const flushPromises = buffer.map(entry =>
          worker.store({
            content: entry.content,
            metadata: entry.metadata,
          }, sessionKey).catch(err => {
            api.logger.warn(`[memory-recall] session_end flush failed: ${String(err)}`);
          })
        );
        await Promise.all(flushPromises);
        api.logger.info(`[memory-recall] session_end: flush complete`);
      }
      sessionBuffers.delete(sessionKey);
    }, { name: "memory-recall-session-end" });

    api.registerHook("gateway_stop", async () => {
      if (worker) worker.kill();
    }, { name: "memory-recall-gateway-stop" });

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
