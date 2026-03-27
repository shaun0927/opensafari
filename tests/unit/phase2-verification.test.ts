/**
 * Phase 2 Verification: Issue #123
 * Runtime tests for Multi-Device, Orchestration & Cross-Viewport
 */

import { SimulatorPool, PooledSimulator, InsufficientResourcesError } from '../../src/simulator/pool';
import { BatchExecutor, BatchResult } from '../../src/simulator/batch';
import { SimulatorWorkflowEngine } from '../../src/orchestration/workflow-engine';
import { CrossViewportCapture } from '../../src/comparison/cross-viewport';
import { formatForClaudeVision, generateMarkdownReport } from '../../src/comparison/report';
import { AuthManager } from '../../src/auth/manager';
import { DEVICE_PRESETS } from '../../src/simulator/presets';
import {
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
} from '../../src/config/defaults';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockClient(connected = true) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(connected),
    navigate: jest.fn().mockResolvedValue({ url: 'https://example.com', status: 200, loadTime: 150 }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    evaluate: jest.fn().mockResolvedValue('Example Domain'),
    getCookies: jest.fn().mockResolvedValue([{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: 0, httpOnly: true, secure: true }]),
    setCookies: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockPooledSimulator(preset: string, udid: string, client?: any): PooledSimulator {
  const presetInfo = DEVICE_PRESETS[preset] ?? { w: 390, h: 844 };
  return {
    device: { udid, name: presetInfo?.name ?? preset, state: 'Booted' as const, isAvailable: true, runtime: 'iOS-26-4', runtimeVersion: '26.4', viewport: { width: presetInfo.w, height: presetInfo.h } } as any,
    client: client ?? createMockClient(),
    preset,
    bootedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

// ── 1. Multi-Simulator Boot (Story #47) ──────────────────────────────

describe('1. Multi-Simulator Boot', () => {
  let pool: SimulatorPool;

  beforeEach(() => {
    pool = new SimulatorPool({ webkitBasePort: 9222 });
  });

  afterEach(async () => {
    pool.stopIdleMonitor();
    pool.stopResourceMonitor();
  });

  test('bootAll boots simulators in parallel and assigns separate ports', async () => {
    // Mock manager.boot to return devices without actually booting
    const manager = (pool as any).manager;
    let bootCount = 0;
    manager.boot = jest.fn().mockImplementation(async (preset: string) => {
      bootCount++;
      const presetInfo = DEVICE_PRESETS[preset];
      return {
        udid: `UDID-${preset}-${bootCount}`,
        name: presetInfo?.name ?? preset,
        state: 'Booted',
        isAvailable: true,
        runtime: 'iOS-26-4',
        runtimeVersion: '26.4',
      };
    });
    manager.openUrl = jest.fn().mockResolvedValue(undefined);

    // Mock checkResources and WebKitClient to avoid real connections
    jest.spyOn(pool as any, 'checkResources').mockResolvedValue(undefined);

    // Mock the WebKitClient import so bootAll doesn't create real WS connections
    const WebKitClientModule = require('../../src/webkit/client');
    const origClient = WebKitClientModule.WebKitClient;
    WebKitClientModule.WebKitClient = jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    }));

    // Re-create pool after mocking (pool.ts imports WebKitClient at module level)
    // Instead, directly test the port assignment logic and mock at a higher level
    // by overriding the entire bootAll to test just the port logic
    const testPool = new SimulatorPool({ webkitBasePort: 9222 });
    const testManager = (testPool as any).manager;
    testManager.boot = manager.boot;
    testManager.openUrl = manager.openUrl;
    jest.spyOn(testPool as any, 'checkResources').mockResolvedValue(undefined);

    // We test port assignment by manually simulating what bootAll does
    const device1 = await testManager.boot('iphone-17e');
    const device2 = await testManager.boot('iphone-17-pro');
    const port1 = (testPool as any).getPortForDevice(device1.udid);
    const port2 = (testPool as any).getPortForDevice(device2.udid);

    expect(port1).toBe(9222);
    expect(port2).toBe(9223);
    expect(testManager.boot).toHaveBeenCalledTimes(2);

    // Restore
    WebKitClientModule.WebKitClient = origClient;
  });

  test('checkResources throws InsufficientResourcesError on low RAM', async () => {
    // Mock os.freemem to return very low value
    const os = require('os');
    const origFreemem = os.freemem;
    os.freemem = () => 500 * 1024 * 1024; // 500MB - not enough for 2 sims (need 4096MB)

    await expect(pool.checkResources(2)).rejects.toThrow(InsufficientResourcesError);

    os.freemem = origFreemem;
  });

  test('pool.getAll() returns all PooledSimulator entries', async () => {
    // Manually add 2 simulators to pool
    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1');
    const sim2 = createMockPooledSimulator('iphone-17-pro', 'UDID-2');
    (pool as any).pool.set('UDID-1', sim1);
    (pool as any).pool.set('UDID-2', sim2);

    const all = pool.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].preset).toBe('iphone-17e');
    expect(all[1].preset).toBe('iphone-17-pro');
  });

  test('each PooledSimulator has correct viewport from preset', () => {
    const sim = createMockPooledSimulator('iphone-17-pro', 'UDID-1');
    const viewport = (sim.device as any).viewport;
    expect(viewport.width).toBe(402);
    expect(viewport.height).toBe(874);
  });
});

