#!/usr/bin/env node
// Launcher for npx-style runners (nubx / npx / pnpx).
//
// The real entrypoint is dist/server.js. Some runners (notably nubx's git/tarball
// fetch path) do NOT execute the package's `prepare` script, so dist/ may be
// absent when this launcher runs. In that case we build it on demand, then import.
//
// This keeps the published package runnable straight from GitHub without a
// prebuilt artifact checked in (dist/ is gitignored).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const entry = join(pkgRoot, 'dist', 'server.js');

if (!existsSync(entry)) {
  // Build once. Prefer a local typescript binary; fall back to nub/npx exec.
  const tsc = join(pkgRoot, 'node_modules', '.bin', 'tsc');
  const cmd = existsSync(tsc) ? tsc : 'nub';
  const args = existsSync(tsc) ? ['-p', 'tsconfig.build.json'] : ['exec', 'tsc', '-p', 'tsconfig.build.json'];

  const r = spawnSync(cmd, args, {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('browsee: build step failed; cannot locate', entry);
    process.exit(r.status ?? 1);
  }
}

await import(entry);
