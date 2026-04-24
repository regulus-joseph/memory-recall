/**
 * memory-recall test suite
 * Run: node --test tests/all.test.mjs
 * Python modules are tested via subprocess calls to the venv Python.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir as osTmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(testDir, "..");
const PY = process.env.PYTHON_BIN || "/home/marlon-wei/.memory-recall-venv/bin/python";

function makeTmpFile() {
  return path.join(osTmpdir(), `mr-test-${Math.random().toString(36).slice(2, 8)}.json`);
}

function cleanupFile(file) {
  try { rmSync(file, { force: true }); } catch (_) {}
}

async function pyRun(code, cwd = PROJ) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ["-c", code], {
      cwd,
      timeout: 15000,
      env: { ...process.env, PYTHONPATH: PROJ },
    });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${code}: ${err.slice(0, 200)}`));
      resolve(out.trim());
    });
    proc.on("error", reject);
  });
}

async function pyTest(code, expected) {
  const result = await pyRun(code);
  assert.equal(result, expected, `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`);
}

async function pyAssert(code, check) {
  const result = await pyRun(code);
  check(result);
}

// --- lark_tok tests ---

describe("lark_tok tokenizer", () => {
  it("segments Chinese compound words", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.lark_tok import tokenize; print('|'.join(tokenize('我住在深圳南山区')))`,
      (out) => {
        assert.ok(out.includes("深圳"), `Expected 深圳 in ${out}`);
        assert.ok(out.includes("南山区"), `Expected 南山区 in ${out}`);
      });
  });

  it("segments food terms as single word", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.lark_tok import tokenize; print('|'.join(tokenize('我喜欢吃麻辣火锅')))`,
      (out) => {
        assert.ok(out.includes("麻辣火锅"), `Expected 麻辣火锅 in ${out}`);
      });
  });

  it("filters stopwords", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.lark_tok import tokenize, STOPWORDS; tokens = tokenize('我住在深圳'); print('OK' if '我' not in tokens and '深圳' in tokens and '的' in STOPWORDS else 'FAIL')`,
      (out) => { assert.equal(out, "OK"); });
  });

  it("handles English version numbers", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.lark_tok import tokenize; print('|'.join(tokenize('qwen3.5和qwen2.5对比')))`,
      (out) => {
        assert.ok(out.toLowerCase().includes("qwen"), `Expected qwen in ${out}`);
      });
  });

  it("filters single-char tokens", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.lark_tok import tokenize; tokens = tokenize('我住在深圳南山区'); single = [t for t in tokens if len(t)==1]; print('none' if not single else '|'.join(single))`,
      (out) => { assert.equal(out, "none"); });
  });
});

// --- rule_extractor tests ---

describe("rule_extractor", () => {
  it("extracts category from keywords", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.rule_extractor import extract; print(extract('我住在深圳南山区')['category'])`,
      (out) => { assert.ok(out.length > 0, `Category should not be empty: ${out}`); });
  });

  it("extracts 6w when time/location present", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.rule_extractor import extract; r = extract('我上周去深圳出差三天'); import json; print(json.dumps(r.get('6w', {})))`,
      (out) => {
        const sixw = JSON.parse(out);
        const filled = Object.values(sixw).filter(Boolean).length;
        assert.ok(filled > 0, `At least one 6w field should be filled: ${JSON.stringify(sixw)}`);
      });
  });

  it("assigns higher importance to decisions", async () => {
    await pyAssert(`import sys; sys.path.insert(0, '${PROJ}'); from src.rule_extractor import extract; high = extract('我决定移民去德国柏林工作'); low = extract('测试一下'); print(round(high['importance'], 2), round(low['importance'], 2))`,
      (out) => {
        const [hi, lo] = out.split(" ").map(Number);
        assert.ok(hi >= lo, `High (${hi}) should >= low (${lo})`);
      });
  });
});

// --- BM25Index tests ---

describe("BM25Index incremental", () => {
  it("adds documents", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.bm25_index import BM25Index; idx = BM25Index('${f}'); idx.add('doc1','我住在深圳','a'); idx.add('doc2','川菜','a'); idx.add('doc3','天气','b'); print(idx.doc_count())`);
      assert.equal(parseInt(out), 3);
    } finally { cleanupFile(f); }
  });

  it("searches by keyword with scores", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.bm25_index import BM25Index; idx = BM25Index('${f}'); idx.add('doc1','我住在深圳南山区','a'); idx.add('doc2','我喜欢吃川菜','a'); idx.add('doc3','今天天气很好','a'); idx.add('doc4','去深圳出差','a'); idx.add('doc5','住在广州深圳的人','a'); r = idx.search('深圳',5); import json; print(json.dumps([{'id':x['id'],'score':round(x['score'],3)} for x in r]))`);
      const results = JSON.parse(out);
      assert.ok(results.length > 0, "Should find '深圳'");
      const hasDoc1 = results.some((r) => r.id === "doc1");
      const hasDoc4 = results.some((r) => r.id === "doc4");
      const hasDoc5 = results.some((r) => r.id === "doc5");
      assert.ok(hasDoc1 || hasDoc4 || hasDoc5, `At least one doc with 深圳 should appear: ${JSON.stringify(results)}`);
      const nonZero = results.filter((r) => r.score !== 0);
      assert.ok(nonZero.length > 0, `At least one doc should have non-zero BM25 score: ${JSON.stringify(results)}`);
    } finally { cleanupFile(f); }
  });

  it("removes documents", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.bm25_index import BM25Index; idx = BM25Index('${f}'); idx.add('doc1','深圳','a'); idx.add('doc2','川菜','a'); idx.remove('doc2'); print(idx.doc_count())`);
      assert.equal(parseInt(out), 1);
    } finally { cleanupFile(f); }
  });

  it("updates documents", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.bm25_index import BM25Index; idx = BM25Index('${f}'); idx.add('doc1','我住在深圳','a'); idx.update_doc('doc1','我住在广州'); r = idx.search('广州',5); import json; print(json.dumps([x['id'] for x in r]))`);
      const results = JSON.parse(out);
      assert.ok(results.length > 0, "Updated content should be searchable");
    } finally { cleanupFile(f); }
  });

  it("persists to disk", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.bm25_index import BM25Index; idx = BM25Index('${f}'); idx.add('doc1','测试内容','a'); idx.force_rebuild(); idx2 = BM25Index('${f}'); print(idx2.doc_count())`);
      assert.equal(parseInt(out), 1);
    } finally { cleanupFile(f); }
  });
});

// --- GraphStore tests ---

describe("GraphStore", () => {
  it("adds nodes", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.graph_store import GraphStore; gs = GraphStore('${f}'); gs.add_node('mem1', {'content':'我住在深圳'}); gs.add_node('mem2', {'content':'我喜欢川菜'}); print(gs.node_count())`);
      assert.equal(parseInt(out), 2);
    } finally { cleanupFile(f); }
  });

  it("session edges connect same conversation", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.graph_store import GraphStore; gs = GraphStore('${f}'); gs.add_node('mem1',{'content':'第一句'}); gs.add_node('mem2',{'content':'第二句'}); gs.add_node('mem3',{'content':'不同会话'}); gs.add_session_edge('mem1','conv1'); gs.add_session_edge('mem2','conv1'); gs.add_session_edge('mem3','conv2'); r1 = gs.expand(['mem1'], depth=1); r3 = gs.expand(['mem3'], depth=1); import json; print('R1:' + json.dumps(r1) + ' R3:' + json.dumps(r3))`);
      assert.ok(out.includes('"mem2"'), `Same conv should connect: ${out}`);
      assert.ok(out.includes('R3:{"mem3"}') || !out.includes('"mem1"'), `Different conv in r3: ${out}`);
    } finally { cleanupFile(f); }
  });

  it("recall edges connect related memories", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.graph_store import GraphStore; gs = GraphStore('${f}'); gs.add_node('mem1',{'content':'query'}); gs.add_node('mem2',{'content':'result1'}); gs.add_node('mem3',{'content':'result2'}); gs.build_recall_edges('mem1',['mem2','mem3']); r = gs.expand(['mem1'], depth=1); import json; print(len(r))`);
      assert.equal(parseInt(out), 2, `Should have 2 recall neighbors: ${out}`);
    } finally { cleanupFile(f); }
  });

  it("expand returns scored neighbors", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.graph_store import GraphStore; gs = GraphStore('${f}'); gs.add_node('seed',{'content':'核心'}); gs.add_node('related',{'content':'相关'}); gs.add_session_edge('seed','c1'); gs.add_session_edge('related','c1'); r = gs.expand(['seed'], depth=1); import json; print(json.dumps(r))`);
      const expanded = JSON.parse(out);
      assert.ok("related" in expanded, `Should expand to related: ${out}`);
      assert.ok(expanded.related > 0, `Score should be positive: ${out}`);
    } finally { cleanupFile(f); }
  });

  it("persists to disk", async () => {
    const f = makeTmpFile();
    try {
      const out = await pyRun(`import sys; sys.path.insert(0, '${PROJ}'); from src.core.graph_store import GraphStore; gs = GraphStore('${f}'); gs.add_node('mem1',{'content':'测试'}); gs._save(); gs2 = GraphStore('${f}'); print(gs2.node_count())`);
      assert.equal(parseInt(out), 1);
    } finally { cleanupFile(f); }
  });
});

// --- plugin smoke tests (pure ESM, no subprocess) ---

describe("plugin smoke", () => {
  it("index.ts contains plugin name and capability registration", () => {
    const content = readFileSync(path.join(PROJ, "src/index.ts"), "utf-8");
    assert.ok(content.includes("memory-recall"));
    assert.ok(content.includes("registerMemoryCapability"));
  });

  it("openclaw.plugin.json is valid manifest", () => {
    const manifest = JSON.parse(readFileSync(path.join(PROJ, "openclaw.plugin.json"), "utf-8"));
    assert.ok(manifest.id);
    assert.ok(manifest.name);
    assert.ok(manifest.version);
    assert.ok(manifest.kind);
    assert.ok(manifest.configSchema);
  });

  it("server.py compiles without syntax errors", () => {
    return new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-m", "py_compile", path.join(PROJ, "src/server.py")], { timeout: 10000 });
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(err));
        resolve();
      });
      proc.on("error", reject);
    });
  });

  it("lark_tok.py compiles", () => {
    return new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-m", "py_compile", path.join(PROJ, "src/lark_tok.py")], { timeout: 10000 });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`));
        resolve();
      });
      proc.on("error", reject);
    });
  });

  it("rule_extractor.py compiles", () => {
    return new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-m", "py_compile", path.join(PROJ, "src/rule_extractor.py")], { timeout: 10000 });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`));
        resolve();
      });
      proc.on("error", reject);
    });
  });

  it("bm25_index.py compiles", () => {
    return new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-m", "py_compile", path.join(PROJ, "src/core/bm25_index.py")], { timeout: 10000 });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`));
        resolve();
      });
      proc.on("error", reject);
    });
  });

  it("graph_store.py compiles", () => {
    return new Promise((resolve, reject) => {
      const proc = spawn(PY, ["-m", "py_compile", path.join(PROJ, "src/core/graph_store.py")], { timeout: 10000 });
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}`));
        resolve();
      });
      proc.on("error", reject);
    });
  });
});
