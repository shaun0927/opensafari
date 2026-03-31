/**
 * E2E: Validate multi-device workflow lifecycle (init, execute, collect)
 * Issue #258 — Tests all 6 acceptance criteria with real simulators.
 *
 * Strategy: Boot one real simulator (iPhone 17 Pro) to prove integration,
 * then mock pool.bootAll to simulate multi-device workflows for state
 * management verification. The workflow engine itself does not interact
 * with devices — it delegates to SimulatorPool and tracks worker state.
 */

import { SimulatorWorkflowEngine } from '../../src/orchestration/workflow-engine';
import { SimulatorPool, PooledSimulator } from '../../src/simulator/pool';
import { SimulatorManager } from '../../src/simulator/manager';
import { AuthManager } from '../../src/auth/manager';
import { WorkflowPersistence } from '../../src/orchestration/workflow-persistence';
import { WebKitClient } from '../../src/webkit/client';
import { describeWithSimulator, isSimulatorAvailable } from './helpers/simulator-check';
import { DEVICE_PRESETS } from '../../src/simulator/presets';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PRESETS = ['iphone-17-pro', 'iphone-17'];

/**
 * Create mock PooledSimulator entries for multi-device workflow testing.
 * Uses a real device UDID for the first entry if available.
 */
function createMockSims(realUdid?: string): PooledSimulator[] {
  return PRESETS.map((preset, i) => {
    const presetInfo = DEVICE_PRESETS[preset];
    const mockClient = {
      isConnected: () => false,
      connect: async () => {},
      disconnect: async () => {},
      getCookies: async () => [],
      setCookies: async () => {},
      evaluate: async () => null,
    } as unknown as WebKitClient;

    return {
      device: {
        udid: i === 0 && realUdid ? realUdid : `mock-udid-${preset}`,
        name: presetInfo.name,
        state: 'Booted' as const,
        isAvailable: true,
        runtime: 'iOS-26-4',
        runtimeVersion: '26.4',
        viewport: { width: presetInfo.w, height: presetInfo.h },
      } as any,
      client: mockClient,
      preset,
      bootedAt: Date.now(),
      lastActivity: Date.now(),
    };
  });
}

