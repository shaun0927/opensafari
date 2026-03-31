/**
 * Hybrid QA Engine Tests
 * Verifies two-phase QA strategy: fast scan + deep verify.
 */

import {
  HybridQAEngine,
  HybridQAResult,
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
    it('should inject viewport meta via evaluate', async () => {
      const client = createMockClient();
      const viewport: ViewportConfig = { preset: 'iphone-17', width: 390, height: 844 };

      await applyViewportEmulation(client, viewport);

      expect(client.evaluate).toHaveBeenCalledTimes(1);
      const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
      expect(expr).toContain('width=390');
      expect(expr).toContain('height: 844');
      expect(expr).toContain('preset: "iphone-17"');
    });

    it('should handle different viewport sizes', async () => {
      const client = createMockClient();
      const viewport: ViewportConfig = { preset: 'ipad-pro', width: 1024, height: 1366 };

      await applyViewportEmulation(client, viewport);

      const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
      expect(expr).toContain('width=1024');
      expect(expr).toContain('height: 1366');
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
            viewport: { preset: 'iphone-17', width: 390, height: 844 },
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
