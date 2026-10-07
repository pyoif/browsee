#!/usr/bin/env node
/**
 * browsee — a stdio MCP server exposing scriptable browser sessions.
 *
 * Engines (browser_spawn takes engine: "firefox" | "chrome"):
 *   - "firefox" (default): the camoufox Firefox engine — full anti-fingerprint
 *     capability (config/fingerprint/addons/locale/geoip/humanize). Launched
 *     with LD_LIBRARY_PATH pointed at the pixi GTK env so the build finds
 *     libgtk-3 etc., and driven by vanilla playwright-core's firefox() —
 *     patchright's patched firefox driver is NOT compatible with camoufox's
 *     patched juggler (page.evaluate breaks).
 *   - "chrome": branded Chrome For Testing driven by PATCHRIGHT (the patched,
 *     undetectable Playwright fork), launched headed via Xvfb. Patchright's
 *     stealth comes from the patched driver code, so the driver library — not
 *     just the browser binary — is what makes this undetectable. The browser
 *     must already be installed (we never download on the fly; see
 *     browser_install_chromium).
 *     This is the deliberate split: patchright for chrome, playwright-core for
 *     the camoufox/firefox engine. Both are stealth-optimized; engine selects
 *     the browser stack, not stealth on/off.
 *
 * Sessions are tracked in-memory. On SIGTERM/SIGINT/exit every live session is
 * killed so no browser processes are orphaned (zombie prevention).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium as patchrightChromium } from "patchright";
import {
  firefox as playwrightFirefox,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync as readdirSyncFs, readlinkSync } from "node:fs";
import { extractAll } from "./zip.js";
import { downloadToBuffer, downloadText, logStderr } from "./download.js";
import {
  assembleCamoufoxOptions,
  isOnPath,
  resolveInstallDir,
  type CamoufoxSpawnOptions,
} from "./camoufox.js";

// ---------------------------------------------------------------------------
// Paths / environment
// ---------------------------------------------------------------------------

const HOME = homedir();
const PROJECT_ROOT = join(HOME, "browsee");
const ARTIFACTS_DIR = join(PROJECT_ROOT, "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** GTK/X11 libs shipped by the pixi env, needed by camoufox's Firefox build. */
const GTK_LIB_DIR = join(HOME, "camoufox", ".pixi", "envs", "default", "lib");

/** Return the tag/dir/bin of an existing camoufox build under `root`, if any. */
function findExistingCamoufox(root: string): { tag: string; dir: string; bin: string } | null {
  return findCamoufoxInRoot(root);
}

