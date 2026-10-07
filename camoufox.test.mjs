#!/usr/bin/env node
/**
 * Unit tests for the pure camoufox launcher-assembly functions (dist/camoufox.js).
 *
 * These mirror the official daijro/camoufox launch semantics:
 *   - config → CAMOU_CONFIG_<n> chunked env vars (32767-byte Linux chunks)
 *   - addons passed as config.addons (extracted dirs with manifest.json)
 *   - per-launch seeds gated on the installed build's properties.json
 *   - display planning (DISPLAY reuse / xvfb-run / plain headless)
 *
 * Run: node camoufox.test.mjs   (after `npm run build`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkConfig,
  firefoxMajorFromRelease,
  targetOsFromUserAgent,
  buildCamoufoxConfig,
  findAddonDirs,
  loadSupportedProperties,
  planDisplay,
  buildCamoufoxPlan,
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

const props = new Set([
  "navigator.userAgent",
  "navigator.language",
  "navigator.languages",
  "headers.Accept-Language",
  "window.history.length",
  "fonts:spacing_seed",
  "audio:seed",
  "canvas:seed",
  "canvas:aaOffset",
  "canvas:aaCapOffset",
  "webrtc:ipv4",
  "webrtc:ipv6",
  "humanize",
  "humanize:maxTime",
  "addons",
]);

console.log("camoufox launch-assembly unit tests\n");

// --- chunkConfig -----------------------------------------------------------
test("chunkConfig emits a single CAMOU_CONFIG_1 for small configs", () => {
  const c = chunkConfig({ a: 1 });
  assert.deepEqual(Object.keys(c), ["CAMOU_CONFIG_1"]);
  assert.equal(c.CAMOU_CONFIG_1, '{"a":1}');
});

test("chunkConfig splits into sequentially-numbered chunks", () => {
  const big = { s: "x".repeat(40) };
  const c = chunkConfig(big, 10);
  const keys = Object.keys(c);
  assert.equal(keys[0], "CAMOU_CONFIG_1");
  assert.equal(keys[1], "CAMOU_CONFIG_2");
  // Reassembly round-trips.
  const joined = keys
    .map((k) => Number(k.split("_").pop()))
    .sort((a, b) => a - b)
    .map((n) => c[`CAMOU_CONFIG_${n}`])
    .join("");
  assert.deepEqual(JSON.parse(joined), big);
});

test("chunkConfig always emits at least one chunk", () => {
  const c = chunkConfig({});
  assert.deepEqual(Object.keys(c), ["CAMOU_CONFIG_1"]);
  assert.equal(c.CAMOU_CONFIG_1, "{}");
});

// --- version / OS helpers --------------------------------------------------
test("firefoxMajorFromRelease extracts the Firefox major", () => {
  assert.equal(firefoxMajorFromRelease("152.0.4-beta.31"), "152");
  assert.equal(firefoxMajorFromRelease("135.0"), "135");
});

test("targetOsFromUserAgent maps UA → OS token", () => {
  assert.equal(targetOsFromUserAgent("Mozilla/5.0 (Windows NT 10.0)"), "win");
  assert.equal(targetOsFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)"), "mac");
  assert.equal(targetOsFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)"), "lin");
  assert.equal(targetOsFromUserAgent(undefined), "lin");
});

// --- buildCamoufoxConfig ---------------------------------------------------
test("config seeds only properties the installed build supports", () => {
  const c = buildCamoufoxConfig({}, new Set(["audio:seed"]));
  assert.ok(typeof c["audio:seed"] === "number");
  assert.ok(c["audio:seed"] >= 1);
  assert.ok(!("canvas:seed" in c), "canvas:seed not in supported set ⇒ omitted");
});

test("config includes locale → navigator.language + Accept-Language", () => {
  const c = buildCamoufoxConfig({ locale: ["en-US", "en"] }, props);
  assert.equal(c["navigator.language"], "en-US");
  assert.deepEqual(c["navigator.languages"], ["en-US", "en"]);
  assert.equal(c["headers.Accept-Language"], "en-US,en;q=0.9");
});

test("config humanize:true and numeric max-time", () => {
  const a = buildCamoufoxConfig({ humanize: true }, props);
  assert.equal(a.humanize, true);
  const b = buildCamoufoxConfig({ humanize: 250 }, props);
  assert.equal(b.humanize, true);
  assert.equal(b["humanize:maxTime"], 250);
});

test("config geoip literal IPv4 → webrtc:ipv4", () => {
  const c = buildCamoufoxConfig({ geoip: "203.0.113.7" }, props);
  assert.equal(c["webrtc:ipv4"], "203.0.113.7");
});

test("config geoip literal IPv6 → webrtc:ipv6", () => {
  const c = buildCamoufoxConfig({ geoip: "2001:db8::1" }, props);
  assert.equal(c["webrtc:ipv6"], "2001:db8::1");
});

test("explicit config wins over derived defaults", () => {
  const c = buildCamoufoxConfig(
    { config: { "canvas:aaOffset": 42, humanize: true }, humanize: true },
    props,
  );
  assert.equal(c["canvas:aaOffset"], 42);
});

test("fingerprint splats navigator/screen/headers/webGl into config", () => {
  const c = buildCamoufoxConfig(
    {},
    props,
    {
      navigator: { userAgent: "Mozilla/5.0 Firefox/150.0", platform: "Win32", hardwareConcurrency: 8 },
      screen: { width: 1920, height: 1080 },
      headers: { "Accept-Language": "en-US" },
      webGl: { vendor: "Intel", renderer: "Intel UHD" },
    },
    "152",
  );
  assert.equal(c["navigator.platform"], "Win32");
  assert.equal(c["screen.width"], 1920);
  assert.equal(c["headers.Accept-Language"], "en-US");
  assert.equal(c["webGl:vendor"], "Intel");
  // UA major is synced to the installed Firefox version.
  assert.equal(c["navigator.userAgent"], "Mozilla/5.0 Firefox/152");
});

// --- addons ----------------------------------------------------------------
test("findAddonDirs returns only dirs containing manifest.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-addons-"));
  try {
    mkdirSync(join(root, "UBO"));
    writeFileSync(join(root, "UBO", "manifest.json"), "{}");
    mkdirSync(join(root, "not-an-addon"));
    const dirs = findAddonDirs(root);
    assert.deepEqual(dirs, [join(root, "UBO")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findAddonDirs on a missing root returns []", () => {
  assert.deepEqual(findAddonDirs("/nonexistent/camoufox/addons"), []);
});

// --- properties.json -------------------------------------------------------
test("loadSupportedProperties reads property names; missing file → empty set", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-props-"));
  try {
    writeFileSync(
      join(dir, "properties.json"),
      JSON.stringify([{ property: "audio:seed", type: "uint" }, { property: "timezone", type: "str" }]),
    );
    const s = loadSupportedProperties(dir);
    assert.ok(s.has("audio:seed"));
    assert.ok(s.has("timezone"));
    assert.equal(s.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(loadSupportedProperties("/nonexistent").size, 0);
});

// --- display planning ------------------------------------------------------
test("planDisplay reuses an existing DISPLAY (headed, no wrapper)", () => {
  const p = planDisplay(true, false, ":99");
  assert.equal(p.headless, false);
  assert.equal(p.needsXvfbRun, false);
  assert.equal(p.display, ":99");
});

test("planDisplay wraps with xvfb-run when no DISPLAY but xvfb present", () => {
  const p = planDisplay(false, true, undefined);
  assert.equal(p.headless, false);
  assert.equal(p.needsXvfbRun, true);
});

test("planDisplay falls back to plain headless only when explicitly asked", () => {
  const explicit = planDisplay(true, false, undefined);
  assert.equal(explicit.headless, true);
  const notAsked = planDisplay(false, false, undefined);
  assert.equal(notAsked.headless, true);
  assert.match(notAsked.note, /ERROR/);
});

// --- full plan -------------------------------------------------------------
test("buildCamoufoxPlan wires executable, env chunks, addons and FONTCONFIG", () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-plan-"));
  const addonDir = join(dir, "addons", "UBO");
  try {
    mkdirSync(join(dir, "fontconfig", "lin"), { recursive: true });
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "manifest.json"), "{}");

    const plan = buildCamoufoxPlan({
      installDir: dir,
      executablePath: join(dir, "camoufox-bin"),
      properties: props,
      addons: findAddonDirs(join(dir, "addons")),
      options: { locale: "en-US" },
      release: "152.0.4",
      baseEnv: { LD_LIBRARY_PATH: "/gtk/lib" },
      targetOs: "lin",
    });

    assert.equal(plan.executablePath, join(dir, "camoufox-bin"));
    assert.equal(plan.env.LD_LIBRARY_PATH, "/gtk/lib");
    assert.equal(plan.env.FONTCONFIG_PATH, join(dir, "fontconfig", "lin"));
    assert.ok(plan.env.CAMOU_CONFIG_1, "config chunk present");
    const parsed = JSON.parse(plan.env.CAMOU_CONFIG_1);
    assert.deepEqual(parsed.addons, [addonDir]);
    assert.equal(plan.addons.length, 1);
    assert.equal(plan.firefoxUserPrefs["network.proxy.type"], 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
