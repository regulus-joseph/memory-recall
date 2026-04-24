/**
 * Plugin smoke test - validates plugin structure without OpenClaw runtime
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function testPlugin() {
  console.log("=== memory-recall Plugin Smoke Test ===\n");

  // 1. Validate manifest
  console.log("1. Checking openclaw.plugin.json...");
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "openclaw.plugin.json"), "utf-8")
  );
  console.log(`   ID: ${manifest.id}`);
  console.log(`   Name: ${manifest.name}`);
  console.log(`   Entry: ${manifest.openclaw?.plugins?.[0]?.entry}`);
  console.log("   ✓ Manifest valid\n");

  // 2. Validate package.json
  console.log("2. Checking package.json...");
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf-8")
  );
  console.log(`   Name: ${pkg.name}`);
  console.log(`   Version: ${pkg.version}`);
  console.log(`   Type: ${pkg.type}`);
  console.log("   ✓ package.json valid\n");

  // 3. Validate TypeScript entry
  console.log("3. Checking src/index.ts...");
  const entrySrc = readFileSync(resolve(__dirname, "src/index.ts"), "utf-8");
  // Check for createPlugin OR memoryRecallPlugin.register
  if (!entrySrc.includes("register")) {
    throw new Error("Missing register method");
  }
  if (!entrySrc.includes('api.on("before_prompt_build"')) {
    throw new Error("Missing before_prompt_build hook");
  }
  console.log("   ✓ TypeScript entry valid\n");

  // 4. Validate config schema
  console.log("4. Checking configSchema...");
  const schema = manifest.configSchema;
  if (!schema?.properties?.qdrant) {
    throw new Error("Missing qdrant config schema");
  }
  if (!schema?.properties?.embedding) {
    throw new Error("Missing embedding config schema");
  }
  console.log("   ✓ Config schema valid\n");

  // 5. Validate Qdrant connectivity
  console.log("5. Testing Qdrant connection...");
  try {
    const resp = await fetch("http://localhost:6333/collections/memory_recall", {
      method: "GET",
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log(`   ✓ Qdrant reachable, collection exists (${data.result?.points_count ?? 0} points)\n`);
    } else {
      console.log(`   ⚠ Qdrant responded with status ${resp.status} (collection may not exist)\n`);
    }
  } catch (err) {
    console.log(`   ⚠ Qdrant not reachable: ${err.message}\n`);
  }

  // 6. Validate Ollama embedding
  console.log("6. Testing Ollama embedding...");
  try {
    const resp = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bge-m3", prompt: "test" }),
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log(`   ✓ Ollama reachable, embedding dim: ${data.embedding?.length ?? "unknown"}\n`);
    } else {
      console.log(`   ⚠ Ollama responded with status ${resp.status}\n`);
    }
  } catch (err) {
    console.log(`   ⚠ Ollama not reachable: ${err.message}\n`);
  }

  console.log("=== Smoke Test Complete ===");
  console.log("\nTo run with OpenClaw:");
  console.log("  1. Link plugin: openclaw plugin add memory-recall");
  console.log("  2. Or copy to ~/.openclaw/plugins/");
  console.log("  3. Start openclaw and check logs for [memory-recall]");
}

testPlugin().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});