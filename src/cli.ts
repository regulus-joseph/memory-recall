#!/usr/bin/env node
/**
 * Memory Recall CLI - TypeScript
 * Usage: npx tsx src/cli.ts <command> [options]
 *        node dist/cli.js <command> [options]  (after build)
 */
import { MemoryStore } from "./index.js";
import { extractText } from "./utils/extract.js";
import { embedText } from "./utils/embed.js";

const DATA_DIR = `${process.env.HOME}/.memory-recall/data`;

interface CliOptions {
  agentId?: string;
  content?: string;
  query?: string;
  max?: number;
  category?: string;
  importance?: number;
  memoryId?: string;
  since?: string;
  until?: string;
  scope?: string;
  force?: boolean;
}

async function cmdInit(agentId: string = "cli"): Promise<void> {
  console.log(`[init] Initializing for agent=${agentId}...`);
  const store = new MemoryStore(agentId);
  await store._ensureInit();
  console.log(`[init] Done: ${DATA_DIR}/${agentId}/memories.lance`);
}

async function cmdStore(content: string, agentId: string = "cli", category?: string, importance?: number): Promise<void> {
  if (!content) {
    console.error("[store] Error: --content is required");
    process.exit(1);
  }
  console.log(`[store] Storing for agent=${agentId}, len=${content.length}`);
  const store = new MemoryStore(agentId);
  const result = await store.store({
    content,
    agent_id: agentId,
    metadata: { category, importance },
  });
  console.log(`[store] Done: memory_id=${result.memory_id}`);
}

async function cmdRecall(query: string, agentId: string = "cli", max: number = 5): Promise<void> {
  if (!query) {
    console.error("[recall] Error: --query is required");
    process.exit(1);
  }
  console.log(`[recall] Query="${query}", agent=${agentId}, max=${max}`);
  const store = new MemoryStore(agentId);
  const result = await store.recall({ query, agent_id: agentId, max_results: max });
  if (!result.count) {
    console.log("[recall] No relevant memories found");
    return;
  }
  console.log(`\n[recall] Found ${result.count} results (L1=${result.layers.l1}, L2=${result.layers.l2}, L3=${result.layers.l3}):\n`);
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    console.log(`${i + 1}. [${r.category || "unknown"}] score=${r.relevance_score?.toFixed(3) || "n/a"}`);
    console.log(`   ${(r.text as string || "").slice(0, 200)}`);
    console.log(`   memory_id=${r.memory_id}`);
    console.log();
  }
}

async function cmdSearch(query: string, agentId: string = "cli", max: number = 10): Promise<void> {
  if (!query) {
    console.error("[search] Error: --query is required");
    process.exit(1);
  }
  console.log(`[search] Keyword="${query}", agent=${agentId}`);
  const store = new MemoryStore(agentId);
  const result = await store.search({ query, agent_id: agentId, limit: max });
  if (!result.count) {
    console.log(`[search] No matches for '${query}'`);
    return;
  }
  console.log(`[search] Found ${result.count} matches:\n`);
  for (const r of result.results) {
    console.log(`- ${(r.text as string || "").slice(0, 100)}`);
    console.log(`  score=${r.score}`);
  }
}

async function cmdBrowse(agentId: string = "cli", since?: string, until?: string, limit: number = 20): Promise<void> {
  console.log(`[browse] agent=${agentId}, since=${since || "all"}, until=${until || "now"}`);
  const store = new MemoryStore(agentId);
  const result = await store.list({ agent_id: agentId, limit });
  const all = result.memories;
  if (!all.length) {
    console.log("[browse] No memories found");
    return;
  }
  console.log(`[browse] ${all.length} memories:\n`);
  for (const r of all) {
    console.log(`- [${r.category}] ${((r as Record<string, unknown>).text as string || "").slice(0, 80)}`);
    console.log(`  id=${r.memory_id}, importance=${r.importance}, created=${r.created_at}`);
  }
}

async function cmdGet(memoryId: string, agentId: string = "cli"): Promise<void> {
  if (!memoryId) {
    console.error("[get] Error: --memory-id is required");
    process.exit(1);
  }
  const store = new MemoryStore(agentId);
  const result = await store.get({ memory_id: memoryId, agent_id: agentId });
  if (!(result as Record<string, unknown>).found) {
    console.log(`[get] Memory ${memoryId} not found`);
    return;
  }
  console.log("[get]", JSON.stringify(result, null, 2));
}