function findCamoufoxInRoot(root: string): { tag: string; dir: string; bin: string } | null {
  const official = join(root, "browsers", "official");
  if (!existsSync(official)) return null;
  for (const entry of readdirSync(official)) {
    const dir = join(official, entry);
    const bin = join(dir, "camoufox-bin");
    if (existsSync(bin)) return { tag: entry, dir, bin };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

type Engine = "firefox" | "chrome";

interface Session {
  id: string;
  engine: Engine;
  browser: Browser;
  context: BrowserContext;
  /**
   * The active page for this session. browser_action/browser_cookies operate on
   * this page. Tab tools (browser_tab_*) mutate it; the pages themselves live in
   * `context.pages()`, which is the source of truth for ordering.
   */
  page: Page;
  pid: number | null;
  /** Human-readable display/xvfb decision for this session (optional). */
  displayNote?: string;
  /** Xvfb process we started for this session, killed on session close. */
  xvfb?: XvfbHandle;
  /** Number of camoufox addons loaded (firefox engine only). */
  addonsLoaded?: number;
}

const sessions = new Map<string, Session>();

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

/**
 * Resolve the active page for a session, guarding against the case where the
 * active tab was closed externally (by the page, not by our tools). If the
 * stored page is gone, fall back to the last open page, or throw if none remain.
 */
function activePage(session: Session): Page {
  if (!session.page.isClosed()) return session.page;
  const open = session.context.pages().filter((p) => !p.isClosed());
  const fallback = open[open.length - 1];
  if (!fallback) throw new Error("session has no open tabs; create one with browser_tab_new");
  session.page = fallback;
  return fallback;
}

/** Index of the session's active page among the context's live pages, or -1. */
function activeIndex(session: Session): number {
  const pages = session.context.pages();
  const idx = pages.indexOf(session.page);
  return idx;
}

/**
 * Validate a tab index against the session's live page list and return the
 * Page. Throws a clear error for out-of-range indices.
 */
function pageAtIndex(session: Session, index: number): Page {
  const pages = session.context.pages();
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
    throw new Error(`invalid tab index ${index}; session has ${pages.length} tab(s) (0..${pages.length - 1})`);
  }
  const page = pages[index];
  if (!page) throw new Error(`invalid tab index ${index}`);
  return page;
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

/**
 * Launch the camoufox firefox engine with FULL capability, via the official
 * `camoufox` package (daijro/camoufox/typescript). The package owns fingerprint
 * generation, CAMOU_CONFIG/CAMOU_PREFS assembly, addons, fonts, GeoIP, locale,
 * humanize and virtual display. We only add container plumbing: the GTK/X11
 * LD_LIBRARY_PATH (no system libgtk-3 in the Wolfi image) and the translation
 * of browser_spawn's capability knobs into launchOptions().
 *
 * camoufox is a Firefox build, so it is driven by vanilla playwright-core's
 * firefox() — patchright's patched firefox driver is incompatible with
 * camoufox's patched juggler (page.evaluate breaks).
 */
async function launchCamoufox(
  headless: boolean,
  startUrl: string | undefined,
  options: CamoufoxSpawnOptions = {},
): Promise<Session> {
  if (!existsSync(GTK_LIB_DIR)) {
    throw new Error(
      `GTK lib dir not found at ${GTK_LIB_DIR} — the pixi env providing libgtk-3 is missing`,
    );
  }

  // The official launcher resolves the browser itself (its paired build by
  // default, or whatever is active). We do not force executable_path unless an
  // install already exists at the expected location, so a plain `Camoufox()`
  // launch can still fetch/manage its build.
  const { dir: installDir, exists: hasInstall } = resolveInstallDir(process.env);
  const installed = hasInstall ? findExistingCamoufox(installDir) : null;
  const bin = installed?.bin;
  const browserDir = installed?.dir;

  const launchOpts = await assembleCamoufoxOptions(options, {
    headless,
    homeDir: HOME,
    processEnv: process.env,
    executablePath: bin,
    browserDir,
  });

  logStderr(
    `camoufox launch: engine=firefox headless=${headless} install=${hasInstall ? installDir : "(package-managed)"} display=${process.env.DISPLAY ?? "none"}`,
  );

  const browser = (await playwrightFirefox.launch({
    ...launchOpts,
    timeout: 90_000,
  } as Parameters<typeof playwrightFirefox.launch>[0])) as unknown as Browser;

  const session = await register(browser, "firefox", startUrl, bin ?? null);
  const cfgAddons = (launchOpts as { env?: Record<string, string> }).env?.CAMOU_CONFIG_1;
  session.displayNote = process.env.DISPLAY ? `DISPLAY=${process.env.DISPLAY}` : "headless (no display)";
  if (cfgAddons) {
    try {
      const parsed = JSON.parse(cfgAddons) as { addons?: unknown[] };
      if (Array.isArray(parsed.addons)) session.addonsLoaded = parsed.addons.length;
    } catch {
      /* config chunk is split across CAMOU_CONFIG_2.. for large configs */
    }
  }
  return session;
}

async function launchChromium(
  headless: boolean,
  startUrl: string | undefined,
): Promise<Session> {
  // The Wolfi runtime image ships most of chromium's shared libs, but a few
  // can be absent (e.g. libudev.so.1). Playwright's chromium looks for them via
  // the dynamic loader; we extend LD_LIBRARY_PATH with any browser-support lib
  // directories present on disk so the launch works in a slim image without
  // requiring the caller to set the env var. No-op when the libs already load.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const extraLibDirs = findBrowserSupportLibDirs();
  if (extraLibDirs.length > 0) {
    const existing = env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "";
    env.LD_LIBRARY_PATH = `${extraLibDirs.join(":")}${existing}`;
  }

  // Headed is required for stealth fidelity: patchright's patches only hold in
  // a real (non-headless-shell) browser. On a server with no display we must
  // ACTUALLY provide one — previously we only *reported* "headed via xvfb-run"
  // while launching with no DISPLAY, which made Chromium fail with its own
  // "Missing X server or $DISPLAY". We now manage a real Xvfb lifecycle: when
  // DISPLAY is unset and `Xvfb` is on PATH, spawn Xvfb on a free display, point
  // the launch env at it, and record the child so it can be killed on session
  // close. `xvfb-run` is only a fallback when the raw `Xvfb` binary is absent.
  const display = env.DISPLAY;
  let xvfb: XvfbHandle | null = null;
  let displayNote: string;
  if (display && display.trim() !== "") {
    env.DISPLAY = display;
    displayNote = `headed on DISPLAY=${display}`;
  } else if (isOnPath("Xvfb")) {
    xvfb = await startXvfb();
    env.DISPLAY = xvfb.display;
    displayNote = `headed via Xvfb ${xvfb.display} (no DISPLAY set)`;
  } else if (isOnPath("xvfb-run")) {
    // Fallback: wrap the launch in `xvfb-run`. patchright exposes no argv
    // override for the browser process itself, so we instead provide a display
    // by running the whole stdio server under xvfb-run is not possible here;
    // refuse with an actionable error rather than launch headless.
    throw new Error(
      "Chrome engine requires a display (patchright's stealth patches need a headed browser). " +
        "`Xvfb` is not on PATH (only `xvfb-run` is); install the xvfb package to get the `Xvfb` " +
        "binary, or set DISPLAY, then retry.",
    );
  } else {
    throw new Error(
      "Chrome engine requires a display (patchright's stealth patches need a headed browser). " +
        "No DISPLAY is set and Xvfb is not installed. Install xvfb (e.g. `apk add xvfb`) " +
        "or set DISPLAY, then retry.",
    );
  }

  // Resolve the executable explicitly instead of forcing `channel: "chrome"`.
  //
  // `channel: "chrome"` makes patchright look for a SYSTEM branded Chrome at
  // /opt/google/chrome/chrome. This container has no system Chrome — the
  // Chrome-for-Testing build is installed into patchright's browsers cache by
  // browser_install_chromium. So install location and launch location must be
  // reconciled by resolving the SAME path the install tool writes to, in this
  // order:
  //   (a) an explicit env override (BROWSEE_CHROME_EXECUTABLE / CHROME_PATH),
  //   (b) the path patchright itself resolves for its managed Chrome-for-Testing
  //       build (patchright's executablePath()) — the exact location
  //       browser_install_chromium installs into, so install/launch agree by
  //       construction,
  //   (c) /opt/google/chrome/chrome as the last fallback (a real system Chrome),
  //   (d) otherwise a clear error telling the caller to run
  //       browser_install_chromium.
  // `channel` is intentionally NOT set when we resolve an explicit path: passing
  // both would re-trigger the system-Chrome lookup we're avoiding.
  const executablePath = resolveChromeExecutable();

  const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage"];

  let browser: Browser;
  try {
    // patchright chromium is API-identical to playwright-core's; its nominal
    // types just live in a different package. Cast so both engines share the
    // playwright-core-typed Session.
    browser = (await patchrightChromium.launch({
      // Headed: never headless-shell. Note we pass headless:false and rely on
      // the real Xvfb display acquired above for the "no display" case.
      headless: false,
      // Explicit executable resolved above (do NOT also set channel: "chrome").
      executablePath,
      args: launchArgs,
      env,
      timeout: 90_000,
    })) as unknown as Browser;
  } catch (err) {
    if (xvfb) await xvfb.stop();
    throw new Error(
      `failed to launch Chrome (is it installed? run browser_install_chromium): ${
        (err as Error).message
      }`,
    );
  }
  const session = await register(browser, "chrome", startUrl, executablePath);
  if (xvfb) session.xvfb = xvfb;
  session.displayNote = displayNote;
  return session;
}

/**
 * A live Xvfb display we started for a session. `display` is the value to put in
 * DISPLAY (e.g. ":99"); `stop()` terminates the Xvfb process and resolves once
 * it has exited. Best-effort: a failed stop is ignored.
 */
interface XvfbHandle {
  display: string;
  stop(): Promise<void>;
}

/**
 * Start Xvfb on a free display number and wait until its socket exists.
 *
 * Strategy: probe display numbers from `:99` upward (skipping any whose
 * /tmp/.X11-unix/X<n> socket already exists), spawn `Xvfb :<n> -screen 0
 * 1920x1080x24 -nolisten tcp`, then poll for the socket (up to ~5s) so the
 * caller never launches Chrome before the X server is ready. If all probed
 * displays are taken or Xvfb dies, throw with the captured stderr.
 */
async function startXvfb(): Promise<XvfbHandle> {
  const { spawn } = await import("node:child_process");

  for (let n = 99; n < 130; n++) {
    const display = `:${n}`;
    const socketPath = `/tmp/.X11-unix/X${n}`;
    if (existsSync(socketPath)) continue;

    const child = spawn("Xvfb", [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    let exited = false;
    let exitCode: number | null = null;
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    // Wait for the X socket to appear (server ready), or for Xvfb to exit.
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      if (exited) break;
      if (existsSync(socketPath)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!ready) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      // If a specific display number was the only problem, try the next one;
      // otherwise surface why Xvfb died.
      if (exited && stderr.trim() !== "") {
        // e.g. display already in use race — continue probing
        continue;
      }
      continue;
    }

    const stop = async (): Promise<void> => {
      if (exited) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child.once("exit", done);
        try {
          child.kill("SIGTERM");
        } catch {
          resolve();
          return;
        }
        // Escalate if it doesn't go down promptly.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000).unref?.();
        // Resolve on its own if the exit listener never fires.
        setTimeout(done, 4000).unref?.();
      });
    };

    void exitCode; // referenced for clarity of the exit-tracking above
    return { display, stop };
  }

  throw new Error(
    "Chrome engine: could not start Xvfb — no free display number found in :99..:129.",
  );
}

/**
 * Directories that should be appended to LD_LIBRARY_PATH for chromium. We scan
 * a small set of workspace-local locations (the same places the container's
 * other toolchains keep their libs) for libudev.so.1, which is the one commonly
 * missing from slim images. Returns dirs in priority order, deduped.
 */
function findBrowserSupportLibDirs(): string[] {
  const dirs: string[] = [];
  const candidates = [
    join(HOME, ".local", "lib", "udev"),
    join(HOME, "camoufox", ".pixi", "envs", "default", "lib"),
    "/usr/lib",
    "/lib",
  ];
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir);
      if (entries.some((e) => e.startsWith("libudev.so"))) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    } catch {
      /* ignore */
    }
  }
  return dirs;
}

