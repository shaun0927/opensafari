/**
 * E2E Detector Validation - Full lifecycle
 * Handles: boot, Safari open, proxy start, detection, cleanup
 */
import { WebKitClient } from '../src/webkit/client';
import { WebInspectorProxy } from '../src/simulator/proxy';
import { SimulatorManager } from '../src/simulator/manager';
import { addManagedDevice } from '../src/reliability/zombie-cleanup';
import { detectAutoZoom } from '../src/qa/detectors/auto-zoom';
import { detectTouchTargets } from '../src/qa/detectors/touch-targets';
import { detectHoverOnly } from '../src/qa/detectors/hover-only';
import { detectInputType } from '../src/qa/detectors/input-type';
import { detectSafeArea } from '../src/qa/detectors/safe-area';
import { detectKeyboardOverlap } from '../src/qa/detectors/keyboard-overlap';
import { detectHorizontalOverflow } from '../src/qa/detectors/horizontal-overflow';
import { detect100vh } from '../src/qa/detectors/vh100';
import { detectFixedStacking } from '../src/qa/detectors/fixed-stacking';
import { detectScrollLock } from '../src/qa/detectors/scroll-lock';
import { detectDarkMode } from '../src/qa/detectors/dark-mode';
import { detectOrientation } from '../src/qa/detectors/orientation';
import { detectPwaMeta } from '../src/qa/detectors/pwa-meta';
import { detectAccessibility } from '../src/qa/detectors/accessibility';
import type { DetectorResult } from '../src/qa/types';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFileCb);
const BUGGY_PAGE = 'http://localhost:8765/buggy-page.html';
const CLEAN_PAGE = 'http://localhost:8765/clean-page.html';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface DetDef {
  name: string;
  fn: (c: any, s?: any, d?: string) => Promise<DetectorResult>;
  expectBuggy: boolean;
  needsSim?: boolean;
}

const DETS: DetDef[] = [
  { name: 'auto_zoom', fn: detectAutoZoom, expectBuggy: true },
  { name: 'touch_targets', fn: detectTouchTargets, expectBuggy: true },
  { name: 'hover_only', fn: detectHoverOnly, expectBuggy: true },
  { name: 'input_type', fn: detectInputType, expectBuggy: true },
  { name: 'safe_area', fn: detectSafeArea, expectBuggy: true },
  { name: 'keyboard_overlap', fn: detectKeyboardOverlap, expectBuggy: true },
  { name: 'horizontal_overflow', fn: detectHorizontalOverflow, expectBuggy: true },
  { name: '100vh', fn: detect100vh, expectBuggy: false },
  { name: 'fixed_stacking', fn: detectFixedStacking, expectBuggy: true },
  { name: 'scroll_lock', fn: detectScrollLock, expectBuggy: true },
  { name: 'dark_mode', fn: detectDarkMode, expectBuggy: true, needsSim: true },
  { name: 'orientation', fn: detectOrientation, expectBuggy: false, needsSim: true },
  { name: 'pwa_meta', fn: detectPwaMeta, expectBuggy: true },
  { name: 'accessibility', fn: detectAccessibility, expectBuggy: true },
];

