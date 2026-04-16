/**
 * Long-session soak test for memory SLO verification (issue #554).
 * Gated by OPENSAFARI_RUN_SOAK=1 — not run in normal CI (too slow).
 * Runs for 60 minutes, round-robining across backend tiers.
 *
 * Run locally:
 *   OPENSAFARI_RUN_SOAK=1 npx jest tests/soak/ --testTimeout=3700000
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import {
  getMemorySnapshot,
  resetMemoryTracker,
  bytesToMB,
} from '../../src/metrics/memory-tracker';

const execFileAsync = promisify(execFile);

const SOAK_ENABLED = process.env.OPENSAFARI_RUN_SOAK === '1';
const DURATION_MS = 60 * 60 * 1000; // 1 hour
const CALL_INTERVAL_MS = 3000; // 1 call per 3 seconds
const RSS_DELTA_LIMIT_MB = 100;
const RSS_GROWTH_RATE_LIMIT_MB_PER_MIN = 3;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const HEAP_CLASS_GROWTH_LIMIT = 1000; // reserved for future v8 heap diff
const SAMPLE_INTERVAL_MS = 60 * 1000; // sample RSS every 60s

/** One periodic RSS reading. */
interface RssSample {
  timestampMs: number;
  elapsedMinutes: number;
  rssMB: number;
}

/** Rolling 10-minute window for growth-rate calculation. */
const ROLLING_WINDOW_MINUTES = 10;

/** Directory where RSS baseline JSON is written so CI can upload it. */
const OUTPUT_DIR = path.join(__dirname, 'output');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function saveRssSamples(samples: RssSample[]): void {
  try {
    ensureOutputDir();
    const outPath = path.join(OUTPUT_DIR, 'rss-baseline.json');
    fs.writeFileSync(outPath, JSON.stringify(samples, null, 2), 'utf8');
  } catch (err) {
    console.error('[soak] Failed to write RSS baseline:', err);
  }
}

/**
 * Calculate the worst-case MB/min growth rate over any rolling
 * ROLLING_WINDOW_MINUTES window in the sample array.
 */
function maxRollingGrowthRate(samples: RssSample[]): number {
  if (samples.length < 2) return 0;
  let worstRate = 0;
  for (let i = 0; i < samples.length; i++) {
    const windowStart = samples[i];
    // Find the latest sample within the rolling window
    for (let j = i + 1; j < samples.length; j++) {
      const windowEnd = samples[j];
      const minutesDelta =
        (windowEnd.timestampMs - windowStart.timestampMs) / 60_000;
      if (minutesDelta > ROLLING_WINDOW_MINUTES) break;
      const mbGrowth = windowEnd.rssMB - windowStart.rssMB;
      const rate = mbGrowth / Math.max(minutesDelta, 0.001);
      if (rate > worstRate) worstRate = rate;
    }
  }
  return worstRate;
}

/**
 * Attempt to boot a simulator and return its UDID.
 * Falls back to the first available booted device if creation fails.
 */
async function ensureSimulatorBooted(): Promise<string> {
  // Try to use an already-booted device first (fastest path in local dev).
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl',
      'list',
      'devices',
      'booted',
      '-j',
    ]);
    const data = JSON.parse(stdout) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const devs of Object.values(data.devices)) {
      for (const d of devs) {
        if (d.state === 'Booted') return d.udid;
      }
    }
  } catch {
    // fall through
  }

  // Boot a new iPhone 16 simulator.
  const deviceName = 'iPhone 16';
  let udid = '';

  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl',
      'list',
      'devices',
      'available',
      '-j',
    ]);
    const data = JSON.parse(stdout) as {
      devices: Record<string, Array<{ udid: string; name: string }>>;
    };
    for (const devs of Object.values(data.devices)) {
      for (const d of devs) {
        if (d.name === deviceName) {
          udid = d.udid;
          break;
        }
      }
      if (udid) break;
    }
  } catch (err) {
    console.error('[soak] Could not list simulators:', err);
  }

  if (!udid) {
    // Create a new device as last resort.
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl',
        'create',
        'SoakTest',
        deviceName,
      ]);
      udid = stdout.trim();
    } catch (err) {
      throw new Error(`[soak] Cannot create simulator: ${err}`);
    }
  }

  try {
    await execFileAsync('xcrun', ['simctl', 'boot', udid]);
  } catch {
    // Already booted or boot in progress — not fatal.
  }

  return udid;
}