/** Resolve the chromium executable path patchright will use, best-effort. */
function chromiumExecutablePath(): string | null {
  try {
    return patchrightChromium.executablePath();
  } catch {
    return null;
  }
}

/**
 * Resolve the Chrome executable to launch for `engine: "chrome"`.
 *
 * This is the SINGLE source of truth shared (by construction) with
 * `browser_install_chromium`: the install tool writes the Chrome-for-Testing
 * build to patchright's managed cache, and `patchrightChromium.executablePath()`
 * reports exactly that location. Resolving through it here means install and
 * launch can never disagree again (the previous `channel: "chrome"` forced a
 * lookup of a SYSTEM Chrome at /opt/google/chrome/chrome that does not exist in
 * this container).
 *
 * Resolution order:
 *   (a) explicit env override: BROWSEE_CHROME_EXECUTABLE, then CHROME_PATH
 *   (b) patchright's managed Chrome-for-Testing path (where the install tool puts it)
 *   (c) /opt/google/chrome/chrome (a real system Chrome), if it exists
 *   (d) throw a clear error telling the caller to run browser_install_chromium
 */
function resolveChromeExecutable(): string {
  const override = (
    process.env.BROWSEE_CHROME_EXECUTABLE ||
    process.env.CHROME_PATH ||
    ""
  ).trim();
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(
      `BROWSEE_CHROME_EXECUTABLE/CHROME_PATH points at "${override}" but that file does not exist.`,
    );
  }

  // (b) patchright's own resolution — the SAME location browser_install_chromium
  // installs into (chromium-<revision>/chrome-linux64/chrome).
  const managed = chromiumExecutablePath();
  if (managed && existsSync(managed)) return managed;

  // (c) last resort: a genuine system Chrome.
  const system = "/opt/google/chrome/chrome";
  if (existsSync(system)) return system;

  // (d) nothing usable — be explicit about how to fix it.
  const expected = managed ?? "(patchright could not report a path)";
  throw new Error(
    `Chrome engine: no Chrome executable found. Run browser_install_chromium to install the ` +
      `matching Chrome-for-Testing build (expected at ${expected}), or set ` +
      `BROWSEE_CHROME_EXECUTABLE to an existing Chrome binary.`,
  );
}

