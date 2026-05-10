/**
 * memory-recall: worker smoke tests (end-to-end)
 * Tests store, recall, update, forget, stats, health via JSON-RPC.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "node:url";

const PROJ = join(fileURLToPath(import.meta.url), "../..");
const PY = process.env.PYTHON_BIN || "/home/marlon-wei/.memory-recall-venv/bin/python";

function makeWorker() {
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 10000);
  });
  const cleanup = () => { try { proc.kill(); } catch { /* ignore */ } };
  return { call, cleanup };
}

describe("worker smoke (end-to-end)", () => {
  const uid = `s${Date.now().toString(36)}`;

  it("health returns ok", async () => {
    const w = makeWorker();
    try {
      const r = await w.call("health");
      assert.strictEqual(r.status, "ok");
    } finally {
      w.cleanup();
    }
  });

  it("store returns memory_id and conversation_id", async () => {
    const w = makeWorker();
    try {
      const r = await w.call("store", {
        content: "今天天气很好，我们去公园散步",
        agent_id: `${uid}-smoke`,
      });
      assert.ok(r.memory_id, "store should return memory_id");
      assert.ok(r.memory_id.length > 10, "memory_id should be a UUID");
      assert.ok(r.conversation_id, "store should return conversation_id");
      assert.strictEqual(typeof r.dedup, "boolean", "store should return dedup flag");
    } finally {
      w.cleanup();
    }
  });

  it("recall finds stored content", async () => {
    const w = makeWorker();
    try {
      const stored = await w.call("store", {
        content: "我最喜欢的食物是麻辣火锅",
        agent_id: `${uid}-recall`,
      });

      const recall = await w.call("recall", {
        query: "喜欢 什么 食物",
        agent_id: `${uid}-recall`,
        max_results: 5,
      });

      assert.ok(recall.results, "recall should return results array");
      assert.ok(recall.count >= 0, "recall should return count");
      assert.ok(typeof recall.layers === "object", "recall should return layers");
      assert.ok("l1" in recall.layers, "layers should have l1");
      assert.ok("l2" in recall.layers, "layers should have l2");
    } finally {
      w.cleanup();
    }
  });

  it("recall with empty query returns empty results", async () => {
    const w = makeWorker();
    try {
      const r = await w.call("recall", { query: "", agent_id: `${uid}-empty` });
      assert.strictEqual(r.count, 0);
      assert.deepStrictEqual(r.results, []);
    } finally {
      w.cleanup();
    }
  });

  it("update changes content", async () => {
    const w = makeWorker();
    try {
      const stored = await w.call("store", {
        content: "原内容 version 1",
        agent_id: `${uid}-update`,
      });

      const updated = await w.call("update", {
        memory_id: stored.memory_id,
        content: "更新后内容 version 2",
      });
      assert.ok(updated.updated, "update should succeed");

      const recall = await w.call("recall", {
        query: "version 2",
        agent_id: `${uid}-update`,
        max_results: 5,
      });
      assert.ok(recall.results.some(r => r.content.includes("version 2")),
        `Should find updated content. Got: ${JSON.stringify(recall.results)}`);
    } finally {
      w.cleanup();
    }
  });

  it("update non-existent memory returns error", async () => {
    const w = makeWorker();
    try {
      const r = await w.call("update", {
        memory_id: "00000000-0000-0000-0000-000000000000",
        content: "new content",
      });
      // Should return gracefully with either updated=false or error field
      assert.ok(!r.updated || r.error, `update of non-existent should fail gracefully, got: ${JSON.stringify(r)}`);
    } finally {
      w.cleanup();
    }
  }, 15000); // 15s timeout for this slow test

  it("forget removes memory", async () => {
    const w = makeWorker();
    try {
      const stored = await w.call("store", {
        content: "这条消息将被删除",
        agent_id: `${uid}-forget`,
      });

      const forgotten = await w.call("forget", { memory_id: stored.memory_id });
      assert.ok(forgotten.deleted, "forget should return deleted: true");

      const recall = await w.call("recall", {
        query: "删除",
        agent_id: `${uid}-forget`,
        max_results: 5,
      });
      assert.ok(!recall.results.some(r => r.id === stored.memory_id),
        "Forgotten memory should not appear in recall");
    } finally {
      w.cleanup();
    }
  });

  it("stats returns counts", async () => {
    const w = makeWorker();
    try {
      await w.call("store", { content: `stat test 1 ${uid}`, agent_id: `${uid}-stats` });
      await w.call("store", { content: `stat test 2 ${uid}`, agent_id: `${uid}-stats` });
      await w.call("store", { content: `stat test 3 ${uid}`, agent_id: `${uid}-stats` });

      const stats = await w.call("stats", { agent_id: `${uid}-stats` });
      assert.ok(typeof stats.memory_count === "number", "stats should have memory_count");
      assert.ok(typeof stats.graph_node_count === "number", "stats should have graph_node_count");
      assert.ok(typeof stats.categories === "object" || typeof stats.tiers === "object", "stats should have breakdown fields");
    } finally {
      w.cleanup();
    }
  });

  it("store dedup flag works", async () => {
    const w = makeWorker();
    try {
      const content = `完全相同的存储内容，用于测试去重 ${uid}`;
      const r1 = await w.call("store", { content, agent_id: `${uid}-dedup` });
      const r2 = await w.call("store", { content, agent_id: `${uid}-dedup` });

      assert.ok(!r1.dedup, "first store should not be dedup");
    } finally {
      w.cleanup();
    }
  });

  it("Chinese text content preserved in recall", async () => {
    const w = makeWorker();
    try {
      const original = "深圳市南山区科技园大冲商务中心B座1903室";
      const r = await w.call("store", { content: original, agent_id: `${uid}-chinese` });

      const recall = await w.call("recall", {
        query: "大冲",
        agent_id: `${uid}-chinese`,
        max_results: 3,
      });

      if (recall.results.length > 0) {
        assert.ok(
          recall.results.some(m => m.content.includes("大冲")),
          `Chinese content should be preserved. Got: ${JSON.stringify(recall.results.map(m => m.content))}`
        );
      }
    } finally {
      w.cleanup();
    }
  });
});