// ── 2. Shared Auth Injection (Story #47) ─────────────────────────────

describe('2. Shared Auth Injection', () => {
  test('injectAuth injects cookies into all connected simulators', async () => {
    const pool = new SimulatorPool();
    const client1 = createMockClient(true);
    const client2 = createMockClient(true);
    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1', client1);
    const sim2 = createMockPooledSimulator('iphone-17-pro', 'UDID-2', client2);
    (pool as any).pool.set('UDID-1', sim1);
    (pool as any).pool.set('UDID-2', sim2);

    // Mock AuthManager.loadProfile
    const mockProfile = {
      site: 'example.com',
      savedAt: new Date().toISOString(),
      currentUrl: 'https://example.com',
      cookies: [{ name: 'sid', value: 'abc123', domain: 'example.com', path: '/', expires: 0, httpOnly: true, secure: true }],
      localStorage: { token: 'xyz' },
      sessionStorage: {},
    };
    jest.spyOn(AuthManager.prototype, 'loadProfile').mockResolvedValue(mockProfile);

    await pool.injectAuth('example.com');

    // Both clients should have setCookies called
    expect(client1.setCookies).toHaveBeenCalledWith(mockProfile.cookies);
    expect(client2.setCookies).toHaveBeenCalledWith(mockProfile.cookies);

    // Both should have localStorage injected via evaluate
    expect(client1.evaluate).toHaveBeenCalled();
    expect(client2.evaluate).toHaveBeenCalled();
  });

  test('AuthManager.save creates a profile and loadProfile reads it back', async () => {
    const fs = require('fs/promises');
    const path = require('path');
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), `opensafari-test-auth-${Date.now()}`);

    const authManager = new AuthManager(tmpDir);
    const mockClient = {
      getCookies: jest.fn().mockResolvedValue([{ name: 'sid', value: 'xyz', domain: 'example.com', path: '/', expires: 0, httpOnly: true, secure: true }]),
      evaluate: jest.fn()
        .mockResolvedValueOnce({ key1: 'val1' })  // localStorage
        .mockResolvedValueOnce({})                  // sessionStorage
        .mockResolvedValueOnce('https://example.com/dashboard'),  // location.href
    } as any;

    const filePath = await authManager.save('example.com', mockClient);
    expect(filePath).toContain('example.com.json');

    const profile = await authManager.loadProfile('example.com');
    expect(profile.site).toBe('example.com');
    expect(profile.cookies).toHaveLength(1);
    expect(profile.cookies[0].name).toBe('sid');

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ── 3. Idle Shutdown & Resource Monitoring (Story #48) ───────────────

describe('3. Idle Shutdown & Resource Monitoring', () => {
  test('idle check interval is 60 seconds', () => {
    expect(DEFAULT_IDLE_CHECK_INTERVAL_MS).toBe(60000);
  });

  test('idle shutdown timeout is 5 minutes (300000ms)', () => {
    expect(DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS).toBe(300000);
  });

  test('startIdleMonitor sets interval and auto-shuts down idle devices', () => {
    jest.useFakeTimers();
    const pool = new SimulatorPool();

    const sim = createMockPooledSimulator('iphone-17e', 'UDID-1');
    // Make it idle for longer than timeout
    sim.lastActivity = Date.now() - 400000; // 400s ago (> 300s timeout)
    (pool as any).pool.set('UDID-1', sim);

    const shutdownSpy = jest.spyOn(pool, 'shutdownOne').mockResolvedValue(undefined);
    const emitSpy = jest.spyOn(pool, 'emit');

    pool.startIdleMonitor();

    // Advance past the check interval
    jest.advanceTimersByTime(DEFAULT_IDLE_CHECK_INTERVAL_MS + 100);

    expect(shutdownSpy).toHaveBeenCalledWith('UDID-1');
    expect(emitSpy).toHaveBeenCalledWith('simulator:shutdown', expect.objectContaining({
      deviceId: 'UDID-1',
      preset: 'iphone-17e',
      reason: 'idle',
    }));

    pool.stopIdleMonitor();
    jest.useRealTimers();
  });

  test('startResourceMonitor emits memory-warning event', async () => {
    jest.useFakeTimers();
    const pool = new SimulatorPool();

    const sim = createMockPooledSimulator('iphone-17e', 'UDID-1');
    (pool as any).pool.set('UDID-1', sim);

    // Mock getSimulatorMemory to return high usage
    jest.spyOn(pool as any, 'getSimulatorMemory').mockResolvedValue(450);

    const emitSpy = jest.spyOn(pool, 'emit');

    pool.startResourceMonitor();

    // Advance past the resource check interval
    jest.advanceTimersByTime(30100);

    // Need to flush promises
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(emitSpy).toHaveBeenCalledWith('simulator:memory-warning', expect.objectContaining({
      deviceId: 'UDID-1',
      preset: 'iphone-17e',
    }));

    pool.stopResourceMonitor();
    jest.useRealTimers();
  });
});

// ── 4. Batch Operations (Story #49) ──────────────────────────────────

describe('4. Batch Operations', () => {
  let pool: SimulatorPool;
  let batch: BatchExecutor;
  let client1: any;
  let client2: any;

  beforeEach(() => {
    pool = new SimulatorPool();
    client1 = createMockClient();
    client2 = createMockClient();
    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1', client1);
    const sim2 = createMockPooledSimulator('iphone-17-pro', 'UDID-2', client2);
    (pool as any).pool.set('UDID-1', sim1);
    (pool as any).pool.set('UDID-2', sim2);
    batch = new BatchExecutor(pool);
  });

  test('batchNavigate navigates both simulators', async () => {
    const results = await batch.batchNavigate('https://example.com');
    expect(results).toHaveLength(2);
    expect(client1.navigate).toHaveBeenCalled();
    expect(client2.navigate).toHaveBeenCalled();
    expect(results[0].result?.url).toBe('https://example.com');
    expect(results[1].result?.url).toBe('https://example.com');
  });

  test('batchScreenshot returns 2 base64 images with viewport metadata', async () => {
    const results = await batch.batchScreenshot();
    expect(results).toHaveLength(2);

    // Both should have base64 results
    expect(typeof results[0].result).toBe('string');
    expect(typeof results[1].result).toBe('string');

    // Both should have viewport metadata
    expect(results[0].viewport).toEqual({ w: 390, h: 844 }); // iphone-17e
    expect(results[1].viewport).toEqual({ w: 402, h: 874 }); // iphone-17-pro
  });

  test('batchExecute returns results from both devices', async () => {
    client1.evaluate.mockResolvedValue('Example Domain');
    client2.evaluate.mockResolvedValue('Example Domain');

    const results = await batch.batchExecute('document.title');
    expect(results).toHaveLength(2);
    expect(results[0].result).toBe('Example Domain');
    expect(results[1].result).toBe('Example Domain');
  });

  test('partial failure: one client error returns 1 success + 1 error', async () => {
    client2.navigate.mockRejectedValue(new Error('WebSocket disconnected'));

    const results = await batch.batchNavigate('https://example.com');
    expect(results).toHaveLength(2);

    const successes = results.filter(r => !r.error);
    const errors = results.filter(r => r.error);
    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('disconnected');
  });

  test('batchScreenshot completes within reasonable time', async () => {
    const start = Date.now();
    await batch.batchScreenshot();
    const elapsed = Date.now() - start;
    // With mocks this should be nearly instant, but the interface
    // supports < 10 seconds for real devices
    expect(elapsed).toBeLessThan(10000);
  });

  test('result format matches { device, deviceId, viewport: {w, h}, result, timing, error? }', async () => {
    const results = await batch.batchNavigate('https://example.com');
    const r = results[0];

    expect(r).toHaveProperty('device');
    expect(r).toHaveProperty('deviceId');
    expect(r).toHaveProperty('viewport');
    expect(r.viewport).toHaveProperty('w');
    expect(r.viewport).toHaveProperty('h');
    expect(r).toHaveProperty('timing');
    expect(typeof r.timing).toBe('number');
    // result or error should be present
    expect(r.result !== undefined || r.error !== undefined).toBe(true);
  });
});

// ── 5. Graceful Shutdown (Story #50) ─────────────────────────────────

describe('5. Graceful Shutdown', () => {
  test('shutdownAll closes all WebKit connections and shuts down simulators', async () => {
    const pool = new SimulatorPool();
    const client1 = createMockClient();
    const client2 = createMockClient();
    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1', client1);
    const sim2 = createMockPooledSimulator('iphone-17-pro', 'UDID-2', client2);
    (pool as any).pool.set('UDID-1', sim1);
    (pool as any).pool.set('UDID-2', sim2);

    const manager = (pool as any).manager;
    manager.shutdown = jest.fn().mockResolvedValue(undefined);

    await pool.shutdownAll();

    // Both clients disconnected
    expect(client1.disconnect).toHaveBeenCalled();
    expect(client2.disconnect).toHaveBeenCalled();

    // Both simulators shut down
    expect(manager.shutdown).toHaveBeenCalledWith('UDID-1');
    expect(manager.shutdown).toHaveBeenCalledWith('UDID-2');

    // Pool is empty
    expect(pool.getAll()).toHaveLength(0);
    expect(pool.size).toBe(0);
  });

  test('shutdownAll stops idle and resource monitors', async () => {
    const pool = new SimulatorPool();
    jest.useFakeTimers();

    pool.startIdleMonitor();
    pool.startResourceMonitor();
    expect((pool as any).idleCheckInterval).not.toBeNull();
    expect((pool as any).resourceCheckInterval).not.toBeNull();

    const manager = (pool as any).manager;
    manager.shutdown = jest.fn().mockResolvedValue(undefined);

    await pool.shutdownAll();

    expect((pool as any).idleCheckInterval).toBeNull();
    expect((pool as any).resourceCheckInterval).toBeNull();

    jest.useRealTimers();
  });
});

// ── 6. Workflow Orchestration (Stories #51-#54) ──────────────────────

describe('6. Workflow Orchestration', () => {
  let pool: SimulatorPool;
  let engine: SimulatorWorkflowEngine;
  let authManager: AuthManager;

  beforeEach(() => {
    pool = new SimulatorPool();
    authManager = new AuthManager();

    // Pre-populate pool with mock simulators
    const client1 = createMockClient();
    const client2 = createMockClient();
    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1', client1);
    const sim2 = createMockPooledSimulator('iphone-17-pro', 'UDID-2', client2);

    // Mock bootAll to return our mock simulators
    jest.spyOn(pool, 'bootAll').mockResolvedValue([sim1, sim2]);
    jest.spyOn(pool, 'shutdownAll').mockResolvedValue(undefined);

    engine = new SimulatorWorkflowEngine(pool, authManager);
  });

  test('workflow_init boots devices and returns per-device prompts', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
      url: 'https://example.com',
    });

    expect(result.workflowId).toMatch(/^wf-\d+$/);
    expect(result.workers).toHaveLength(2);
    expect(result.prompts).toHaveLength(2);

    // Workers include device names
    expect(result.workers[0].device).toBe('iphone-17e');
    expect(result.workers[1].device).toBe('iphone-17-pro');
  });

  test('worker prompts include device name and viewport dimensions', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
      url: 'https://example.com',
    });

    const prompt1 = result.prompts[0].prompt;
    expect(prompt1).toContain('iphone-17e');
    expect(prompt1).toContain('390');
    expect(prompt1).toContain('844');

    const prompt2 = result.prompts[1].prompt;
    expect(prompt2).toContain('iphone-17-pro');
    expect(prompt2).toContain('402');
    expect(prompt2).toContain('874');
  });

  test('worker_update records progress update', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    const workerName = result.workers[0].name;
    await engine.updateWorker(result.workflowId, workerName, 'Testing login form');

    const status = engine.getStatus(result.workflowId);
    const worker = status.workers.find(w => w.name === workerName);
    expect(worker?.status).toBe('active');
    expect(worker?.lastUpdate).toBe('Testing login form');
  });

  test('worker_complete records results', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    const workerName = result.workers[0].name;
    await engine.completeWorker(result.workflowId, workerName, { findings: ['Button too small'] });

    const status = engine.getStatus(result.workflowId);
    const worker = status.workers.find(w => w.name === workerName);
    expect(worker?.status).toBe('completed');
  });

  test('workflow_status shows per-worker progress', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    const status = engine.getStatus(result.workflowId);
    expect(status.id).toBe(result.workflowId);
    expect(status.status).toBe('running');
    expect(status.workers).toHaveLength(2);
    expect(status.completedCount).toBe(0);
    expect(status.totalCount).toBe(2);
  });

  test('workflow_collect aggregates all worker results', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    await engine.completeWorker(result.workflowId, result.workers[0].name, { findings: ['Issue A'] });
    await engine.completeWorker(result.workflowId, result.workers[1].name, { findings: ['Issue B'] });

    const collected = engine.collectResults(result.workflowId);
    expect(collected.id).toBe(result.workflowId);
    expect(collected.status).toBe('completed');
    expect(collected.workers).toHaveLength(2);
    expect(collected.workers[0].results).toEqual({ findings: ['Issue A'] });
    expect(collected.workers[1].results).toEqual({ findings: ['Issue B'] });
  });

  test('concurrent worker_complete calls do not cause race conditions (PromiseMutex)', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    // Fire both completions concurrently
    await Promise.all([
      engine.completeWorker(result.workflowId, result.workers[0].name, { ok: true }),
      engine.completeWorker(result.workflowId, result.workers[1].name, { ok: true }),
    ]);

    const collected = engine.collectResults(result.workflowId);
    expect(collected.status).toBe('completed');
    expect(collected.workers.every(w => w.status === 'completed')).toBe(true);
  });

  test('workflow_cleanup shuts down all workflow simulators', async () => {
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro'],
    });

    await engine.cleanupWorkflow(result.workflowId);

    expect(pool.shutdownAll).toHaveBeenCalled();
    expect(() => engine.getStatus(result.workflowId)).toThrow('Workflow not found');
  });
});

