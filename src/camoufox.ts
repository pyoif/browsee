/**
 * camoufox.ts — integration layer over the OFFICIAL camoufox TypeScript package.
 *
 * The official launcher is published on npm as `camoufox` (from
 * daijro/camoufox/typescript, MIT, bit-exact twin of the Python launcher). It
 * owns every piece of "full capability": fpgen fingerprint generation, the
 * chunked CAMOU_CONFIG/CAMOU_PREFS env blobs, addons, fonts, GeoIP, locale,
 * humanize, virtual display, and browser install/resolution.
 *
 * Rather than re-port that logic (which is what an earlier draft of this file
 * did), we depend on the package and keep only the bits specific to running it
 * inside this server's container:
 *
 *   1. GTK/X11 libs — the launch needs libgtk-3 on LD_LIBRARY_PATH; we resolve
 *      the dir across an env override / pixi env / the system image and pass it
 *      through to the browser's own dir.
 *   2. The API surface browser_spawn exposes (engine: "firefox" + capability
 *      knobs) → the package's snake_case launchOptions() options.
 *   3. Headed/headless plumbing for a display-less server.
 *
 * The functions here are small and pure (option translation only) so they can
 * be unit-tested without launching a browser.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  launchOptions as camoufoxLaunchOptions,
  INSTALL_DIR,
  type LaunchOptions,
} from "camoufox";

/** Capability knobs surfaced through browser_spawn for the firefox engine. */
export interface CamoufoxSpawnOptions {
  /** Public IP to spoof geolocation/WebRTC for. string IP or true to detect. */
  geoip?: string | boolean;
  /** Locale, e.g. "en-US" or ["en-US", "en"]. */
  locale?: string | string[];
  /** Humanize cursor movement: true, or max duration in seconds. */
  humanize?: boolean | number;
  /** Explicit fpgen fingerprint object. */
  fingerprint?: Record<string, unknown>;
  /** Raw CAMOU_CONFIG overrides, merged by the launcher. */
  config?: Record<string, unknown>;
  /** Target OS for fingerprint generation: "windows" | "macos" | "linux". */
  os?: string | string[];
  /** Block images. */
  block_images?: boolean;
  /** Block WebRTC entirely. */
  block_webrtc?: boolean;
  /** Disable crossorigin-opener-policy so Turnstile etc. can be clicked. */
  disable_coop?: boolean;
  /** Extra Firefox addons (paths to extracted addons). */
  addons?: string[];
  /** Extra Firefox user prefs. */
  firefox_user_prefs?: Record<string, unknown>;
}

/**
 * Candidate GTK/X11 lib dirs for a camoufox launch, in priority order.
 *
 * The primary location is the pixi env under the process HOME
 * (`$HOME/camoufox/.pixi/envs/default/lib`), which is what `run.sh` and the
 * README wire up. But the MCP child's HOME is whatever the *client* passes
 * (spacebot sets `HOME=/data`), while the pixi env may have been provisioned
 * under a different HOME (e.g. the agent workspace). Hard-requiring a single
 * `$HOME` prefix made the launcher fail even though a perfectly good GTK was on
 * disk one directory over. So we accept, in order:
 *
 *   1. `BROWSEE_GTK_LIB_DIR` — explicit override.
 *   2. `$HOME/camoufox/.pixi/envs/default/lib` — the documented location.
 *   3. `<cwd>/camoufox/.pixi/envs/default/lib` — workspace-local provisioning.
 *   4. `/usr/lib`, `/lib` — a distro/Wolfi image that ships libgtk-3 itself.
 *
 * The first candidate that actually contains `libgtk-3.so.0` wins; the list is
 * returned so the caller can also fold it into LD_LIBRARY_PATH.
 */
export function gtkLibDirCandidates(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const dirs: string[] = [];
  const push = (d: string | undefined): void => {
    if (d && d.trim() !== "" && !dirs.includes(d)) dirs.push(d);
  };
  push(env.BROWSEE_GTK_LIB_DIR);
  push(join(homeDir, "camoufox", ".pixi", "envs", "default", "lib"));
  push(join(process.cwd(), "camoufox", ".pixi", "envs", "default", "lib"));
  push("/usr/lib");
  push("/lib");
  return dirs;
}

/** Whether `dir` contains a usable libgtk-3 shared object. */
export function hasGtkLib(dir: string): boolean {
  try {
    return existsSync(join(dir, "libgtk-3.so.0")) || existsSync(join(dir, "libgtk-3.so"));
  } catch {
    return false;
  }
}

/**
 * Resolve the best GTK lib dir for this launch, or the first candidate when
 * none of them has libgtk-3 (so the caller can report a useful path).
 */
export function resolveGtkLibDir(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const candidates = gtkLibDirCandidates(homeDir, env);
  return candidates.find(hasGtkLib) ?? candidates[0] ?? "/usr/lib";
}

