/**
 * Unit tests for the ax-bridge device targeting contract (issue #3).
 *
 * Covers the TS port in `src/native/ax-bridge-device-resolution.ts`, which
 * mirrors the Swift functions `resolveRequestedDevice`, `scoreWindow`, and
 * `findMatchingWindow` in `src/native/ax-bridge.swift`. The production path
 * is Swift; the TS port exists so the rubric is unit-testable from Jest.
 *
 * Anything covered here must also hold in the Swift implementation.
 */

import {
  DEVICE_RESOLUTION_FAILED,
  DEVICE_RESOLUTION_AMBIGUOUS,
  DEVICE_WINDOW_NOT_FOUND,
  DEVICE_WINDOW_AMBIGUOUS,
  findMatchingWindow,
  resolveRequestedDevice,
  scoreWindow,
  type AXWindowMetadata,
  type SimulatorDeviceRecord,
} from '../../src/native/ax-bridge-device-resolution';

const IPHONE: SimulatorDeviceRecord = {
  udid: '3BEF4E9A-069A-4419-AC62-AB889348EF12',
  name: 'iPhone 16',
  runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
  state: 'Booted',
};

const IPHONE_VERIFY2: SimulatorDeviceRecord = {
  udid: '7ED6F6E9-E433-4603-9C58-E82EA40EE7E1',
  name: 'iPhone 16 Verify 2',
  runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
  state: 'Booted',
};

const IPAD: SimulatorDeviceRecord = {
  udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  name: 'iPad Pro (M4)',
  runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
  state: 'Booted',
};

const SHUTDOWN_IPHONE: SimulatorDeviceRecord = {
  ...IPHONE,
  udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
  state: 'Shutdown',
};

function window(title: string, identifier = ''): AXWindowMetadata {
  return { title, identifier };
}

