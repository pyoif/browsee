#!/usr/bin/env node
/**
 * Unit tests for the camoufox integration layer (dist/camoufox.js).
 *
 * This layer is a thin adapter over the official `camoufox` npm package
 * (daijro/camoufox/typescript). We test the parts WE own — option translation,
 * LD_LIBRARY_PATH assembly, install-dir resolution — not the package's own
 * fingerprint/config machinery (that has its own bit-exact golden suite).
 *
 * Run: node camoufox.test.mjs   (after `npm run build`).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { firefox } from "playwright-core";
import {
  toLaunchOptions,
  buildLdLibraryPath,
  gtkLibDirCandidates,
  hasGtkLib,
  resolveInstallDir,
  assembleCamoufoxOptions,
  resolveStorageStatePath,
} from "./dist/camoufox.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log("camoufox integration-layer unit tests\n");

// --- gtkLibDirCandidates ---------------------------------------------------
test("gtkLibDirCandidates orders env override, pixi env, cwd env, then system", () => {
  const dirs = gtkLibDirCandidates("/home/u", {
    BROWSEE_GTK_LIB_DIR: "/override",
    PATH: "/usr/bin",
  });
  assert.deepEqual(dirs, [
    "/override",
    "/home/u/camoufox/.pixi/envs/default/lib",
    join(process.cwd(), "camoufox", ".pixi", "envs", "default", "lib"),
    "/usr/lib",
    "/lib",
  ]);
});

test("gtkLibDirCandidates drops an unset env override", () => {
  const dirs = gtkLibDirCandidates("/home/u", {});
  assert.equal(dirs[0], "/home/u/camoufox/.pixi/envs/default/lib");
  assert.ok(!dirs.includes(""), "no empty entries");
});

test("hasGtkLib reflects the filesystem (system libgtk-3 present on this image)", () => {
  // The spacebotX Wolfi image bakes libgtk-3 in /usr/lib, so this must be true
  // here; on a bare image it would be false and that is the point of the
  // candidate search.
  assert.equal(hasGtkLib("/usr/lib"), true);
  assert.equal(hasGtkLib("/nonexistent-dir-xyz"), false);
});

// --- buildLdLibraryPath ----------------------------------------------------
test("buildLdLibraryPath orders gtk, browser dir, then existing", () => {
  assert.equal(buildLdLibraryPath("/gtk", "/bin/dir", "/old"), "/gtk:/bin/dir:/old");
  assert.equal(buildLdLibraryPath("/gtk", "/bin/dir", ""), "/gtk:/bin/dir");
  assert.equal(buildLdLibraryPath("/gtk", "/bin/dir", undefined), "/gtk:/bin/dir");
});

// --- toLaunchOptions (option translation) ---------------------------------
test("toLaunchOptions sets headless, env and i_know_what_im_doing", () => {
  const lo = toLaunchOptions({}, { headless: true, env: { FOO: "bar" } });
  assert.equal(lo.headless, true);
  assert.deepEqual(lo.env, { FOO: "bar" });
  assert.equal(lo.i_know_what_im_doing, true);
});

test("toLaunchOptions maps capability knobs to snake_case keys", () => {
  const lo = toLaunchOptions(
    {
      geoip: "203.0.113.7",
      locale: ["en-US", "en"],
      humanize: 2,
      block_images: true,
      block_webrtc: false,
      disable_coop: true,
      addons: ["/a/ubo"],
      config: { "canvas:seed": 1 },
      fingerprint: { navigator: {} },
      os: "linux",
      firefox_user_prefs: { "network.proxy.type": 0 },
    },
    { headless: false, env: {} },
  );
  assert.equal(lo.geoip, "203.0.113.7");
  assert.deepEqual(lo.locale, ["en-US", "en"]);
  assert.equal(lo.humanize, 2);
  assert.equal(lo.block_images, true);
  assert.equal(lo.block_webrtc, false);
  assert.equal(lo.disable_coop, true);
  assert.deepEqual(lo.addons, ["/a/ubo"]);
  assert.deepEqual(lo.config, { "canvas:seed": 1 });
  assert.deepEqual(lo.fingerprint, { navigator: {} });
  assert.equal(lo.os, "linux");
  assert.deepEqual(lo.firefox_user_prefs, { "network.proxy.type": 0 });
});

test("toLaunchOptions omits unset keys (exactOptionalPropertyTypes-safe)", () => {
  const lo = toLaunchOptions({}, { headless: true, env: {} });
  for (const k of ["geoip", "locale", "humanize", "fingerprint", "config", "addons"]) {
    assert.ok(!(k in lo), `${k} should be absent when unset`);
  }
});

test("toLaunchOptions only sets executable_path when provided", () => {
  const a = toLaunchOptions({}, { headless: true, env: {} });
  assert.ok(!("executable_path" in a), "executable_path absent by default (package resolves its paired build)");
  const b = toLaunchOptions({}, { headless: true, env: {}, executablePath: "/x/camoufox-bin" });
  assert.equal(b.executable_path, "/x/camoufox-bin");
});

// --- resolveInstallDir -----------------------------------------------------
test("resolveInstallDir honors CAMOUFOX_INSTALL_DIR", () => {
  const r = resolveInstallDir({ CAMOUFOX_INSTALL_DIR: "/custom/camoufox" });
  assert.equal(r.dir, "/custom/camoufox");
  // exists flag reflects the actual filesystem (custom path → false here).
  assert.equal(r.exists, false);
});

test("resolveInstallDir falls back to the package INSTALL_DIR", () => {
  const r = resolveInstallDir({});
  assert.ok(r.dir.length > 0);
  assert.ok(r.dir.includes("camoufox"));
});

// --- assembleCamoufoxOptions (async, calls the official launcher) ----------
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push([name, fn]);
}

testAsync("assembleCamoufoxOptions wires LD_LIBRARY_PATH and returns firefox launch options", async () => {
  const opts = await assembleCamoufoxOptions(
    { locale: "en-US" },
    {
      headless: true,
      homeDir: "/home/u",
      processEnv: { PATH: "/usr/bin", LD_LIBRARY_PATH: "/old" },
      browserDir: "/bin/dir",
    },
  );
  // Everything playwright's firefox() needs must be present.
  assert.ok("executablePath" in opts, "executablePath set by the package");
  assert.ok("env" in opts, "env set");
  // The GTK dir is RESOLVED to the first candidate that actually has
  // libgtk-3.so.0. /home/u has no pixi env, but this image ships system GTK in
  // /usr/lib, so that wins — then the browser dir, then the caller's existing
  // LD_LIBRARY_PATH. (On an image without system GTK this would resolve to the
  // pixi candidate instead; the resolution logic is what we assert here.)
  assert.equal(opts.env.LD_LIBRARY_PATH, "/usr/lib:/bin/dir:/old");
  assert.equal(opts.env.MOZ_HEADLESS, "1");
  assert.ok(opts.env.CAMOU_CONFIG_1, "chunked CAMOU_CONFIG present");
  // And the object round-trips as a valid firefox launch options shape.
  assert.ok(typeof opts.executablePath === "string" && opts.executablePath.length > 0);
});

testAsync("assembleCamoufoxOptions options are accepted by playwright firefox() validator", async () => {
  const opts = await assembleCamoufoxOptions(
    { humanize: true },
    { headless: true, homeDir: "/home/u", processEnv: {} },
  );
  // firefox.launch would reject an invalid options object synchronously; we do
  // not actually launch (no display in unit tests), we just assert the keys
  // playwright consumes are present and well-typed.
  assert.equal(typeof opts.executablePath, "string");
  assert.equal(typeof opts.firefoxUserPrefs, "object");
  assert.equal(typeof opts.env, "object");
  assert.ok(Array.isArray(opts.args));
});

// --- resolveStorageStatePath (browser_spawn storage_state validation) ------
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const ssDir = mkdtempSync(pjoin(tmpdir(), "browsee-ss-"));
const artifactsDir = pjoin(ssDir, "artifacts");
import { mkdirSync as mkdirSyncFs } from "node:fs";
mkdirSyncFs(artifactsDir, { recursive: true });

test("resolveStorageStatePath rejects an empty path", () => {
  assert.throws(() => resolveStorageStatePath("", artifactsDir), /non-empty/);
});

test("resolveStorageStatePath throws clearly when the file is missing", () => {
  assert.throws(
    () => resolveStorageStatePath("nope.json", artifactsDir),
    /does not exist/,
  );
});

test("resolveStorageStatePath resolves a relative path against BROWSEE_ARTIFACTS_DIR", () => {
  const p = pjoin(artifactsDir, "state.json");
  writeFileSync(p, JSON.stringify({ cookies: [], origins: [] }));
  assert.equal(resolveStorageStatePath("state.json", artifactsDir), p);
});

test("resolveStorageStatePath accepts an absolute path", () => {
  const p = pjoin(ssDir, "abs.json");
  writeFileSync(p, JSON.stringify({ cookies: [{ name: "a" }], origins: [] }));
  assert.equal(resolveStorageStatePath(p, artifactsDir), p);
});

test("resolveStorageStatePath rejects malformed JSON", () => {
  const p = pjoin(artifactsDir, "bad.json");
  writeFileSync(p, "{ not json ");
  assert.throws(() => resolveStorageStatePath("bad.json", artifactsDir), /not valid JSON/);
});

test("resolveStorageStatePath rejects JSON without a cookies array", () => {
  const p = pjoin(artifactsDir, "shape.json");
  writeFileSync(p, JSON.stringify({ origins: [] }));
  assert.throws(() => resolveStorageStatePath("shape.json", artifactsDir), /no "cookies" array/);
});

try {
  rmSync(ssDir, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}

// Run async tests sequentially, then report.
for (const [name, fn] of asyncTests) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

// Sanity: the firefox type we import is the one the server uses.
test("playwright-core exports firefox()", () => {
  assert.equal(typeof firefox.launch, "function");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
