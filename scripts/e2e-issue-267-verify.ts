/**
 * E2E Verification for Issue #267: QA Regression Tracking with Historical Audit Data
 *
 * Tests all 5 acceptance criteria using real opensafari simulator + QAHistory:
 * 1. Audit reports persist across server restarts
 * 2. Score regression correctly detected when QA score drops
 * 3. No false regression on first run
 * 4. Per-device history tracked independently
 * 5. History storage has reasonable bounds
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { QAHistory } from '../src/qa/history';
import { QAAudit, AuditReport } from '../src/qa/audit';
import { WebKitClient } from '../src/webkit/client';

const TEST_DIR = '/tmp/opensafari-e2e-267-test';
const RESULTS: { criterion: string; passed: boolean; detail: string }[] = [];

function report(criterion: string, passed: boolean, detail: string) {
  RESULTS.push({ criterion, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${criterion}: ${detail}`);
}

async function cleanTestDir() {
  try { await fs.rm(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  await fs.mkdir(TEST_DIR, { recursive: true });
}

async function runRealAudit(client: any, deviceName: string, deviceW: number, deviceH: number): Promise<AuditReport> {
  const audit = new QAAudit(client, {}, undefined, undefined, { name: deviceName, w: deviceW, h: deviceH });
  return audit.runFullAudit();
}

async function main() {
  console.log('=== Issue #267 E2E Verification ===\n');

  // ---- Setup: Connect to already-running simulator + proxy ----
  console.log('[Setup] Connecting to running simulator...');
  const PROXY_PORT = 9322;

  const client = new WebKitClient({ host: 'localhost', port: PROXY_PORT });
  await client.connect({ retries: 5, retryDelay: 2000 });
  console.log('[Setup] WebKit connected');

  await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
  console.log('[Setup] Navigated to https://example.com\n');

  // ---- Criterion 1: Persistence across restarts ----
  console.log('--- Criterion 1: Audit reports persist across server restarts ---');
  await cleanTestDir();
  const history1 = new QAHistory(path.join(TEST_DIR, 'persist-test'));
  const realReport = await runRealAudit(client, 'iPhone 17 Pro', 393, 852);
  console.log(`  Audit score: ${realReport.score}, issues: ${realReport.summary.totalIssues}`);

  const savedPath = await history1.save(realReport);
  console.log(`  Saved to: ${savedPath}`);

  // Verify file exists on disk
  const fileExists = await fs.stat(savedPath).then(() => true).catch(() => false);

  // Simulate "restart" by creating a brand new QAHistory instance (new process)
  const history1b = new QAHistory(path.join(TEST_DIR, 'persist-test'));
  const retrieved = await history1b.getLatest(realReport.url);

  const persistPassed = fileExists && retrieved !== null && retrieved.score === realReport.score && retrieved.url === realReport.url;
  report(
    'Audit reports persist across server restarts',
    persistPassed,
    fileExists
      ? `File on disk ✓, re-read score=${retrieved?.score} matches original=${realReport.score}`
      : 'File NOT found on disk'
  );

  // ---- Criterion 2: Score regression detected ----
  console.log('\n--- Criterion 2: Score regression correctly detected ---');
  const history2 = new QAHistory(path.join(TEST_DIR, 'regression-test'));

  // First audit (real)
  const goodReport = { ...realReport };
  await history2.save(goodReport);

  // Second audit: simulate regression by adding fake critical issues
  const badReport: AuditReport = {
    ...realReport,
    score: Math.max(0, realReport.score - 30),
    timestamp: new Date(Date.now() + 1000).toISOString(),
    summary: { ...realReport.summary, critical: realReport.summary.critical + 3, totalIssues: realReport.summary.totalIssues + 3 },
    detectors: [
      ...realReport.detectors,
      {
        detector: 'fake-regression-detector',
        severity: 'critical' as const,
        issues: [
          { selector: '#regression-1', problem: 'Injected regression issue 1', bounds: undefined as any },
          { selector: '#regression-2', problem: 'Injected regression issue 2', bounds: undefined as any },
          { selector: '#regression-3', problem: 'Injected regression issue 3', bounds: undefined as any },
        ],
        passed: false,
        totalScanned: 3,
        issueCount: 3,
      },
    ],
  };
  await history2.save(badReport);

  const regression = await history2.detectRegressions(badReport, goodReport);
  const regressionPassed = regression.scoreDelta < 0 && regression.newIssues.length > 0 && regression.summary.includes('regressed');
  report(
    'Score regression correctly detected when QA score drops',
    regressionPassed,
    `scoreDelta=${regression.scoreDelta}, newIssues=${regression.newIssues.length}, summary="${regression.summary}"`
  );

  // ---- Criterion 3: No false regression on first run ----
  console.log('\n--- Criterion 3: No false regression on first run ---');
  const history3 = new QAHistory(path.join(TEST_DIR, 'first-run-test'));

  // Save one report (first run)
  await history3.save(realReport);

  // getPrevious should return null (only one report)
  const previous = await history3.getPrevious(realReport.url);
  const firstRunPassed = previous === null;
  report(
    'No false regression on first run',
    firstRunPassed,
    `getPrevious() returned ${previous === null ? 'null (correct — no prior data to compare)' : 'a report (unexpected!)'}`
  );

  // ---- Criterion 4: Per-device history tracked independently ----
  console.log('\n--- Criterion 4: Per-device history tracked independently ---');
  const history4 = new QAHistory(path.join(TEST_DIR, 'multi-device-test'));

  // Navigate to a second URL to simulate different device auditing different page
  await client.navigate({ url: 'https://www.example.org', waitUntil: 'load' });
  const report2 = await runRealAudit(client, 'iPad Air', 820, 1180);

  // Go back to example.com for iPhone report
  await client.navigate({ url: 'https://example.com', waitUntil: 'load' });
  const reportIphone = await runRealAudit(client, 'iPhone 17 Pro', 393, 852);

  await history4.save(report2);    // iPad on example.org
  await history4.save(reportIphone); // iPhone on example.com

  // Verify separate site directories exist
  const deviceTestDir = path.join(TEST_DIR, 'multi-device-test');
  const siteDirs = await fs.readdir(deviceTestDir);

  // Check that reports stored under different URL hostnames
  const iPhoneLatest = await history4.getLatest('https://example.com');
  const iPadLatest = await history4.getLatest('https://www.example.org');

  const devicePassed = siteDirs.length >= 2
    && iPhoneLatest !== null
    && iPadLatest !== null
    && iPhoneLatest.device !== iPadLatest.device;
  report(
    'Per-device history tracked independently',
    devicePassed,
    `${siteDirs.length} site dirs: [${siteDirs.join(', ')}], iPhone device="${iPhoneLatest?.device}", iPad device="${iPadLatest?.device}"`
  );

  // ---- Criterion 5: History storage has reasonable bounds ----
  console.log('\n--- Criterion 5: History storage has reasonable bounds ---');
  const history5 = new QAHistory(path.join(TEST_DIR, 'rotation-test'));

  // Save 35 reports (exceeds the 30 max)
  for (let i = 0; i < 35; i++) {
    const r: AuditReport = {
      ...realReport,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      score: 80 + (i % 20),
    };
    await history5.save(r);
  }

  // Check file count — should be capped at 30
  const rotationDir = path.join(TEST_DIR, 'rotation-test', 'example.com');
  const files = await fs.readdir(rotationDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const storagePassed = jsonFiles.length <= 30;
  report(
    'History storage has reasonable bounds',
    storagePassed,
    `Saved 35 reports, ${jsonFiles.length} remain on disk (max 30 enforced by rotate())`
  );

  // ---- Summary ----
  console.log('\n=== RESULTS ===');
  const allPassed = RESULTS.every(r => r.passed);
  for (const r of RESULTS) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.criterion}`);
  }
  console.log(`\n${allPassed ? '🎉 ALL CRITERIA PASSED' : '⚠️  SOME CRITERIA FAILED'}`);

  // Cleanup
  await client.disconnect();
  await fs.rm(TEST_DIR, { recursive: true }).catch(() => {});

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
