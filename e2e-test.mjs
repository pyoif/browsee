#!/usr/bin/env node
/**
 * End-to-end stdio JSON-RPC conversation against the built browser-mcp server.
 * Sends: initialize -> initialized -> tools/list -> browser_spawn(camoufox)
 *        -> browser_action(navigate) -> browser_action(evaluate title)
 *        -> browser_cookies save -> browser_list -> bogus action
 *        -> browser_kill -> browser_list (empty)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "dist", "server.js");
const LD = process.env.LD_LIBRARY_PATH ?? "";

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LD_LIBRARY_PATH: LD },
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("NON-JSON STDOUT:", line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

function send(method, params, id = nextId++) {
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function show(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 2500));
}

const r = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-test", version: "0.0.1" },
});
show("initialize", r);

notify("notifications/initialized", {});

const tools = await send("tools/list", {});
show("tools/list", tools.result?.tools?.map((t) => t.name));

const spawnRes = await send("tools/call", {
  name: "browser_spawn",
  arguments: { start_url: "https://example.com", stealth: true },
});
show("browser_spawn", spawnRes.result);
const sessionId = JSON.parse(spawnRes.result.content[0].text).session_id;

const navRes = await send("tools/call", {
  name: "browser_action",
  arguments: { session_id: sessionId, action: "navigate", params: { url: "https://example.com" } },
});
show("navigate", navRes.result);

const evalRes = await send("tools/call", {
  name: "browser_action",
  arguments: { session_id: sessionId, action: "evaluate", params: { js: "document.title" } },
});
show("evaluate title", evalRes.result);

const cookieRes = await send("tools/call", {
  name: "browser_cookies",
  arguments: { session_id: sessionId, mode: "save", path: "/tmp/bs_state.json" },
});
show("cookies save", cookieRes.result);

const shotRes = await send("tools/call", {
  name: "browser_action",
  arguments: {
    session_id: sessionId,
    action: "screenshot",
    params: { filename: "e2e-example.png", fullPage: true },
  },
});
show("screenshot", shotRes.result);

const listRes1 = await send("tools/call", { name: "browser_list", arguments: {} });
show("browser_list (1)", listRes1.result);

const bogus = await send("tools/call", {
  name: "browser_action",
  arguments: { session_id: sessionId, action: "fly_to_moon", params: {} },
});
show("bogus action (should be isError, server survives)", bogus.result);

const killRes = await send("tools/call", {
  name: "browser_kill",
  arguments: { session_id: sessionId },
});
show("browser_kill", killRes.result);

const listRes2 = await send("tools/call", { name: "browser_list", arguments: {} });
show("browser_list (2, should be empty)", listRes2.result);

console.log("\n=== E2E DONE ===");
child.stdin.end();
setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
}, 500);
