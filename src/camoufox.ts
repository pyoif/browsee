/**
 * camoufox.ts — full-capability launcher for the camoufox Firefox engine.
 *
 * Camoufox is a Firefox fork patched for anti-fingerprinting. Its "full
 * capability" is driven entirely through the CAMOU_CONFIG_<n> environment
 * variables (NOT a --config file): the browser reads the chunked JSON at
 * startup. This module reproduces the official launcher semantics extracted
 * from daijro/camoufox's Python source (and the apify/camoufox-js port):
 *
 *   - config is serialized to JSON and split into CAMOU_CONFIG_1..N env vars
 *     (32767-byte chunks on Linux; the Windows limit is 2047)
 *   - addons are extracted XPI directories passed as `addons: [abs paths]`
 *     inside the config (not --extension)
 *   - FONTCONFIG_PATH points at `fontconfig/<targetOS>` inside the install
 *   - the launch is a plain playwright firefox() launch with the camoufox
 *     executablePath, the assembled env, and firefoxUserPrefs
 *   - headed mode needs a DISPLAY; on a server without one the official path
 *     uses Xvfb. We auto-wrap with xvfb-run when present.
 *
 * All assembly functions here are PURE (no I/O, no spawning) so they can be
 * unit-tested directly. The I/O (reading properties.json, probing for Xvfb)
 * is isolated in small helpers at the bottom.
 *
 * Dependency note: the official camoufox-js package exists, but it drags in 12
 * runtime deps (better-sqlite3 native, maxmind, impit, …) purely for
 * fingerprint GENERATION — the part the caller supplies here. We port only the
 * launcher/config assembly, which is what "full capability" means in this
 * server. See README for the dependency rationale.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A camoufox fingerprint object, as produced by browserforge/BrowserForge. */
export type Fingerprint = Record<string, unknown>;

/** Options surfaced through browser_spawn for the firefox (camoufox) engine. */
export interface CamoufoxSpawnOptions {
  /** Public IP to spoof geolocation (+WebRTC) for. */
  geoip?: string | boolean;
  /** Locale, e.g. "en-US" or ["en-US", "en"]. */
  locale?: string | string[];
  /** Humanize cursor movement. `true` or a max-time (ms) number. */
  humanize?: boolean | number;
  /** Explicit fingerprint object (overrides the generated one). */
  fingerprint?: Fingerprint;
  /** Raw CAMOU_CONFIG overrides, merged last (wins over derived fields). */
  config?: Record<string, unknown>;
}

/** Everything needed to launch camoufox, computed without side effects. */
export interface CamoufoxLaunchPlan {
  executablePath: string;
  /** CAMOU_CONFIG_<n> (+ FONTCONFIG_PATH) env entries. */
  env: Record<string, string>;
  /** Firefox prefs passed to playwright's firefoxUserPrefs. */
  firefoxUserPrefs: Record<string, unknown>;
  /** Absolute addon directories to load (from the install's addons/ dir). */
  addons: string[];
  /** The config object that was serialized (for reporting/debugging). */
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config assembly (pure)
// ---------------------------------------------------------------------------

const LINUX_CHUNK = 32767;
const WINDOWS_CHUNK = 2047;

/** Random integer in [min, max] (inclusive). */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Chunk a JSON config string into CAMOU_CONFIG_<n> env entries exactly the way
 * the official launcher does (chunk size is platform-dependent). Exported for
 * unit testing.
 */
export function chunkConfig(
  config: Record<string, unknown>,
  chunkSize = LINUX_CHUNK,
): Record<string, string> {
  const str = JSON.stringify(config);
  const out: Record<string, string> = {};
  let i = 0;
  let n = 1;
  for (; i < str.length; i += chunkSize) {
    out[`CAMOU_CONFIG_${n}`] = str.slice(i, i + chunkSize);
    n += 1;
  }
  // Always emit at least one chunk (e.g. an empty config → CAMOU_CONFIG_1:"{}").
  if (n === 1) out.CAMOU_CONFIG_1 = str;
  return out;
}

/** Map an install's version string to a Firefox major version. */
export function firefoxMajorFromRelease(release: string): string {
  // Version strings look like "152.0.4-beta.31" or "135.0"; the leading token
  // before the first "." is the Firefox major version.
  return release.split(".", 1)[0] ?? "";
}

/** Merge source into target, only filling keys not already present. */
function mergeDefaults(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (!(k in target)) target[k] = v;
  }
}

/** Detect the target OS from a User-Agent string → "mac"/"win"/"lin". */
export function targetOsFromUserAgent(ua: string | undefined): string {
  if (!ua) return "lin";
  if (/Windows/i.test(ua)) return "win";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "lin";
}

/**
 * Assemble the CAMOU_CONFIG object for a launch. `properties` is the set of
 * property names the installed browser's properties.json knows about; we only
 * seed properties the installed build actually supports (mirrors camoufox-js).
 *
 * Pure: given the same inputs it is deterministic apart from the intentionally
 * random canvas offset / history length / per-launch seeds.
 */
