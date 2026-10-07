/**
 * e2e storage-state round-trip test (firefox/camoufox engine — no display needed).
 *
 * Proves the fix for the save/restore asymmetry:
 *   1. spawn firefox, navigate to a real origin, set localStorage + a cookie
 *   2. browser_cookies mode=save  → full storageState JSON on disk
 *   3. kill the session
 *   4. browser_spawn with storage_state=<that file>  → context created seeded
 *   5. evaluate localStorage on the SAME origin → value must be restored
 *
 * Run: node storage-state.e2e.mjs   (browsers already installed in the workspace cache)
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPO = process.env.BROWSEE_DIR ?? process.cwd();
const ARTIFACTS = process.env.BROWSEE_ARTIFACTS_DIR ?? `${REPO}/artifacts`;
const STATE = `${ARTIFACTS}/e2e-storage-state.json`;

const child = spawn("bash", ["run.sh"], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
child.stderr.on("data", (d) => process.stderr.write("[server] " + d.toString()));

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); }
    }, 120_000);
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { process.stderr.write("[nonjson] " + line + "\n"); return; }
  if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m); }
});
const tool = (name, args) => call("tools/call", { name, arguments: args });
const txt = (r) => { try { return JSON.parse(r.result.content[0].text); } catch { return r.result ?? r; } };

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? " — " + JSON.stringify(detail) : ""}`); }
}

try {
  rmSync(STATE, { force: true });
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  console.log("  server:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  notify("notifications/initialized", {});

  // 1. spawn firefox
  const sp = await tool("browser_spawn", { engine: "firefox" });
  const s1 = txt(sp);
  check("spawn firefox", !!s1.session_id, s1);

  // navigate to a real https origin so localStorage is same-origin addressable
  const ORIGIN = "https://example.com";
  await tool("browser_action", { session_id: s1.session_id, action: "navigate", params: { url: ORIGIN } });
  await tool("browser_action", {
    session_id: s1.session_id, action: "evaluate",
    params: { js: `localStorage.setItem('browsee_e2e','restored-42'); document.cookie='browsee_c=1; path=/'; 'set'` },
  });
  const before = txt(await tool("browser_action", {
    session_id: s1.session_id, action: "evaluate", params: { js: `localStorage.getItem('browsee_e2e')` },
  }));
  check("localStorage set before save", before?.result === "restored-42" || before?.value === "restored-42", before);

  // 2. save
  const save = txt(await tool("browser_cookies", { session_id: s1.session_id, mode: "save", path: STATE }));
  check("save wrote storage state", save.ok === true && existsSync(STATE), save);
  const saved = JSON.parse(readFileSync(STATE, "utf8"));
  check("state file has cookies array", Array.isArray(saved.cookies), { keys: Object.keys(saved) });
  check("state file has origins/localStorage", Array.isArray(saved.origins) && saved.origins.length > 0, saved.origins?.length);

  // 3. kill
  await tool("browser_kill", { session_id: s1.session_id });

  // 4. respawn with storage_state
  const sp2 = await tool("browser_spawn", { engine: "firefox", storage_state: STATE });
  const s2 = txt(sp2);
  check("spawn with storage_state", !!s2.session_id, s2);
  check("spawn echoes storage_state", s2.storage_state === STATE, s2);

  // 5. verify restore — must be on the SAME origin
  await tool("browser_action", { session_id: s2.session_id, action: "navigate", params: { url: ORIGIN } });
  const after = txt(await tool("browser_action", {
    session_id: s2.session_id, action: "evaluate", params: { js: `localStorage.getItem('browsee_e2e')` },
  }));
  check("localStorage restored AFTER respawn", after?.result === "restored-42" || after?.value === "restored-42", after);

  const cookieCheck = txt(await tool("browser_cookies", { session_id: s2.session_id, mode: "get" }));
  const hasCookie = (cookieCheck.cookies ?? []).some((c) => c.name === "browsee_c");
  check("cookie restored AFTER respawn", hasCookie, cookieCheck.cookies?.map((c) => c.name));

  await tool("browser_kill", { session_id: s2.session_id });

  // validation failures
  const bad = await tool("browser_spawn", { engine: "firefox", storage_state: "definitely-missing.json" });
  const badErr = bad?.result?.isError === true && /does not exist/.test(bad.result.content[0].text);
  check("missing storage_state file errors clearly", badErr, bad);
} catch (err) {
  failures++;
  console.log("  FAIL (exception) " + err.message);
} finally {
  child.stdin.end();
  try { child.kill(); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
