/**
 * HybridQA Pipeline Tests (Issue #320)
 * Tests for HybridQAEngine.start() pipeline, selectHostDevice(), and runDetectors().
 */

import { HybridQAEngine } from '../../src/orchestration/hybrid-qa';
import { SimulatorPool } from '../../src/simulator/pool';
import { BrowserBackend } from '../../src/types/browser-backend';
import { DetectorResult } from '../../src/qa/types';

// ── Module Mocks ──

jest.mock('../../src/simulator/manager', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    boot: jest.fn().mockResolvedValue({
      udid: 'mock-udid', name: 'Mock', state: 'Booted',
      isAvailable: true, runtime: 'iOS-18-0', runtimeVersion: '18.0',
    }),
    shutdown: jest.fn().mockResolvedValue(undefined),
    openUrl: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/webkit/client', () => ({
  WebKitClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    on: jest.fn(),
    removeListener: jest.fn(),
  })),
}));

jest.mock('../../src/reliability/zombie-cleanup', () => ({
  registerManagedDevices: jest.fn(),
  unregisterManagedDevices: jest.fn(),
}));

const mockOpenTab = jest.fn();
const mockCloseAll = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/simulator/tab-pool', () => ({
  TabPool: jest.fn().mockImplementation(() => ({
    openTab: mockOpenTab,
    closeAll: mockCloseAll,
  })),
}));

// ── Helpers ──

function createMockClient(): BrowserBackend {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 0 }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('png')),
    evaluate: jest.fn().mockResolvedValue(undefined),
    readPage: jest.fn().mockResolvedValue('<html></html>'),
    getCookies: jest.fn().mockResolvedValue([]),
    setCookies: jest.fn().mockResolvedValue(undefined),
    clearCookies: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    type: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn().mockResolvedValue(undefined),
    longPress: jest.fn().mockResolvedValue(undefined),
    swipe: jest.fn().mockResolvedValue(undefined),
    press: jest.fn().mockResolvedValue(undefined),
    dismissKeyboard: jest.fn().mockResolvedValue(undefined),
    selectOption: jest.fn().mockResolvedValue(undefined),
    querySelector: jest.fn().mockResolvedValue(null),
    querySelectorAll: jest.fn().mockResolvedValue([]),
    inspect: jest.fn().mockResolvedValue({}),
    waitFor: jest.fn().mockResolvedValue(undefined),
    onConsole: jest.fn(),
    onRequest: jest.fn(),
    onResponse: jest.fn(),
  } as unknown as BrowserBackend;
}

function highSeverityResult(detector: string): DetectorResult {
  return {
    detector,
    severity: 'high',
    issues: [{ selector: 'div.test', problem: 'test issue', fix: 'fix it' }],
    passed: false,
    totalScanned: 5,
    issueCount: 1,
  };
}

function passResult(detector: string): DetectorResult {
  return {
    detector,
    severity: 'pass',
    issues: [],
    passed: true,
    totalScanned: 5,
    issueCount: 0,
  };
}

// ── HybridQAEngine.start() Pipeline ──

