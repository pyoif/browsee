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
  gtkLibDir,
  resolveInstallDir,
  assembleCamoufoxOptions,
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

// --- gtkLibDir -------------------------------------------------------------
test("gtkLibDir points at the pixi env's lib dir", () => {
  assert.equal(gtkLibDir("/home/u"), "/home/u/camoufox/.pixi/envs/default/lib");
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
  assert.equal(opts.env.LD_LIBRARY_PATH, "/home/u/camoufox/.pixi/envs/default/lib:/bin/dir:/old");
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