export function buildCamoufoxConfig(
  opts: CamoufoxSpawnOptions,
  properties: Set<string>,
  fingerprint?: Fingerprint,
  firefoxVersion?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(opts.config ?? {}) };

  // Fingerprint-derived fields (navigator.*, screen.*, webGl:*, ...).
  if (fingerprint) mergeDefaults(config, fingerprintToConfig(fingerprint, firefoxVersion));

  // Per-launch seeds. 0 is a no-op for the C++ managers, so range is 1..2^32-1;
  // without an audio:seed every spoofed context returns identical audio samples.
  for (const seed of ["fonts:spacing_seed", "audio:seed", "canvas:seed"]) {
    if (properties.has(seed) && !(seed in config)) {
      config[seed] = randInt(1, 4_294_967_295);
    }
  }

  // Random window.history.length (1..5) unless the caller set one.
  if (properties.has("window.history.length") && !("window.history.length" in config)) {
    config["window.history.length"] = randInt(1, 5);
  }

  // Locale convenience: derive navigator.language/languages + Accept-Language.
  if (opts.locale) applyLocale(config, opts.locale);

  // Humanize.
  if (opts.humanize) {
    if (!("humanize" in config)) config.humanize = true;
    if (typeof opts.humanize === "number" && !("humanize:maxTime" in config)) {
      config["humanize:maxTime"] = opts.humanize;
    }
  }

  // Canvas anti-fingerprinting (mirrors the official launcher).
  if (properties.has("canvas:aaOffset") && !("canvas:aaOffset" in config)) {
    config["canvas:aaOffset"] = randInt(-50, 50);
  }
  if (properties.has("canvas:aaCapOffset") && !("canvas:aaCapOffset" in config)) {
    config["canvas:aaCapOffset"] = true;
  }

  // GeoIP: when a literal IP is supplied we set WebRTC directly. (Resolving a
  // public IP / MaxMind lookup would need network + the maxmind dependency the
  // official JS port carries; we accept an explicit IP instead.)
  if (typeof opts.geoip === "string" && opts.geoip.trim() !== "") {
    const ip = opts.geoip.trim();
    if (properties.has("webrtc:ipv4") && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      if (!("webrtc:ipv4" in config)) config["webrtc:ipv4"] = ip;
    } else if (properties.has("webrtc:ipv6") && ip.includes(":")) {
      if (!("webrtc:ipv6" in config)) config["webrtc:ipv6"] = ip;
    }
  }

  return config;
}

/** Splat a BrowserForge-style fingerprint into CAMOU_CONFIG keys. */
function fingerprintToConfig(fp: Fingerprint, firefoxVersion?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const navigator = (fp.navigator ?? {}) as Record<string, unknown>;
  if (navigator.userAgent) out["navigator.userAgent"] = navigator.userAgent;
  if (firefoxVersion && typeof navigator.userAgent === "string") {
    // Keep the UA's Firefox major in sync with the installed build.
    out["navigator.userAgent"] = (navigator.userAgent as string).replace(
      /Firefox\/\d+(\.\d+)*/,
      `Firefox/${firefoxVersion}`,
    );
  }
  for (const k of [
    "language",
    "languages",
    "platform",
    "oscpu",
    "hardwareConcurrency",
    "appVersion",
    "appName",
    "product",
    "productSub",
    "buildID",
  ]) {
    if (k in navigator) out[`navigator.${k}`] = navigator[k];
  }
  const screen = (fp.screen ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(screen)) out[`screen.${k}`] = screen[k];
  const headers = (fp.headers ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(headers)) out[`headers.${k}`] = headers[k];
  if (fp.webGl) {
    const webGl = fp.webGl as Record<string, unknown>;
    for (const k of Object.keys(webGl)) out[`webGl:${k}`] = webGl[k];
  }
  if (fp.canvas) {
    const canvas = fp.canvas as Record<string, unknown>;
    for (const k of Object.keys(canvas)) out[`canvas:${k}`] = canvas[k];
  }
  if (fp.fonts) out.fonts = fp.fonts;
  return out;
}

