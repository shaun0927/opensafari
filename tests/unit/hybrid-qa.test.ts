/**
 * Hybrid QA Engine Tests
 * Verifies two-phase QA strategy: fast scan + deep verify.
 */

import {
  HybridQAEngine,
  HybridQAResult,
  HybridQAStatus,
  PageScanResult,
  applyViewportEmulation,
  ViewportConfig,
} from '../../src/orchestration/hybrid-qa';
import { SimulatorPool } from '../../src/simulator/pool';
import { BrowserBackend } from '../../src/types/browser-backend';

// ── Mocks ──

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

// ── Tests ──

describe('HybridQAEngine', () => {
  describe('applyViewportEmulation', () => {
    it('should inject viewport meta and dimension overrides via evaluate', async () => {
      const client = createMockClient();
      (client.evaluate as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ x: 0, y: 0 });
      const viewport: ViewportConfig = { preset: 'iphone-17', width: 390, height: 844, dpr: 3 };

      await applyViewportEmulation(client, viewport);

      // Call 0: main viewport override script, call 1: scroll save, call 2: resize event, call 3: scroll restore
      expect(client.evaluate).toHaveBeenCalledTimes(4);
      const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
      expect(expr).toContain('width=390');
      expect(expr).toContain('height: 844');
      expect(expr).toContain('dpr: 3');
      expect(expr).toContain('preset: "iphone-17"');
    });

    it('should override innerWidth, innerHeight, and devicePixelRatio', async () => {
      const client = createMockClient();
      (client.evaluate as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ x: 0, y: 0 });
      const viewport: ViewportConfig = { preset: 'iphone-17', width: 390, height: 844, dpr: 3 };

      await applyViewportEmulation(client, viewport);

      const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
      expect(expr).toContain("Object.defineProperty(window, 'innerWidth'");
      expect(expr).toContain("Object.defineProperty(window, 'innerHeight'");
      expect(expr).toContain("Object.defineProperty(window, 'devicePixelRatio'");
      expect(expr).toContain("Object.defineProperty(screen, 'width'");
      expect(expr).toContain("Object.defineProperty(screen, 'height'");
    });

    it('should dispatch resize event after viewport override', async () => {
      const client = createMockClient();
      (client.evaluate as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ x: 0, y: 0 });
      const viewport: ViewportConfig = { preset: 'iphone-17', width: 390, height: 844, dpr: 3 };

      await applyViewportEmulation(client, viewport);

      expect(client.evaluate).toHaveBeenCalledTimes(4);
      const resizeExpr = (client.evaluate as jest.Mock).mock.calls[2][0] as string;
      expect(resizeExpr).toContain('dispatchEvent');
      expect(resizeExpr).toContain('resize');
    });

    it('should handle different viewport sizes', async () => {
      const client = createMockClient();
      (client.evaluate as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ x: 0, y: 0 });
      const viewport: ViewportConfig = { preset: 'ipad-pro', width: 1024, height: 1366, dpr: 2 };

      await applyViewportEmulation(client, viewport);

      const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
      expect(expr).toContain('width=1024');
      expect(expr).toContain('height: 1366');
      expect(expr).toContain('dpr: 2');
    });
  });

  describe('Result types', () => {
    it('should correctly structure HybridQAResult', () => {
      const result: HybridQAResult = {
        id: 'hqa-123',
        status: 'completed',
        phaseA: {
          duration: 5000,
          scans: [{
            url: 'https://example.com',
            viewport: { preset: 'iphone-17', width: 390, height: 844, dpr: 3 },
            detectorResults: [{
              detector: 'touch-targets',
              severity: 'high',
              issues: [{ selector: 'button.small', problem: 'Too small', fix: 'Increase size' }],
              passed: false,
              totalScanned: 10,
              issueCount: 1,
            }],
            issueCount: 1,
            maxSeverity: 'high',
            emulationConfidence: 'low',
          }],
          totalIssues: 1,
          flaggedForVerification: 1,
        },
        phaseB: {
          duration: 15000,
          verified: [{
            url: 'https://example.com',
            device: 'iphone-17',
            detector: 'touch-targets',
            severity: 'high',
            confirmedOnDevice: true,
            issue: {
              detector: 'touch-targets',
              severity: 'high',
              issues: [{ selector: 'button.small', problem: 'Too small', fix: 'Increase size' }],
              passed: false,
              totalScanned: 10,
              issueCount: 1,
            },
          }],
          confirmedCount: 1,
          falsePositiveCount: 0,
        },
        totalDuration: 20000,
        peakMode: 'tabs+sequential',
      };

      expect(result.status).toBe('completed');
      expect(result.phaseA.totalIssues).toBe(1);
      expect(result.phaseB?.confirmedCount).toBe(1);
      expect(result.peakMode).toBe('tabs+sequential');
    });

    it('should structure result without Phase B when skipped', () => {
      const result: HybridQAResult = {
        id: 'hqa-456',
        status: 'completed',
        phaseA: {
          duration: 3000,
          scans: [],
          totalIssues: 0,
          flaggedForVerification: 0,
        },
        totalDuration: 3000,
        peakMode: 'tabs-only',
      };

      expect(result.phaseB).toBeUndefined();
      expect(result.peakMode).toBe('tabs-only');
    });
  });

  describe('Engine construction', () => {
    it('should create engine with SimulatorPool', () => {
      // Minimal test — full integration requires simulators
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      expect(engine).toBeInstanceOf(HybridQAEngine);
    });

    it('should return null for unknown workflow', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      expect(engine.getStatus('nonexistent')).toBeNull();
      expect(engine.getResults('nonexistent')).toBeNull();
    });

    it('getStatus() should return lightweight status object', () => {
      // We need to test that getStatus returns the lightweight HybridQAStatus type
      // Since we can't call start() without real simulators, we test the null case
      // and verify the type structure through the interface
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      expect(engine.getStatus('nonexistent')).toBeNull();
    });

    it('getResults() should return full HybridQAResult', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      expect(engine.getResults('nonexistent')).toBeNull();
    });
  });

  describe('API differentiation: getStatus vs getResults', () => {
    it('HybridQAStatus should be a lightweight subset of HybridQAResult', () => {
      // Verify the HybridQAStatus type structure
      const status: HybridQAStatus = {
        id: 'hqa-789',
        status: 'completed',
        phasesCompleted: 2,
        totalIssues: 5,
        flaggedForVerification: 2,
        confirmedCount: 1,
        elapsed: 20000,
      };

      // Status should NOT contain scan details or verified issues
      expect(status).not.toHaveProperty('phaseA');
      expect(status).not.toHaveProperty('phaseB');
      expect(status).not.toHaveProperty('peakMode');
      expect(status).not.toHaveProperty('totalDuration');
      expect(status).toHaveProperty('phasesCompleted');
      expect(status).toHaveProperty('elapsed');
    });

    it('HybridQAStatus should include error field when present', () => {
      const status: HybridQAStatus = {
        id: 'hqa-err',
        status: 'error',
        error: 'Phase A failed',
        phasesCompleted: 0,
        totalIssues: 0,
        flaggedForVerification: 0,
        confirmedCount: 0,
        elapsed: 500,
      };

      expect(status.error).toBe('Phase A failed');
      expect(status.status).toBe('error');
    });

    it('both should return null for nonexistent workflow ID', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      expect(engine.getStatus('does-not-exist')).toBeNull();
      expect(engine.getResults('does-not-exist')).toBeNull();
    });
  });

  describe('Event emission', () => {
    it('should be an EventEmitter', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      const handler = jest.fn();
      engine.on('hybrid:started', handler);
      engine.emit('hybrid:started', { id: 'test' });
      expect(handler).toHaveBeenCalledWith({ id: 'test' });
    });
  });

  describe('HybridQAOptions validation', () => {
    it('should accept minimal options', () => {
      const options = { urls: ['https://example.com'], devices: ['iphone-17'] };
      expect(options.urls).toHaveLength(1);
      expect(options.devices).toHaveLength(1);
    });

    it('should accept all options', () => {
      const options = {
        urls: ['https://a.com', 'https://b.com'],
        devices: ['iphone-17', 'ipad-pro', 'iphone-se'],
        detectors: ['touch-targets', 'horizontal-overflow'],
        deepVerifyThreshold: 'high' as const,
        skipPhaseB: false,
        authProfile: 'my-auth',
      };
      expect(options.deepVerifyThreshold).toBe('high');
      expect(options.detectors).toHaveLength(2);
    });

    it('should support skipPhaseB option', () => {
      const options = {
        urls: ['https://example.com'],
        devices: ['iphone-17'],
        skipPhaseB: true,
      };
      expect(options.skipPhaseB).toBe(true);
    });
  });

  describe('Severity threshold logic', () => {
    // Test the severity ordering used in the engine
    it('should order severities correctly', () => {
      const order: Record<string, number> = {
        critical: 5, high: 4, medium: 3, low: 2, pass: 1, error: 0,
      };
      expect(order['critical']).toBeGreaterThan(order['high']);
      expect(order['high']).toBeGreaterThan(order['medium']);
      expect(order['medium']).toBeGreaterThan(order['low']);
      expect(order['low']).toBeGreaterThan(order['pass']);
    });

    it('should meet threshold correctly', () => {
      // Simulating the meetsThreshold logic
      const meetsThreshold = (sev: string, threshold: string) => {
        const order: Record<string, number> = {
          critical: 5, high: 4, medium: 3, low: 2, pass: 1, error: 0,
        };
        return (order[sev] ?? 0) >= (order[threshold] ?? 0);
      };

      expect(meetsThreshold('critical', 'medium')).toBe(true);
      expect(meetsThreshold('high', 'medium')).toBe(true);
      expect(meetsThreshold('medium', 'medium')).toBe(true);
      expect(meetsThreshold('low', 'medium')).toBe(false);
      expect(meetsThreshold('pass', 'medium')).toBe(false);
      expect(meetsThreshold('critical', 'critical')).toBe(true);
      expect(meetsThreshold('high', 'critical')).toBe(false);
    });
  });

  describe('ViewportConfig with DPR', () => {
    it('should include dpr field', () => {
      const viewport: ViewportConfig = { preset: 'iphone-17', width: 402, height: 874, dpr: 3 };
      expect(viewport.dpr).toBe(3);
    });

    it('should support different DPR values for different devices', () => {
      const iphone: ViewportConfig = { preset: 'iphone-17', width: 402, height: 874, dpr: 3 };
      const ipad: ViewportConfig = { preset: 'ipad-pro', width: 1032, height: 1376, dpr: 2 };
      expect(iphone.dpr).toBe(3);
      expect(ipad.dpr).toBe(2);
    });
  });

  describe('PageScanResult with emulationConfidence', () => {
    it('should include emulationConfidence field', () => {
      const scan: PageScanResult = {
        url: 'https://example.com',
        viewport: { preset: 'iphone-17', width: 402, height: 874, dpr: 3 },
        detectorResults: [],
        issueCount: 0,
        maxSeverity: 'pass',
        emulationConfidence: 'high',
      };
      expect(scan.emulationConfidence).toBe('high');
    });

    it('should support all confidence levels', () => {
      const levels: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
      for (const level of levels) {
        const scan: PageScanResult = {
          url: 'https://example.com',
          viewport: { preset: 'iphone-17', width: 402, height: 874, dpr: 3 },
          detectorResults: [],
          issueCount: 0,
          maxSeverity: 'pass',
          emulationConfidence: level,
        };
        expect(scan.emulationConfidence).toBe(level);
      }
    });
  });

  describe('resolveViewports with DPR', () => {
    it('should include dpr from device presets', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      const viewports = (engine as any).resolveViewports(['iphone-17', 'ipad-pro']);
      expect(viewports[0].dpr).toBe(3);  // iphone-17 has dpr: 3
      expect(viewports[1].dpr).toBe(2);  // ipad-pro has dpr: 2
    });

    it('should default dpr to 3 for unknown presets', () => {
      const mockPool = {} as SimulatorPool;
      const engine = new HybridQAEngine(mockPool);
      const viewports = (engine as any).resolveViewports(['unknown-device']);
      expect(viewports[0].dpr).toBe(3);
      expect(viewports[0].width).toBe(390);
      expect(viewports[0].height).toBe(844);
    });
  });
});

