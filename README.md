# browsee

A **stdio Model Context Protocol (MCP) server** exposing scriptable, steerable
browser sessions.

Two browser engines, both stealth-optimized:

| Engine | Driver | Binary | Default | Notes |
|---|---|---|---|---|
| **`firefox`** | official [`camoufox`](https://github.com/daijro/camoufox/tree/main/typescript) TS launcher | Camoufox stealth Firefox build | ✅ yes | Full anti-fingerprint capability — fingerprint generation, addons, fonts, GeoIP, locale, humanize, virtual display. |
| **`chrome`** | [`patchright`](https://github.com/Kaliiiiiiiiii-Vincent/patchright) | Branded **Chrome** (Chrome-for-Testing) | no | Undetectable via the **patched driver** (not just a patched binary). **Headed only** — runs under Xvfb on a display-less server. |

> **Engine selects the browser stack, not stealth on/off.** There is no
> `stealth` flag. Both engines are the anti-detection stack; the choice is which
> browser you want to drive.

> **Why the split driver?** Patchright's stealth comes from its patched driver
> code (no `Runtime.enable` leaks, etc.), so Chrome must be driven by
> `patchright`, not vanilla `playwright-core`. But camoufox is a *Firefox* build
> whose patched juggler is incompatible with patchright's patched Firefox driver
> (`page.evaluate` throws `Cannot read properties of undefined (reading '_client')`),
> so the firefox engine goes through the official `camoufox` launcher, which
> handles the juggler protocol and all fingerprint plumbing itself.

> **Why headed Chrome?** Patchright's patches only hold in a real, headed
> browser — the headless-shell build is detectable. On a server with no display
> the `chrome` engine runs under a virtual display (`Xvfb`). If neither a
> display nor Xvfb is available the spawn **fails with a clear error** rather
> than silently launching a detectable headless Chrome.

## Dependencies

Three runtime packages, all real (no vendoring):

- `camoufox` — the official TypeScript launcher for the Camoufox Firefox build.
- `patchright` — patched, undetectable Playwright fork; drives branded Chrome.
- `playwright-core` — bundled here so the camoufox launcher's driver types and
  browser resolution are available.

## Install

```sh
mise use nub@latest          # Node toolkit, project-scoped
nub install                  # installs camoufox, patchright, playwright-core, zod, @modelcontextprotocol/sdk
nub exec tsc -p tsconfig.build.json   # build -> dist/server.js
```

## Run

The server speaks JSON-RPC over **stdin/stdout**. Launch it with:

```sh
./run.sh            # wraps: LD_LIBRARY_PATH=<pixi GTK lib>:… nub dist/server.js
```

`run.sh` sets `LD_LIBRARY_PATH` so (a) Node can find `libatomic` and (b) the
Camoufox Firefox binary can find `libgtk-3`/X11 libs. Wire it into an MCP client
by pointing the client's `command` at `run.sh` (or directly at
`nub dist/server.js` with `LD_LIBRARY_PATH` exported).

## Tools

11 tools: spawn/kill/list/action/cookies, four tab tools, and two install tools.

### `browser_spawn`
Launch a session.

| arg | type | default | meaning |
|---|---|---|---|
| `session_id` | string | (auto uuid) | requested id (a uuid is generated) |
| `engine` | `"chrome" \| "firefox"` | `"firefox"` | which browser stack to drive |
| `headless` | boolean | `true` (firefox) / `false` (chrome) | firefox: honoured; chrome: always headed regardless (virtual display used when no `DISPLAY`) |
| `start_url` | string | — | navigate here on spawn |
| `fingerprint` | object | — | *firefox* — `fingerprint` config passed to the camoufox launcher |
| `geoip` | string \| boolean | — | *firefox* — GeoIP spoofing (e.g. `"auto"` or a country code) |
| `locale` | string \| string[] | — | *firefox* — locale(s) to present |
| `humanize` | boolean \| number | — | *firefox* — humanize cursor movement (bool or max duration in ms) |
| `config` | object | — | *firefox* — additional raw CAMOU config entries |

Returns `{ session_id, engine, headless, url }` (plus a display note when the
engine had to fall back to a virtual display).

The four firefox-only params map directly onto the official camoufox launcher's
options; on the `chrome` engine they are ignored.

### `browser_kill`
`{ session_id }` → closes the context + browser and removes it from the registry.

### `browser_list`
`{}` → `{ count, sessions: [{ session_id, engine, pid, url }] }`.
`pid` is resolved by matching the launched executable in `/proc/<pid>/exe`
(playwright-core's `Browser` exposes no `process()` accessor).

### `browser_action`
`{ session_id, action, params }`. Actions:

| action | params | result |
|---|---|---|
| `navigate` | `url`, `waitUntil?` | `{ url, status, title }` |
| `click` | `selector` | `{ ok, url }` |
| `fill` | `selector`, `value` | `{ ok }` |
| `press` | `key`, `selector?` | `{ ok }` |
| `evaluate` | `js` | `{ value }` |
| `wait_for` | `selector`, `timeout?` | `{ ok }` |
| `screenshot` | `filename?`, `fullPage?` | `{ path, bytes }` (saved under `artifacts/`) |
| `status` | — | `{ url, title, bodyText }` |

An unknown action returns an `isError` result — the server never crashes.

### `browser_cookies`
`{ session_id, mode, path? }` — the cookie wiring:

| mode | behaviour |
|---|---|
| `get` | `{ count, cookies }` from the live context |
| `save` | writes a full storage-state JSON to `path`; returns `{ ok, path, cookies, origins }` |
| `load` | reads storage state from `path` and adds its cookies to the context |

### Tab management

A session can hold multiple tabs (pages) in one browser context. `browser_action`
and `browser_cookies` always operate on the session's **active** tab.

| tool | args | behaviour |
|---|---|---|
| `browser_tab_list` | `{ session_id }` | `{ count, active, tabs: [{ index, url, title, active }] }` |
| `browser_tab_new` | `{ session_id, url? }` | opens a tab, makes it active → `{ ok, index, url, count }` |
| `browser_tab_select` | `{ session_id, index }` | switches the active tab → `{ ok, index, url, title }` |
| `browser_tab_close` | `{ session_id, index }` | closes a tab; active falls back to the last remaining → `{ ok, closed, remaining, active }` |

Indices are the positions in the context's live page list (see
`browser_tab_list`). Out-of-range indices return an `isError` result.

### `browser_install_chromium`

`{}` → downloads the **exact** Chrome build this server's `patchright` expects
(revision read from patchright's bundled `browsers.json`) into the Playwright
browsers directory (`$PLAYWRIGHT_BROWSERS_PATH` or
`~/.cache/ms-playwright/`), then writes Playwright's `INSTALLATION_COMPLETE`
marker. This is what the `chrome` engine launches.

- Installs the **full** branded Chrome (Chrome-for-Testing) build, never
  `chromium_headless_shell` (the shell is detectable; patchright's own guidance
  is to use the full headed build).
- Fetched from `https://cdn.playwright.dev/builds/cft/<browserVersion>/<platform>/…`.
- Zero dependencies: the ZIP is downloaded with Node's `fetch` and extracted
  with a built-in zlib-based ZIP reader (`src/zip.ts`).
- Idempotent: returns `{ alreadyInstalled: true }` when the build is present.
- (Name kept for continuity: it installs the Chrome-for-Testing build the
  `chrome` engine uses.)

### `browser_install_camoufox`

`{}` → downloads the latest Camoufox Linux build from GitHub releases into the
layout the launcher expects. Idempotent: if a Camoufox build is already present
it reports it and does **not** re-download. Most users don't need to call this —
the official `camoufox` package can fetch/manage its own install.

## Prerequisites

- **No manual browser fetch is required.** Browsers are installed through the
  two install tools above (`browser_install_chromium` for the `chrome` engine,
  `browser_install_camoufox` for the `firefox` engine), or by the camoufox
  package itself.
- **Display for the `chrome` engine.** A headed Chrome needs a display. On a
  headless server install Xvfb; the server auto-wraps Chrome in a virtual
  display when `DISPLAY` is unset. Without Xvfb, spawning `engine:"chrome"`
  errors out by design.
- **`firefox` engine on Linux** needs the GTK/X11 libraries (see
  `LD_LIBRARY_PATH` below); `run.sh` wires this up.

## Zombie prevention

- All live sessions are tracked in an in-memory `Map`.
- On `SIGTERM` / `SIGINT`, the server closes every session (context + browser)
  and exits 0.
- Playwright manages its own child processes and reaps them on `browser.close()`.
- Verified: after `browser_kill`, no `camoufox-bin` / `firefox` / `chrome` /
  `node` server processes remain and no defunct/zombie processes are left.

## End-to-end test

`nub e2e-test.mjs` drives a full stdio JSON-RPC conversation:
`initialize → initialized → tools/list → browser_spawn(firefox) →
navigate → evaluate(title) → cookies save → screenshot → browser_list →
bogus action → browser_kill → browser_list(empty)`.

## Paths

- Project root: `$HOME/browsee`
- Screenshots: `$HOME/browsee/artifacts/`
- Camoufox install: package-managed (official `camoufox` launcher) or
  `$CAMOUFOX_INSTALL_DIR` / `$HOME/.cache/camoufox/`
- Chrome (patchright): `$PLAYWRIGHT_BROWSERS_PATH` or `$HOME/.cache/ms-playwright/`
- GTK libs: `$HOME/camoufox/.pixi/envs/default/lib`
- libudev shim: `$HOME/.local/lib/udev` (Chrome links `libudev.so.1`, absent from
  some minimal images such as Wolfi)

## Note on `LD_LIBRARY_PATH`

`run.sh` prepends `$HOME/.local/lib/udev` and the pixi GTK lib dir to
`LD_LIBRARY_PATH` so:
1. Node (fetched by nub) finds `libatomic`;
2. Camoufox's Firefox finds `libgtk-3`/X11 libs;
3. Chrome finds `libudev.so.1`.

The server also self-heals for (3): the Chrome launch path scans for a
`libudev.so.1` provider on disk and appends it to the child's `LD_LIBRARY_PATH`,
so a Chrome session works even when the server is launched without `run.sh`.

## History

- **v0.3.2** — the chrome engine's "no display" path now **actually provides** a
  display instead of only reporting one. Previously `needXvfbRun` was set and
  surfaced as `displayNote` ("headed via xvfb-run (no DISPLAY)") but was never
  consumed by the launch, so Chromium failed with its own "Missing X server or
  $DISPLAY". The server now manages a real Xvfb lifecycle: with no `DISPLAY` set
  and the `Xvfb` binary on `PATH`, it spawns Xvfb on a free display (`:99`
  upward), waits for the X socket, points the launch env at it, and kills the
  Xvfb process when the session closes. If neither `DISPLAY` nor `Xvfb` is
  available it refuses with an actionable error rather than silently launching a
  detectable headless Chrome.
- **v0.3.1** — `engine: "chrome"` no longer forces patchright `channel: "chrome"`
  (which looked for a *system* Chrome at `/opt/google/chrome/chrome`). The launch
  now resolves the executable explicitly — env override
  (`BROWSEE_CHROME_EXECUTABLE` / `CHROME_PATH`) → the patchright-managed
  Chrome-for-Testing path that `browser_install_chromium` installs into → last
  resort `/opt/google/chrome/chrome` → a clear "run browser_install_chromium"
  error. Install location and launch location now agree by construction.
- **v0.3.0** — `engine: "chrome" | "firefox"` replaces the old `stealth`
  boolean; the `firefox` engine uses the **official** daijro/camoufox TypeScript
  launcher with full capability (fingerprint/addons/fonts/GeoIP/locale/humanize/
  virtual display); the `chrome` engine is patchright-driven branded Chrome,
  headed only. Camoufox capability params added to `browser_spawn`.
- **v0.2.0** — patchright driver (replacing vanilla Chromium), 4 tab-management
  tools, `browser_install_chromium` / `browser_install_camoufox`.
- **v0.1.0** — initial 5 tools, camoufox + Chromium engines behind `stealth`.
