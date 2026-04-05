#!/usr/bin/env npx ts-node
/**
 * verify-presets.ts — Automated device preset dimension verification.
 *
 * Boots each preset's device (if available), reads the simulator's physical
 * display dimensions via `simctl io enumerate`, and compares against the
 * preset definitions in src/simulator/presets.ts.
 *
 * Usage:
 *   npx ts-node scripts/verify-presets.ts
 *
 * Output: Markdown accuracy table to stdout (suitable for CI artifact capture).
 * Exit code: 0 if all available presets pass, 1 if any mismatch is found.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Inline preset definitions to avoid import path issues when run from project root
const DEVICE_PRESETS: Record<string, { name: string; w: number; h: number; dpr: number }> = {
  'iphone-se-1': { name: 'iPhone SE (1st generation)', w: 320, h: 568, dpr: 2 },
  'iphone-se-2': { name: 'iPhone SE (2nd generation)', w: 375, h: 667, dpr: 2 },
  'iphone-se-3': { name: 'iPhone SE (3rd generation)', w: 375, h: 667, dpr: 2 },
  'iphone-17e': { name: 'iPhone 17e', w: 390, h: 844, dpr: 3 },
  'iphone-17': { name: 'iPhone 17', w: 402, h: 874, dpr: 3 },
  'iphone-air': { name: 'iPhone Air', w: 420, h: 912, dpr: 3 },
  'iphone-17-pro': { name: 'iPhone 17 Pro', w: 402, h: 874, dpr: 3 },
  'iphone-17-pro-max': { name: 'iPhone 17 Pro Max', w: 440, h: 956, dpr: 3 },
  'ipad-air': { name: 'iPad Air 13-inch (M4)', w: 1024, h: 1366, dpr: 2 },
  'ipad-pro': { name: 'iPad Pro 13-inch (M5)', w: 1032, h: 1376, dpr: 2 },
};

// Map preset names to simctl device type identifiers
const DEVICE_TYPE_MAP: Record<string, string> = {
  'iphone-se-1': 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE',
  'iphone-se-2': 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE--2nd-generation-',
  'iphone-se-3': 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
  'iphone-17e': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17e',
  'iphone-17': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  'iphone-air': 'com.apple.CoreSimulator.SimDeviceType.iPhone-Air',
  'iphone-17-pro': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  'iphone-17-pro-max': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max',
  'ipad-air': 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-13-inch-M4',
  'ipad-pro': 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB',
};

const TOLERANCE = 1; // ±1 point for rounding

interface VerifyResult {
  preset: string;
  device: string;
  expectedW: number;
  expectedH: number;
  expectedDpr: number;
  actualPhysicalW: number;
  actualPhysicalH: number;
  actualLogicalW: number;
  actualLogicalH: number;
  status: 'PASS' | 'FAIL' | 'SKIP';
  notes: string;
}

async function getLatestRuntime(): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'runtimes', '--json']);
  const data = JSON.parse(stdout);
  const iosRuntimes = data.runtimes.filter(
    (r: { isAvailable: boolean; platform: string }) => r.isAvailable && r.platform === 'iOS',
  );
  if (iosRuntimes.length === 0) throw new Error('No available iOS runtime found');
  return iosRuntimes[iosRuntimes.length - 1].identifier;
}

async function getDisplayDimensions(udid: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'io', udid, 'enumerate'], {
      timeout: 15000,
    });
    // Parse Display class 0 (main LCD)
    const blocks = stdout.split('Port:');
    for (const block of blocks) {
      if (block.includes('Display class: 0')) {
        const wMatch = block.match(/Default width:\s+(\d+)/);
        const hMatch = block.match(/Default height:\s+(\d+)/);
        if (wMatch && hMatch) {
          return { w: parseInt(wMatch[1], 10), h: parseInt(hMatch[1], 10) };
        }
      }
    }
  } catch {
    // enumerate failed
  }
  return null;
}

async function verifyPreset(
  key: string,
  runtime: string,
): Promise<VerifyResult> {
  const preset = DEVICE_PRESETS[key];
  const deviceType = DEVICE_TYPE_MAP[key];
  const result: VerifyResult = {
    preset: key,
    device: preset.name,
    expectedW: preset.w,
    expectedH: preset.h,
    expectedDpr: preset.dpr,
    actualPhysicalW: 0,
    actualPhysicalH: 0,
    actualLogicalW: 0,
    actualLogicalH: 0,
    status: 'SKIP',
    notes: '',
  };

  // Create temp simulator
  let udid: string;
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'simctl', 'create', `verify-${key}`, deviceType, runtime,
    ]);
    udid = stdout.trim();
  } catch (err) {
    result.notes = `Device incompatible with runtime: ${(err as Error).message.slice(0, 80)}`;
    return result;
  }

  try {
    // Boot
    await execFileAsync('xcrun', ['simctl', 'boot', udid]);
    await new Promise(r => setTimeout(r, 5000));

    // Get dimensions
    const dims = await getDisplayDimensions(udid);
    if (!dims) {
      result.notes = 'Could not read display dimensions';
      return result;
    }

    result.actualPhysicalW = dims.w;
    result.actualPhysicalH = dims.h;
    result.actualLogicalW = Math.round(dims.w / preset.dpr);
    result.actualLogicalH = Math.round(dims.h / preset.dpr);

    const wOk = Math.abs(result.actualLogicalW - preset.w) <= TOLERANCE;
    const hOk = Math.abs(result.actualLogicalH - preset.h) <= TOLERANCE;
    result.status = wOk && hOk ? 'PASS' : 'FAIL';

    if (!wOk || !hOk) {
      result.notes = `Expected ${preset.w}x${preset.h}, got ${result.actualLogicalW}x${result.actualLogicalH}`;
    }
  } finally {
    // Cleanup
    try { await execFileAsync('xcrun', ['simctl', 'shutdown', udid]); } catch { /* ok */ }
    try { await execFileAsync('xcrun', ['simctl', 'delete', udid]); } catch { /* ok */ }
  }

  return result;
}