async function cmdStats(agentId: string = "cli"): Promise<void> {
  const store = new MemoryStore(agentId);
  const stats = await store.stats({ agent_id: agentId });
  console.log("[stats]", JSON.stringify(stats, null, 2));
}

async function cmdForget(memoryId: string, agentId: string = "cli", force: boolean = false): Promise<void> {
  if (!memoryId) {
    console.error("[forget] Error: --memory-id is required");
    process.exit(1);
  }
  const store = new MemoryStore(agentId);
  const result = await store.forget({ memory_id: memoryId, agent_id: agentId, force });
  console.log("[forget]", JSON.stringify(result));
}

async function cmdList(agentId: string = "cli", category?: string, limit: number = 20): Promise<void> {
  const store = new MemoryStore(agentId);
  const result = await store.list({ agent_id: agentId, category, limit });
  console.log(`[list] ${result.count} total, showing ${result.memories.length}:\n`);
  for (const m of result.memories) {
    console.log(`- [${m.category}] ${((m as Record<string, unknown>).text as string || "").slice(0, 80)}`);
    console.log(`  id=${m.memory_id}, importance=${m.importance}`);
  }
}

async function cmdReset(agentId: string = "cli", scope?: string, force: boolean = false): Promise<void> {
  if (!force) {
    console.error("[reset] Error: requires --force flag");
    console.error("[reset] Usage: cli.ts reset --agent-id X --scope Y --force");
    process.exit(1);
  }
  const store = new MemoryStore(agentId);
  const result = await store.reset({ scope: scope || agentId, force: true });
  console.log("[reset]", JSON.stringify(result));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Memory Recall CLI (TypeScript)
Usage: npx tsx src/cli.ts <command> [options]

Commands:
  init --agent-id <id>          Initialize LanceDB for agent
  store --content <text>         Store a memory
  recall --query <text>          L1/L2/L3 cascade recall
  search --query <text>          BM25 keyword search
  browse                        Browse memories by time
  get --memory-id <id>          Get single memory
  list                         List all memories
  stats                        Show statistics
  forget --memory-id <id>       Delete a memory
  reset --force                Reset all memories

Examples:
  npx tsx src/cli.ts init --agent-id main
  npx tsx src/cli.ts store --agent-id main --content "用户的项目在 ~/projects"
  npx tsx src/cli.ts recall --agent-id main --query "用户的项目路径"
  npx tsx src/cli.ts search --agent-id main --query "futu OpenD"
`);
    return;
  }

  const cmd = args[0];
  const get = (long: string, short?: string): string | undefined => {
    const idx = args.indexOf(`--${long}`);
    return idx >= 0 ? args[idx + 1] : short !== undefined ? args.indexOf(`-${short}`) >= 0 ? args[args.indexOf(`-${short}`) + 1] : undefined : undefined;
  };
  const flag = (long: string, short?: string): boolean => args.indexOf(`--${long}`) >= 0 || (short !== undefined && args.indexOf(`-${short}`) >= 0);

  const agentId = get("agent-id", "a") || "cli";
  const max = get("max", "n") ? parseInt(get("max", "n")!) : 5;
  const force = flag("force", "f");

  switch (cmd) {
    case "init":
      await cmdInit(agentId);
      break;
    case "store":
      await cmdStore(get("content", "c") || "", agentId, get("category"), get("importance") ? parseFloat(get("importance")!) : undefined);
      break;
    case "recall":
      await cmdRecall(get("query", "q") || "", agentId, max);
      break;
    case "search":
      await cmdSearch(get("query", "q") || "", agentId, max);
      break;
    case "browse":
      await cmdBrowse(agentId, get("since"), get("until"), max);
      break;
    case "get":
      await cmdGet(get("memory-id") || "", agentId);
      break;
    case "stats":
      await cmdStats(agentId);
      break;
    case "forget":
      await cmdForget(get("memory-id") || "", agentId, force);
      break;
    case "list":
      await cmdList(agentId, get("category"), max);
      break;
    case "reset":
      await cmdReset(agentId, get("scope"), force);
      break;
    default:
      console.error(`[cli] Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[cli] Error:", err);
  process.exit(1);
});