/**
 * Whether an executable named `name` is resolvable on PATH. Used by the chrome
 * launcher to decide if it can wrap itself in xvfb-run for a display.
 */
export function isOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return false;
}

/**
 * Build the LD_LIBRARY_PATH for a camoufox launch: the resolved GTK lib dir
 * first, then the browser's own directory (bundled libxul/libnss), then
 * whatever the caller already had. Accepts several GTK candidate dirs so the
 * launcher keeps working whether GTK comes from the pixi env or the system.
 */
export function buildLdLibraryPath(
  gtkDirs: string | string[],
  browserDir: string,
  existing?: string,
): string {
  const dirs = (Array.isArray(gtkDirs) ? gtkDirs : [gtkDirs]).filter(
    (d): d is string => typeof d === "string" && d.trim() !== "",
  );
  if (browserDir && browserDir.trim() !== "") dirs.push(browserDir);
  const base = dirs.join(":");
  return existing && existing.trim() !== "" ? `${base}:${existing}` : base;
}

/**
 * Translate browser_spawn's capability knobs into the official launcher's
 * launchOptions() argument. Pure. `env` is merged with the caller's process env
 * and the computed LD_LIBRARY_PATH; `headless` is passed through.
 */
export function toLaunchOptions(
  opts: CamoufoxSpawnOptions,
  opts2: {
    headless: boolean;
    env: Record<string, string>;
    /** Set to false to keep the package's default paired-build resolution. */
    executablePath?: string | undefined;
  },
): LaunchOptions {
  const lo: LaunchOptions = {
    headless: opts2.headless,
    env: opts2.env,
    // Suppress leak warnings for options we deliberately override (e.g. env)
    // so the server's stderr stays clean.
    i_know_what_im_doing: true,
  };
  if (opts2.executablePath) lo.executable_path = opts2.executablePath;
  if (opts.geoip !== undefined) lo.geoip = opts.geoip;
  if (opts.locale !== undefined) lo.locale = opts.locale;
  if (opts.humanize !== undefined) lo.humanize = opts.humanize;
  if (opts.fingerprint !== undefined) lo.fingerprint = opts.fingerprint;
  if (opts.config !== undefined) lo.config = opts.config;
  if (opts.os !== undefined) lo.os = opts.os;
  if (opts.block_images !== undefined) lo.block_images = opts.block_images;
  if (opts.block_webrtc !== undefined) lo.block_webrtc = opts.block_webrtc;
  if (opts.disable_coop !== undefined) lo.disable_coop = opts.disable_coop;
  if (opts.addons !== undefined) lo.addons = opts.addons;
  if (opts.firefox_user_prefs !== undefined) lo.firefox_user_prefs = opts.firefox_user_prefs;
  return lo;
}

/**
 * Resolve the camoufox browser install root the official package uses, honoring
 * CAMOUFOX_INSTALL_DIR (the same var browser_install_camoufox writes to). Falls
 * back to the package's own INSTALL_DIR. Returns the dir + whether it exists.
 */
export function resolveInstallDir(
  env: Record<string, string | undefined> = process.env,
): { dir: string; exists: boolean } {
  const override = env.CAMOUFOX_INSTALL_DIR;
  const dir = override && override.trim() !== "" ? override : INSTALL_DIR;
  return { dir, exists: existsSync(dir) };
}

/**
 * Assemble the full browser launch options for the firefox engine: compute the
 * LD_LIBRARY_PATH, translate the capability knobs, and call the official
 * launcher. The returned value is exactly what playwright-core's firefox()
 * expects (executablePath/firefoxUserPrefs/env/args/headless).
 *
 * `browserDir` is the directory of the resolved browser binary (used for the
 * LD_LIBRARY_PATH tail); it is optional — when unknown we only add the GTK dir.
 */
export async function assembleCamoufoxOptions(
  options: CamoufoxSpawnOptions,
  ctx: {
    headless: boolean;
    homeDir: string;
    processEnv: Record<string, string | undefined>;
    executablePath?: string | undefined;
    browserDir?: string | undefined;
  },
): Promise<Record<string, unknown>> {
  const gtkDir = resolveGtkLibDir(ctx.homeDir, ctx.processEnv);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.processEnv)) {
    if (typeof v === "string") env[k] = v;
  }
  env.LD_LIBRARY_PATH = buildLdLibraryPath(gtkDir, ctx.browserDir ?? "", env.LD_LIBRARY_PATH);
  env.MOZ_HEADLESS = ctx.headless ? "1" : "0";

  const lo = toLaunchOptions(options, {
    headless: ctx.headless,
    env,
    executablePath: ctx.executablePath,
  });
  return (await camoufoxLaunchOptions(lo)) as unknown as Record<string, unknown>;
}