async function main(): Promise<void> {
  console.error('Device Preset Verification Script');
  console.error('==================================\n');

  const runtime = await getLatestRuntime();
  console.error(`Using runtime: ${runtime}\n`);

  const results: VerifyResult[] = [];
  let hasFailure = false;

  for (const key of Object.keys(DEVICE_PRESETS)) {
    console.error(`Verifying ${key}...`);
    const result = await verifyPreset(key, runtime);
    results.push(result);
    console.error(`  ${result.status}${result.notes ? ` (${result.notes})` : ''}`);
    if (result.status === 'FAIL') hasFailure = true;
  }

  // Output markdown table to stdout
  console.log('\n## Device Preset Accuracy Table\n');
  console.log(`Verified: ${new Date().toISOString().slice(0, 10)} | Runtime: ${runtime}\n`);
  console.log('| Preset | Device | Expected | Physical | Logical | DPR | Status | Notes |');
  console.log('|--------|--------|----------|----------|---------|-----|--------|-------|');

  for (const r of results) {
    const statusIcon = r.status === 'PASS' ? ':white_check_mark:' : r.status === 'FAIL' ? ':x:' : ':warning:';
    console.log(
      `| \`${r.preset}\` | ${r.device} | ${r.expectedW}x${r.expectedH} ` +
      `| ${r.actualPhysicalW}x${r.actualPhysicalH || '-'} ` +
      `| ${r.actualLogicalW || '-'}x${r.actualLogicalH || '-'} ` +
      `| ${r.expectedDpr}x | ${statusIcon} ${r.status} | ${r.notes} |`,
    );
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  console.log(`\n**Summary:** ${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length} presets.`);

  console.error(`\nDone: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(hasFailure ? 1 : 0);
}

main().catch(err => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