describe('HybridQAEngine.start() Pipeline', () => {
  let mockPool: SimulatorPool;
  let mockTabClient: BrowserBackend;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTabClient = createMockClient();
    mockPool = new SimulatorPool();

    mockPool.bootAll = jest.fn().mockResolvedValue([{
      device: { udid: 'mock-udid', name: 'iPhone 17', state: 'Booted', isAvailable: true, runtime: 'iOS-18-0', runtimeVersion: '18.0' },
      client: { isConnected: () => true } as any,
      preset: 'iphone-17',
      bootedAt: Date.now(),
      lastActivity: Date.now(),
    }]);
    mockPool.shutdownAll = jest.fn().mockResolvedValue(undefined);
    mockPool.injectAuth = jest.fn().mockResolvedValue(undefined);
    mockPool.bootSequential = jest.fn().mockResolvedValue([]);
    mockPool.setTempAuth = jest.fn();
    mockPool.clearTempAuth = jest.fn();
    mockPool.saveTempAuth = jest.fn().mockResolvedValue(undefined);
    mockPool.restoreTempAuth = jest.fn().mockResolvedValue(true);

    mockOpenTab.mockResolvedValue(mockTabClient);
  });

  it('should create scans for each URL × device combination', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([passResult('auto-zoom')]);

    const result = await engine.start({
      urls: ['https://a.com', 'https://b.com'],
      devices: ['iphone-17', 'ipad-pro'],
    });

    // 2 URLs × 2 devices = 4 scans
    expect(result.phaseA.scans).toHaveLength(4);
    expect(result.status).toBe('completed');
  });

  it('Phase A error: bootAll throws → status error and error message set', async () => {
    mockPool.bootAll = jest.fn().mockRejectedValue(new Error('Simulator boot failed'));
    const engine = new HybridQAEngine(mockPool);

    const result = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Phase A failed');
    expect(result.error).toContain('Simulator boot failed');
  });

  it('Phase A issues found: high severity detector → flaggedForVerification > 0', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([highSeverityResult('touch-targets')]);

    const result = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
    });

    expect(result.phaseA.flaggedForVerification).toBeGreaterThan(0);
    expect(result.phaseA.totalIssues).toBeGreaterThan(0);
  });

  it('Phase B trigger: issues above threshold → bootSequential called with flagged devices', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([highSeverityResult('touch-targets')]);

    mockPool.bootSequential = jest.fn().mockImplementation(async (presets: string[]) => {
      return presets.map((p: string) => ({ preset: p, status: 'completed', duration: 100 }));
    });

    const result = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      deepVerifyThreshold: 'medium',
    });

    expect(mockPool.bootSequential).toHaveBeenCalled();
    const calledPresets = (mockPool.bootSequential as jest.Mock).mock.calls[0][0];
    expect(calledPresets).toContain('iphone-17');
    expect(result.peakMode).toBe('tabs+sequential');
  });

  it('Phase B skip: skipPhaseB true → phaseB is undefined', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([highSeverityResult('touch-targets')]);

    const result = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      skipPhaseB: true,
    });

    expect(result.phaseB).toBeUndefined();
    expect(result.phaseA.flaggedForVerification).toBeGreaterThan(0);
  });

  it('Phase B skip: no issues above threshold → phaseB is undefined', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([passResult('auto-zoom')]);

    const result = await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
    });

    expect(result.phaseA.flaggedForVerification).toBe(0);
    expect(result.phaseB).toBeUndefined();
  });

  it('Auth injection: authProfile set → injectAuth called', async () => {
    const engine = new HybridQAEngine(mockPool);
    jest.spyOn(engine as any, 'runDetectors').mockResolvedValue([passResult('auto-zoom')]);

    await engine.start({
      urls: ['https://example.com'],
      devices: ['iphone-17'],
      authProfile: 'my-auth',
      skipPhaseB: true,
    });

    expect(mockPool.injectAuth).toHaveBeenCalledWith('my-auth');
  });
});

// ── selectHostDevice() ──

describe('selectHostDevice()', () => {
  let engine: HybridQAEngine;

  beforeEach(() => {
    const mockPool = new SimulatorPool();
    engine = new HybridQAEngine(mockPool);
  });

  it('should return largest viewport: ipad-pro from [iphone-se, ipad-pro, iphone-17]', () => {
    const result = (engine as any).selectHostDevice(['iphone-se', 'ipad-pro', 'iphone-17']);
    expect(result).toBe('ipad-pro');
  });

  it('should return single device when only one provided', () => {
    const result = (engine as any).selectHostDevice(['iphone-17']);
    expect(result).toBe('iphone-17');
  });

  it('should return first device as fallback for unknown presets', () => {
    const result = (engine as any).selectHostDevice(['unknown-device', 'also-unknown']);
    expect(result).toBe('unknown-device');
  });
});

// ── runDetectors() Dynamic Import ──

describe('runDetectors() Dynamic Import', () => {
  let engine: HybridQAEngine;
  let mockClient: BrowserBackend;

  beforeEach(() => {
    const mockPool = new SimulatorPool();
    engine = new HybridQAEngine(mockPool);
    mockClient = createMockClient();
  });

  it('should return DetectorResult for valid detector', async () => {
    // Mock evaluate to return a proper DetectorResult
    (mockClient.evaluate as jest.Mock).mockResolvedValue({
      detector: 'auto-zoom',
      severity: 'pass',
      issues: [],
      passed: true,
      totalScanned: 3,
      issueCount: 0,
    });

    const results = await (engine as any).runDetectors(mockClient, ['auto-zoom']);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('detector');
    expect(results[0]).toHaveProperty('severity');
  });

  it('should return error result for invalid detector name', async () => {
    const results = await (engine as any).runDetectors(mockClient, ['nonexistent-detector-xyz']);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('error');
    expect(results[0].detector).toBe('nonexistent-detector-xyz');
    expect(results[0].error).toContain('Failed to run nonexistent-detector-xyz');
  });

  it('should return empty array for empty detector list', async () => {
    const results = await (engine as any).runDetectors(mockClient, []);
    expect(results).toEqual([]);
  });
});
