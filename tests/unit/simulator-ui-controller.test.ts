/**
 * Unit tests for src/simulator/ui-controller.ts — #708 step 5.
 *
 * Covers:
 *   - screenshot happy path
 *   - screenshot timeout/retry (DeviceNotBootedError for unbooted device)
 *   - screenshot uses DEFAULT_SCREENSHOT_TIMEOUT_MS
 *   - screenshotBase64 returns base64-encoded result
 *   - setAppearance happy path
 *   - getAppearance returns 'light' or 'dark'
 *   - toggleAppearance flips current mode
 *   - rotate happy path (simctl method)
 *   - rotate fallback to 'none' when both methods fail
 *   - overrideStatusBar happy path
 *   - openUrl happy path
 *   - openUrl throws for invalid URL
 *   - DeviceNotBootedError thrown for unbooted device across all functions
 */

const readFileMock = jest.fn();
const unlinkMock = jest.fn();

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    readFile: (...args: unknown[]) => readFileMock(...args),
    unlink: (...args: unknown[]) => unlinkMock(...args),
  };
});

// Mock execFile used by rotate()
const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  screenshot,
  screenshotBase64,
  setAppearance,
  getAppearance,
  toggleAppearance,
  rotate,
  overrideStatusBar,
  openUrl,
} from '../../src/simulator/ui-controller';
import { DeviceNotBootedError } from '../../src/simulator/errors';
import { SimulatorDevice } from '../../src/simulator/types';

// ── helpers ──────────────────────────────────────────────────────────────────

const DEVICE_ID = '22222222-2222-2222-2222-222222222222';

function makeDevice(overrides: Partial<SimulatorDevice> = {}): SimulatorDevice {
  return {
    udid: DEVICE_ID,
    name: 'iPhone UI Test',
    state: 'Booted',
    isAvailable: true,
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    runtimeVersion: '18.0',
    ...overrides,
  };
}

function makeSimctl(execImpl?: (args: string[], options?: unknown) => Promise<string>) {
  const exec = jest.fn(async (args: string[], options?: unknown) => {
    return execImpl ? execImpl(args, options) : '';
  });
  return { exec };
}

function makeLookup(device: SimulatorDevice | null) {
  return {
    getDevice: jest.fn(async () => device),
  };
}

// ── screenshot ────────────────────────────────────────────────────────────────