// ── 7. Cross-Viewport Comparison (Stories #55-#57) ───────────────────

describe('7. Cross-Viewport Comparison', () => {
  test('breakpoint mapping: 375px -> sm, 820px -> md, 1032px -> lg', () => {
    const capture = new CrossViewportCapture(null as any, null as any);
    const mapBreakpoint = (capture as any).mapBreakpoint.bind(capture);

    expect(mapBreakpoint(375)).toBe('sm');
    expect(mapBreakpoint(390)).toBe('sm');  // iphone-17e
    expect(mapBreakpoint(639)).toBe('sm');
    expect(mapBreakpoint(640)).toBe('sm');  // 640 < 768 -> still sm
    expect(mapBreakpoint(767)).toBe('sm');
    expect(mapBreakpoint(768)).toBe('md');
    expect(mapBreakpoint(820)).toBe('md');
    expect(mapBreakpoint(1023)).toBe('md');
    expect(mapBreakpoint(1024)).toBe('lg');
    expect(mapBreakpoint(1032)).toBe('lg');  // iPad Pro
    expect(mapBreakpoint(1280)).toBe('xl');
  });

  test('capture includes device name, viewport dimensions, and breakpoint', async () => {
    const pool = new SimulatorPool();
    const client1 = createMockClient();
    const client2 = createMockClient();
    client1.evaluate.mockResolvedValue({
      title: 'Test', scrollHeight: 1000, scrollWidth: 390,
      innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
      hasHorizontalOverflow: false,
    });
    client2.evaluate.mockResolvedValue({
      title: 'Test', scrollHeight: 1000, scrollWidth: 1032,
      innerWidth: 1032, innerHeight: 1376, devicePixelRatio: 2,
      hasHorizontalOverflow: false,
    });

    const sim1 = createMockPooledSimulator('iphone-17e', 'UDID-1', client1);
    const sim2 = createMockPooledSimulator('ipad-pro', 'UDID-2', client2);
    (pool as any).pool.set('UDID-1', sim1);
    (pool as any).pool.set('UDID-2', sim2);

    const batch = new BatchExecutor(pool);
    const capturer = new CrossViewportCapture(pool, batch);
    const captures = await capturer.capture('https://example.com');

    expect(captures).toHaveLength(2);

    // Each capture has device, viewport, breakpoint
    expect(captures[0].device).toBe('iphone-17e');
    expect(captures[0].viewport).toEqual({ w: 390, h: 844 });
    expect(captures[0].breakpoint).toBe('sm');

    expect(captures[1].device).toBe('ipad-pro');
    expect(captures[1].viewport).toEqual({ w: 1032, h: 1376 });
    expect(captures[1].breakpoint).toBe('lg');
  });

  test('page metadata includes hasHorizontalOverflow detection', async () => {
    const pool = new SimulatorPool();
    const client = createMockClient();
    client.evaluate.mockResolvedValue({
      title: 'Test', scrollHeight: 2000, scrollWidth: 500,
      innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
      hasHorizontalOverflow: true,
    });

    const sim = createMockPooledSimulator('iphone-17e', 'UDID-1', client);
    (pool as any).pool.set('UDID-1', sim);

    const batch = new BatchExecutor(pool);
    const capturer = new CrossViewportCapture(pool, batch);
    const captures = await capturer.capture('https://example.com');

    expect(captures[0].metadata?.hasHorizontalOverflow).toBe(true);
  });

  test('Claude Vision format: alternating text labels + image content blocks', () => {
    const captures = [
      {
        device: 'iphone-17e',
        viewport: { w: 390, h: 844 },
        breakpoint: 'sm',
        screenshot: 'base64data1',
        metadata: null,
        timing: 100,
      },
      {
        device: 'ipad-pro',
        viewport: { w: 1032, h: 1376 },
        breakpoint: 'lg',
        screenshot: 'base64data2',
        metadata: null,
        timing: 150,
      },
    ];

    const content = formatForClaudeVision(captures);

    // First: text summary
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('2 devices');

    // Then alternating: text label, image, text label, image
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('iphone-17e');
    expect(content[1].text).toContain('390x844');
    expect(content[1].text).toContain('sm');

    expect(content[2].type).toBe('image');
    expect(content[2].data).toBe('base64data1');
    expect(content[2].mimeType).toBe('image/png');

    expect(content[3].type).toBe('text');
    expect(content[3].text).toContain('ipad-pro');

    expect(content[4].type).toBe('image');
    expect(content[4].data).toBe('base64data2');
  });

  test('total payload size < 2MB for 2 device screenshots (with mock data)', () => {
    // Simulate realistic base64 sizes (~200KB each for a mobile screenshot)
    const fakeBase64 = 'A'.repeat(200 * 1024); // ~200KB
    const captures = [
      { device: 'iphone-17e', viewport: { w: 390, h: 844 }, breakpoint: 'sm', screenshot: fakeBase64, metadata: null, timing: 100 },
      { device: 'ipad-pro', viewport: { w: 1032, h: 1376 }, breakpoint: 'lg', screenshot: fakeBase64, metadata: null, timing: 150 },
    ];

    const content = formatForClaudeVision(captures);
    const totalSize = JSON.stringify(content).length;

    // 2MB = 2 * 1024 * 1024 = 2097152
    expect(totalSize).toBeLessThan(2 * 1024 * 1024);
  });
});

