#!/usr/bin/env ts-node
/**
 * bench-cli-startup.ts
 *
 * Measures CLI startup time for `opensafari --help`.
 * Run after building: npx ts-node scripts/bench-cli-startup.ts
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/bench-cli-startup.ts
 *   # or after build:
 *   node scripts/bench-cli-startup.js
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const RUNS = 10;
const CLI_PATH = path.resolve(__dirname, '../dist/cli/index.js');

if (!fs.existsSync(CLI_PATH)) {
  console.error(`[bench] CLI not built. Run: npm run build:cli`);
  process.exit(1);
}

const times: number[] = [];

for (let i = 0; i < RUNS; i++) {
  const start = process.hrtime.bigint();
  execFileSync(process.execPath, [CLI_PATH, '--help'], { stdio: 'pipe' });
  const end = process.hrtime.bigint();
  times.push(Number(end - start) / 1_000_000);
}

times.sort((a, b) => a - b);
const median = times[Math.floor(RUNS / 2)];
const min = times[0];
const max = times[times.length - 1];
const mean = times.reduce((a, b) => a + b, 0) / RUNS;

console.log(`CLI startup benchmark (opensafari --help) — ${RUNS} runs`);
console.log(`  min:    ${min.toFixed(1)}ms`);
console.log(`  median: ${median.toFixed(1)}ms`);
console.log(`  mean:   ${mean.toFixed(1)}ms`);
console.log(`  max:    ${max.toFixed(1)}ms`);
console.log(`  all:    ${times.map(t => t.toFixed(1)).join(', ')}ms`);
