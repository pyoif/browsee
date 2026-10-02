#!/usr/bin/env node
// Launcher for npx-style runners (nubx / npx / pnpx).
//
// The real entrypoint is dist/server.js. Some runners (notably nubx's git/tarball
// fetch path) do NOT execute the package's `prepare` script and do NOT install
// devDependencies, so dist/ may be absent and tsc may be unavailable when this
// launcher runs. In that case we build on demand, fetching typescript ad-hoc if
// there is no local copy.
//
// This keeps the published package runnable straight from GitHub without a
// prebuilt artifact checked in (dist/ is gitignored).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const entry = join(pkgRoot, 'dist', 'server.js');

if (!existsSync(entry)) {
  const localTsc = join(pkgRoot, 'node_modules', '.bin', 'tsc');
  // Prefer a config that does not require devDependency type packages
  // (@nubjs/types, node). Those are absent in nubx's dlx install, which would
  // otherwise fail type resolution (TS2688) even though JS emits fine.
  const dlxConfig = join(pkgRoot, 'tsconfig.dlx.json');
  const buildConfig = existsSync(dlxConfig) ? 'tsconfig.dlx.json' : 'tsconfig.build.json';
  let cmd;
  let args;

  if (existsSync(localTsc)) {
    // Normal install: devDeps present.
    cmd = localTsc;
    args = ['-p', buildConfig];
  } else {
    // nubx dlx: devDeps absent. Fetch the `typescript` package and run its
    // `tsc` bin explicitly. (`nubx tsc` alone would fetch the unrelated
    // deprecated `tsc` package, so `-p typescript` is required.)
    cmd = 'nubx';
    args = ['-y', '-p', 'typescript', 'tsc', '-p', buildConfig];
  }

  const r = spawnSync(cmd, args, {
    cwd: pkgRoot,
    // Keep stdout clean for JSON-RPC: capture the build's output and forward it
    // to stderr instead of inheriting, so MCP clients never see tsc diagnostics
    // interleaved with protocol messages.
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  // Trust the emitted artifact over tsc's exit code: with noEmitOnError unset,
  // JS is emitted even if type resolution warned. Only fail if dist is truly
  // absent after the build attempt.
  if (!existsSync(entry)) {
    console.error('browsee: build step failed; cannot locate', entry);
    if (r.error) console.error(r.error.message);
    process.exit(r.status ?? 1);
  }
}

// On Windows a raw absolute path like C:\... parses as a URL with scheme "c:",
// which throws ERR_UNSUPPORTED_ESM_URL_SCHEME. Convert to a file:// URL first.
await import(pathToFileURL(entry).href);