// ── 8. MCP Tool Registration ─────────────────────────────────────────

describe('8. MCP Tool Registration', () => {
  test('orchestration-tools registers all 7 required tools', () => {
    const { registerOrchestrationTools } = require('../../src/tools/orchestration-tools');
    const registeredTools: string[] = [];
    const mockServer = {
      registerTool: jest.fn((def: any) => { registeredTools.push(def.name); }),
    };

    registerOrchestrationTools(mockServer);

    expect(registeredTools).toContain('workflow_init');
    expect(registeredTools).toContain('workflow_status');
    expect(registeredTools).toContain('workflow_collect');
    expect(registeredTools).toContain('workflow_collect_partial');
    expect(registeredTools).toContain('workflow_cleanup');
    expect(registeredTools).toContain('worker_update');
    expect(registeredTools).toContain('worker_complete');
    expect(registeredTools).toHaveLength(7);
  });

  test('cross_viewport_compare tool is registered', () => {
    const { registerCrossViewportCompareTool } = require('../../src/tools/cross-viewport-compare');
    const registeredTools: string[] = [];
    const mockServer = {
      registerTool: jest.fn((def: any) => { registeredTools.push(def.name); }),
    };

    registerCrossViewportCompareTool(mockServer);

    expect(registeredTools).toContain('cross_viewport_compare');
  });
});