async function register(
  browser: Browser,
  engine: Engine,
  startUrl: string | undefined,
  executableHint: string | null,
): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Playwright (patchright) Browser has no process() accessor; find the browser
  // OS process by matching the launched executable in /proc (best-effort).
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
  if (s.xvfb) {
    try {
      await s.xvfb.stop();
    } catch {
      /* ignore */
    }
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
  const page = activePage(session);
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

const server = new McpServer({ name: "browsee", version: "0.3.0" });

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
      "Launch a browser session. engine=\"firefox\" (default) uses the camoufox Firefox engine with full anti-fingerprinting capability (config, addons, locale/geoip/humanize). engine=\"chrome\" uses the patchright-driven branded Chrome engine (headed, via Xvfb when no display). Both engines are the stealth-optimized stack — the choice is which browser stack to drive, not stealth on/off.",
    inputSchema: {
      session_id: z.string().optional(),
      engine: z.enum(["chrome", "firefox"]).optional(),
      headless: z.boolean().optional(),
      start_url: z.string().optional(),
      // firefox (camoufox) capability knobs:
      fingerprint: z.record(z.string(), z.unknown()).optional(),
      geoip: z.union([z.string(), z.boolean()]).optional(),
      locale: z.union([z.string(), z.array(z.string())]).optional(),
      humanize: z.union([z.boolean(), z.number()]).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async ({ engine, headless, start_url, fingerprint, geoip, locale, humanize, config }) => {
    try {
      const useFirefox = (engine ?? "firefox") === "firefox";
      const camoufoxOptions: CamoufoxSpawnOptions = {};
      if (fingerprint) camoufoxOptions.fingerprint = fingerprint as Record<string, unknown>;
      if (geoip !== undefined) camoufoxOptions.geoip = geoip;
      if (locale !== undefined) camoufoxOptions.locale = locale;
      if (humanize !== undefined) camoufoxOptions.humanize = humanize;
      if (config) camoufoxOptions.config = config as Record<string, unknown>;
      const session = useFirefox
        ? await launchCamoufox(headless ?? true, start_url, camoufoxOptions)
        : await launchChromium(headless ?? false, start_url);
      return text({
        session_id: session.id,
        engine: session.engine,
        url: activePage(session).url(),
        ...(session.displayNote ? { display: session.displayNote } : {}),
        ...(session.addonsLoaded !== undefined ? { addons: session.addonsLoaded } : {}),
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
      url: activePage(s).url(),
      tabs: s.context.pages().length,
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
// Tab management
// ---------------------------------------------------------------------------

server.registerTool(
  "browser_tab_list",
  {
    title: "List tabs",
    description:
      "List the open tabs of a session. Each entry has index, url, title and an active flag. The active tab is the one browser_action/browser_cookies operate on.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    try {
      const session = getSession(session_id);
      const pages = session.context.pages();
      const active = activeIndex(session);
      const tabs = await Promise.all(
        pages.map(async (p, index) => ({
          index,
          url: p.url(),
          title: await p.title().catch(() => ""),
          active: index === active,
        })),
      );
      return text({ count: tabs.length, active, tabs });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_tab_new",
  {
    title: "Open new tab",
    description:
      "Open a new tab in a session (optional url) and make it the session's active tab.",
    inputSchema: {
      session_id: z.string(),
      url: z.string().optional(),
    },
  },
  async ({ session_id, url }) => {
    try {
      const session = getSession(session_id);
      const page = await session.context.newPage();
      session.page = page;
      if (url) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
      const index = session.context.pages().indexOf(page);
      return text({ ok: true, index, url: page.url(), count: session.context.pages().length });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_tab_select",
  {
    title: "Select active tab",
    description:
      "Switch a session's active tab by index (see browser_tab_list). Subsequent browser_action and browser_cookies calls use this tab.",
    inputSchema: {
      session_id: z.string(),
      index: z.number(),
    },
  },
  async ({ session_id, index }) => {
    try {
      const session = getSession(session_id);
      const page = pageAtIndex(session, index);
      session.page = page;
      return text({ ok: true, index, url: page.url(), title: await page.title().catch(() => "") });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "browser_tab_close",
  {
    title: "Close tab",
    description:
      "Close a session tab by index. If the last tab is closed, the underlying browser is kept alive with zero pages (playwright-core permits a context with no pages); use browser_tab_new to open a fresh one, or browser_kill to end the session. The active tab is reassigned to the last remaining tab.",
    inputSchema: {
      session_id: z.string(),
      index: z.number(),
    },
  },
  async ({ session_id, index }) => {
    try {
      const session = getSession(session_id);
      const page = pageAtIndex(session, index);
      await page.close();
      const remaining = session.context.pages();
      if (remaining.length > 0) {
        // If we closed the active tab, fall back to the last remaining one.
        if (session.page === page || session.page.isClosed()) {
          const fallback = remaining[remaining.length - 1];
          if (fallback) session.page = fallback;
        }
      }
      return text({
        ok: true,
        closed: index,
        remaining: remaining.length,
        active: remaining.length > 0 ? session.context.pages().indexOf(session.page) : null,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Browser install tools (zero dependencies; Node builtins only)
// ---------------------------------------------------------------------------

/** Where playwright-core looks for browsers unless PLAYWRIGHT_BROWSERS_PATH overrides. */
function playwrightBrowsersDir(): string {
  return process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH.trim() !== ""
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : join(homedir(), ".cache", "ms-playwright");
}

/**
 * Locate patchright's bundled browsers.json. Patchright re-exports
 * patchright-core, and the revision data lives in `patchright-core/browsers.json`
 * (the `patchright` package itself has none). We search the local node_modules
 * and the nub store/cache for both package layouts.
 */
function readBrowserRevision(name: string): { revision: string; browserVersion: string; source: string } {
  const candidates: string[] = [];

  const addFrom = (dir: string): void => {
    // Direct install: <dir>/patchright-core/browsers.json
    candidates.push(join(dir, "patchright-core", "browsers.json"));
    candidates.push(join(dir, "patchright", "node_modules", "patchright-core", "browsers.json"));
    // nub store layout: <dir>/node_modules/.store/patchright-core@x/node_modules/patchright-core/browsers.json
    for (const store of [join(dir, "node_modules", ".store"), join(dir, ".store")]) {
      try {
        if (!existsSync(store)) continue;
        for (const entry of readdirSync(store)) {
          if (entry.startsWith("patchright-core@")) {
            candidates.push(join(store, entry, "node_modules", "patchright-core", "browsers.json"));
          }
        }
      } catch {
        /* ignore */
      }
    }
  };

  // 1) Relative to THIS module (dist/server.js → ../node_modules). This is the
  //    reliable anchor: the server may be launched from any cwd (e.g. the daemon
  //    workspace) and resolves its own dependencies next to its own file.
  const moduleRoots = collectAncestorNodeModules(dirname(fileURLToPath(import.meta.url)));
  for (const root of moduleRoots) addFrom(root);

  // 2) The process cwd's node_modules (dev runs from the repo root).
  addFrom(join(process.cwd(), "node_modules"));

  // 3) nub global package cache: each cached package lives under pm/git.
  try {
    const pmGit = join(homedir(), ".cache", "nub", "pm", "git");
    if (existsSync(pmGit)) {
      for (const pkg of readdirSync(pmGit)) addFrom(join(pmGit, pkg));
    }
  } catch {
    /* ignore */
  }

  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        browsers: { name: string; revision: string; browserVersion?: string }[];
      };
      const hit = data.browsers.find((b) => b.name === name);
      if (hit) return { revision: hit.revision, browserVersion: hit.browserVersion ?? "", source: path };
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `could not locate patchright's browsers.json (patchright-core/browsers.json). Looked in: ${candidates.join(", ")}. Is patchright installed?`,
  );
}

/**
 * Return node_modules parent roots by walking up from `startDir`, so a server
 * launched from a nested directory still finds its own installed dependencies.
 */
function collectAncestorNodeModules(startDir: string): string[] {
  const roots: string[] = [];
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

server.registerTool(
  "browser_install_chromium",
  {
    title: "Install Chrome For Testing for patchright",
    description:
      "Download the exact Chrome For Testing build that this server's patchright (patched Playwright fork) expects — revision read from patchright-core's browsers.json (the \"chromium\" entry IS the Chrome-for-Testing build) — into the Playwright browsers directory, so browser_spawn with engine=\"chrome\" works. Installs the FULL build (never the detectable chromium_headless_shell). Zero dependencies: ZIP fetched from the Playwright CDN and extracted with Node's zlib.",
    inputSchema: {},
  },
  async () => {
    try {
      // Patchright's own guidance: use the full chromium build, not the
      // headless shell (the shell leaks detectable signals). We therefore read
      // the "chromium" revision and never install "chromium-headless-shell".
      const { revision, browserVersion, source } = readBrowserRevision("chromium");
      const target = playwrightBrowsersDir();
      const dest = join(target, `chromium-${revision}`);
      // Determine the platform layout the zip will use. Playwright's chromium
      // is a Chrome-for-Testing build: linux x64 => chrome-linux64/chrome,
      // linux arm64 => chrome-linux-arm64/chrome.
      const isArm = process.arch === "arm64";
      const cftDir = isArm ? "chrome-linux-arm64" : "chrome-linux64";
      const cftPlatform = isArm ? "linux-arm64/chrome-linux-arm64.zip" : "linux64/chrome-linux64.zip";
      const chromeBin = join(dest, cftDir, "chrome");
      if (existsSync(join(dest, "INSTALLATION_COMPLETE")) && existsSync(chromeBin)) {
        return text({
          ok: true,
          alreadyInstalled: true,
          revision,
          browserVersion,
          path: dest,
          chrome: chromeBin,
          browsersJson: source,
        });
      }
      if (!existsSync(join(dest, "INSTALLATION_COMPLETE"))) {
        logStderr(`chromium ${revision} not installed; fetching from Playwright CDN`);
      }

      // Build the candidate URLs the way playwright's registry does: modern
      // revisions are Chrome-for-Testing builds addressed by browserVersion
      // (builds/cft/<version>/<platform>/<file>). We keep the legacy
      // chromium-<revision> paths as fallbacks for older layouts.
      const urls: string[] = [];
      if (browserVersion) {
        for (const mirror of [
          "https://cdn.playwright.dev",
          "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
        ]) {
          for (const suffix of [
            `builds/cft/${browserVersion}/${cftPlatform}`,
            // Some CFT assets also live under the Playwright mirror path.
            `dbazure/download/playwright/builds/cft/${browserVersion}/${cftPlatform}`,
          ]) {
            urls.push(`${mirror}/${suffix}`);
          }
        }
      }
      urls.push(
        `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-${revision}.zip`,
        `https://playwright.azureedge.net/builds/chromium/${revision}/chromium-${revision}.zip`,
        `https://cdn.playwright.dev/builds/chromium/${revision}/chromium-${revision}.zip`,
      );
      const label = `chromium-${revision}${browserVersion ? ` (${browserVersion})` : ""}.zip`;
      const { buffer, source: srcUrl } = await downloadToBuffer(urls, { label });
      // Verify ZIP magic ("PK\x03\x04" or "PK\x05\x06" for an empty archive).
      if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
        throw new Error("downloaded file is not a ZIP (missing PK magic)");
      }

      mkdirSync(dest, { recursive: true });
      const res = extractAll(buffer, dest, {
        chmodPlusX: [
          `${cftDir}/chrome`,
          `${cftDir}/chrome_crashpad_handler`,
          `${cftDir}/chrome_sandbox`,
          // legacy layouts
          `chrome-linux64/chrome`,
          `chrome-linux64/chrome_crashpad_handler`,
          `chrome-linux64/chrome_sandbox`,
          `chrome-linux/chrome`,
          `chrome-linux/chrome_crashpad_handler`,
          `chrome-linux/chrome_sandbox`,
        ],
      });
      // Write the Playwright INSTALLATION_COMPLETE marker that playwright-core
      // checks before it will use this browser build.
      const marker = join(dest, "INSTALLATION_COMPLETE");
      writeFileSync(marker, "");
      // Locate chrome under whichever layout the zip used.
      const chromeCandidates = [
        join(dest, "chrome-linux64", "chrome"),
        join(dest, "chrome-linux-arm64", "chrome"),
        join(dest, "chrome-linux", "chrome"),
      ];
      const chrome = chromeCandidates.find((p) => existsSync(p));
      if (chrome) {
        try {
          chmodSync(chrome, 0o755);
        } catch {
          /* ignore */
        }
      }

      return text({
        ok: true,
        component: "chromium",
        revision,
        browserVersion,
        path: dest,
        chrome: chrome ?? null,
        extractedFiles: res.files,
        bytes: buffer.length,
        source: srcUrl,
        browsersJson: source,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

/**
 * Summarize an installed camoufox build's layout: the binary, whether the
 * addons/ tree + properties.json + fontconfig are present (the pieces the
 * full-capability launcher reads), and the addon names found.
 */
function describeCamoufoxLayout(dest: string, root: string): {
  executable: boolean;
  addonsDir: string | null;
  addons: string[];
  propertiesJson: boolean;
  fontconfig: boolean;
  versionJson: boolean;
  auxFiles: string[];
} {
  const addonsRootCandidates = [join(dest, "addons"), join(root, "addons")];
  let addonsDir: string | null = null;
  for (const c of addonsRootCandidates) {
    if (existsSync(c)) {
      addonsDir = c;
      break;
    }
  }
  // List immediate subdirectories of addons/ (each is an unpacked addon).
  const addons = addonsDir
    ? readdirSync(addonsDir).filter((name) => {
        try {
          return statSync(join(addonsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  const versionJsonPath = join(dest, "version.json");
  return {
    executable: existsSync(join(dest, "camoufox-bin")),
    addonsDir,
    addons,
    propertiesJson: existsSync(join(dest, "properties.json")),
    fontconfig: existsSync(join(dest, "fontconfig")),
    versionJson: existsSync(versionJsonPath),
    auxFiles: [
      "application.ini",
      "platform.ini",
      "camoufox.cfg",
      "chrome.css",
      "dependentlibs.list",
      "fonts",
      "defaults",
    ].filter((f) => existsSync(join(dest, f))),
  };
}

server.registerTool(
  "browser_install_camoufox",
  {
    title: "Install camoufox firefox browser",
    description:
      "Download the latest camoufox Linux build from GitHub releases into the directory server.ts expects (~/.cache/camoufox, or CAMOUFOX_INSTALL_DIR), so browser_spawn works. Extracts the FULL release (binary + addons/ + fontconfig/ + properties.json) so the full-capability launcher can load addons and validate config. Zero dependencies: ZIP fetched from GitHub and extracted with Node's zlib.",
    inputSchema: {},
  },
  async () => {
    try {
      // server.ts resolves camoufox via findCamoufoxDir() ->
      //   <CAMOUFOX_INSTALL_DIR | ~/.cache/camoufox>/browsers/official/<tag>/camoufox-bin
      // The tool must install to exactly that layout, so we mirror it here.
      const root = process.env.CAMOUFOX_INSTALL_DIR && process.env.CAMOUFOX_INSTALL_DIR.trim() !== ""
        ? process.env.CAMOUFOX_INSTALL_DIR
        : join(homedir(), ".cache", "camoufox");

      const release = JSON.parse(
        await downloadText("https://api.github.com/repos/daijro/camoufox/releases/latest", {
          headers: {
            "User-Agent": "browsee-mcp",
            Accept: "application/vnd.github+json",
          },
        }),
      ) as {
        tag_name: string;
        assets: { name: string; browser_download_url: string; size: number }[];
      };

      const arch = process.arch === "arm64" ? "arm64" : "x86_64";
      // camoufox release assets use the platform token "lin" (e.g.
      // camoufox-<ver>-lin.x86_64.zip), not "linux". Match either spelling plus
      // the arch so we don't accidentally select a mac/win/other-arch build.
      const asset = release.assets.find(
        (a) =>
          /[-.](lin|linux)[.-]/.test(a.name) &&
          a.name.includes(arch) &&
          a.name.endsWith(".zip"),
      );
      if (!asset) {
        throw new Error(
          `no matching linux/${arch} asset in camoufox release ${release.tag_name} (assets: ${release.assets
            .map((a) => a.name)
            .join(", ")})`,
        );
      }
      if (!asset.name.endsWith(".zip")) {
        throw new Error(
          `camoufox asset ${asset.name} is not a .zip; this zero-dependency tool only extracts ZIP archives. Download it manually and extract into ${join(root, "browsers", "official")}.`,
        );
      }

      const tag = release.tag_name.replace(/^v/, "");
      const dest = join(root, "browsers", "official", tag);
      const bin = join(dest, "camoufox-bin");
      if (existsSync(bin)) {
        return text({
          ok: true,
          alreadyInstalled: true,
          tag: release.tag_name,
          path: dest,
          executable: bin,
        });
      }
      // If a different camoufox build is already present and on PATH-ish, don't
      // re-download the latest; report the existing one and how to force-upgrade.
      const existing = findExistingCamoufox(root);
      if (existing && existing.tag !== tag) {
        return text({
          ok: true,
          alreadyInstalled: true,
          installedTag: existing.tag,
          latestTag: release.tag_name,
          path: existing.dir,
          executable: existing.bin,
          note: `a camoufox build (${existing.tag}) is already installed; not downloading ${release.tag_name}. Remove ${existing.dir} to force the latest.`,
        });
      }

      const { buffer, source: srcUrl } = await downloadToBuffer([asset.browser_download_url], {
        headers: { "User-Agent": "browsee-mcp" },
        label: asset.name,
        timeoutMs: 300_000,
      });
      if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
        throw new Error("downloaded camoufox asset is not a ZIP (missing PK magic)");
      }

      mkdirSync(dest, { recursive: true });
      const res = extractAll(buffer, dest, { chmodPlusX: ["camoufox-bin"] });
      // Ensure camoufox-bin is executable wherever it landed.
      const find = (dir: string): string | null => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            const hit = find(p);
            if (hit) return hit;
          } else if (e.name === "camoufox-bin") {
            return p;
          }
        }
        return null;
      };
      const exe = find(dest) ?? (existsSync(bin) ? bin : null);
      if (exe) {
        try {
          chmodSync(exe, 0o755);
        } catch {
          /* ignore */
        }
      }

      // Point camoufox's own config at the freshly installed build so any
      // consumer that reads config.json (rather than scanning) finds it.
      const configPath = join(root, "config.json");
      try {
        writeFileSync(configPath, JSON.stringify({ active_version: `browsers/official/${tag}` }, null, 2));
      } catch {
        /* non-fatal */
      }

      // Report the FULL installed layout so callers can confirm the launcher
      // has everything it needs (binary + addons + fontconfig + properties.json).
      const layout = describeCamoufoxLayout(dest, root);
      return text({
        ok: true,
        component: "camoufox",
        tag: release.tag_name,
        asset: asset.name,
        path: dest,
        executable: exe,
        extractedFiles: res.files,
        bytes: buffer.length,
        source: srcUrl,
        installRoot: root,
        config: configPath,
        layout,
      });
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
