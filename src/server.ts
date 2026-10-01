#!/usr/bin/env node
/**
 * browsee — a stdio MCP server exposing scriptable browser sessions.
 *
 * Engines:
 *   - "camoufox" (default, stealth=true): launches the camoufox binary fetched
 *     by `camoufox fetch` with LD_LIBRARY_PATH pointed at the pixi GTK env so
 *     the Firefox build can find libgtk-3 etc.
 *   - "chromium" (stealth=false): launches playwright-core's bundled Chromium,
 *     which must already be installed (we never download on the fly).
 *
 * Sessions are tracked in-memory. On SIGTERM/SIGINT/exit every live session is
 * killed so no browser processes are orphaned (zombie prevention).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright-core";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync as readdirSyncFs, readlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Paths / environment
// ---------------------------------------------------------------------------

const HOME = homedir();
const PROJECT_ROOT = join(HOME, "browsee");
const ARTIFACTS_DIR = join(PROJECT_ROOT, "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** GTK/X11 libs shipped by the pixi env, needed by camoufox's Firefox build. */
const GTK_LIB_DIR = join(HOME, "camoufox", ".pixi", "envs", "default", "lib");

/** Locate the camoufox-bin executable inside the fetched browsers cache. */
function findCamoufoxDir(): string | null {
  const root = join(HOME, ".cache", "camoufox", "browsers", "official");
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (existsSync(join(dir, "camoufox-bin"))) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

type Engine = "camoufox" | "chromium";

interface Session {
  id: string;
  engine: Engine;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pid: number | null;
}

const sessions = new Map<string, Session>();

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

/** Best-effort: find a live pid whose /proc/<pid>/exe points at `exePath`. */
function findBrowserPid(exePath: string): number | null {
  try {
    for (const entry of readdirSyncFs("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const target = readlinkSync(join("/proc", entry, "exe"));
        if (target === exePath) return Number(entry);
      } catch {
        /* not our process / perm */
      }
    }
  } catch {
    /* /proc unavailable */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Launch helpers
// ---------------------------------------------------------------------------

async function launchCamoufox(
  headless: boolean,
  startUrl: string | undefined,
): Promise<Session> {
  const dir = findCamoufoxDir();
  if (!dir) {
    throw new Error(
      "camoufox not found under ~/.cache/camoufox/browsers/official/*/camoufox-bin — run `camoufox fetch` first",
    );
  }
  if (!existsSync(GTK_LIB_DIR)) {
    throw new Error(
      `GTK lib dir not found at ${GTK_LIB_DIR} — the pixi env providing libgtk-3 is missing`,
    );
  }

  const bin = join(dir, "camoufox-bin");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const existing = env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "";
  // GTK/X11 libs from the pixi env, plus the browser's own dir for its bundled
  // libxul/libnss etc.
  env.LD_LIBRARY_PATH = `${GTK_LIB_DIR}:${dir}${existing}`;
  env.MOZ_HEADLESS = headless ? "1" : "0";

  // camoufox is a Firefox build, so it must be driven by playwright-core's
  // firefox() — chromium() would send Chromium flags + a CDP handshake that
  // Firefox's juggler never completes.
  const browser = await firefox.launch({
    executablePath: bin,
    headless,
    env,
    firefoxUserPrefs: { "network.proxy.type": 0 },
    timeout: 90_000,
  });

  return register(browser, "camoufox", startUrl, bin);
}

async function launchChromium(
  headless: boolean,
  startUrl: string | undefined,
): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      timeout: 90_000,
    });
  } catch (err) {
    throw new Error(
      `failed to launch bundled chromium (is it installed? this server does not download browsers): ${
        (err as Error).message
      }`,
    );
  }
  return register(browser, "chromium", startUrl, null);
}

async function register(
  browser: Browser,
  engine: Engine,
  startUrl: string | undefined,
  executableHint: string | null,
): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Playwright-core's Browser has no process() accessor; find the browser OS
  // process by matching the launched executable in /proc (best-effort).
  let pid: number | null = null;
  if (executableHint) {
    pid = findBrowserPid(executableHint);
  }
  const session: Session = {
    id: randomUUID(),
    engine,
    browser,
    context,
    page,
    pid,
  };
  sessions.set(session.id, session);
  if (startUrl) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return session;
}

async function killSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    await s.context.close();
  } catch {
    /* ignore */
  }
  try {
    await s.browser.close();
  } catch {
    /* ignore */
  }
}