async function main() {
  console.log('=== QA Detector E2E Validation (Issue #254) ===\n');

  // Use existing booted device and proxy on port 9322
  console.log('[1] Finding booted device...');
  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  if (booted.length === 0) { console.error('No booted device'); process.exit(1); }
  const device = booted[0];
  console.log(`  ${device.name} (${device.udid})`);

  const PORT = parseInt(process.env.PORT || '9322', 10);
  console.log(`[2] Connecting to WebKit on port ${PORT}...`);

  const client = new WebKitClient({ host: 'localhost', port: PORT, targetIndex: 1 });
  await client.connect({ retries: 5, retryDelay: 2000 });
  console.log('  Connected!\n');

  const deviceId = device.udid;
  const buggyResults: Record<string, DetectorResult> = {};
  const cleanResults: Record<string, DetectorResult> = {};

  // 4. Test buggy page
  console.log(`--- BUGGY PAGE ---`);
  await client.navigate({ url: BUGGY_PAGE, waitUntil: 'load' });
  await sleep(2000);
  console.log('Page loaded.\n');

  for (const det of DETS) {
    try {
      const r = det.needsSim ? await det.fn(client, manager, deviceId) : await det.fn(client);
      buggyResults[det.name] = r;
      const found = !r.passed && r.issueCount > 0;
      const icon = (det.expectBuggy && found) || (!det.expectBuggy && !found) ? '✅' : '❌';
      console.log(`${icon} ${det.name}: ${found ? `${r.issueCount} issues [${r.severity}]` : 'PASS'}`);
      if (found) for (const iss of r.issues.slice(0, 3)) console.log(`   ${iss.selector}: ${iss.problem}`);
      if (found && r.issues.length > 3) console.log(`   ... +${r.issues.length - 3} more`);
    } catch (err) { console.log(`⚠️  ${det.name}: ERROR ${err}`); }
  }

  // 5. Test clean page
  console.log(`\n--- CLEAN PAGE ---`);
  await client.navigate({ url: CLEAN_PAGE, waitUntil: 'load' });
  await sleep(2000);
  console.log('Page loaded.\n');

  for (const det of DETS) {
    try {
      const r = det.needsSim ? await det.fn(client, manager, deviceId) : await det.fn(client);
      cleanResults[det.name] = r;
      const found = !r.passed && r.issueCount > 0;
      console.log(`${found ? '❌' : '✅'} ${det.name}: ${found ? `FP: ${r.issueCount} issues` : 'PASS'}`);
      if (found) for (const iss of r.issues.slice(0, 2)) console.log(`   ${iss.selector}: ${iss.problem}`);
    } catch (err) { console.log(`⚠️  ${det.name}: ERROR ${err}`); }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('VALIDATION SUMMARY');
  console.log('='.repeat(70));

  let tp = 0, fp = 0, totalExpected = 0, errors = 0;
  console.log('\n| Detector           | Buggy           | Clean           | TP  | FP  |');
  console.log('|--------------------|-----------------|-----------------|-----|-----|');

  for (const det of DETS) {
    const b = buggyResults[det.name];
    const c = cleanResults[det.name];
    if (!b && !c) { errors++; continue; }
    const bStr = b ? (b.passed ? 'PASS' : `${b.issueCount} issues`) : 'ERR';
    const cStr = c ? (c.passed ? 'PASS' : `${c.issueCount} issues`) : 'ERR';
    let tpOk = false;
    if (det.expectBuggy) {
      totalExpected++;
      tpOk = !!(b && !b.passed && b.issueCount > 0);
      if (tpOk) tp++;
    }
    const fpHit = !!(c && !c.passed && c.issueCount > 0);
    if (fpHit) fp++;
    const tpIcon = det.expectBuggy ? (tpOk ? '✅' : '❌') : 'N/A';
    const fpIcon = fpHit ? '❌' : '✅';
    console.log(`| ${det.name.padEnd(18)} | ${bStr.padEnd(15)} | ${cStr.padEnd(15)} | ${String(tpIcon).padEnd(3)} | ${String(fpIcon).padEnd(3)} |`);
  }

  const accuracy = totalExpected > 0 ? Math.round((tp / totalExpected) * 100) : 0;
  const fpRate = Math.round((fp / DETS.length) * 100);
  console.log(`\nTrue Positives:    ${tp}/${totalExpected} (${accuracy}%)`);
  console.log(`False Positives:   ${fp}/${DETS.length} (${fpRate}%)`);
  console.log(`Errors:            ${errors}`);
  console.log(`Detection Accuracy: ${accuracy}%`);
  console.log(`Result: ${accuracy >= 90 ? 'PASS ✅' : 'FAIL ❌'}`);

  const report = {
    timestamp: new Date().toISOString(),
    device: device.name, runtime: device.runtimeVersion,
    buggyPage: BUGGY_PAGE, cleanPage: CLEAN_PAGE,
    detectors: DETS.map(d => ({
      name: d.name, expectBuggy: d.expectBuggy,
      buggy: buggyResults[d.name] ? { passed: buggyResults[d.name].passed, issues: buggyResults[d.name].issueCount, severity: buggyResults[d.name].severity, details: buggyResults[d.name].issues } : null,
      clean: cleanResults[d.name] ? { passed: cleanResults[d.name].passed, issues: cleanResults[d.name].issueCount, severity: cleanResults[d.name].severity, details: cleanResults[d.name].issues } : null,
    })),
    summary: { truePositives: tp, totalExpected, falsePositives: fp, errors, accuracy, fpRate },
  };
  fs.writeFileSync('tests/e2e-fixtures/validation-report.json', JSON.stringify(report, null, 2));
  console.log('\nReport: tests/e2e-fixtures/validation-report.json');

  await client.disconnect();
  process.exit(accuracy >= 90 ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
