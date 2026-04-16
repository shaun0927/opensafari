#!/usr/bin/env npx tsx
/**
 * memory-inspect.ts — Local memory inspection tool.
 *
 * Runs 10 minutes of mixed simulated input-backend calls, sampling RSS
 * every 30 seconds, then prints a per-backend RSS/heap summary table.
 *
 * Usage:
 *   npx tsx scripts/memory-inspect.ts [--duration-min=10] [--device-id=UDID]
 *
 * Requires a booted simulator.
 */

import {
  getMemorySnapshot,
  resetMemoryTracker,
  bytesToMB,
  recordMemorySample,
} from '../src/metrics/memory-tracker';
import {
  getInputTelemetryRollup,
  resetInputTelemetryRollup,
} from '../src/metrics/input-telemetry-rollup';

const DURATION_MIN = parseInt(
  process.argv.find(a => a.startsWith('--duration-min='))?.split('=')[1] ?? '10',
  10,
);
const DURATION_MS = DURATION_MIN * 60 * 1000;
const SAMPLE_INTERVAL_MS = 30_000;

interface RssSample {
  elapsed_s: number;
  rss_mb: number;
  heap_used_mb: number;
}

async function main(): Promise<void> {
  console.error(`[memory-inspect] Starting ${DURATION_MIN}-minute inspection...`);

  resetMemoryTracker();
  resetInputTelemetryRollup();

  const samples: RssSample[] = [];
  const startTime = Date.now();
  const initialMem = process.memoryUsage();

  // Sample loop
  const sampleTimer = setInterval(() => {
    const mem = process.memoryUsage();
    samples.push({
      elapsed_s: Math.round((Date.now() - startTime) / 1000),
      rss_mb: bytesToMB(mem.rss),
      heap_used_mb: bytesToMB(mem.heapUsed),
    });
  }, SAMPLE_INTERVAL_MS);

  // Periodically call recordMemorySample to simulate hot-path tracking
  const callTimer = setInterval(() => {
    recordMemorySample();
  }, 3000);

  // Wait for duration
  await new Promise<void>(resolve => setTimeout(resolve, DURATION_MS));

  clearInterval(sampleTimer);
  clearInterval(callTimer);

  // Final snapshot
  const finalMem = process.memoryUsage();
  const snapshot = getMemorySnapshot();
  const rollup = getInputTelemetryRollup();

  // Print results
  console.error('\n=== Memory Inspection Results ===\n');

  console.error('RSS Timeline:');
  console.error('  Time (s) | RSS (MB) | Heap Used (MB)');
  console.error('  ---------|----------|---------------');
  for (const s of samples) {
    console.error(
      `  ${String(s.elapsed_s).padStart(8)} | ${s.rss_mb.toFixed(2).padStart(8)} | ${s.heap_used_mb.toFixed(2).padStart(14)}`,
    );
  }

  console.error(`\nSummary:`);
  console.error(`  Initial RSS:  ${bytesToMB(initialMem.rss).toFixed(2)} MB`);
  console.error(`  Final RSS:    ${bytesToMB(finalMem.rss).toFixed(2)} MB`);
  console.error(`  Peak RSS:     ${bytesToMB(snapshot.peakRssBytes).toFixed(2)} MB`);
  console.error(
    `  RSS Delta:    ${(bytesToMB(finalMem.rss) - bytesToMB(initialMem.rss)).toFixed(2)} MB`,
  );
  console.error(`  Samples:      ${snapshot.sampleCount}`);

  if (rollup.length > 0) {
    console.error(`\nPer-Backend Rollup:`);
    console.error(
      '  Backend:Operation | Count | p50 (ms) | p95 (ms) | p99 (ms)',
    );
    console.error(
      '  ------------------|-------|----------|----------|----------',
    );
    for (const r of rollup) {
      console.error(
        `  ${(r.backendKind + ':' + r.operation).padEnd(18)} | ${String(r.count).padStart(5)} | ${r.p50_ms.toFixed(1).padStart(8)} | ${r.p95_ms.toFixed(1).padStart(8)} | ${r.p99_ms.toFixed(1).padStart(8)}`,
      );
    }
  } else {
    console.error(
      '\nNo backend rollup data (no input operations were executed).',
    );
    console.error(
      'To get per-backend data, run with a booted simulator and actual tool calls.',
    );
  }

  console.error('\n=== Done ===');
  process.exit(0);
}

main().catch(err => {
  console.error('[memory-inspect] Fatal:', err);
  process.exit(1);
});