describe('resolveRequestedDevice — UDID targeting', () => {
  test('exact booted UDID resolves to that device', () => {
    const result = resolveRequestedDevice(IPHONE_VERIFY2.udid, [IPHONE, IPHONE_VERIFY2]);
    expect(result.error).toBeNull();
    expect(result.target?.udid).toBe(IPHONE_VERIFY2.udid);
  });

  test('UDID match is case-insensitive', () => {
    const result = resolveRequestedDevice(IPHONE.udid.toLowerCase(), [IPHONE, IPHONE_VERIFY2]);
    expect(result.error).toBeNull();
    expect(result.target?.udid).toBe(IPHONE.udid);
  });

  test('UDID points to a shutdown device → DEVICE_RESOLUTION_FAILED', () => {
    const result = resolveRequestedDevice(SHUTDOWN_IPHONE.udid, [IPHONE, SHUTDOWN_IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_FAILED);
    expect(result.error?.error).toMatch(/not booted/);
  });

  test('unknown UDID → DEVICE_RESOLUTION_FAILED with simctl diagnostic hint', () => {
    const result = resolveRequestedDevice('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', [IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_FAILED);
    expect(result.error?.error).toMatch(/simctl list devices/);
  });
});

describe('resolveRequestedDevice — device-name targeting', () => {
  test('unique booted name match resolves exactly', () => {
    const result = resolveRequestedDevice('iPhone 16 Verify 2', [IPHONE, IPHONE_VERIFY2]);
    expect(result.error).toBeNull();
    expect(result.target?.udid).toBe(IPHONE_VERIFY2.udid);
  });

  test('name matches multiple booted simulators → DEVICE_RESOLUTION_AMBIGUOUS', () => {
    const twin: SimulatorDeviceRecord = { ...IPHONE, udid: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC' };
    const result = resolveRequestedDevice('iPhone 16', [IPHONE, twin]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_AMBIGUOUS);
    expect(result.error?.error).toContain(IPHONE.udid);
    expect(result.error?.error).toContain(twin.udid);
  });

  test('name exists but no booted match → DEVICE_RESOLUTION_FAILED with UDID list', () => {
    const result = resolveRequestedDevice('iPhone 16', [SHUTDOWN_IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_FAILED);
    expect(result.error?.error).toContain('none are booted');
  });

  test('device-name matching is case-sensitive (iPhone 16 ≠ iphone 16)', () => {
    const result = resolveRequestedDevice('iphone 16', [IPHONE, IPHONE_VERIFY2]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_FAILED);
  });
});

describe('resolveRequestedDevice — booted alias', () => {
  test('exactly one booted simulator → resolves', () => {
    const result = resolveRequestedDevice('booted', [IPHONE, SHUTDOWN_IPHONE]);
    expect(result.error).toBeNull();
    expect(result.target?.udid).toBe(IPHONE.udid);
  });

  test('multiple booted simulators → DEVICE_RESOLUTION_AMBIGUOUS', () => {
    const result = resolveRequestedDevice('booted', [IPHONE, IPHONE_VERIFY2, IPAD]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_AMBIGUOUS);
    expect(result.error?.error).toContain(IPHONE.name);
    expect(result.error?.error).toContain(IPHONE_VERIFY2.name);
    expect(result.error?.error).toContain(IPAD.name);
  });

  test('zero booted simulators → DEVICE_RESOLUTION_FAILED', () => {
    const result = resolveRequestedDevice('booted', [SHUTDOWN_IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error?.code).toBe(DEVICE_RESOLUTION_FAILED);
    expect(result.error?.error).toMatch(/no booted simulators/);
  });
});

describe('resolveRequestedDevice — any alias (permissive)', () => {
  test('any returns null target and null error regardless of boot state', () => {
    const result = resolveRequestedDevice('any', [IPHONE, IPHONE_VERIFY2, SHUTDOWN_IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error).toBeNull();
  });

  test('any is permissive even when nothing is booted', () => {
    const result = resolveRequestedDevice('any', [SHUTDOWN_IPHONE]);
    expect(result.target).toBeNull();
    expect(result.error).toBeNull();
  });
});

describe('scoreWindow — individual window scoring', () => {
  test('title containing target UDID scores 1000 (strongest signal)', () => {
    const match = scoreWindow(window(`iPhone 16 – iOS 26.4 (${IPHONE.udid})`), IPHONE.udid, IPHONE);
    expect(match?.score).toBe(1000);
  });

  test('title starts with "<name> –" scores 850 on current Simulator builds', () => {
    // Titles emit an em-dash, per ax-bridge.swift:449.
    const match = scoreWindow(window('iPhone 16 Verify 2 – iOS 26.4'), IPHONE_VERIFY2.udid, IPHONE_VERIFY2);
    expect(match?.score).toBe(850);
  });

  test('title exactly equals device name scores 900', () => {
    const match = scoreWindow(window('iPhone 16'), IPHONE.udid, IPHONE);
    expect(match?.score).toBe(900);
  });

  test('title merely contains device name scores 800', () => {
    const match = scoreWindow(window('Preview: iPhone 16 window'), IPHONE.udid, IPHONE);
    expect(match?.score).toBe(800);
  });

  test('no match → null', () => {
    const match = scoreWindow(window('iPad Pro (M4) – iOS 26.4'), IPHONE.udid, IPHONE);
    expect(match).toBeNull();
  });

  test('any request scores every window at 1 regardless of target', () => {
    const match = scoreWindow(window('SomeOtherApp'), 'any', null);
    expect(match?.score).toBe(1);
  });
});

describe('findMatchingWindow — window disambiguation', () => {
  test('UDID-only title still selects correct window when multiple booted simulators exist', () => {
    // Reproduces the original failure signature from issue #3: titles omit UDIDs.
    const result = findMatchingWindow(
      [
        window('iPhone 16 – iOS 26.4'),
        window('iPhone 16 Verify 2 – iOS 26.4'),
      ],
      IPHONE_VERIFY2.udid,
      IPHONE_VERIFY2,
    );
    expect(result.error).toBeNull();
    expect(result.match?.title).toBe('iPhone 16 Verify 2 – iOS 26.4');
  });

  test('two windows tie on device-name prefix → DEVICE_WINDOW_AMBIGUOUS', () => {
    const result = findMatchingWindow(
      [
        window('iPhone 16 – iOS 26.4'),
        window('iPhone 16 – iOS 26.4 (mirror)'),
      ],
      IPHONE.udid,
      IPHONE,
    );
    expect(result.match).toBeNull();
    expect(result.error?.code).toBe(DEVICE_WINDOW_AMBIGUOUS);
  });

  test('no window scores → DEVICE_WINDOW_NOT_FOUND with diagnostics', () => {
    const result = findMatchingWindow(
      [window('iPad Pro (M4) – iOS 26.4')],
      IPHONE.udid,
      IPHONE,
    );
    expect(result.match).toBeNull();
    expect(result.error?.code).toBe(DEVICE_WINDOW_NOT_FOUND);
    expect(result.error?.error).toContain('iPad Pro (M4) – iOS 26.4');
  });

  test('empty window list → DEVICE_WINDOW_NOT_FOUND', () => {
    const result = findMatchingWindow([], IPHONE.udid, IPHONE);
    expect(result.match).toBeNull();
    expect(result.error?.code).toBe(DEVICE_WINDOW_NOT_FOUND);
  });

  test('any request returns the first window even when the content is unexpected', () => {
    const first = window('Some Random Simulator Window');
    const result = findMatchingWindow([first, window('Another Window')], 'any', null);
    expect(result.error).toBeNull();
    expect(result.match).toEqual(first);
  });

  test('Simulator title without UDID + matching device name resolves when UDID is the request', () => {
    const result = findMatchingWindow(
      [window('iPhone 16 Verify 2 – iOS 26.4')],
      IPHONE_VERIFY2.udid,
      IPHONE_VERIFY2,
    );
    expect(result.error).toBeNull();
    expect(result.match?.title).toBe('iPhone 16 Verify 2 – iOS 26.4');
  });

  test('UDID-in-title beats name-only title (higher score tier wins)', () => {
    const udidTitle = window(`iPhone 16 (${IPHONE.udid})`);
    const nameTitle = window('iPhone 16 – iOS 26.4');
    const result = findMatchingWindow([nameTitle, udidTitle], IPHONE.udid, IPHONE);
    expect(result.error).toBeNull();
    expect(result.match?.title).toBe(udidTitle.title);
  });
});
