#!/usr/bin/env node
/**
 * memory-recall hook test via OpenClaw gateway API
 */
import { readFileSync } from "node:fs";

const GW_URL = "ws://127.0.0.1:18789";
const TOKEN = JSON.parse(readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8")).gateway?.auth?.token;

let ws;
let requestId = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `test-${++requestId}`;
    const msg = { id, method, params };
    const timeout = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    ws.send(JSON.stringify(msg));
    ws.on("message", (data) => {
      const resp = JSON.parse(data.toString());
      if (resp.id === id) {
        clearTimeout(timeout);
        resolve(resp);
      }
    });
  });
}

async function main() {
  console.log("Connecting to gateway...");
  ws = await import("ws").then(m => new m.default(GW_URL, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  }));

  await new Promise(r => ws.on("open", r));

  console.log("Sending test message with '上海' (should trigger L1 keyword match)...\n");

  const result = await send("chat.send", {
    text: "我在上海，想去健身房锻炼",
    sessionKey: "test/memory-recall-test"
  });

  console.log("Result:", JSON.stringify(result, null, 2));

  ws.close();
}

main().catch(console.error);