/** Apply locale to navigator.language/languages + headers.Accept-Language. */
function applyLocale(config: Record<string, unknown>, locale: string | string[]): void {
  const langs = Array.isArray(locale) ? locale : [locale];
  const primary = langs[0];
  if (!primary) return;
  if (!("navigator.language" in config)) config["navigator.language"] = primary;
  if (!("navigator.languages" in config)) config["navigator.languages"] = langs;
  if (!("headers.Accept-Language" in config)) {
    // Build a realistic Accept-Language: "en-US,en;q=0.9".
    const parts = langs.map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`));
    config["headers.Accept-Language"] = parts.join(",");
  }
}

// ---------------------------------------------------------------------------
// Addons (pure path selection)
// ---------------------------------------------------------------------------

/**
 * Find addon directories under the install's `addons/` root. camoufox expects
 * `addons` entries to be extracted addon directories that contain
 * manifest.json (see the official confirmPaths). Pure directory scan.
 */
export function findAddonDirs(addonsRoot: string): string[] {
  if (!existsSync(addonsRoot)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(addonsRoot, { withFileTypes: true })) {
    const p = join(addonsRoot, entry.name);
    if (entry.isDirectory() && existsSync(join(p, "manifest.json"))) dirs.push(p);
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// properties.json (I/O helper — reads the installed build's schema)
// ---------------------------------------------------------------------------

/**
 * Load the set of property names the installed camoufox build supports, from
 * `properties.json` next to the executable. Returns an empty set if the file
 * is missing (callers then skip property gating and pass config through).
 */
export function loadSupportedProperties(installDir: string): Set<string> {
  const p = join(installDir, "properties.json");
  if (!existsSync(p)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as { property: string }[];
    return new Set(arr.map((e) => e.property));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Xvfb / display handling
// ---------------------------------------------------------------------------

export interface DisplayPlan {
  /** Whether to launch headless rather than headed. */
  headless: boolean;
  /** DISPLAY value to set (only when reusing an existing display). */
  display?: string;
  /** True when we must wrap the launch in `xvfb-run` (no DISPLAY present). */
  needsXvfbRun: boolean;
  /** Human-readable rationale, surfaced in spawn results / errors. */
  note: string;
}

/**
 * Decide headed vs headless for camoufox. Full anti-fingerprinting fidelity
 * requires a real display, so:
 *   - if a DISPLAY is already available → headed, no wrapper
 *   - else if xvfb-run is on PATH        → headed under xvfb-run
 *   - else if headless was explicitly requested → plain headless (documented
 *     tradeoff)
 *   - else → caller should error (no display and no xvfb)
 *
 * `hasXvfbRun` and `display` are injected so this stays pure/testable.
 */
export function planDisplay(
  wantHeadless: boolean,
  hasXvfbRun: boolean,
  display: string | undefined,
): DisplayPlan {
  if (display && display.trim() !== "") {
    return {
      headless: false,
      display,
      needsXvfbRun: false,
      note: `headed on existing DISPLAY=${display} (full fingerprint fidelity)`,
    };
  }
  if (hasXvfbRun) {
    return {
      headless: false,
      needsXvfbRun: true,
      note: "headed under xvfb-run (no DISPLAY; full fingerprint fidelity)",
    };
  }
  if (wantHeadless) {
    return {
      headless: true,
      needsXvfbRun: false,
      note: "plain headless (no DISPLAY and xvfb-run unavailable — reduced fidelity)",
    };
  }
  return {
    headless: true,
    needsXvfbRun: false,
    note: "ERROR: headed mode requested but no DISPLAY and xvfb-run is not installed",
  };
}

/** Whether an executable named `name` is on PATH (best-effort, no spawn). */
export function isOnPath(name: string, pathEnv = process.env.PATH ?? ""): boolean {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plan assembly (pure, given resolved inputs)
// ---------------------------------------------------------------------------

/**
 * Assemble the full launch plan. Pure: all I/O (finding the binary, reading
 * properties.json, probing PATH) happens in the caller and is passed in.
 */
export function buildCamoufoxPlan(input: {
  installDir: string;
  executablePath: string;
  properties: Set<string>;
  addons: string[];
  options: CamoufoxSpawnOptions;
  release: string;
  /** Extra env entries to layer under the generated CAMOU_CONFIG_*. */
  baseEnv: Record<string, string>;
  targetOs: string;
}): CamoufoxLaunchPlan {
  const ffMajor = firefoxMajorFromRelease(input.release);
  const config = buildCamoufoxConfig(input.options, input.properties, input.options.fingerprint, ffMajor);
  if (input.addons.length > 0) config.addons = input.addons;

  const chunkSize = input.targetOs === "win" ? WINDOWS_CHUNK : LINUX_CHUNK;
  const camouEnv = chunkConfig(config, chunkSize);
  // FONTCONFIG_PATH points at the install's per-OS fontconfig dir on Linux.
  if (input.targetOs === "lin") {
    const fc = join(input.installDir, "fontconfig", input.targetOs);
    if (existsSync(fc)) camouEnv.FONTCONFIG_PATH = fc;
  }

  const env: Record<string, string> = { ...input.baseEnv, ...camouEnv };

  const firefoxUserPrefs: Record<string, unknown> = { "network.proxy.type": 0 };

  return {
    executablePath: input.executablePath,
    env,
    firefoxUserPrefs,
    addons: input.addons,
    config,
  };
}

/** Read the installed build's version string from version.json ("" if absent). */
export function readRelease(installDir: string): string {
  const p = join(installDir, "version.json");
  if (!existsSync(p)) return "";
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as { version?: string; release?: string };
    return d.version ?? d.release ?? "";
  } catch {
    return "";
  }
}
