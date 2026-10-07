# browsee

A **stdio Model Context Protocol (MCP) server** exposing scriptable, steerable
browser sessions. Built with `@modelcontextprotocol/sdk` + `patchright` (the
patched, undetectable Playwright fork) for Chromium, and `playwright-core` for
the camoufox/Firefox stealth path.

Two engines:

| Engine | When | Binary | Driver | Notes |
|---|---|---|---|---|
| **camoufox** | `stealth: true` (default) | `$HOME/.cache/camoufox/browsers/official/*/camoufox-bin` | `playwright-core`'s `firefox()` | Stealth Firefox build, launched with `LD_LIBRARY_PATH` pointed at the pixi GTK env. |
| **chromium** | `stealth: false` | patchright's Chromium (`~/.cache/ms-playwright/chromium-<rev>`) | `patchright`'s `chromium()` | Undetectable via the **patched driver** (not just a patched binary). Install with `browser_install_chromium`. |

> **Why the split driver?** Patchright's stealth comes from its patched driver
> code (no `Runtime.enable` leaks, etc.), so Chromium must be driven by
> `patchright`, not vanilla `playwright-core`. But camoufox is a *Firefox* build
> whose patched juggler is incompatible with patchright's patched Firefox driver
> (`page.evaluate` throws `Cannot read properties of undefined (reading '_client')`),
> so camoufox stays on vanilla `playwright-core`'s `firefox()`.

> **Why `firefox()` and not `chromium()` for camoufox?** camoufox is a Firefox
> build. Driving it through `chromium.launch()` sends Chromium flags and a CDP
> handshake that Firefox's juggler never completes (the launch times out).
> `firefox.launch({ executablePath })` speaks the juggler protocol and works.

## Install

```sh
mise use nub@latest          # Node toolkit, project-scoped
nub install                  # installs @modelcontextprotocol/sdk, patchright, playwright-core, zod
nub exec tsc -p tsconfig.build.json   # build -> dist/server.js
```

## Run

The server speaks JSON-RPC over **stdin/stdout**. Launch it with:

```sh
./run.sh            # wraps: LD_LIBRARY_PATH=<pixi GTK lib>:… nub dist/server.js
```

`run.sh` sets `LD_LIBRARY_PATH` so (a) Node can find `libatomic` and (b) the
camoufox Firefox binary can find `libgtk-3`/X11 libs. Wire it into an MCP client
by pointing the client's `command` at `run.sh` (or directly at
`nub dist/server.js` with `LD_LIBRARY_PATH` exported).

## Tools

### `browser_spawn`
Launch a session.

| arg | type | default | meaning |
|---|---|---|---|
| `session_id` | string | (auto uuid) | requested id (a uuid is generated) |
| `headless` | boolean | `true` | run headless |
| `start_url` | string | — | navigate here on spawn |
| `stealth` | boolean | `true` | `true` → camoufox; `false` → bundled chromium |

Returns `{ session_id, engine, headless, url }`.

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

`{}` → downloads the **exact** Chromium build this server's `patchright` expects
(revision read from `patchright-core/browsers.json`) into the Playwright browsers
directory (`$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright/chromium-<rev>`),
then writes Playwright's `INSTALLATION_COMPLETE` marker.

- Installs the **full** Chromium build, never `chromium_headless_shell` (the
  shell is detectable; patchright's own guidance is to use the full build).
- The modern revision is a Chrome-for-Testing build, fetched from
  `https://cdn.playwright.dev/builds/cft/<browserVersion>/<platform>/…`.
- Zero dependencies: the ZIP is downloaded with Node's `fetch` and extracted
  with a built-in zlib-based ZIP reader (`src/zip.ts`).
- Idempotent: returns `{ alreadyInstalled: true }` when the build is present.

### `browser_install_camoufox`

`{}` → downloads the latest camoufox Linux build from GitHub releases into the
layout the server expects (`$CAMOUFOX_INSTALL_DIR` or `~/.cache/camoufox`, i.e.
`…/browsers/official/<tag>/camoufox-bin`). Idempotent: if a camoufox build is
already present it reports it and does **not** re-download.

## Zombie prevention

- All live sessions are tracked in an in-memory `Map`.
- On `SIGTERM` / `SIGINT`, the server closes every session (context + browser)
  and exits 0.
- Playwright manages its own child processes and reaps them on `browser.close()`.
- Verified: after `browser_kill`, no `camoufox-bin` / `firefox` / `node` server
  processes remain and no defunct/zombie processes are left.

## End-to-end test

`nub e2e-test.mjs` drives a full stdio JSON-RPC conversation:
`initialize → initialized → tools/list → browser_spawn(camoufox) →
navigate → evaluate(title) → cookies save → screenshot → browser_list →
bogus action → browser_kill → browser_list(empty)`.

## Paths

- Project root: `$HOME/browsee`
- Screenshots: `$HOME/browsee/artifacts/`
- camoufox binary: `$HOME/.cache/camoufox/browsers/official/*/camoufox-bin`
- GTK libs: `$HOME/camoufox/.pixi/envs/default/lib`
- Chromium (patchright): `$PLAYWRIGHT_BROWSERS_PATH` or `$HOME/.cache/ms-playwright/chromium-<rev>/`
- libudev shim: `$HOME/.local/lib/udev` (Chromium links `libudev.so.1`, absent from the Wolfi image)

## Note on `LD_LIBRARY_PATH`

`run.sh` prepends `$HOME/.local/lib/udev` and the pixi GTK lib dir to
`LD_LIBRARY_PATH` so:
1. Node (fetched by nub) finds `libatomic`;
2. camoufox's Firefox finds `libgtk-3`/X11 libs;
3. Chromium finds `libudev.so.1`.

The server also self-heals for (3): `launchChromium` scans for a `libudev.so.1`
provider on disk and appends it to the child's `LD_LIBRARY_PATH`, so a Chromium
session works even when the server is launched without `run.sh`.
