/**
 * memory-recall: concurrency tests
 * Tests concurrent writes, updates, and file lock behavior.
 * Uses multiple worker processes to simulate real concurrency.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "node:url";

const PROJ = join(fileURLToPath(import.meta.url), "../..");
const PY = process.env.PYTHON_BIN || "/home/marlon-wei/.memory-recall-venv/bin/python";

function makeWorker(agentId) {
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
          if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else cb.resolve(msg.result);
        }
      } catch { /* non-JSON */ }
    }
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
  });

  const cleanup = () => { try { proc.kill(); } catch { /* ignore */ } };

  return { call, cleanup, proc };
}

describe("worker concurrency", { concurrency: 1 }, () => {
  const uid = `c${Date.now().toString(36)}`;

  it("sequential writes succeed without conflict", async () => {
    const w = makeWorker(`${uid}-seq`);
    try {
      await w.call("health");

      const r1 = await w.call("store", { content: `sequential memory 1 ${uid}`, agent_id: `${uid}-seq` });
      const r2 = await w.call("store", { content: `sequential memory 2 ${uid}`, agent_id: `${uid}-seq` });
      const r3 = await w.call("store", { content: `sequential memory 3 ${uid}`, agent_id: `${uid}-seq` });

      assert.ok(r1.memory_id !== r2.memory_id);
      assert.ok(r2.memory_id !== r3.memory_id);
      assert.ok(r1.memory_id !== r3.memory_id);

      const stats = await w.call("stats", { agent_id: `${uid}-seq` });
      assert.ok(stats.memory_count >= 3, `Expected >= 3 docs, got ${stats.memory_count}`);
    } finally {
      w.cleanup();
    }
  });

  it("concurrent writes from multiple workers succeed (no data loss)", async () => {
    const workers = [makeWorker(`${uid}-cw-a`), makeWorker(`${uid}-cw-b`), makeWorker(`${uid}-cw-c`)];
    try {
      await Promise.all(workers.map(w => w.call("health")));

      const stores = [];
      for (let i = 0; i < 3; i++) {
        stores.push(workers[i].call("store", {
          content: `concurrent memory from worker ${i} ${uid}`,
          agent_id: `${uid}-concurrent-test`,
        }));
      }

      const results = await Promise.all(stores);
      const ids = new Set(results.map(r => r.memory_id));

      assert.strictEqual(ids.size, 3, `All 3 concurrent stores should succeed and have unique IDs. Got: ${results.map(r => r.memory_id)}`);
      assert.ok(results.every(r => r.memory_id), "All results should have memory_id");
    } finally {
      workers.forEach(w => w.cleanup());
    }
  });

  it("concurrent stores to different agents succeed (per-agent isolation)", async () => {
    const u = `${uid}-iso`;
    const w1 = makeWorker(`${u}-a`);
    const w2 = makeWorker(`${u}-b`);
    const w3 = makeWorker(`${u}-c`);

    try {
      await Promise.all([w1.call("health"), w2.call("health"), w3.call("health")]);

      const [r1, r2, r3] = await Promise.all([
        w1.call("store", { content: `agent-a memory ${u}`, agent_id: `${u}-a` }),
        w2.call("store", { content: `agent-b memory ${u}`, agent_id: `${u}-b` }),
        w3.call("store", { content: `agent-c memory ${u}`, agent_id: `${u}-c` }),
      ]);

      assert.ok(r1.memory_id && r2.memory_id && r3.memory_id, "All stores should succeed");

      const [recallA, recallB, recallC] = await Promise.all([
        w1.call("recall", { query: "memory", agent_id: `${u}-a`, max_results: 5 }),
        w2.call("recall", { query: "memory", agent_id: `${u}-b`, max_results: 5 }),
        w3.call("recall", { query: "memory", agent_id: `${u}-c`, max_results: 5 }),
      ]);

      assert.ok(recallA.results.some(r => r.agent_id === `${u}-a`), "iso-a should find its memory");
      assert.ok(recallB.results.some(r => r.agent_id === `${u}-b`), "iso-b should find its memory");
      assert.ok(recallC.results.some(r => r.agent_id === `${u}-c`), "iso-c should find its memory");
    } finally {
      [w1, w2, w3].forEach(w => w.cleanup());
    }
  });

  it("concurrent updates do not corrupt data", async () => {
    const workers = [makeWorker(`${uid}-upd-0`), makeWorker(`${uid}-upd-1`), makeWorker(`${uid}-upd-2`)];
    try {
      await Promise.all(workers.map(w => w.call("health")));

      const stores = await Promise.all(workers.map((w, i) =>
        w.call("store", { content: `original content ${i} ${uid}`, agent_id: `${uid}-update-test` })
      ));

      const updates = await Promise.all(stores.map((r, i) =>
        workers[i].call("update", { memory_id: r.memory_id, content: `updated content ${i} ${uid}` })
      ));

      assert.ok(updates.every(u => u.updated), "All updates should succeed");

      const recalls = await Promise.all(workers.map((w, i) =>
        w.call("recall", { query: `updated content ${i}`, agent_id: `${uid}-update-test`, max_results: 5 })
      ));

      for (let i = 0; i < 3; i++) {
        assert.ok(recalls[i].results.some(r => r.content.includes(`updated content ${i} ${uid}`)),
          `Memory ${i} should reflect update. Got: ${JSON.stringify(recalls[i].results)}`);
      }
    } finally {
      workers.forEach(w => w.cleanup());
    }
  });

  it("high concurrency stores (4 workers x 2 stores) - verify data integrity", async () => {
    const WORKER_COUNT = 4;
    const workers = Array.from({ length: WORKER_COUNT }, (_, i) => makeWorker(`${uid}-hc-${i}`));
    try {
      await Promise.all(workers.map(w => w.call("health")));

      const allStores = workers.map((w, i) =>
        Promise.all([
          w.call("store", { content: `hc-content-a-${uid}-${i}`, agent_id: `${uid}-high-conc` }),
          w.call("store", { content: `hc-content-b-${uid}-${i}`, agent_id: `${uid}-high-conc` }),
        ])
      );

      const flat = (await Promise.all(allStores)).flat();
      const valid = flat.filter(r => r && r.memory_id);
      const ids = [...new Set(valid.map(r => r.memory_id))];

      assert.ok(valid.length >= 4, `At least 4 of 8 stores should succeed, got ${valid.length}`);
      assert.ok(ids.length === valid.length, `All returned IDs should be unique. IDs=${ids.length}, valid=${valid.length}`);

      const recall = await workers[0].call("recall", { query: uid, agent_id: `${uid}-high-conc`, max_results: 20 });
      const recalledIds = recall.results.map(r => r.id);
      const uniqueRecalled = new Set(recalledIds);

      assert.ok(uniqueRecalled.size > 0, "Should be able to recall stored memories");
      assert.ok(recall.results.every(r => r.agent_id === `${uid}-high-conc`), "All recalled memories should belong to the correct agent");
    } finally {
      workers.forEach(w => w.cleanup());
    }
  });
});