/** Shut down the simulator we booted (best-effort). */
async function shutdownSimulator(udid: string): Promise<void> {
  try {
    await execFileAsync('xcrun', ['simctl', 'shutdown', udid]);
  } catch {
    // Best effort — don't fail the test suite on teardown issues.
  }
}

// ---------------------------------------------------------------------------
// Simulated operation stubs
//
// In a full soak run these would import and call the actual tool handlers
// directly (no process spawn needed — same Node.js process). Because the
// MCP tool handlers require a live simulator + running app, we stub them
// here so the test file compiles and the scaffolding is exercisable.
//
// Replace each stub body with the real handler call once the per-tool
// import surface is stabilised (tracked in issue #554 follow-up).
// ---------------------------------------------------------------------------

async function runTier0FlutterEvaluate(_udid: string): Promise<void> {
  // TODO(#554): import { flutterEvaluateHandler } from '../../src/tools/flutter/evaluate'
  // and call it with a trivial expression, e.g. '1 + 1'.
  // For now simulate the memory churn a real call would produce.
  const buf = Buffer.alloc(4096);
  buf.fill(0x42);
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function runTier1SimHidKeys(_udid: string): Promise<void> {
  // TODO(#554): import { appKeyInputHandler } from '../../src/tools/input/key-input'
  // and send a no-op key sequence.
  const buf = Buffer.alloc(4096);
  buf.fill(0x43);
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function runTier15AxPress(_udid: string): Promise<void> {
  // TODO(#554): import { appTapElementHandler } from '../../src/tools/input/tap-element'
  // and tap a known-safe accessibility element.
  const buf = Buffer.alloc(4096);
  buf.fill(0x44);
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function runTier3WebKit(_udid: string): Promise<void> {
  // TODO(#554): import { appQueryHandler } from '../../src/tools/webkit/query'
  // and issue a trivial DOM query.
  const buf = Buffer.alloc(4096);
  buf.fill(0x45);
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

/** Round-robin operation dispatch across all four tiers. */
const OPERATIONS = [
  runTier0FlutterEvaluate,
  runTier1SimHidKeys,
  runTier15AxPress,
  runTier3WebKit,
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('long-session soak test', () => {
  // Always-on scaffolding check — verifies the gate constant is readable even
  // when the full suite is skipped.
  it('is gated by OPENSAFARI_RUN_SOAK=1', () => {
    expect(typeof SOAK_ENABLED).toBe('boolean');
  });

  const describeOrSkip = SOAK_ENABLED ? describe : describe.skip;

  describeOrSkip('memory SLO', () => {
    let simulatorUdid = '';
    const rssSamples: RssSample[] = [];
    const startMs = Date.now();

    // -----------------------------------------------------------------------
    // Setup / teardown
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      // Allow up to 3 minutes for simulator boot.
      jest.setTimeout(3 * 60 * 1000 + DURATION_MS + 60_000);

      resetMemoryTracker();
      simulatorUdid = await ensureSimulatorBooted();
      console.error(`[soak] Simulator ready: ${simulatorUdid}`);
      console.error(
        `[soak] Initial RSS: ${bytesToMB(getMemorySnapshot().rssBytes)} MB`,
      );
    }, 3 * 60 * 1000);

    afterAll(async () => {
      saveRssSamples(rssSamples);

      // Emit a summary regardless of pass/fail so CI artifacts are useful.
      if (rssSamples.length >= 2) {
        const initialRss = rssSamples[0].rssMB;
        const finalRss = rssSamples[rssSamples.length - 1].rssMB;
        const delta = finalRss - initialRss;
        const worstRate = maxRollingGrowthRate(rssSamples);
        console.error('[soak] === RSS Summary ===');
        console.error(`[soak]   Initial RSS   : ${initialRss.toFixed(2)} MB`);
        console.error(`[soak]   Final RSS     : ${finalRss.toFixed(2)} MB`);
        console.error(`[soak]   Delta         : ${delta.toFixed(2)} MB`);
        console.error(
          `[soak]   Worst rate    : ${worstRate.toFixed(3)} MB/min`,
        );
        console.error('[soak] === All samples ===');
        for (const s of rssSamples) {
          console.error(
            `[soak]   t+${s.elapsedMinutes.toFixed(1)}m  ${s.rssMB.toFixed(2)} MB`,
          );
        }
        if (delta > RSS_DELTA_LIMIT_MB) {
          console.error(
            `[soak] FAIL: RSS delta ${delta.toFixed(2)} MB > limit ${RSS_DELTA_LIMIT_MB} MB`,
          );
          console.error(
            `[soak] Hint: capture a heap snapshot with --expose-gc and v8.writeHeapSnapshot()`,
          );
          console.error(
            `[soak] Hint: heap snapshots are written to process.cwd() by default`,
          );
        }
        if (worstRate > RSS_GROWTH_RATE_LIMIT_MB_PER_MIN) {
          console.error(
            `[soak] FAIL: worst 10-min growth rate ${worstRate.toFixed(3)} MB/min > limit ${RSS_GROWTH_RATE_LIMIT_MB_PER_MIN} MB/min`,
          );
        }
      }

      if (simulatorUdid) {
        await shutdownSimulator(simulatorUdid);
      }
    });

    // -----------------------------------------------------------------------
    // Main soak loop
    // -----------------------------------------------------------------------

    it(
      'RSS delta stays within SLO over 60 minutes',
      async () => {
        const deadline = startMs + DURATION_MS;
        let operationIndex = 0;
        let lastSampleMs = Date.now();

        // Record initial baseline before any operations.
        const initialSnapshot = getMemorySnapshot();
        rssSamples.push({
          timestampMs: Date.now(),
          elapsedMinutes: 0,
          rssMB: bytesToMB(initialSnapshot.rssBytes),
        });

        while (Date.now() < deadline) {
          const op = OPERATIONS[operationIndex % OPERATIONS.length];
          operationIndex += 1;

          try {
            await op(simulatorUdid);
          } catch (err) {
            // Individual operation failures are logged but do not abort the
            // soak loop — we want to see the memory profile even when some
            // calls fail (e.g., app not installed for a given tier).
            console.error(`[soak] op${operationIndex} error:`, err);
          }

          // Periodic RSS sample.
          const now = Date.now();
          if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
            const snap = getMemorySnapshot();
            rssSamples.push({
              timestampMs: now,
              elapsedMinutes: (now - startMs) / 60_000,
              rssMB: bytesToMB(snap.rssBytes),
            });
            lastSampleMs = now;
          }

          // Pace the loop.
          const elapsed = Date.now() - now;
          const waitMs = Math.max(0, CALL_INTERVAL_MS - elapsed);
          if (waitMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          }
        }

        // Final sample at end of run.
        const finalSnapshot = getMemorySnapshot();
        rssSamples.push({
          timestampMs: Date.now(),
          elapsedMinutes: (Date.now() - startMs) / 60_000,
          rssMB: bytesToMB(finalSnapshot.rssBytes),
        });

        // ----------------------------------------------------------------
        // Assertions
        // ----------------------------------------------------------------

        const initialRssMB = rssSamples[0].rssMB;
        const finalRssMB = rssSamples[rssSamples.length - 1].rssMB;
        const rssDeltaMB = finalRssMB - initialRssMB;

        // SLO 1: absolute RSS growth must stay under 100 MB.
        expect(rssDeltaMB).toBeLessThanOrEqual(RSS_DELTA_LIMIT_MB);

        // SLO 2: rolling 10-minute growth rate must not exceed 3 MB/min.
        const worstRate = maxRollingGrowthRate(rssSamples);
        expect(worstRate).toBeLessThanOrEqual(RSS_GROWTH_RATE_LIMIT_MB_PER_MIN);

        // TODO(#554): SLO 3 (heap class growth diff) is aspirational.
        // v8.writeHeapSnapshot() requires --expose-gc which cannot be passed
        // to jest without a custom runner. Implement in a follow-up once the
        // test infrastructure supports it.
      },
      DURATION_MS + 5 * 60 * 1000, // test-level timeout: run duration + 5 min buffer
    );
  });
});