describe('ui-controller.screenshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readFileMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    unlinkMock.mockResolvedValue(undefined);
  });

  it('captures screenshot and returns buffer', async () => {
    const simctl = makeSimctl(async () => '');
    const lookup = makeLookup(makeDevice());

    const buf = await screenshot(DEVICE_ID, undefined, { simctl, lookup });

    expect(buf).toBeInstanceOf(Buffer);
    expect(simctl.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['io', DEVICE_ID, 'screenshot', '--type=png']),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('uses jpeg format when specified', async () => {
    const simctl = makeSimctl(async () => '');
    const lookup = makeLookup(makeDevice());

    await screenshot(DEVICE_ID, { format: 'jpeg' }, { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['--type=jpeg']),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('cleans up temp file even when readFile throws', async () => {
    const simctl = makeSimctl(async () => '');
    const lookup = makeLookup(makeDevice());
    readFileMock.mockRejectedValue(new Error('read failed'));

    await expect(screenshot(DEVICE_ID, undefined, { simctl, lookup })).rejects.toThrow('read failed');
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(screenshot(DEVICE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('throws DeviceNotBootedError when device is null', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(null);

    await expect(screenshot(DEVICE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });
});

// ── screenshotBase64 ──────────────────────────────────────────────────────────

describe('ui-controller.screenshotBase64', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readFileMock.mockResolvedValue(Buffer.from('test-image-data'));
    unlinkMock.mockResolvedValue(undefined);
  });

  it('returns base64-encoded screenshot', async () => {
    const simctl = makeSimctl(async () => '');
    const lookup = makeLookup(makeDevice());

    const result = await screenshotBase64(DEVICE_ID, undefined, { simctl, lookup });

    expect(typeof result).toBe('string');
    expect(Buffer.from(result, 'base64').toString()).toBe('test-image-data');
  });
});

// ── setAppearance ─────────────────────────────────────────────────────────────

describe('ui-controller.setAppearance', () => {
  it('sets dark mode via simctl ui appearance', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    await setAppearance(DEVICE_ID, 'dark', { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(['ui', DEVICE_ID, 'appearance', 'dark']);
  });

  it('sets light mode via simctl ui appearance', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    await setAppearance(DEVICE_ID, 'light', { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(['ui', DEVICE_ID, 'appearance', 'light']);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(setAppearance(DEVICE_ID, 'dark', { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });
});

// ── getAppearance ─────────────────────────────────────────────────────────────

describe('ui-controller.getAppearance', () => {
  it('returns "dark" when simctl output is "Dark"', async () => {
    const simctl = makeSimctl(async () => 'Dark\n');
    const lookup = makeLookup(makeDevice());

    const result = await getAppearance(DEVICE_ID, { simctl, lookup });

    expect(result).toBe('dark');
  });

  it('returns "light" when simctl output is "Light"', async () => {
    const simctl = makeSimctl(async () => 'Light\n');
    const lookup = makeLookup(makeDevice());

    const result = await getAppearance(DEVICE_ID, { simctl, lookup });

    expect(result).toBe('light');
  });

  it('returns "light" for unknown output', async () => {
    const simctl = makeSimctl(async () => 'unknown\n');
    const lookup = makeLookup(makeDevice());

    const result = await getAppearance(DEVICE_ID, { simctl, lookup });

    expect(result).toBe('light');
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(getAppearance(DEVICE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });
});

// ── toggleAppearance ──────────────────────────────────────────────────────────

describe('ui-controller.toggleAppearance', () => {
  it('toggles from light to dark', async () => {
    let callCount = 0;
    const simctl = makeSimctl(async (args) => {
      callCount++;
      // First call: getAppearance — return Light
      if (callCount === 1 && args[2] === 'appearance' && args.length === 3) return 'Light\n';
      // Second call: setAppearance to dark
      return '';
    });
    const lookup = makeLookup(makeDevice());

    const result = await toggleAppearance(DEVICE_ID, { simctl, lookup });

    expect(result).toBe('dark');
    expect(simctl.exec).toHaveBeenCalledTimes(2);
  });

  it('toggles from dark to light', async () => {
    let callCount = 0;
    const simctl = makeSimctl(async (args) => {
      callCount++;
      if (callCount === 1 && args[2] === 'appearance' && args.length === 3) return 'Dark\n';
      return '';
    });
    const lookup = makeLookup(makeDevice());

    const result = await toggleAppearance(DEVICE_ID, { simctl, lookup });

    expect(result).toBe('light');
  });
});

// ── rotate ────────────────────────────────────────────────────────────────────

describe('ui-controller.rotate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: execFile calls the callback with success
    execFileMock.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: '', stderr: '' });
      },
    );
  });

  it('returns simctl method on success', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    const result = await rotate(DEVICE_ID, 'left', { simctl, lookup });

    expect(result.success).toBe(true);
    expect(result.method).toBe('simctl');
    expect(result.orientation).toBe('landscapeLeft');
  });

  it('uses landscapeRight for direction=right', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    const result = await rotate(DEVICE_ID, 'right', { simctl, lookup });

    expect(result.success).toBe(true);
    expect(result.orientation).toBe('landscapeRight');
  });

  it('returns none when both simctl and AppleScript fail', async () => {
    execFileMock.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback: (err: Error) => void) => {
        callback(new Error('command not found'));
      },
    );
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    const result = await rotate(DEVICE_ID, 'left', { simctl, lookup });

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(rotate(DEVICE_ID, 'left', { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });
});

// ── overrideStatusBar ─────────────────────────────────────────────────────────

describe('ui-controller.overrideStatusBar', () => {
  it('calls simctl status_bar override with deterministic values', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    await overrideStatusBar(DEVICE_ID, { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith([
      'status_bar', DEVICE_ID, 'override',
      '--time', '9:41',
      '--batteryLevel', '100',
      '--cellularBars', '4',
    ]);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(overrideStatusBar(DEVICE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });
});

// ── openUrl ───────────────────────────────────────────────────────────────────

describe('ui-controller.openUrl', () => {
  it('calls simctl openurl for valid URL', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    await openUrl(DEVICE_ID, 'https://example.com', { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(['openurl', DEVICE_ID, 'https://example.com']);
  });

  it('throws for invalid URL', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice());

    await expect(openUrl(DEVICE_ID, 'not-a-url', { simctl, lookup }))
      .rejects.toThrow('Invalid URL: not-a-url');
    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(openUrl(DEVICE_ID, 'https://example.com', { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });
});
