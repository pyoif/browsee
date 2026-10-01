# browsee

A **stdio Model Context Protocol (MCP) server** exposing scriptable, steerable
browser sessions. Built with `@modelcontextprotocol/sdk` + `playwright-core`.

Two engines:

| Engine | When | Binary | Notes |
|---|---|---|---|
| **camoufox** | `stealth: true` (default) | `$HOME/.cache/camoufox/browsers/official/*/camoufox-bin` | Stealth Firefox build; launched via `playwright-core`'s `firefox()` with `LD_LIBRARY_PATH` pointed at the pixi GTK env. |
| **chromium** | `stealth: false` | playwright-core's bundled Chromium | Must already be installed; this server **never downloads** a browser at runtime. |

> **Why `firefox()` and not `chromium()` for camoufox?** camoufox is a Firefox
> build. Driving it through `chromium.launch()` sends Chromium flags and a CDP
> handshake that Firefox's juggler never completes (the launch times out).
> `firefox.launch({ executablePath })` speaks the juggler protocol and works.

## Install

```sh
mise use nub@latest          # Node toolkit, project-scoped
nub install                  # install deps (@modelcontextprotocol/sdk, playwright-core, zod)
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
