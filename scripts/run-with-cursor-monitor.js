#!/usr/bin/env node
// Run a command wrapped in the Swift cursor-monitor helper so we fail the
// suite if the host OS cursor moves. Used by `npm run test:integration:monitored`
// and the headless-smoke CI workflow.
//
// Resolution order:
//   1. `dist/cursor-monitor` (compiled binary produced by `npm run build`)
//   2. `swift src/native/cursor-monitor.swift` (interpreter fallback)
//
// Usage:
//   node scripts/run-with-cursor-monitor.js -- <command> [args...]

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const dashIdx = args.indexOf('--');
if (dashIdx === -1 || dashIdx === args.length - 1) {
  console.error(
    "run-with-cursor-monitor: expected '-- <command> [args...]' after wrapper flags"
  );
  process.exit(2);
}
const childArgv = args.slice(dashIdx + 1);

const repoRoot = path.resolve(__dirname, '..');
const binaryPath = path.join(repoRoot, 'dist', 'cursor-monitor');
const sourcePath = path.join(repoRoot, 'src', 'native', 'cursor-monitor.swift');

let launcher;
let launcherArgs;

if (fs.existsSync(binaryPath)) {
  launcher = binaryPath;
  launcherArgs = ['--', ...childArgv];
} else if (fs.existsSync(sourcePath)) {
  launcher = 'swift';
  launcherArgs = [sourcePath, '--', ...childArgv];
} else {
  console.error(
    `run-with-cursor-monitor: neither ${binaryPath} nor ${sourcePath} exists — did you run npm run build?`
  );
  process.exit(2);
}

const result = spawnSync(launcher, launcherArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`run-with-cursor-monitor: failed to spawn: ${result.error.message}`);
  process.exit(2);
}
if (result.signal) {
  console.error(`run-with-cursor-monitor: child terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
