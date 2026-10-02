#!/usr/bin/env node
// Launcher so npx-style runners (nubx/npx/pnpx) can execute the built server.
// The real entrypoint is dist/server.js, produced by the `prepare` build step.
import('../dist/server.js');