async function killAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map((id) => killSession(id)));
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function runAction(
  session: Session,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const page = session.page;
  switch (action) {
    case "navigate": {
      const url = params.url as string;
      if (!url) throw new Error("navigate requires params.url");
      const resp = await page.goto(url, {
        waitUntil: (params.waitUntil as "domcontentloaded") ?? "domcontentloaded",
        timeout: 60_000,
      });
      return { url: page.url(), status: resp?.status() ?? null, title: await page.title() };
    }
    case "click": {
      const selector = params.selector as string;
      if (!selector) throw new Error("click requires params.selector");
      await page.click(selector, { timeout: 30_000 });
      return { ok: true, url: page.url() };
    }
    case "fill": {
      const selector = params.selector as string;
      if (!selector) throw new Error("fill requires params.selector");
      await page.fill(selector, String(params.value ?? ""), { timeout: 30_000 });
      return { ok: true };
    }
    case "press": {
      const key = params.key as string;
      if (!key) throw new Error("press requires params.key");
      if (params.selector) await page.press(params.selector as string, key);
      else await page.keyboard.press(key);
      return { ok: true };
    }
    case "evaluate": {
      const js = params.js as string;
      if (!js) throw new Error("evaluate requires params.js");
      const value: unknown = await page.evaluate(js);
      return { value };
    }
    case "wait_for": {
      const selector = params.selector as string;
      if (!selector) throw new Error("wait_for requires params.selector");
      await page.waitForSelector(selector, {
        timeout: Number(params.timeout ?? 30_000),
      });
      return { ok: true };
    }
    case "screenshot": {
      const name = (params.filename as string) ?? `shot-${Date.now()}.png`;
      const path = join(ARTIFACTS_DIR, name);
      const fullPage = Boolean(params.fullPage ?? false);
      await page.screenshot({ path, fullPage });
      return { path, bytes: statSync(path).size };
    }
    case "status": {
      const bodyText = (await page.evaluate(
        "document.body ? document.body.innerText : ''",
      )) as string;
      return {
        url: page.url(),
        title: await page.title(),
        bodyText: String(bodyText).slice(0, 500),
      };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "browsee", version: "0.1.0" });

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }],
  };
}

server.registerTool(
  "browser_spawn",
  {
    title: "Spawn browser session",
    description:
      "Launch a browser session. stealth=true (default) uses the camoufox stealth Firefox; stealth=false uses bundled Chromium.",
    inputSchema: {
      session_id: z.string().optional(),
      headless: z.boolean().optional(),
      start_url: z.string().optional(),
      stealth: z.boolean().optional(),
    },
  },
  async ({ headless, start_url, stealth }) => {
    try {
      const useStealth = stealth ?? true;
      const session =
        useStealth === true
          ? await launchCamoufox(headless ?? true, start_url)
          : await launchChromium(headless ?? true, start_url);
      return text({
        session_id: session.id,
        engine: session.engine,
        headless: headless ?? true,
        url: session.page.url(),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_kill",
  {
    title: "Kill browser session",
    description: "Close a session by id and remove it from the registry.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    try {
      if (!sessions.has(session_id)) throw new Error(`unknown session_id: ${session_id}`);
      await killSession(session_id);
      return text({ ok: true, killed: session_id });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_list",
  {
    title: "List browser sessions",
    description: "List all live sessions with id, engine, pid and current URL.",
    inputSchema: {},
  },
  async () => {
    const list = [...sessions.values()].map((s) => ({
      session_id: s.id,
      engine: s.engine,
      pid: s.pid,
      url: s.page.url(),
    }));
    return text({ count: list.length, sessions: list });
  },
);

server.registerTool(
  "browser_action",
  {
    title: "Browser action",
    description:
      "Dispatch an action on a live session's page: navigate, click, fill, press, evaluate, screenshot, wait_for, status.",
    inputSchema: {
      session_id: z.string(),
      action: z.string(),
      params: z.record(z.string(), z.any()).optional(),
    },
  },
  async ({ session_id, action, params }) => {
    try {
      const session = getSession(session_id);
      const result = await runAction(session, action, params ?? {});
      return text(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_cookies",
  {
    title: "Browser cookies / storage state",
    description:
      "mode=get returns cookies; mode=save writes a full storage-state JSON to path; mode=load loads storage state from path into the context.",
    inputSchema: {
      session_id: z.string(),
      mode: z.enum(["get", "save", "load"]),
      path: z.string().optional(),
    },
  },
  async ({ session_id, mode, path }) => {
    try {
      const session = getSession(session_id);
      if (mode === "get") {
        const cookies = await session.context.cookies();
        return text({ count: cookies.length, cookies });
      }
      if (mode === "save") {
        if (!path) throw new Error("mode=save requires path");
        const state = await session.context.storageState({ path });
        return text({ ok: true, path, cookies: state.cookies.length, origins: state.origins.length });
      }
      // load
      if (!path) throw new Error("mode=load requires path");
      if (!existsSync(path)) throw new Error(`path does not exist: ${path}`);
      const state = JSON.parse(readFileSync(path, "utf8"));
      const cookies = state.cookies ?? [];
      if (cookies.length) await session.context.addCookies(cookies);
      return text({ ok: true, path, loadedCookies: cookies.length });
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Lifecycle / zombie prevention
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`browsee: shutting down (${signal}), killing ${sessions.size} session(s)\n`);
  await killAllSessions();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("exit", () => {
  // Best-effort synchronous kill; playwright children are tracked by the
  // browser object but exit handlers must be sync, so we rely on SIGTERM path.
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("browsee: ready on stdio\n");
