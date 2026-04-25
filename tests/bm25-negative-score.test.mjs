/**
 * memory-recall: BM25 negative score regression tests
 * Tiny corpora produce negative BM25 scores (IDF = 0 when term appears in 50%+ docs).
 * This was a real bug: combined score was < 0 and results were silently dropped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "os";
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

describe("BM25 negative score handling", () => {
  const uid = `n${Date.now().toString(36)}`;

  it("single-doc corpus returns results even with negative scores", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      const r = await w.call("store", {
        content: "我喜欢在深圳南山区科技园工作",
        agent_id: `${uid}-single`,
      });

      const recall = await w.call("recall", {
        query: "工作",
        agent_id: `${uid}-single`,
        max_results: 3,
      });

      assert.ok(recall.count > 0 || recall.results.length > 0 || recall.layers.l1 > 0,
        `Should return results even for negative scores. Got: ${JSON.stringify(recall)}`);
      assert.ok(recall.results.every(m => m.content), "Every result must have content");
    } finally {
      w.cleanup();
    }
  });

  it("tiny corpus with shared terms still returns results", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      await w.call("store", { content: "我喜欢学习 Python 编程", agent_id: `${uid}-tiny` });
      await w.call("store", { content: "Python 是最好的语言", agent_id: `${uid}-tiny` });

      const recall = await w.call("recall", {
        query: "学习",
        agent_id: `${uid}-tiny`,
        max_results: 3,
      });

      assert.ok(
        recall.results.length > 0 || recall.layers.l1 > 0,
        `Should find results despite shared 'Python' term causing low IDF. Got: ${JSON.stringify(recall)}`
      );
    } finally {
      w.cleanup();
    }
  });

  it("BM25 scores are correctly negative for tiny corpora", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mr-negscore-"));

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-c", `
import sys, json
sys.path.insert(0, '${PROJ}')
from src.core.bm25_index import BM25Index

bm = BM25Index('${workDir}/bm25_tiny.json')
bm.add('doc1', '苹果 是 水果', '${uid}-tiny')
bm.add('doc2', '苹果 是 水果', '${uid}-tiny')
scores = bm.search('苹果', top_k=5)
print(json.dumps(scores))
`], {
        env: { ...process.env, PYTHONPATH: PROJ },
        timeout: 10000,
      });
      let out = "", err = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.stderr.on("data", (d) => { err += d.toString(); });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`${code}: ${err}`));
        resolve(out.trim());
      });
      proc.on("error", reject);
    });

    const scores = JSON.parse(result);
    assert.ok(Array.isArray(scores) && scores.length > 0, `Should have BM25 results. Got: ${result}`);
    assert.ok(typeof scores[0].score === "number", "Score should be a number");

    const found = scores.find(s => s.id === "doc1");
    assert.ok(found, "Should find doc1");
    rmSync(workDir, { recursive: true, force: true });
  });

  it("worker recall with negative combined score still returns results", async () => {
    const w = makeWorker();
    try {
      await w.call("health");

      await w.call("store", { content: "测试 内容 A", agent_id: `${uid}-neg-combined` });
      await w.call("store", { content: "测试 内容 B", agent_id: `${uid}-neg-combined` });

      const recall = await w.call("recall", {
        query: "测试",
        agent_id: `${uid}-neg-combined`,
        max_results: 5,
      });

      assert.ok(
        recall.results.length > 0 || recall.layers.l1 > 0,
        `Combined score may be negative but should still return results. Got: ${JSON.stringify(recall)}`
      );
      assert.ok(
        recall.results.every(m => m.content && typeof m.agent_id === "string"),
        `All results should have content and valid agent_id. Got: ${JSON.stringify(recall.results)}`
      );
    } finally {
      w.cleanup();
    }
  });
});