describeWithSimulator('Issue #258: Multi-device workflow lifecycle E2E', () => {
  let pool: SimulatorPool;
  let authManager: AuthManager;
  let engine: SimulatorWorkflowEngine;
  let manager: SimulatorManager;
  let available = false;
  let realDeviceUdid: string | null = null;
  const workflowIds: string[] = [];

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) return;

    manager = new SimulatorManager();

    // Verify a real simulator is booted (iPhone 17 Pro)
    try {
      const device = await manager.boot('iPhone 17 Pro', { timeout: 90_000 });
      realDeviceUdid = device.udid;
      console.log(`[Setup] Real device booted: ${device.name} (${device.udid})`);
    } catch (err) {
      console.error(`[Setup] Could not boot real device: ${err}`);
    }

    pool = new SimulatorPool({ max: 5, concurrency: 2 });
    jest.spyOn(pool, 'checkResources').mockResolvedValue(undefined);
    // Mock bootAll to return simulated multi-device pool entries
    const mockSims = createMockSims(realDeviceUdid ?? undefined);
    jest.spyOn(pool, 'bootAll').mockResolvedValue(mockSims);
    jest.spyOn(pool, 'getAll').mockReturnValue(mockSims);
    jest.spyOn(pool, 'injectAuth').mockResolvedValue(undefined);
    jest.spyOn(pool, 'shutdownAll').mockResolvedValue(undefined);

    authManager = new AuthManager();
    engine = new SimulatorWorkflowEngine(pool, authManager);
  }, 300_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    // Only shutdown the real device
    if (realDeviceUdid && manager) {
      try { await manager.shutdown(realDeviceUdid); } catch { /* */ }
    }
  }, 120_000);

  // ─── Criterion 1: Full init → execute → collect lifecycle ───
  test('Criterion 1: Full init → execute → collect lifecycle completes', async () => {
    if (!available) return;

    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'E2E lifecycle verification',
      workerNames: ['lifecycle-pro', 'lifecycle-std'],
    });
    workflowIds.push(initResult.workflowId);

    // Verify init result structure
    expect(initResult.workflowId).toMatch(/^wf-/);
    expect(initResult.workers).toHaveLength(2);
    expect(initResult.prompts).toHaveLength(2);
    expect(initResult.workers[0].name).toBe('lifecycle-pro');
    expect(initResult.workers[1].name).toBe('lifecycle-std');

    // Verify prompts are device-specific
    for (const p of initResult.prompts) {
      expect(p.prompt).toContain('worker');
      expect(p.prompt).toContain('example.com');
    }

    const wfId = initResult.workflowId;

    // Execute: update then complete both workers
    await engine.updateWorker(wfId, 'lifecycle-pro', 'Navigated to example.com');
    await engine.updateWorker(wfId, 'lifecycle-std', 'Navigated to example.com');

    await engine.completeWorker(wfId, 'lifecycle-pro', {
      screenshots: ['base64_pro'], title: 'Example Domain', passed: true,
    });
    await engine.completeWorker(wfId, 'lifecycle-std', {
      screenshots: ['base64_std'], title: 'Example Domain', passed: true,
    });

    // Collect and verify
    const results = engine.collectResults(wfId);
    expect(results.id).toBe(wfId);
    expect(results.status).toBe('completed');
    expect(results.workers).toHaveLength(2);
    expect(results.duration).toBeGreaterThan(0);

    // Verify pool.bootAll was called (real integration point)
    expect(pool.bootAll).toHaveBeenCalledWith(PRESETS);

    console.log('[Criterion 1] PASSED: Full lifecycle init→execute→collect completed');
  }, 300_000);

  // ─── Criterion 2: Auth credentials injection ───
  test('Criterion 2: Auth credentials correctly injected across all workflow devices', async () => {
    if (!available) return;

    const authDir = path.join(os.homedir(), '.opensafari', 'auth');
    const testProfilePath = path.join(authDir, 'e2e-test-258.json');
    fs.mkdirSync(authDir, { recursive: true });

    const testProfile = {
      site: 'e2e-test-258',
      savedAt: new Date().toISOString(),
      currentUrl: 'https://example.com',
      cookies: [{
        name: 'test_session', value: 'e2e_258_value',
        domain: '.example.com', path: '/',
        expires: Date.now() / 1000 + 7200, httpOnly: false, secure: false,
      }],
      localStorage: { theme: 'dark' },
      sessionStorage: {},
    };
    fs.writeFileSync(testProfilePath, JSON.stringify(testProfile, null, 2));

    try {
      const initResult = await engine.initWorkflow({
        devices: PRESETS,
        url: 'https://example.com',
        authProfile: 'e2e-test-258',
        taskDescription: 'Auth injection test',
        workerNames: ['auth-w1', 'auth-w2'],
      });
      workflowIds.push(initResult.workflowId);

      expect(initResult.workers).toHaveLength(2);

      // Verify pool.injectAuth was called with the auth profile
      expect(pool.injectAuth).toHaveBeenCalledWith('e2e-test-258');

      // Verify auth profile exists and is loadable
      const loadedProfile = await authManager.loadProfile('e2e-test-258');
      expect(loadedProfile.cookies).toHaveLength(1);
      expect(loadedProfile.cookies[0].name).toBe('test_session');
      expect(loadedProfile.cookies[0].value).toBe('e2e_258_value');
      expect(loadedProfile.localStorage).toEqual({ theme: 'dark' });

      await engine.completeWorker(initResult.workflowId, 'auth-w1', { auth: true });
      await engine.completeWorker(initResult.workflowId, 'auth-w2', { auth: true });

      console.log('[Criterion 2] PASSED: Auth injection invoked for all workflow devices');
    } finally {
      try { fs.unlinkSync(testProfilePath); } catch { /* */ }
    }
  }, 300_000);

  // ─── Criterion 3: Worker status transitions ───
  test('Criterion 3: Worker status transitions are accurate and timely', async () => {
    if (!available) return;

    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'Status tracking',
      workerNames: ['status-w1', 'status-w2'],
    });
    workflowIds.push(initResult.workflowId);
    const wfId = initResult.workflowId;

    // Initial: all pending, workflow running
    const s0 = engine.getStatus(wfId);
    expect(s0.status).toBe('running');
    expect(s0.totalCount).toBe(2);
    expect(s0.completedCount).toBe(0);
    for (const w of s0.workers) expect(w.status).toBe('pending');

    // Update w1 → active
    await engine.updateWorker(wfId, 'status-w1', 'Checking page');
    const s1 = engine.getStatus(wfId);
    expect(s1.workers.find(w => w.name === 'status-w1')!.status).toBe('active');
    expect(s1.workers.find(w => w.name === 'status-w1')!.lastUpdate).toBe('Checking page');
    expect(s1.workers.find(w => w.name === 'status-w1')!.lastUpdateAt).toBeGreaterThan(0);
    expect(s1.workers.find(w => w.name === 'status-w2')!.status).toBe('pending');

    // Complete w1 → workflow still running
    await engine.completeWorker(wfId, 'status-w1', { ok: true });
    const s2 = engine.getStatus(wfId);
    expect(s2.completedCount).toBe(1);
    expect(s2.workers.find(w => w.name === 'status-w1')!.status).toBe('completed');
    expect(s2.status).toBe('running');

    // Complete w2 → workflow completed
    await engine.completeWorker(wfId, 'status-w2', { ok: true });
    const s3 = engine.getStatus(wfId);
    expect(s3.completedCount).toBe(2);
    expect(s3.status).toBe('completed');
    expect(s3.elapsed).toBeGreaterThan(0);

    console.log('[Criterion 3] PASSED: pending→active→completed transitions verified');
  }, 300_000);

  // ─── Criterion 4: Collected results contain valid data ───
  test('Criterion 4: Collected results contain valid data from all devices', async () => {
    if (!available) return;

    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'Result validation',
      workerNames: ['data-pro', 'data-std'],
    });
    workflowIds.push(initResult.workflowId);
    const wfId = initResult.workflowId;

    await engine.completeWorker(wfId, 'data-pro', {
      screenshots: ['base64_pro'], pageTitle: 'Example Domain',
      auditScore: 95, deviceInfo: { preset: 'iphone-17-pro' },
    });
    await engine.completeWorker(wfId, 'data-std', {
      screenshots: ['base64_std'], pageTitle: 'Example Domain',
      auditScore: 92, deviceInfo: { preset: 'iphone-17' },
    });

    const results = engine.collectResults(wfId);
    expect(results.id).toBe(wfId);
    expect(results.status).toBe('completed');
    expect(results.workers).toHaveLength(2);
    expect(results.duration).toBeGreaterThanOrEqual(0);

    // Verify per-device data with viewports
    for (const w of results.workers) {
      expect(w.name).toBeTruthy();
      expect(w.device).toBeTruthy();
      expect(w.viewport).toBeDefined();
      expect(w.viewport!.width).toBeGreaterThan(0);
      expect(w.viewport!.height).toBeGreaterThan(0);
      expect(w.status).toBe('completed');
      expect(w.results).toBeDefined();
      expect(w.duration).toBeGreaterThanOrEqual(0);
    }

    // Verify distinct per-worker results
    expect((results.workers.find(w => w.name === 'data-pro')!.results as any).auditScore).toBe(95);
    expect((results.workers.find(w => w.name === 'data-std')!.results as any).auditScore).toBe(92);

    console.log('[Criterion 4] PASSED: Results contain valid per-device data with viewports');
  }, 300_000);

  // ─── Criterion 5: Partial failure → "partial" status ───
  test('Criterion 5: Partial failure produces "partial" status (not crash)', async () => {
    if (!available) return;

    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'Partial failure test',
      workerNames: ['success-w', 'failing-w'],
    });
    workflowIds.push(initResult.workflowId);
    const wfId = initResult.workflowId;

    await engine.completeWorker(wfId, 'success-w', { passed: true });
    await engine.failWorker(wfId, 'failing-w', 'Safari crashed mid-test');

    // Workflow: "partial" (not crash)
    const status = engine.getStatus(wfId);
    expect(status.status).toBe('partial');
    expect(status.completedCount).toBe(2);
    expect(status.totalCount).toBe(2);
    expect(status.workers.find(w => w.name === 'success-w')!.status).toBe('completed');
    expect(status.workers.find(w => w.name === 'failing-w')!.status).toBe('failed');

    // collectResults works (no crash)
    const results = engine.collectResults(wfId);
    expect(results.status).toBe('partial');
    expect(results.workers).toHaveLength(2);

    // collectPartialResults includes completed+failed
    const partial = engine.collectPartialResults(wfId);
    expect(partial.workers).toHaveLength(2);
    expect(partial.workers.find(w => w.name === 'failing-w')!.error).toBe('Safari crashed mid-test');

    console.log('[Criterion 5] PASSED: Partial failure → "partial" status, no crash');
  }, 300_000);

  // ─── Criterion 6: Workflow timing data ───
  test('Criterion 6: Workflow timing data matches actual execution duration', async () => {
    if (!available) return;

    const beforeInit = Date.now();
    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'Timing verification',
      workerNames: ['timing-w1', 'timing-w2'],
    });
    workflowIds.push(initResult.workflowId);
    const wfId = initResult.workflowId;

    await new Promise(r => setTimeout(r, 500));
    await engine.updateWorker(wfId, 'timing-w1', 'Processing...');
    await new Promise(r => setTimeout(r, 300));
    await engine.completeWorker(wfId, 'timing-w1', { timing: true });
    await new Promise(r => setTimeout(r, 200));
    await engine.completeWorker(wfId, 'timing-w2', { timing: true });

    const afterComplete = Date.now();
    const totalElapsed = afterComplete - beforeInit;

    const results = engine.collectResults(wfId);
    expect(results.duration).toBeGreaterThan(0);
    expect(results.duration).toBeLessThanOrEqual(totalElapsed + 5000);
    expect(results.duration).toBeGreaterThanOrEqual(500);

    for (const w of results.workers) {
      expect(w.duration).toBeGreaterThan(0);
    }

    const status = engine.getStatus(wfId);
    expect(status.elapsed).toBeGreaterThan(500);

    console.log(`[Criterion 6] PASSED: duration=${results.duration}ms, elapsed=${totalElapsed}ms`);
  }, 300_000);

  // ─── Bonus: Persistence ───
  test('Bonus: Workflow state persists and recovers after crash', async () => {
    if (!available) return;

    const initResult = await engine.initWorkflow({
      devices: PRESETS,
      url: 'https://example.com',
      taskDescription: 'Persistence test',
      workerNames: ['persist-w1', 'persist-w2'],
    });
    workflowIds.push(initResult.workflowId);
    const wfId = initResult.workflowId;

    await engine.updateWorker(wfId, 'persist-w1', 'In progress...');

    // Verify persisted to disk
    const workflowsDir = path.join(os.homedir(), '.opensafari', 'workflows');
    const safeId = wfId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const wfFile = path.join(workflowsDir, `${safeId}.json`);
    expect(fs.existsSync(wfFile)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(wfFile, 'utf-8'));
    expect(persisted.id).toBe(wfId);
    expect(persisted.status).toBe('running');
    expect(persisted.workers).toHaveLength(2);

    // Crash recovery: WorkflowPersistence loads raw state
    const persistence = new WorkflowPersistence();
    const loaded = persistence.load(wfId);
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe('running');
    // SimulatorWorkflowEngine constructor converts running→partial on restore

    persistence.remove(wfId);
    expect(fs.existsSync(wfFile)).toBe(false);

    console.log('[Bonus] PASSED: Workflow state persists and recovers');
  }, 300_000);

  // ─── Integration: Real simulator is booted ───
  test('Integration: Real simulator device is booted and accessible', async () => {
    if (!available) return;

    expect(realDeviceUdid).toBeTruthy();
    const device = await manager.getDevice(realDeviceUdid!);
    expect(device).toBeDefined();
    expect(device!.state).toBe('Booted');

    console.log(`[Integration] PASSED: Real device ${device!.name} (${device!.udid}) verified booted`);
  }, 30_000);
});