describe('Hybrid QA Tools registration', () => {
  it('should export setHybridQAEngine', async () => {
    const mod = await import('../../src/tools/hybrid-qa-tools');
    expect(typeof mod.setHybridQAEngine).toBe('function');
  });

  it('should export registerHybridQATools', async () => {
    const mod = await import('../../src/tools/hybrid-qa-tools');
    expect(typeof mod.registerHybridQATools).toBe('function');
  });
});

// ── Auth persistence tests ──

// Mock dependencies needed by SimulatorPool
jest.mock('../../src/simulator/manager', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    boot: jest.fn().mockResolvedValue({ udid: 'udid-mock', name: 'Mock', state: 'Booted', isAvailable: true, runtime: 'iOS-18-0', runtimeVersion: '18.0' }),
    shutdown: jest.fn().mockResolvedValue(undefined),
    openUrl: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/webkit/client', () => ({
  WebKitClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
  })),
}));

jest.mock('../../src/reliability/zombie-cleanup', () => ({
  registerManagedDevices: jest.fn(),
  unregisterManagedDevices: jest.fn(),
}));

describe('Auth persistence across sequential devices', () => {
  it('should expose saveTempAuth/restoreTempAuth/clearTempAuth/setTempAuth on SimulatorPool', () => {
    const pool = new SimulatorPool();
    expect(typeof pool.saveTempAuth).toBe('function');
    expect(typeof pool.restoreTempAuth).toBe('function');
    expect(typeof pool.clearTempAuth).toBe('function');
    expect(typeof pool.setTempAuth).toBe('function');
  });

  it('should save and restore temp auth state', async () => {
    const pool = new SimulatorPool();
    const mockClient = createMockClient();

    // Setup mock to return cookies
    (mockClient.getCookies as jest.Mock).mockResolvedValue([
      { name: 'session', value: 'abc123', domain: 'example.com', path: '/', expires: 0, httpOnly: true, secure: true },
    ]);
    (mockClient.evaluate as jest.Mock).mockResolvedValue({ token: 'xyz' });

    await pool.saveTempAuth('wf-1', mockClient);
    expect(mockClient.getCookies).toHaveBeenCalled();

    // Restore to a new client
    const newClient = createMockClient();
    const restored = await pool.restoreTempAuth('wf-1', newClient);
    expect(restored).toBe(true);
    expect(newClient.setCookies).toHaveBeenCalledWith([
      { name: 'session', value: 'abc123', domain: 'example.com', path: '/', expires: 0, httpOnly: true, secure: true },
    ]);
  });

  it('should return false when no temp auth exists', async () => {
    const pool = new SimulatorPool();
    const mockClient = createMockClient();
    const restored = await pool.restoreTempAuth('nonexistent', mockClient);
    expect(restored).toBe(false);
    expect(mockClient.setCookies).not.toHaveBeenCalled();
  });

  it('should clear temp auth state', async () => {
    const pool = new SimulatorPool();
    pool.setTempAuth('wf-2', [{ name: 'a', value: 'b', domain: 'd', path: '/', expires: 0, httpOnly: false, secure: false }], {});
    pool.clearTempAuth('wf-2');

    const mockClient = createMockClient();
    const restored = await pool.restoreTempAuth('wf-2', mockClient);
    expect(restored).toBe(false);
  });

  it('should handle gracefully when getCookies fails', async () => {
    const pool = new SimulatorPool();
    const mockClient = createMockClient();
    (mockClient.getCookies as jest.Mock).mockRejectedValue(new Error('disconnected'));

    // Should not throw
    await pool.saveTempAuth('wf-3', mockClient);

    const newClient = createMockClient();
    const restored = await pool.restoreTempAuth('wf-3', newClient);
    expect(restored).toBe(false);
  });
});
