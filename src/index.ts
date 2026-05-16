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
import type { Connection, Table } from "@lancedb/lancedb";
import Graph from "graphology";
import nodejieba from "nodejieba";
import BM25 from "bm25";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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

// Per-session worker map
const sessionWorkers = new Map<string, MemoryStore>();

// ─── Memory Schema ─────────────────────────────────────────────────────────────

interface MemoryRecord {
  id: string;
  text: string;
  tokens: string;
  vector: Float32Array;
  category: string;
  scope: string;
  conversation_id: string;
  importance: number;
  timestamp: number;
  stored_at: string;
  metadata_json: string;
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
  summary: string;
  confidence: number;
  temporal_type: string;
  access_count: number;
  last_accessed_at: number;
  compaction_rounds: number;
  last_compacted_at: number;
  original_source_count: number;
}

// ─── Memory Store (pure TypeScript) ────────────────────────────────────────────

const EMBEDDING_URL = process.env.EMBEDDING_URL || "http://localhost:11434/api/embeddings";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "bge-m3";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LLM_MODEL = process.env.LLM_MODEL || "qwen2.5:7b";
const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".memory-recall", "data");
const EMBEDDING_DIM = 1024;

function getDataDir(scope: string): string {
  const dir = join(DATA_DIR, scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getGraphPath(scope: string): string {
  return join(getDataDir(scope), "graph.json");
}

function getLanceDBPath(scope: string): string {
  return join(getDataDir(scope), "lancedb");
}

function uuid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function tokenize(text: string): string[] {
  const chinese = /[\u4e00-\u9fff]/.test(text);
  if (chinese) {
    return nodejieba.cut(text, true).filter(t => t.length > 1);
  }
  return text.split(/\s+/).filter(t => t.length > 1);
}

async function getEmbedding(text: string): Promise<Float32Array> {
  const resp = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`embedding failed: ${resp.status}`);
  const data = await resp.json() as { embedding?: number[] };
  const embedding = data.embedding;
  if (!embedding || !Array.isArray(embedding)) throw new Error("no embedding in response");
  return new Float32Array(embedding);
}

interface ExtractedFields {
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
}

async function extractFields(content: string): Promise<ExtractedFields> {
  const prompt = `You are a memory extraction system. Analyze the following text and extract structured memory fields. Return ONLY a valid JSON object with these exact fields (no markdown, no explanation):

{
  "category": "event|fact|preference|conversation|task|other",
  "importance": 0.0-1.0 (float),
  "confidence": 0.0-1.0 (float),
  "temporal_type": "dynamic|static|recurring|ephemeral",
  "who": "who is involved (empty string if none)",
  "what": "what happened (empty string if none)",
  "when": "when did it happen (empty string if none)",
  "where": "where did it happen (empty string if none)",
  "why": "why did it happen (empty string if none)",
  "how": "how did it happen (empty string if none)",
  "summary": "2-3 sentence summary of the memory"
}

Text to analyze:
${content.slice(0, 2000)}

Respond with ONLY the JSON object.`;

  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: LLM_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`extract failed: ${resp.status}`);
  const data = await resp.json() as { response?: string };
  const text = data.response || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("no JSON in extract response");
  try {
    return JSON.parse(jsonMatch[0]) as ExtractedFields;
  } catch {
    return {
      category: "other", importance: 0.5, confidence: 0.5,
      temporal_type: "dynamic", who: "", what: "", when: "",
      where: "", why: "", how: "", summary: content.slice(0, 200),
    };
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function weibullScore(
  storedAt: string,
  importance: number,
  accessCount: number,
  temporalType: string,
  maxAccessCount: number
): number {
  const now = Date.now();
  const stored = new Date(storedAt).getTime();
  const ageMs = now - stored;
  const halfLifeMap: Record<string, number> = {
    dynamic: 7 * 24 * 3600 * 1000 / 3,
    static: 365 * 24 * 3600 * 1000,
    recurring: 30 * 24 * 3600 * 1000,
    ephemeral: 1 * 24 * 3600 * 1000,
  };
  const halfLife = halfLifeMap[temporalType] || 30 * 24 * 3600 * 1000;
  const recencyScore = Math.exp(-ageMs / halfLife);
  const frequencyScore = maxAccessCount > 0 ? accessCount / maxAccessCount : 0;
  const intrinsicScore = importance;
  return Math.max(0.1, 0.4 * recencyScore + 0.3 * frequencyScore + 0.3 * intrinsicScore);
}

function scoreBM25(query: string, documents: string[]): number[] {
  const tokenized = documents.map(d => tokenize(d));
  const queryTokens = tokenize(query);
  const bm25 = new BM25(tokenized);
  return bm25.search(queryTokens);
}

// ─── Memory Store ──────────────────────────────────────────────────────────────

class MemoryStore {
  private db: Connection | null = null;
  private table: Table | null = null;
  private graph: Graph | null = null;
  private scope: string;
  private vectorIndex: Map<string, Float32Array> = new Map();
  private initialized = false;
  private initPromise: Promise<void>;

  constructor(scope: string) {
    this.scope = scope || "default";
    this.initPromise = this._init();
  }

  private async _init(): Promise<void> {
    try {
      const { connect } = await import("@lancedb/lancedb");
      const dbPath = getLanceDBPath(this.scope);
      this.db = await connect(dbPath);

      const schema: Array<{ name: string; type: unknown }> = [
        { name: "vector", type: new Float32Array(0).constructor },
        { name: "text", type: String },
        { name: "tokens", type: String },
        { name: "category", type: String },
        { name: "scope", type: String },
        { name: "conversation_id", type: String },
        { name: "importance", type: Number },
        { name: "timestamp", type: Number },
        { name: "stored_at", type: String },
        { name: "metadata_json", type: String },
        { name: "who", type: String },
        { name: "what", type: String },
        { name: "when", type: String },
        { name: "where", type: String },
        { name: "why", type: String },
        { name: "how", type: String },
        { name: "summary", type: String },
        { name: "confidence", type: Number },
        { name: "temporal_type", type: String },
        { name: "access_count", type: Number },
        { name: "last_accessed_at", type: Number },
        { name: "compaction_rounds", type: Number },
        { name: "last_compacted_at", type: Number },
        { name: "original_source_count", type: Number },
      ];

      this.table = await this.db.createTable("memories", schema as unknown as Record<string, unknown>[]).catch(async () => {
        return await this.db!.openTable("memories");
      });

      this.graph = new Graph();
      const graphPath = getGraphPath(this.scope);
      if (existsSync(graphPath)) {
        try {
          const data = JSON.parse(readFileSync(graphPath, "utf-8"));
          this.graph = Graph.from(data);
        } catch {}
      }

      this.initialized = true;
    } catch (err) {
      console.warn(`[memory-recall] init error for ${this.scope}: ${err}`);
      throw err;
    }
  }

  private async _ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.initPromise;
  }

  private async _saveGraph(): Promise<void> {
    if (!this.graph) return;
    try {
      writeFileSync(getGraphPath(this.scope), JSON.stringify(this.graph.toJSON()));
    } catch {}
  }

  private async _buildIndex(): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.createIndex("tokens", "BM25");
    } catch {}
  }

  async health(): Promise<{ status: string }> {
    await this._ensureInit();
    return { status: "ok" };
  }

  async store(params: {
    content: string;
    agent_id?: string;
    conversation_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ memory_id: string; conversation_id: string; dedup: boolean }> {
    await this._ensureInit();
    const content = params.content;
    const scope = params.agent_id || this.scope;
    const conversation_id = params.conversation_id || uuid();

    const dedup = await this._checkDedup(content, scope);

    const embedding = await getEmbedding(content);
    const tokens = tokenize(content).join(" ");
    let extracted: ExtractedFields;
    try {
      extracted = await extractFields(content);
    } catch {
      extracted = {
        category: "other", importance: 0.5, confidence: 0.5,
        temporal_type: "dynamic", who: "", what: "", when: "",
        where: "", why: "", how: "", summary: content.slice(0, 200),
      };
    }

    const now = Date.now();
    const memory_id = uuid();
    const record: Record<string, unknown> = {
      id: memory_id,
      text: content,
      tokens,
      vector: embedding,
      category: extracted.category,
      scope,
      conversation_id,
      importance: extracted.importance,
      timestamp: now,
      stored_at: new Date(now).toISOString(),
      metadata_json: JSON.stringify(params.metadata || {}),
      who: extracted.who,
      what: extracted.what,
      when: extracted.when,
      where: extracted.where,
      why: extracted.why,
      how: extracted.how,
      summary: extracted.summary,
      confidence: extracted.confidence,
      temporal_type: extracted.temporal_type,
      access_count: 0,
      last_accessed_at: now,
      compaction_rounds: 0,
      last_compacted_at: 0,
      original_source_count: 1,
    };

    await this.table!.add([record]);
    this.vectorIndex.set(memory_id, embedding);

    if (this.graph) {
      this.graph.addNode(memory_id, { scope, category: extracted.category });
      const existing = await this._findRelated(memory_id, embedding, 5);
      for (const rel of existing) {
        if (rel !== memory_id) {
          try { this.graph!.addEdge(memory_id, rel); } catch {}
          try { this.graph!.addEdge(rel, memory_id); } catch {}
        }
      }
      await this._saveGraph();
    }

    return { memory_id, conversation_id, dedup };
  }

  private async _checkDedup(content: string, scope: string): Promise<boolean> {
    try {
      const results = await this.table!.search(content, "tokens").limit(5).toArray();
      for (const r of results as Record<string, unknown>[]) {
        const similarity = cosineSimilarity(
          (r.vector as Float32Array) || new Float32Array(EMBEDDING_DIM),
          await getEmbedding(content)
        );
        if (similarity > 0.92) return true;
      }
    } catch {}
    return false;
  }

  private async _findRelated(memoryId: string, embedding: Float32Array, limit: number): Promise<string[]> {
    if (!this.table) return [];
    try {
      const all = await this.table.query().limit(1000).toArray();
      const scored = all
        .map(r => ({ id: r.id as string, sim: cosineSimilarity(embedding, (r.vector as Float32Array) || new Float32Array(EMBEDDING_DIM)) }))
        .filter(x => x.id !== memoryId && x.sim > 0.7)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit);
      return scored.map(s => s.id);
    } catch {
      return [];
    }
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
    await this._ensureInit();
    const maxResults = params.max_results ?? 5;
    const minScore = params.min_score ?? 0;
    const scope = params.agent_id || this.scope;

    const embedding = await getEmbedding(params.query);
    const candidates = await this._vectorSearch(embedding, scope, maxResults * 3);
    const l1Count = candidates.length;

    const l2Results = this._bm25Rerank(params.query, candidates);
    const l2Count = l2Results.length;

    const l3Results = await this._graphExpand(l2Results);
    const l3Count = l3Results.length;

    const results = l3Results
      .filter(r => (r.relevance_score as number) >= minScore)
      .slice(0, maxResults);

    return { results, count: results.length, layers: { l1: l1Count, l2: l2Count, l3: l3Count } };
  }

  private async _vectorSearch(embedding: Float32Array, scope: string, limit: number): Promise<Array<Record<string, unknown> & { relevance_score: number }>> {
    if (!this.table) return [];
    try {
      const all = await this.table.query().limit(500).toArray();
      const scored = all
        .filter(r => (r.scope as string) === scope)
        .map(r => ({
          ...r,
          relevance_score: cosineSimilarity(embedding, (r.vector as Float32Array) || new Float32Array(EMBEDDING_DIM)),
        }))
        .sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
        .slice(0, limit);
      return scored;
    } catch {
      return [];
    }
  }

  private _bm25Rerank(query: string, candidates: Array<Record<string, unknown> & { relevance_score: number }>): Array<Record<string, unknown> & { relevance_score: number }> {
    if (!candidates.length) return [];
    const texts = candidates.map(c => c.text as string);
    const scores = scoreBM25(query, texts);
    return candidates
      .map((c, i) => ({ ...c, relevance_score: Math.max(c.relevance_score as number, scores[i] || 0) }))
      .sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  }

  private async _graphExpand(candidates: Array<Record<string, unknown> & { relevance_score: number }>): Promise<Array<Record<string, unknown> & { relevance_score: number }>> {
    if (!this.graph || candidates.length === 0) return candidates;
    const expanded = new Set<string>();
    const resultMap = new Map<string, Record<string, unknown> & { relevance_score: number }>();

    for (const c of candidates) {
      expanded.add(c.id as string);
      resultMap.set(c.id as string, c);
    }

    for (const c of candidates) {
      try {
        const neighbors = this.graph.neighbors(c.id as string);
        for (const n of neighbors) {
          if (!expanded.has(n)) {
            expanded.add(n);
            const memory = await this.get({ memory_id: n, agent_id: this.scope });
            if (memory && memory.found) {
              resultMap.set(n, memory as Record<string, unknown> & { relevance_score: number });
            }
          }
        }
      } catch {}
    }

    return Array.from(resultMap.values());
  }

  async forget(params: { memory_id: string }): Promise<{ memory_id: string; deleted: boolean }> {
    await this._ensureInit();
    const memory_id = params.memory_id;
    try {
      await this.table!.delete(`id = '${memory_id}'`);
      this.vectorIndex.delete(memory_id);
      if (this.graph) {
        try { this.graph.dropNode(memory_id); } catch {}
        await this._saveGraph();
      }
      return { memory_id, deleted: true };
    } catch {
      return { memory_id, deleted: false };
    }
  }

  async get(params: { memory_id: string; agent_id?: string }): Promise<Record<string, unknown>> {
    await this._ensureInit();
    try {
      const results = await this.table!.search(params.memory_id, "id").limit(1).toArray();
      if (!results.length) return { found: false };
      const r = results[0] as Record<string, unknown>;
      await this.table!.update([{
        ...r,
        access_count: (r.access_count as number || 0) + 1,
        last_accessed_at: Date.now(),
      }]);
      return { ...r, found: true };
    } catch {
      return { found: false };
    }
  }

  async stats(params: { agent_id?: string }): Promise<{
    memory_count: number;
    bm25_doc_count: number;
    graph_node_count: number;
  }> {
    await this._ensureInit();
    const scope = params.agent_id || this.scope;
    try {
      const all = await this.table!.query().limit(10000).toArray();
      const filtered = all.filter(r => (r.scope as string) === scope);
      return {
        memory_count: filtered.length,
        bm25_doc_count: filtered.length,
        graph_node_count: this.graph ? this.graph.size : 0,
      };
    } catch {
      return { memory_count: 0, bm25_doc_count: 0, graph_node_count: 0 };
    }
  }

  async list(params: {
    agent_id?: string;
    category?: string;
    conversation_id?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  }): Promise<{
    memories: Array<Record<string, unknown>>;
    count: number;
    offset: number;
    limit: number;
    agent_id: string;
  }> {
    await this._ensureInit();
    const scope = params.agent_id || this.scope;
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    try {
      const all = await this.table!.query().limit(10000).toArray();
      let filtered = all.filter(r => (r.scope as string) === scope);
      if (params.category) filtered = filtered.filter(r => (r.category as string) === params.category);
      if (params.conversation_id) filtered = filtered.filter(r => (r.conversation_id as string) === params.conversation_id);
      const sorted = filtered.sort((a, b) => {
        if (params.sort === "asc") return (a.timestamp as number) - (b.timestamp as number);
        return (b.timestamp as number) - (a.timestamp as number);
      });
      const memories = sorted.slice(offset, offset + limit);
      return { memories, count: filtered.length, offset, limit, agent_id: scope };
    } catch {
      return { memories: [], count: 0, offset, limit, agent_id: scope };
    }
  }

  async search(params: {
    query: string;
    agent_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    results: Array<Record<string, unknown>>;
    count: number;
  }> {
    await this._ensureInit();
    const scope = params.agent_id || this.scope;
    const limit = params.limit ?? 20;
    try {
      const all = await this.table!.query().limit(10000).toArray();
      const filtered = all.filter(r => (r.scope as string) === scope);
      const texts = filtered.map(r => r.text as string);
      const scores = scoreBM25(params.query, texts);
      const results = filtered
        .map((r, i) => ({ ...r, score: scores[i] || 0 }))
        .filter(r => r.score > 0)
        .sort((a, b) => (b.score as number) - (a.score as number))
        .slice(params.offset ?? 0, limit);
      return { results, count: results.length };
    } catch {
      return { results: [], count: 0 };
    }
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
    await this._ensureInit();
    return extractFields(params.content);
  }

  async reset(params: { agent_id?: string; force?: boolean }): Promise<{
    reset: boolean;
    deleted?: number;
    agent_id?: string;
    error?: string;
  }> {
    await this._ensureInit();
    if (!params.force) return { reset: false, error: "need force:true", agent_id: params.agent_id };
    const scope = params.agent_id || this.scope;
    try {
      const all = await this.table!.query().limit(10000).toArray();
      const filtered = all.filter(r => (r.scope as string) === scope);
      const count = filtered.length;
      await this.table!.delete(`scope = '${scope}'`);
      this.vectorIndex.clear();
      if (this.graph) {
        const nodesToDrop: string[] = [];
        this.graph.forEachNode((node, attrs) => {
          if (attrs.scope === scope) nodesToDrop.push(node);
        });
        for (const n of nodesToDrop) {
          try { this.graph!.dropNode(n); } catch {}
        }
        await this._saveGraph();
      }
      return { reset: true, deleted: count, agent_id: scope };
    } catch (err) {
      return { reset: false, error: String(err), agent_id: scope };
    }
  }

  async compact(params: {
    dry_run?: boolean;
    limit?: number;
    scopes?: string[];
  }): Promise<{
    clusters_found: number;
    memories_deleted: number;
    memories_created: number;
    dry_run: boolean;
  }> {
    await this._ensureInit();
    const dryRun = params.dry_run ?? false;
    const maxRounds = params.limit ?? 4;
    const scopes = params.scopes || [this.scope];
    let clustersFound = 0, deletedCount = 0, createdCount = 0;

    for (const scope of scopes) {
      let round = 0;
      let changed = true;
      while (changed && round < maxRounds) {
        changed = false;
        round++;
        const all = await this.table!.query().limit(5000).toArray();
        const filtered = all.filter(r => (r.scope as string) === scope);
        const toDelete: string[] = [];
        const toCreate: Array<Record<string, unknown>> = [];

        for (let i = 0; i < filtered.length; i++) {
          const a = filtered[i];
          const va = (a.vector as Float32Array) || new Float32Array(EMBEDDING_DIM);
          for (let j = i + 1; j < filtered.length; j++) {
            const b = filtered[j];
            if (toDelete.includes(b.id as string)) continue;
            const vb = (b.vector as Float32Array) || new Float32Array(EMBEDDING_DIM);
            const sim = cosineSimilarity(va, vb);
            if (sim >= 0.88) {
              const merged: Record<string, unknown> = {
                id: uuid(),
                text: (a.text as string) + "\n" + (b.text as string),
                tokens: tokenize((a.text as string) + " " + (b.text as string)).join(" "),
                vector: va,
                category: a.category as string,
                scope,
                conversation_id: a.conversation_id as string,
                importance: Math.max(a.importance as number, b.importance as number),
                timestamp: Math.min(a.timestamp as number, b.timestamp as number),
                stored_at: a.stored_at as string,
                metadata_json: a.metadata_json as string,
                who: a.who as string,
                what: a.what as string,
                when: a.when as string,
                where: a.where as string,
                why: a.why as string,
                how: a.how as string,
                summary: (a.summary as string) + " | " + (b.summary as string),
                confidence: (a.confidence as number + b.confidence as number) / 2,
                temporal_type: a.temporal_type as string,
                access_count: 0,
                last_accessed_at: Date.now(),
                compaction_rounds: (a.compaction_rounds as number || 0) + 1,
                last_compacted_at: Date.now(),
                original_source_count: (a.original_source_count as number || 1) + (b.original_source_count as number || 1),
              };
              toDelete.push(a.id as string, b.id as string);
              toCreate.push(merged);
              clustersFound++;
              changed = true;
            }
          }
        }

        if (!dryRun && toDelete.length > 0) {
          for (const id of toDelete) {
            await this.table!.delete(`id = '${id}'`);
            this.vectorIndex.delete(id);
          }
          await this.table!.add(toCreate);
          deletedCount += toDelete.length;
          createdCount += toCreate.length;
        }
      }
    }

    return { clusters_found: clustersFound, memories_deleted: deletedCount, memories_created: createdCount, dry_run: dryRun };
  }

  async graphRebuild(params: { agent_id?: string }): Promise<{
    agents_rebuilt: number;
    dangling_edges_cleaned: number;
  }> {
    await this._ensureInit();
    const scope = params.agent_id || this.scope;
    let danglingCleaned = 0;

    if (this.graph) {
      const nodesToRemove: string[] = [];
      this.graph.forEachNode((node, attrs) => {
        if (attrs.scope === scope) {
          try {
            const memory = this.get({ memory_id: node, agent_id: scope });
            if (!(memory as Record<string, unknown>).found) nodesToRemove.push(node);
          } catch {
            nodesToRemove.push(node);
          }
        }
      });
      for (const n of nodesToRemove) {
        try { this.graph.dropNode(n); danglingCleaned++; } catch {}
      }
      await this._saveGraph();
    }

    const all = await this.table!.query().limit(5000).toArray();
    const filtered = all.filter(r => (r.scope as string) === scope);

    if (this.graph) {
      for (const r of filtered) {
        if (!this.graph.hasNode(r.id as string)) {
          this.graph.addNode(r.id as string, { scope, category: r.category as string });
        }
      }
      for (const r of filtered) {
        const va = (r.vector as Float32Array) || new Float32Array(EMBEDDING_DIM);
        const neighbors = await this._findRelated(r.id as string, va, 3);
        for (const n of neighbors) {
          try { this.graph.addEdge(r.id as string, n); } catch {}
        }
      }
      await this._saveGraph();
    }

    return { agents_rebuilt: 1, dangling_edges_cleaned: danglingCleaned };
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
    await this._ensureInit();
    const scope = params.agent_id || this.scope;
    const dryRun = params.dry_run ?? false;
    const limit = params.limit ?? 50;

    const all = await this.table!.query().limit(5000).toArray();
    const filtered = all.filter(r => (r.scope as string) === scope);

    const maxAccess = Math.max(...filtered.map(r => r.access_count as number || 0), 1);
    const staleMemories: Array<Record<string, unknown>> = [];
    let deletedCount = 0, compactedCount = 0;

    for (const r of filtered) {
      const score = weibullScore(
        r.stored_at as string,
        r.importance as number,
        r.access_count as number,
        r.temporal_type as string,
        maxAccess
      );
      if (score < 0.15 && (r.importance as number) < 0.4) {
        staleMemories.push({ ...r, decay_score: score });
      }
    }

    if (!dryRun && staleMemories.length > 0) {
      const toDelete = staleMemories.slice(0, limit);
      for (const m of toDelete) {
        await this.forget({ memory_id: m.id as string });
        deletedCount++;
      }
    }

    if (params.also_compact && !dryRun) {
      const compactResult = await this.compact({ dry_run: false, limit: 4, scopes: [scope] });
      compactedCount = compactResult.memories_deleted;
    }

    if (params.also_graph_rebuild && !dryRun) {
      await this.graphRebuild({ agent_id: scope });
    }

    return { stale_count: staleMemories.length, stale_memories: staleMemories, deleted: deletedCount, compacted: compactedCount, dry_run: dryRun };
  }

  async update(params: {
    memory_id: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ memory_id: string; updated: boolean }> {
    await this._ensureInit();
    const memory_id = params.memory_id;
    try {
      const results = await this.table!.search(memory_id, "id").limit(1).toArray();
      if (!results.length) return { memory_id, updated: false };
      const existing = results[0] as Record<string, unknown>;
      const updated: Record<string, unknown> = { ...existing };
      if (params.content !== undefined) {
        updated.text = params.content;
        updated.tokens = tokenize(params.content).join(" ");
        const embedding = await getEmbedding(params.content);
        updated.vector = embedding;
        this.vectorIndex.set(memory_id, embedding);
      }
      if (params.metadata !== undefined) {
        updated.metadata_json = JSON.stringify(params.metadata);
      }
      await this.table!.update([updated]);
      return { memory_id, updated: true };
    } catch {
      return { memory_id, updated: false };
    }
  }

  kill() {
    this.db = null;
    this.table = null;
    this.graph = null;
    this.vectorIndex.clear();
    this.initialized = false;
  }
}

// Get or create session worker
function getSessionWorker(sessionKey: string): MemoryStore {
  if (!sessionWorkers.has(sessionKey)) {
    const scope = sessionKey.split(":")[1] || sessionKey || "default";
    const w = new MemoryStore(scope);
    sessionWorkers.set(sessionKey, w);
  }
  return sessionWorkers.get(sessionKey)!;
}

// ─── Session Worker (deprecated - kept for compatibility) ───────────────────────
// Wraps MemoryStore to maintain the same interface

class SessionWorker {
  private store: MemoryStore;
  constructor(_pythonBin: string, _workerPath: string, _cwd: string, sessionKey: string) {
    const scope = sessionKey.split(":")[1] || sessionKey || "default";
    this.store = new MemoryStore(scope);
  }

  async health(): Promise<{ status: string }> { return this.store.health(); }
  async store(params: { content: string; agent_id?: string; conversation_id?: string; metadata?: Record<string, unknown> }): Promise<{ memory_id: string; conversation_id: string; dedup: boolean }> { return this.store.store(params); }
  async recall(params: { query: string; agent_id?: string; max_results?: number; min_score?: number }): Promise<{ results: Array<Record<string, unknown>>; count: number; layers: { l1: number; l2: number; l3: number } }> { return this.store.recall(params); }
  async forget(params: { memory_id: string }): Promise<{ memory_id: string; deleted: boolean }> { return this.store.forget(params); }
  async get(params: { memory_id: string; agent_id?: string }): Promise<Record<string, unknown>> { return this.store.get(params); }
  async stats(params: { agent_id?: string }): Promise<{ memory_count: number; bm25_doc_count: number; graph_node_count: number }> { return this.store.stats(params); }
  async list(params: { agent_id?: string; category?: string; conversation_id?: string; limit?: number; offset?: number; sort?: string }): Promise<{ memories: Array<Record<string, unknown>>; count: number; offset: number; limit: number; agent_id: string }> { return this.store.list(params); }
  async search(params: { query: string; agent_id?: string; limit?: number; offset?: number }): Promise<{ results: Array<Record<string, unknown>>; count: number }> { return this.store.search(params); }
  async extract(params: { content: string }): Promise<{ category: string; importance: number; confidence: number; temporal_type: string; who: string; what: string; when: string; where: string; why: string; how: string; summary: string }> { return this.store.extract(params); }
  async reset(params: { agent_id?: string; force?: boolean }): Promise<{ reset: boolean; deleted?: number; agent_id?: string; error?: string }> { return this.store.reset(params); }
  async compact(params: { dry_run?: boolean; limit?: number; scopes?: string[] }): Promise<{ clusters_found: number; memories_deleted: number; memories_created: number; dry_run: boolean }> { return this.store.compact(params); }
  async graphRebuild(params: { agent_id?: string }): Promise<{ agents_rebuilt: number; dangling_edges_cleaned: number }> { return this.store.graphRebuild(params); }
  async decayScan(params: { dry_run?: boolean; limit?: number; also_compact?: boolean; also_graph_rebuild?: boolean; agent_id?: string }): Promise<{ stale_count: number; stale_memories: Array<Record<string, unknown>>; deleted: number; compacted: number; dry_run: boolean }> { return this.store.decayScan(params); }
  async update(params: { memory_id: string; content?: string; metadata?: Record<string, unknown> }): Promise<{ memory_id: string; updated: boolean }> { return this.store.update(params); }
  kill() { this.store.kill(); }
}

function getSessionWorker_old(sessionKey: string, pythonBin: string, workerPath: string, cwd: string): SessionWorker {
  if (!sessionWorkers.has(sessionKey)) {
    const w = new SessionWorker(pythonBin, workerPath, cwd, sessionKey);
    sessionWorkers.set(sessionKey, w);
  }
  return sessionWorkers.get(sessionKey)!;
}

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
  kind: "sensorium" as const,

  register(api: OpenClawPluginApi) {
    console.log("[memory-recall] === REGISTER CALLED ===");
    const config = parsePluginConfig(api.pluginConfig);
    console.log(`[memory-recall] pluginConfig keys: ${Object.keys(api.pluginConfig || {}).join(",")}`);

    const require = createRequire(import.meta.url);
    const pluginDir = require.resolve("./index.js").replace(/\/index\.js$/, "");
    const workerPath = pluginDir.replace(/\/dist$/, "/src") + "/worker.py";
    const pythonBin = process.env.PYTHON_BIN || PYTHON_BIN;
    const cwd = pluginDir.replace(/\/src$/, "");

    // Default worker for tools (global, single instance) - now using MemoryStore
    let _defaultWorker: MemoryStore | undefined;
    try {
      _defaultWorker = new MemoryStore("default");
      _defaultWorker.health().catch((e) => {
        api.logger.error(`[memory-recall] default worker failed to start: ${e.message}`);
      });
    } catch (e) {
      api.logger.error(`[memory-recall] default worker spawn failed: ${String(e)}`);
    }
    api.logger.info(`[memory-recall] MemoryStore mode (pure TypeScript)`);

    const worker = _defaultWorker;

    const getWorker = (sessionKey: string) => getSessionWorker(sessionKey);

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
        name: "mr_memory_recall",
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
            const data = await worker!.recall({
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
              `${i + 1}. [${r.category || "memory"}] ${r.text} (score: ${((r.relevance_score as number ?? 0) * 100).toFixed(0)}%)`
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
      { name: "mr_memory_recall" }
    );

    api.registerTool(
      {
        name: "mr_memory_store",
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
            const data = await worker!.store({
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
      { name: "mr_memory_store" }
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
            const data = await worker!.forget({ memory_id: params.memory_id });
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
        name: "mr_memory_get",
        label: "Get Memory",
        description: "Retrieve a specific memory by its exact ID. Returns full memory details.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "The exact memory ID to retrieve" }),
          agent_id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { memory_id: string; agent_id?: string }) {
          try {
            const data = await worker!.get({ memory_id: params.memory_id, agent_id: params.agent_id });
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
                text: `[${d.category}][importance: ${d.importance}] ${d.text}\nID: ${d.id} | stored: ${d.stored_at}`,
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
      { name: "mr_memory_get" }
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
            const data = await worker!.list({
              conversation_id: params.conversation_id,
              agent_id: params.agent_id,
              limit: params.limit,
              offset: 0,
              sort: "desc",
            });
            const d = data as Record<string, unknown>;
            const mems = (d.memories as Array<Record<string, unknown>>) || [];
            const lines = mems.map((m) =>
              `[${m.category}][${m.stored_at}] ${String(m.text).slice(0, 100)}`
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
            const data = await worker!.list({
              agent_id: params.agent_id,
              category: params.category,
              conversation_id: params.conversation_id,
              limit: params.limit,
              offset: params.offset,
              sort: params.sort,
            });
            const mems = (data.memories as Array<Record<string, unknown>>) || [];
            const lines = mems.map((m) =>
              `[${m.category}][${m.stored_at}] ${String(m.text).slice(0, 80)}`
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
        name: "mr_memory_search",
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
            const data = await worker!.search({
              query: params.query,
              agent_id: params.agent_id,
              limit: params.limit,
              offset: params.offset,
            });
            const results = (data.results as Array<Record<string, unknown>>) || [];
            const lines = results.map((r) =>
              `[score:${r.score}][${r.category}] ${String(r.text).slice(0, 80)}`
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
      { name: "mr_memory_search" }
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
            const data = await worker!.extract({ content: params.content });
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
            api.logger.error("[memory-recall] extract error: " + String(err));
            return { content: [{ type: "text", text: "Extract failed: " + String(err) }], details: { error: String(err) } };
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
            const data = await worker!.reset({ agent_id: params.agent_id, force: params.force });
            if (!(data as Record<string, unknown>).reset) {
              const errorMsg = (data as Record<string, unknown>).error || "need force:true";
              return { content: [{ type: "text", text: "Reset aborted: " + errorMsg }], details: data };
            }
            const deletedCount = (data as Record<string, unknown>).deleted || 0;
            return { content: [{ type: "text", text: "Reset complete: " + deletedCount + " memories deleted." }], details: data };
          } catch (err) {
            const errStr = String(err);
            const errObj = { error: errStr };
            api.logger.error("[memory-recall] reset error: " + errStr);
            return { content: [{ type: "text", text: "Reset failed: " + errStr }], details: errObj };
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
            const data = await worker!.stats({ agent_id: params.agent_id });
            const d = data as Record<string, unknown>;
            const mc = d.memory_count || 0;
            const gn = d.graph_node_count || 0;
            const bc = d.bm25_doc_count || 0;
            const lines = [
              "memories: " + mc + " | graph nodes: " + gn,
              "bm25_doc_count: " + bc,
            ];
            return { content: [{ type: "text", text: lines.join("\n") }], details: data };
          } catch (err) {
            const errStr = String(err);
            const errObj = { error: errStr };
            api.logger.error("[memory-recall] stats error: " + errStr);
            return { content: [{ type: "text", text: "Stats failed: " + errStr }], details: errObj };
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
            const data = await worker!.update({
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

    // ─── Worker management tools ──────────────────────────────────────────────────

    api.registerTool(
      {
        name: "memory_worker_status",
        label: "Memory Worker Status",
        description: "Show all active session workers and their health status.",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: Record<string, never>) {
          const entries: Array<{ sessionKey: string; alive: boolean }> = [];
          for (const [key, w] of sessionWorkers) {
            let alive = false;
            try { await w.health(); alive = true; } catch {}
            entries.push({ sessionKey: key, alive });
          }
          const lines = entries.map(e => `${e.sessionKey}: ${e.alive ? "alive" : "dead"}`);
          return {
            content: [{ type: "text", text: `Active workers: ${entries.length}\n${lines.join("\n")}` }],
            details: { count: entries.length, workers: entries },
          };
        },
      },
      { name: "memory_worker_status" }
    );

    api.registerTool(
      {
        name: "memory_worker_restart",
        label: "Restart Memory Worker",
        description: "Kill and restart the worker for a specific session. Use when worker is stuck.",
        parameters: Type.Object({
          session_key: Type.String({ description: "Session key of the worker to restart" }),
        }),
        async execute(_toolCallId: string, params: { session_key: string }) {
          const sessionKey = params.session_key;
          if (sessionWorkers.has(sessionKey)) {
            sessionWorkers.get(sessionKey)!.kill();
            sessionWorkers.delete(sessionKey);
          }
          const newWorker = getWorker(sessionKey);
          try {
            await newWorker.health();
            return {
              content: [{ type: "text", text: `Worker restarted for session ${sessionKey}` }],
              details: { session_key: sessionKey, restarted: true },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Worker restart failed: ${String(err)}` }],
              details: { session_key: sessionKey, restarted: false, error: String(err) },
            };
          }
        },
      },
      { name: "memory_worker_restart" }
    );

    const autoStore = config.autoStore !== false;
    const autoRecall = config.autoRecall !== false;
    api.logger.info(`[memory-recall] autoStore=${autoStore}, autoRecall=${autoRecall}`);

    if (autoStore) {
      console.log("[memory-recall] *** registering message_received hook via api.on ***");
      api.on("message_received", async (event, ctx) => {
        console.log("[memory-recall] *** message_received hook HANDLER CALLED ***");
        console.log("[memory-recall] event.from:", event.from);
        console.log("[memory-recall] event.content type:", typeof event.content);
        console.log("[memory-recall] event.content:", JSON.stringify(event.content)?.slice(0, 200));
        api.logger.info(`[memory-recall] message_received hook FIRED, text length: ${event.content?.length ?? 0}`);
        const text = extractText(event.content);
        if (!text || text.length < 10) return;
        api.logger.info(`[memory-recall] storing message, length: ${text.length}`);

        const sessionKey = event.sessionKey ?? ctx?.sessionKey ?? event.from ?? "default";
        const agentId = event.from || (ctx?.sessionKey?.split(":")[1]) || "default";
        const maxResults = config.autoRecallMaxItems ?? 3;

        const metadata = { role: "user", sender: event.from, channel_id: event.channelId, ctx_session_key: ctx?.sessionKey };
        const sw = getWorker(sessionKey);
        sw.store({
          content: text,
          agent_id: agentId,
          conversation_id: event.sessionKey ?? event.conversationId,
          metadata,
        }).catch(err => {
          api.logger.warn(`[memory-recall] auto-store failed: ${String(err)}`);
        });

        if (!sessionBuffers.has(sessionKey)) {
          sessionBuffers.set(sessionKey, []);
        }
        sessionBuffers.get(sessionKey)!.push({ content: text, metadata });

        if (autoRecall) {
          sw.recall({ query: text, max_results: maxResults })
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
              worker!.store({
                content: text,
                conversation_id: event.sessionKey ?? event.conversationId,
                metadata,
              }).catch(err => {
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
      api.registerHook("before_prompt_build", async (params: { sessionMessages?: string[]; userMessage?: string }, ctx) => {
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
        const sw = getWorker(sessionKey);
        const flushPromises = buffer.map(entry =>
          sw.store({
            content: entry.content,
            metadata: entry.metadata,
          }).catch(err => {
            api.logger.warn(`[memory-recall] session_end flush failed: ${String(err)}`);
          })
        );
        await Promise.all(flushPromises);
        api.logger.info(`[memory-recall] session_end: flush complete`);
      }
      sessionBuffers.delete(sessionKey);
      // Kill session worker
      if (sessionWorkers.has(sessionKey)) {
        sessionWorkers.get(sessionKey)!.kill();
        sessionWorkers.delete(sessionKey);
        api.logger.info(`[memory-recall] session worker killed: ${sessionKey}`);
      }
    }, { name: "memory-recall-session-end" });

    api.registerHook("gateway_stop", async () => {
      // Kill default worker
      if (_defaultWorker) _defaultWorker.kill();
      // Kill all session workers
      for (const [, w] of sessionWorkers) { w.kill(); }
      sessionWorkers.clear();
    }, { name: "memory-recall-gateway-stop" });

    if (config.decayEnabled !== false) {
      const intervalMs = (config.decayIntervalHours ?? 24) * 60 * 60 * 1000;
      let decayTimer: ReturnType<typeof setInterval> | null = null;
      let stopFn: (() => void) | null = null;

      const runDecayCycle = async (logger: typeof api.logger) => {
        try {
          logger.info("[memory-recall] decay cycle starting...");
          const scanResult = await _defaultWorker!.decayScan({ dry_run: true, limit: 50 });
          const staleCount = scanResult.stale_count ?? 0;
          logger.info(`[memory-recall] decay scan: ${staleCount} stale memories`);

          if (staleCount > 0) {
            const compactResult = await _defaultWorker!.compact({ dry_run: false, limit: 200 });
            logger.info(`[memory-recall] compact: ${compactResult.clusters_found} clusters, ${compactResult.memories_deleted} deleted`);
            const decayResult = await _defaultWorker!.decayScan({
              dry_run: false,
              also_compact: false,
              also_graph_rebuild: false,
              limit: 50,
            });
            logger.info(`[memory-recall] decay delete: ${decayResult.deleted} deleted`);
          }

          const graphResult = await _defaultWorker!.graphRebuild({});
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