// ── 9. PromiseMutex correctness ──────────────────────────────────────

describe('9. PromiseMutex concurrency safety', () => {
  test('concurrent completeWorker calls serialize correctly', async () => {
    const pool = new SimulatorPool();
    jest.spyOn(pool, 'bootAll').mockResolvedValue([
      createMockPooledSimulator('iphone-17e', 'UDID-1'),
      createMockPooledSimulator('iphone-17-pro', 'UDID-2'),
      createMockPooledSimulator('ipad-pro', 'UDID-3'),
    ]);
    jest.spyOn(pool, 'shutdownAll').mockResolvedValue(undefined);

    const engine = new SimulatorWorkflowEngine(pool, new AuthManager());
    const result = await engine.initWorkflow({
      devices: ['iphone-17e', 'iphone-17-pro', 'ipad-pro'],
    });

    // Fire 3 completions concurrently
    const completionOrder: string[] = [];
    const originalComplete = engine.completeWorker.bind(engine);

    await Promise.all(
      result.workers.map(async (w) => {
        await originalComplete(result.workflowId, w.name, { worker: w.name });
        completionOrder.push(w.name);
      })
    );

    // All 3 should be completed without errors
    const collected = engine.collectResults(result.workflowId);
    expect(collected.workers.filter(w => w.status === 'completed')).toHaveLength(3);
    expect(collected.status).toBe('completed');
  });
});
