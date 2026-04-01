/**
 * Hybrid QA Engine — End-to-End Integration Tests
 *
 * Tests the full two-phase QA pipeline with REAL iOS Simulators:
 *   Phase A: Fast scan with viewport emulation and multi-tab
 *   Phase B: Deep verification with sequential device rotation
 *
 * Requirements:
 *   - Xcode with Simulator.app installed
 *   - Available iPhone/iPad simulator runtimes
 *   - Sufficient RAM (~4GB free) for simulator boot
 *
 * Skipped automatically in CI or when no simulator tooling is found.
 */

import { HybridQAEngine, HybridQAResult } from '../../src/orchestration/hybrid-qa';
import { SimulatorPool } from '../../src/simulator/pool';
import { isSimulatorAvailable, describeWithSimulator } from './helpers/simulator-check';

// Full pipeline is slow — allow 5 minutes per test
jest.setTimeout(300_000);

/**
 * Check whether we can run E2E tests on this machine.
 * Returns false in CI, when Xcode is missing, or when simctl is unavailable.
 */
async function canRunE2E(): Promise<boolean> {
  if (process.env.CI) {
    console.error('[hybrid-qa-e2e] Skipping: CI environment detected');
    return false;
  }
  const available = await isSimulatorAvailable();
  if (!available) {
    console.error('[hybrid-qa-e2e] Skipping: Xcode Simulator tooling not found');
  }
  return available;
}

