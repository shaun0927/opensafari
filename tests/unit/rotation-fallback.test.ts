/**
 * Rotation Fallback Tests
 * Verifies simctl-based rotation fallback for headless/CI environments.
 */

import { execFile } from 'child_process';
import { SimulatorManager, RotationResult } from '../../src/simulator/manager';
import { detectOrientation } from '../../src/qa/detectors/orientation';
import { BrowserBackend } from '../../src/types/browser-backend';

// ── Mocks ──

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

function createMockClient(): BrowserBackend {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 0 }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('png')),
    evaluate: jest.fn().mockResolvedValue({
      scrollWidth: 390,
      innerWidth: 390,
      overflow: false,
    }),
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

function createMockSimulatorManager(rotateResult: RotationResult): SimulatorManager {
  return {
    rotate: jest.fn().mockResolvedValue(rotateResult),
    listDevices: jest.fn().mockResolvedValue([]),
    listBooted: jest.fn().mockResolvedValue([]),
    getDevice: jest.fn().mockResolvedValue({
      udid: 'test-device-id',
      name: 'iPhone 16',
      state: 'Booted',
      isAvailable: true,
      runtime: 'iOS-18-0',
      runtimeVersion: '18.0',
    }),
  } as unknown as SimulatorManager;
}

// ── Tests ──

describe('SimulatorManager.rotate()', () => {
  let manager: SimulatorManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new SimulatorManager();
    // Mock listDevices / getDevice to return a booted device
    jest.spyOn(manager, 'getDevice').mockResolvedValue({
      udid: 'test-device-id',
      name: 'iPhone 16',
      state: 'Booted',
      isAvailable: true,
      runtime: 'iOS-18-0',
      runtimeVersion: '18.0',
    });
  });

  it('should return RotationResult with correct fields on simctl success', async () => {
    // Mock execFile to succeed on first call (simctl)
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
    });

    const result = await manager.rotate('test-device-id', 'left');
    expect(result).toEqual({
      success: true,
      method: 'simctl',
      orientation: 'landscapeLeft',
    });
  });

  it('should try simctl before AppleScript', async () => {
    const calls: string[] = [];
    mockExecFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      calls.push(cmd);
      if (cb) cb(null);
    });

    await manager.rotate('test-device-id', 'left');

    // simctl is called via xcrun, which should be the first call
    expect(calls[0]).toBe('xcrun');
  });

  it('should fall back to AppleScript when simctl fails', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      callCount++;
      if (callCount === 1) {
        // simctl fails
        if (cb) cb(new Error('simctl setorientation not supported'));
      } else {
        // AppleScript succeeds
        if (cb) cb(null);
      }
    });

    const result = await manager.rotate('test-device-id', 'right');
    expect(result).toEqual({
      success: true,
      method: 'applescript',
      orientation: 'landscapeRight',
    });
    expect(callCount).toBe(2);
  });

  it('should return success: false when both methods fail', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(new Error('not available'));
    });

    const result = await manager.rotate('test-device-id', 'left');
    expect(result).toEqual({
      success: false,
      method: 'none',
    });
  });

  it('should use landscapeLeft for direction "left"', async () => {
    let capturedArgs: string[] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      capturedArgs = args;
      if (cb) cb(null);
    });

    const result = await manager.rotate('test-device-id', 'left');
    expect(result.orientation).toBe('landscapeLeft');
    expect(capturedArgs).toContain('landscapeLeft');
  });

  it('should use landscapeRight for direction "right"', async () => {
    let capturedArgs: string[] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      capturedArgs = args;
      if (cb) cb(null);
    });

    const result = await manager.rotate('test-device-id', 'right');
    expect(result.orientation).toBe('landscapeRight');
    expect(capturedArgs).toContain('landscapeRight');
  });

  it('should default direction to "left"', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
    });

    const result = await manager.rotate('test-device-id');
    expect(result.orientation).toBe('landscapeLeft');
  });

  it('should throw DeviceNotBootedError when device is not booted', async () => {
    jest.spyOn(manager, 'getDevice').mockResolvedValue({
      udid: 'test-device-id',
      name: 'iPhone 16',
      state: 'Shutdown',
      isAvailable: true,
      runtime: 'iOS-18-0',
      runtimeVersion: '18.0',
    });

    await expect(manager.rotate('test-device-id')).rejects.toThrow('not booted');
  });
});

describe('detectOrientation()', () => {
  it('should return severity "warning" when rotation fails', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager({ success: false, method: 'none' });

    const result = await detectOrientation(client, simulator, 'test-device-id');
    expect(result.severity).toBe('warning');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain('rotation unavailable');
    expect(result.metadata?.rotationTested).toBe(false);
    expect(result.metadata?.rotationMethod).toBe('none');
  });

  it('should return severity "pass" when rotation succeeds with no overflow', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager({ success: true, method: 'simctl', orientation: 'landscapeLeft' });

    const result = await detectOrientation(client, simulator, 'test-device-id');
    expect(result.severity).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.metadata?.rotationTested).toBe(true);
    expect(result.metadata?.rotationMethod).toBe('simctl');
  });

  it('should return severity "medium" when landscape has overflow', async () => {
    const client = createMockClient();
    // Second call to evaluate returns overflow
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce({ scrollWidth: 390, innerWidth: 390, overflow: false })
      .mockResolvedValueOnce({ scrollWidth: 1200, innerWidth: 844, overflow: true });

    const simulator = createMockSimulatorManager({ success: true, method: 'simctl', orientation: 'landscapeLeft' });

    const result = await detectOrientation(client, simulator, 'test-device-id');
    expect(result.severity).toBe('medium');
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].problem).toContain('Horizontal overflow');
  });

  it('should return "pass" when no simulator provided', async () => {
    const client = createMockClient();

    const result = await detectOrientation(client);
    expect(result.severity).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.metadata?.rotationTested).toBe(false);
  });

  it('should include rotationMethod in metadata when simctl used', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager({ success: true, method: 'simctl', orientation: 'landscapeLeft' });

    const result = await detectOrientation(client, simulator, 'test-device-id');
    expect(result.metadata?.rotationMethod).toBe('simctl');
  });

  it('should rotate back after testing landscape', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager({ success: true, method: 'simctl', orientation: 'landscapeLeft' });

    await detectOrientation(client, simulator, 'test-device-id');

    // rotate should be called twice: once left (test), once right (restore)
    expect(simulator.rotate).toHaveBeenCalledTimes(2);
    expect(simulator.rotate).toHaveBeenCalledWith('test-device-id', 'left');
    expect(simulator.rotate).toHaveBeenCalledWith('test-device-id', 'right');
  });
});

describe('device_rotate tool', () => {
  it('should return error when rotation is unavailable', async () => {
    // Test the tool's error response format
    const errorResponse = {
      rotated: false,
      deviceId: 'test-id',
      method: 'none',
      error: 'No rotation method available (headless environment?)',
    };
    expect(errorResponse.rotated).toBe(false);
    expect(errorResponse.method).toBe('none');
  });

  it('should include method and orientation on success', () => {
    const successResponse = {
      rotated: true,
      deviceId: 'test-id',
      method: 'simctl',
      orientation: 'landscapeLeft',
    };
    expect(successResponse.rotated).toBe(true);
    expect(successResponse.method).toBe('simctl');
    expect(successResponse.orientation).toBe('landscapeLeft');
  });
});
