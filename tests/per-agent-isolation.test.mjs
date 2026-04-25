/**
 * memory-recall: per-agent isolation tests
 * Verifies agent A cannot see agent B's memories.
 * Uses stdio JSON-RPC to interact with worker.py.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJ = join(fileURLToPath(import.meta.url), "../..");
const PY = process.env.PYTHON_BIN || "/home/marlon-wei/.memory-recall-venv/bin/python";

function makeWorker() {
  const workDir = mkdtempSync(join(tmpdir(), "mr-iso-"));
  const proc = spawn(PY, [join(PROJ, "src/worker.py")], {
    env: { ...process.env, PYTHONPATH: PROJ },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  let nextId = 1;
  const pending = new Map();

  proc.stdout.on("data", (d) => {
    const lines = d.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        }
      } catch { /* non-JSON line */ }
    }
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      proc.stdin?.write(req);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 10000);
    });
  }

  function cleanup() {
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { call, cleanup, stderr };
}

describe("per-agent isolation", () => {
  const uid = `t${Date.now().toString(36)}`;

  it("agent A memories are invisible to agent B", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      const rA = await w.call("store", { content: "agent-alpha 秘密项目代号：凤凰", agent_id: `${uid}-alpha` });
      assert.ok(rA.memory_id, "store for agent A should succeed");

      const rB = await w.call("store", { content: "agent-beta 财务报告 Q1", agent_id: `${uid}-beta` });
      assert.ok(rB.memory_id, "store for agent B should succeed");

      const recallA = await w.call("recall", { query: "秘密项目", agent_id: `${uid}-alpha`, max_results: 5 });
      const recallB = await w.call("recall", { query: "秘密项目", agent_id: `${uid}-beta`, max_results: 5 });

      const aIds = recallA.results.map(r => r.id);
      const bIds = recallB.results.map(r => r.id);

      assert.ok(aIds.includes(rA.memory_id), `Agent A should find its own memory. Got: ${JSON.stringify(recallA.results)}`);
      assert.ok(!bIds.includes(rA.memory_id), `Agent B should NOT find agent A's memory. Got: ${JSON.stringify(recallB.results)}`);

      const recallB2 = await w.call("recall", { query: "财务报告", agent_id: `${uid}-beta`, max_results: 5 });
      const recallA2 = await w.call("recall", { query: "财务报告", agent_id: `${uid}-alpha`, max_results: 5 });

      assert.ok(recallB2.results.some(r => r.id === rB.memory_id), `Agent B should find its own memory`);
      assert.ok(!recallA2.results.some(r => r.id === rB.memory_id), `Agent A should NOT find agent B's memory`);
    } finally {
      w.cleanup();
    }
  });

  it("default agent isolation from named agents", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      await w.call("store", { content: `default session preferences ${uid}`, agent_id: `${uid}-default` });
      await w.call("store", { content: `saffron project roadmap ${uid}`, agent_id: `${uid}-saffron` });

      const defaultRecall = await w.call("recall", { query: "preferences", agent_id: `${uid}-default`, max_results: 5 });
      const saffronRecall = await w.call("recall", { query: "roadmap", agent_id: `${uid}-saffron`, max_results: 5 });

      assert.ok(defaultRecall.results.length > 0, "default agent should find its memories");
      assert.ok(saffronRecall.results.length > 0, "saffron should find its memories");
      assert.ok(!saffronRecall.results.some(r => r.content.includes("preferences")),
        "saffron should not see default's memories");
    } finally {
      w.cleanup();
    }
  });

  it("agent without memories returns empty results", async () => {
    const w = makeWorker();
    try {
      await w.call("health");
      await w.call("store", { content: `taken by occupied ${uid}`, agent_id: `${uid}-occupied` });

      const emptyRecall = await w.call("recall", { query: "未存储的记忆", agent_id: `${uid}-empty`, max_results: 5 });

      assert.strictEqual(emptyRecall.count, 0, "empty agent should have 0 results");
      assert.deepStrictEqual(emptyRecall.results, []);
    } finally {
      w.cleanup();
    }
  });

  it("stats only counts agent's own memories", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      await w.call("store", { content: `stats-alpha memory 1 ${uid}`, agent_id: `${uid}-stats-alpha` });
      await w.call("store", { content: `stats-alpha memory 2 ${uid}`, agent_id: `${uid}-stats-alpha` });
      await w.call("store", { content: `stats-beta memory 1 ${uid}`, agent_id: `${uid}-stats-beta` });

      const alphaStats = await w.call("stats", { agent_id: `${uid}-stats-alpha` });
      const betaStats = await w.call("stats", { agent_id: `${uid}-stats-beta` });

      assert.strictEqual(alphaStats.bm25_doc_count, 2, `${uid}-stats-alpha should have 2 memories, got ${alphaStats.bm25_doc_count}`);
      assert.strictEqual(alphaStats.graph_node_count, 2, "graph should have 2 nodes");
      assert.strictEqual(betaStats.bm25_doc_count, 1, `${uid}-stats-beta should have 1 memory`);
      assert.strictEqual(betaStats.graph_node_count, 1, "graph should have 1 node");
    } finally {
      w.cleanup();
    }
  });

  it("forget only removes from the owning agent", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      const rA = await w.call("store", { content: `alpha to be forgotten ${uid}`, agent_id: `${uid}-forget-alpha` });
      await w.call("store", { content: `beta keep this ${uid}`, agent_id: `${uid}-forget-beta` });

      const before = await w.call("recall", { query: "forgotten", agent_id: `${uid}-forget-alpha`, max_results: 5 });
      assert.ok(before.results.some(r => r.id === rA.memory_id), "memory should exist before forget");

      await w.call("forget", { memory_id: rA.memory_id, agent_id: `${uid}-forget-alpha` });

      const after = await w.call("recall", { query: "forgotten", agent_id: `${uid}-forget-alpha`, max_results: 5 });
      assert.ok(!after.results.some(r => r.id === rA.memory_id), "memory should be gone after forget");

      const betaRecall = await w.call("recall", { query: "keep this", agent_id: `${uid}-forget-beta`, max_results: 5 });
      assert.ok(betaRecall.results.length > 0, "beta's memory should still exist");
    } finally {
      w.cleanup();
    }
  });

  it("per-agent files are separate on disk", async () => {
    const diskUid = `d${Date.now().toString(36)}`;
    const workDir = mkdtempSync(join(tmpdir(), "mr-iso-disk-"));
    const proc = spawn(PY, [join(PROJ, "src/worker.py")], {
      env: { ...process.env, PYTHONPATH: PROJ },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    let nextId = 1;
    proc.stdout.on("data", (d) => {
      const lines = d.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const cb = pending.get(msg.id);
            pending.delete(msg.id);
            cb.resolve(msg.result || msg.error);
          }
        } catch { /* non-JSON */ }
      }
    });

    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout")); } }, 10000);
    });

    try {
      await call("health");
      const alphaId = diskUid + "-alpha-disk";
      const betaId = diskUid + "-beta-disk";
      await call("store", { content: `alpha unique disk content ${diskUid}`, agent_id: alphaId });
      await call("store", { content: `beta unique disk content ${diskUid}`, agent_id: betaId });

      await call("stats", { agent_id: alphaId });

      const { existsSync, readdirSync } = await import("node:fs");
      const alphaDir = join(process.env.HOME, `.memory-recall/data/${alphaId}`);
      const betaDir = join(process.env.HOME, `.memory-recall/data/${betaId}`);

      assert.ok(existsSync(alphaDir), `alpha dir should exist: ${alphaDir}`);
      assert.ok(existsSync(betaDir), `beta dir should exist: ${betaDir}`);
      assert.ok(existsSync(join(alphaDir, "memories.lance")), "alpha should have memories.lance");
      assert.ok(existsSync(join(betaDir, "memories.lance")), "beta should have memories.lance");
      assert.ok(existsSync(join(alphaDir, "graph.json")), "alpha should have graph.json");
      assert.ok(existsSync(join(betaDir, "graph.json")), "beta should have graph.json");

      const alphaFiles = readdirSync(join(alphaDir, "memories.lance"));
      assert.ok(alphaFiles.length > 0, "alpha memories.lance should not be empty");
    } finally {
      try { proc.kill(); } catch { /* ignore */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