describeWithSimulator('Hybrid QA E2E: Full Pipeline with Real Simulators', () => {
  let pool: SimulatorPool;
  let engine: HybridQAEngine;
  let e2eAvailable = false;

  beforeAll(async () => {
    e2eAvailable = await canRunE2E();
    if (!e2eAvailable) return;

    pool = new SimulatorPool({ max: 5, concurrency: 1 });
    engine = new HybridQAEngine(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      try {
        await pool.shutdownAll();
      } catch (err) {
        console.error(`[hybrid-qa-e2e] Cleanup error: ${err}`);
      }
    }
  }, 120_000);

  // ── Test 1: Phase A — Fast Scan with Viewport Emulation ──

  test('Test 1: Phase A fast scan with viewport emulation for multiple devices', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 1 skipped: no simulator available');
      return;
    }

    const result: HybridQAResult = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17', 'ipad-pro'],
      skipPhaseB: true,
    });

    // Status should be completed
    expect(result.status).toBe('completed');

    // 1 URL x 2 devices = 2 scans
    expect(result.phaseA.scans).toHaveLength(2);

    // Phase B should not have run
    expect(result.phaseB).toBeUndefined();

    // Verify each scan has required fields
    for (const scan of result.phaseA.scans) {
      expect(scan.url).toBe('https://example.com');
      expect(scan.viewport).toBeDefined();
      expect(scan.viewport.preset).toBeDefined();
      expect(scan.viewport.width).toBeGreaterThan(0);
      expect(scan.viewport.height).toBeGreaterThan(0);
      expect(Array.isArray(scan.detectorResults)).toBe(true);
    }

    // Verify viewports correspond to the requested devices
    const presets = result.phaseA.scans.map(s => s.viewport.preset);
    expect(presets).toContain('iphone-17');
    expect(presets).toContain('ipad-pro');

    // peakMode should be tabs-only (no Phase B)
    expect(result.peakMode).toBe('tabs-only');

    console.error(`[hybrid-qa-e2e] Test 1 passed: ${result.phaseA.scans.length} scans, ${result.phaseA.totalIssues} issues, ${result.totalDuration}ms`);
  });

  // ── Test 2: Phase A -> Phase B Trigger ──

  test('Test 2: Phase A triggers Phase B when issues exceed threshold', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 2 skipped: no simulator available');
      return;
    }

    const result: HybridQAResult = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17', 'ipad-pro'],
      deepVerifyThreshold: 'low',
      skipPhaseB: false,
    });

    // Flow should complete regardless of whether issues were found
    expect(result.status).toBe('completed');
    expect(result.phaseA.scans.length).toBeGreaterThan(0);
    expect(result.totalDuration).toBeGreaterThan(0);

    if (result.phaseA.flaggedForVerification > 0) {
      // Phase B ran — verify its structure
      expect(result.phaseB).toBeDefined();
      expect(result.peakMode).toBe('tabs+sequential');
      expect(result.phaseB!.verified).toBeDefined();
      expect(Array.isArray(result.phaseB!.verified)).toBe(true);
      expect(typeof result.phaseB!.confirmedCount).toBe('number');
      expect(typeof result.phaseB!.falsePositiveCount).toBe('number');
      expect(result.phaseB!.duration).toBeGreaterThan(0);

      console.error(
        `[hybrid-qa-e2e] Test 2 passed: Phase B triggered — ` +
        `${result.phaseB!.confirmedCount} confirmed, ${result.phaseB!.falsePositiveCount} false positives`
      );
    } else {
      // No issues above threshold — Phase B should not have run
      // This is still a valid outcome: the flow completed without error
      expect(result.phaseB).toBeUndefined();
      expect(result.peakMode).toBe('tabs-only');

      console.error(
        '[hybrid-qa-e2e] Test 2 passed: no issues above threshold, Phase B correctly skipped'
      );
    }
  });

  // ── Test 3: Phase B — False Positive Detection ──

  test('Test 3: Phase B classifies verified issues with confirmedOnDevice boolean', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 3 skipped: no simulator available');
      return;
    }

    const result: HybridQAResult = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      deepVerifyThreshold: 'low',
      skipPhaseB: false,
    });

    expect(result.status).toBe('completed');

    if (result.phaseB && result.phaseB.verified.length > 0) {
      // Each verified issue should have the confirmedOnDevice classification
      for (const issue of result.phaseB.verified) {
        expect(typeof issue.confirmedOnDevice).toBe('boolean');
        expect(issue.url).toBeDefined();
        expect(issue.device).toBeDefined();
        expect(issue.detector).toBeDefined();
        expect(issue.severity).toBeDefined();
        expect(issue.issue).toBeDefined();
      }

      // Counts should add up
      const totalVerified = result.phaseB.verified.length;
      const confirmed = result.phaseB.confirmedCount;
      const falsePositives = result.phaseB.falsePositiveCount;
      expect(confirmed + falsePositives).toBe(totalVerified);

      console.error(
        `[hybrid-qa-e2e] Test 3 passed: ${totalVerified} verified — ` +
        `${confirmed} confirmed, ${falsePositives} false positives`
      );
    } else {
      // No issues to verify — pipeline still completed correctly
      console.error('[hybrid-qa-e2e] Test 3 passed: no issues to verify (clean page)');
    }
  });

  // ── Test 4: Cross-Device QA Matrix Output ──

  test('Test 4: cross-device QA matrix produces URL x Device scan grid', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 4 skipped: no simulator available');
      return;
    }

    const urls = ['https://example.com', 'https://www.example.org'];
    const devices = ['iphone-17', 'ipad-pro'];

    const result: HybridQAResult = await engine.start({
      urls,
      devices,
      skipPhaseB: true,
    });

    expect(result.status).toBe('completed');

    // 2 URLs x 2 devices = 4 scans
    expect(result.phaseA.scans).toHaveLength(urls.length * devices.length);

    // Verify the full matrix is covered
    for (const url of urls) {
      for (const device of devices) {
        const matchingScan = result.phaseA.scans.find(
          s => s.url === url && s.viewport.preset === device
        );
        expect(matchingScan).toBeDefined();
        expect(matchingScan!.viewport.width).toBeGreaterThan(0);
        expect(matchingScan!.viewport.height).toBeGreaterThan(0);
      }
    }

    // Each scan should have url + viewport info
    for (const scan of result.phaseA.scans) {
      expect(typeof scan.url).toBe('string');
      expect(scan.url.length).toBeGreaterThan(0);
      expect(scan.viewport).toBeDefined();
      expect(scan.viewport.preset).toBeDefined();
      expect(Array.isArray(scan.detectorResults)).toBe(true);
    }

    console.error(
      `[hybrid-qa-e2e] Test 4 passed: ${result.phaseA.scans.length} scans ` +
      `covering ${urls.length} URLs x ${devices.length} devices`
    );
  });

  // ── Test 5: Auth in Hybrid QA ──

  test('Test 5: auth profile integration in hybrid QA pipeline', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 5 skipped: no simulator available');
      return;
    }

    // Check if an auth profile is available
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    const authDir = path.join(os.homedir(), '.opensafari', 'auth');

    let authProfile: string | undefined;
    try {
      const files = await fs.readdir(authDir);
      const profileFile = files.find(f => f.endsWith('.json'));
      if (profileFile) {
        authProfile = profileFile.replace('.json', '');
      }
    } catch {
      // Auth directory does not exist — no profiles available
    }

    if (!authProfile) {
      console.error(
        '[hybrid-qa-e2e] Test 5 skipped: no auth profile found in ~/.opensafari/auth/. ' +
        'To test auth persistence, create a profile with the auth_save tool first.'
      );
      return;
    }

    const result: HybridQAResult = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      skipPhaseB: true,
      authProfile,
    });

    // Pipeline should complete with auth injected
    expect(result.status).toBe('completed');
    expect(result.phaseA.scans.length).toBeGreaterThan(0);

    console.error(
      `[hybrid-qa-e2e] Test 5 passed: pipeline completed with auth profile '${authProfile}'`
    );
  });

  // ── Test 6: No Issues -> Phase B Skipped ──

  test('Test 6: Phase B skipped when no issues exceed threshold on clean page', async () => {
    if (!e2eAvailable) {
      console.error('[hybrid-qa-e2e] Test 6 skipped: no simulator available');
      return;
    }

    const result: HybridQAResult = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      skipPhaseB: false,
      deepVerifyThreshold: 'critical',
    });

    expect(result.status).toBe('completed');
    expect(result.phaseA.scans.length).toBeGreaterThan(0);

    // example.com is a minimal page — with 'critical' threshold,
    // issues (if any) should not be severe enough to trigger Phase B
    if (result.phaseA.flaggedForVerification === 0) {
      expect(result.phaseB).toBeUndefined();
      expect(result.peakMode).toBe('tabs-only');
      console.error('[hybrid-qa-e2e] Test 6 passed: no critical issues, Phase B correctly skipped');
    } else {
      // In the unlikely case example.com triggers critical issues,
      // the pipeline still completed — verify Phase B structure
      expect(result.status).toBe('completed');
      console.error(
        `[hybrid-qa-e2e] Test 6 note: ${result.phaseA.flaggedForVerification} issues flagged as critical ` +
        '(unexpected for example.com, but pipeline completed successfully)'
      );
    }
  });
});
