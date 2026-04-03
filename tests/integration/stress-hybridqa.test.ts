/**
 * HybridQA Pipeline Stress Tests — Validates the two-phase QA pipeline under load.
 *
 * Tests multi-URL scanning, Phase A to B handoff, concurrent workflow execution,
 * and status tracking. Uses mocks for simulator/WebKit layers.
 */

import { HybridQAEngine, HybridQAOptions, HybridQAResult } from '../../src/orchestration/hybrid-qa';
import { SimulatorPool } from '../../src/simulator/pool';
import { DEVICE_PRESETS } from '../../src/simulator/presets';

// ── Mock SimulatorManager ──

let mockBootCounter = 0;

jest.mock('../../src/simulator/manager', () => {
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      boot: jest.fn().mockImplementation(async (presetOrName: string) => {
        const udid = `hqa-mock-udid-${++mockBootCounter}`;
        return {
          udid,
          name: DEVICE_PRESETS[presetOrName]?.name ?? presetOrName,
          state: 'Booted',
        };
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      openUrl: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// ── Mock WebKitClient ──

let mockTargetIdCounter = 0;

jest.mock('../../src/webkit/client', () => {
  return {
    WebKitClient: jest.fn().mockImplementation(() => {
      const targetId = `hqa-target-${++mockTargetIdCounter}`;
      const knownTargets = new Set([targetId]);
      return {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(true),
        getHost: jest.fn().mockReturnValue('localhost'),
        getPort: jest.fn().mockReturnValue(9222),
        getActiveTargetId: jest.fn().mockReturnValue(targetId),
        getKnownTargets: jest.fn().mockReturnValue(knownTargets),
        listTargets: jest.fn().mockImplementation(async () => {
          // Return a fresh target for each call to simulate new tabs
          const newId = `hqa-target-${++mockTargetIdCounter}`;
          knownTargets.add(newId);
          return Array.from(knownTargets).map(id => ({
            id,
            url: 'https://example.com',
            webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${id}`,
          }));
        }),
        connectToUrl: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(undefined),
        navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 100 }),
        setCookies: jest.fn().mockResolvedValue(undefined),
        getCookies: jest.fn().mockResolvedValue([]),
        sendToTarget: jest.fn().mockImplementation(async (method: string) => {
          if (method === 'Runtime.evaluate') {
            return { result: { value: undefined }, wasThrown: false };
          }
          return {};
        }),
        enableDomainForTarget: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        once: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn(),
      };
    }),
  };
});

// ── Mock QA Detectors ──
// The HybridQAEngine dynamically imports detectors from ../qa/detectors/*.
// We mock the detector modules to return predictable results.

jest.mock('../../src/qa/detectors/touch-targets.js', () => ({
  detectTouchTargets: jest.fn().mockResolvedValue({
    detector: 'touch-targets',
    severity: 'medium',
    issues: [{ selector: 'button.small', problem: 'Touch target too small', fix: 'Increase size to 44px', element: '<button>' }],
    passed: false,
    totalScanned: 10,
    issueCount: 1,
  }),
}), { virtual: true });

jest.mock('../../src/qa/detectors/horizontal-overflow.js', () => ({
  detectHorizontalOverflow: jest.fn().mockResolvedValue({
    detector: 'horizontal-overflow',
    severity: 'high',
    issues: [{ selector: '.wide-div', problem: 'Causes horizontal scroll', fix: 'Add overflow:hidden', element: '<div>' }],
    passed: false,
    totalScanned: 5,
    issueCount: 1,
  }),
}), { virtual: true });

jest.mock('../../src/qa/detectors/safe-area.js', () => ({
  detectSafeArea: jest.fn().mockResolvedValue({
    detector: 'safe-area',
    severity: 'pass',
    issues: [],
    passed: true,
    totalScanned: 3,
    issueCount: 0,
  }),
}), { virtual: true });

// ── Test Suite ──

describe('HybridQA Pipeline Stress Tests', () => {
  let pool: SimulatorPool;
  let engine: HybridQAEngine;

  beforeEach(() => {
    mockBootCounter = 0;
    mockTargetIdCounter = 0;
    pool = new SimulatorPool({ max: 5, concurrency: 1 });
    pool.checkResources = async () => {};
    engine = new HybridQAEngine(pool);
  });

  afterEach(async () => {
    try { await pool.shutdownAll(); } catch { /* best-effort */ }
  });

  // ── Test 1: Multi-URL Pipeline ──

  test('should handle 3 URLs across 2 devices in Phase A', async () => {
    const options: HybridQAOptions = {
      urls: [
        'https://example.com/page-1',
        'https://example.com/page-2',
        'https://example.com/page-3',
      ],
      devices: ['iphone-17', 'ipad-pro'],
      detectors: ['touch-targets', 'horizontal-overflow'],
      skipPhaseB: true,
    };

    const result = await engine.start(options);

    // Should complete successfully
    expect(result.status).toBe('completed');

    // Should produce 3 URLs x 2 devices = 6 scans
    expect(result.phaseA.scans).toHaveLength(6);

    // Each scan should have the required fields
    for (const scan of result.phaseA.scans) {
      expect(scan.url).toBeTruthy();
      expect(scan.viewport).toBeDefined();
      expect(scan.viewport.preset).toBeTruthy();
      expect(scan.viewport.width).toBeGreaterThan(0);
      expect(scan.viewport.height).toBeGreaterThan(0);
      expect(scan.detectorResults).toBeDefined();
      expect(Array.isArray(scan.detectorResults)).toBe(true);
    }

    // Phase B should be skipped
    expect(result.phaseB).toBeUndefined();
    expect(result.peakMode).toBe('tabs-only');
  }, 30_000);

  // ── Test 2: Phase A to B Handoff ──

  test('should transfer flagged issues from Phase A to Phase B', async () => {
    const options: HybridQAOptions = {
      urls: ['https://example.com/buggy'],
      devices: ['iphone-17', 'ipad-pro'],
      detectors: ['touch-targets', 'horizontal-overflow'],
      deepVerifyThreshold: 'medium',
      // Do NOT skip Phase B — let it run
    };

    const result = await engine.start(options);

    expect(result.status).toBe('completed');

    // Phase A should detect issues (mocked detectors return issues)
    expect(result.phaseA.totalIssues).toBeGreaterThan(0);
    expect(result.phaseA.flaggedForVerification).toBeGreaterThan(0);

    // Phase B should have been triggered
    expect(result.phaseB).toBeDefined();
    expect(result.phaseB!.verified.length).toBeGreaterThan(0);

    // Each verified issue should have the required fields
    for (const v of result.phaseB!.verified) {
      expect(typeof v.confirmedOnDevice).toBe('boolean');
      expect(v.url).toBeDefined();
      expect(v.device).toBeDefined();
      expect(v.detector).toBeDefined();
      expect(v.severity).toBeDefined();
    }

    // Peak mode should indicate both phases ran
    expect(result.peakMode).toBe('tabs+sequential');

    // Confirmed + false positives should equal total verified
    expect(result.phaseB!.verified.length).toBe(
      result.phaseB!.confirmedCount + result.phaseB!.falsePositiveCount
    );
  }, 30_000);

  // ── Test 3: Multiple Concurrent Workflows ──

  test('should run two workflows with different IDs without collision', async () => {
    const options1: HybridQAOptions = {
      urls: ['https://example.com/workflow-1'],
      devices: ['iphone-17'],
      detectors: ['touch-targets'],
      skipPhaseB: true,
    };

    const options2: HybridQAOptions = {
      urls: ['https://example.com/workflow-2'],
      devices: ['ipad-pro'],
      detectors: ['horizontal-overflow'],
      skipPhaseB: true,
    };

    // Run sequentially (parallel would require separate pools)
    const result1 = await engine.start(options1);
    const result2 = await engine.start(options2);

    // Both should complete
    expect(result1.status).toBe('completed');
    expect(result2.status).toBe('completed');

    // IDs should be unique
    expect(result1.id).not.toBe(result2.id);
    expect(result1.id).toMatch(/^hqa-/);
    expect(result2.id).toMatch(/^hqa-/);

    // Each result should have its own scans
    expect(result1.phaseA.scans.length).toBeGreaterThan(0);
    expect(result2.phaseA.scans.length).toBeGreaterThan(0);

    // Verify no cross-contamination of URLs
    const urls1 = result1.phaseA.scans.map(s => s.url);
    const urls2 = result2.phaseA.scans.map(s => s.url);
    expect(urls1.every(u => u.includes('workflow-1'))).toBe(true);
    expect(urls2.every(u => u.includes('workflow-2'))).toBe(true);
  }, 60_000);

  // ── Test 4: Status Tracking During Execution ──

  test('should track workflow status via getStatus()', async () => {
    // Start a workflow
    const result = await engine.start({
      urls: ['https://example.com/status-test'],
      devices: ['iphone-17'],
      detectors: ['touch-targets'],
      skipPhaseB: true,
    });

    // After completion, getStatus should return the final state
    const status = engine.getStatus(result.id);
    expect(status).not.toBeNull();
    expect(status!.id).toBe(result.id);
    expect(status!.status).toBe('completed');
    expect(status!.totalIssues).toBe(result.phaseA.totalIssues);
    expect(status!.phasesCompleted).toBeGreaterThanOrEqual(1);
    expect(status!.elapsed).toBe(result.totalDuration);
  }, 30_000);

  // ── Test 5: getStatus for Unknown ID ──

  test('should return null for unknown workflow ID', () => {
    const status = engine.getStatus('hqa-nonexistent');
    expect(status).toBeNull();
  });

  // ── Test 6: getResults Retrieval ──

  test('should return full results via getResults()', async () => {
    const result = await engine.start({
      urls: ['https://example.com/results-test'],
      devices: ['iphone-17'],
      detectors: ['touch-targets'],
      skipPhaseB: true,
    });

    const retrieved = engine.getResults(result.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(result.id);
    expect(retrieved!.phaseA.scans).toEqual(result.phaseA.scans);
    expect(retrieved!.totalDuration).toBe(result.totalDuration);
  }, 30_000);

  // ── Test 7: Event Emission ──

  test('should emit lifecycle events during pipeline execution', async () => {
    const events: string[] = [];

    engine.on('hybrid:started', () => events.push('started'));
    engine.on('hybrid:phase-a', () => events.push('phase-a'));
    engine.on('hybrid:scan-complete', () => events.push('scan-complete'));
    engine.on('hybrid:phase-a-complete', () => events.push('phase-a-complete'));
    engine.on('hybrid:completed', () => events.push('completed'));

    await engine.start({
      urls: ['https://example.com/events-test'],
      devices: ['iphone-17'],
      detectors: ['touch-targets'],
      skipPhaseB: true,
    });

    expect(events).toContain('started');
    expect(events).toContain('phase-a');
    expect(events).toContain('phase-a-complete');
    expect(events).toContain('completed');

    // scan-complete should fire at least once (1 URL x 1 device)
    expect(events.filter(e => e === 'scan-complete').length).toBeGreaterThanOrEqual(1);

    // Events should be in order
    const startedIdx = events.indexOf('started');
    const phaseAIdx = events.indexOf('phase-a');
    const completedIdx = events.indexOf('completed');
    expect(startedIdx).toBeLessThan(phaseAIdx);
    expect(phaseAIdx).toBeLessThan(completedIdx);
  }, 30_000);

  // ── Test 8: Cross-Device QA Matrix ──

  test('should produce a complete URL x Device matrix', async () => {
    const urls = ['https://example.com/page-a', 'https://example.com/page-b'];
    const devices = ['iphone-17', 'ipad-pro', 'iphone-17-pro'];

    const result = await engine.start({
      urls,
      devices,
      detectors: ['touch-targets'],
      skipPhaseB: true,
    });

    expect(result.status).toBe('completed');
    // 2 URLs x 3 devices = 6 scans
    expect(result.phaseA.scans).toHaveLength(6);

    // Build and verify matrix
    const matrix: Record<string, Record<string, number>> = {};
    for (const scan of result.phaseA.scans) {
      if (!matrix[scan.url]) matrix[scan.url] = {};
      matrix[scan.url][scan.viewport.preset] = scan.issueCount;
    }

    expect(Object.keys(matrix)).toHaveLength(2);
    for (const url of urls) {
      expect(matrix[url]).toBeDefined();
      expect(Object.keys(matrix[url])).toHaveLength(3);
    }
  }, 30_000);

  // ── Test 9: Duration Tracking ──

  test('should track totalDuration and phaseA.duration', async () => {
    const result = await engine.start({
      urls: ['https://example.com/duration-test'],
      devices: ['iphone-17'],
      detectors: ['touch-targets'],
      skipPhaseB: true,
    });

    expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    expect(result.phaseA.duration).toBeGreaterThanOrEqual(0);
    expect(result.totalDuration).toBeGreaterThanOrEqual(result.phaseA.duration);
  }, 30_000);
});
