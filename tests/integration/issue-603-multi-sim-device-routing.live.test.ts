/**
 * Live regression for multi-simulator routing in ax-bridge.
 *
 * Proves that:
 *   1. `--device booted` fails when more than one simulator is booted
 *   2. targeting by exact UDID resolves different device windows instead of
 *      silently collapsing to the first booted simulator
 *
 * Opt-in only. Run with:
 *   OSF_LIVE=1 npm run test:integration -- issue-603-multi-sim-device-routing
 */

import { execFileSync } from 'child_process';
import { AccessibilityBridge } from '../../src/native';

jest.setTimeout(240000);

const shouldRun = process.env.OSF_LIVE === '1';
const describeLive = shouldRun ? describe : describe.skip;

const IPHONE_NAME = 'OSF MultiSim iPhone';
const IPAD_NAME = 'OSF MultiSim iPad';
const IPHONE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16';

function simctl(args: string[], timeout = 30000): string {
  return execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function latestRuntimeIdentifier(): string {
  const raw = simctl(['list', 'runtimes', 'iOS', '-j']);
  const parsed = JSON.parse(raw) as { runtimes: Array<{ identifier: string; isAvailable?: boolean }> };
  const runtimes = parsed.runtimes.filter((runtime) => runtime.isAvailable !== false);
  if (runtimes.length === 0) {
    throw new Error('No available iOS runtimes found');
  }
  return runtimes[runtimes.length - 1].identifier;
}

function resolveDeviceTypeId(kind: 'iphone' | 'ipad'): string {
  const raw = simctl(['list', 'devicetypes', '-j']);
  const parsed = JSON.parse(raw) as {
    devicetypes: Array<{ identifier: string; name: string; productFamily?: string; isAvailable?: boolean }>;
  };
  const candidates = parsed.devicetypes.filter((deviceType) => deviceType.isAvailable !== false);
  const preferred =
    kind === 'iphone'
      ? candidates.find((deviceType) => deviceType.identifier === IPHONE_TYPE)
      : candidates.find((deviceType) => /iPad/i.test(deviceType.name));
  if (!preferred) {
    throw new Error(`No available ${kind} simulator device type found`);
  }
  return preferred.identifier;
}

function createDevice(name: string, typeId: string, runtimeId: string): string {
  return simctl(['create', name, typeId, runtimeId]);
}

function bootAndWait(deviceId: string): void {
  simctl(['boot', deviceId]);
  simctl(['bootstatus', deviceId, '-b'], 120000);
}

describeLive('issue #603 — multi-simulator device routing', () => {
  let iphoneId: string;
  let ipadId: string;

  beforeAll(() => {
    const runtimeId = latestRuntimeIdentifier();
    const iphoneTypeId = resolveDeviceTypeId('iphone');
    const ipadTypeId = resolveDeviceTypeId('ipad');
    iphoneId = createDevice(
      IPHONE_NAME,
      iphoneTypeId,
      runtimeId,
    );
    ipadId = createDevice(
      IPAD_NAME,
      ipadTypeId,
      runtimeId,
    );

    bootAndWait(iphoneId);
    bootAndWait(ipadId);
  });

  afterAll(() => {
    for (const deviceId of [iphoneId, ipadId]) {
      if (!deviceId) continue;
      try { simctl(['shutdown', deviceId]); } catch { /* best-effort */ }
      try { simctl(['delete', deviceId]); } catch { /* best-effort */ }
    }
  });

  test('booted alias is rejected when multiple simulators are booted', async () => {
    const bridge = new AccessibilityBridge();
    await expect(bridge.dumpTree({ deviceId: 'booted' })).rejects.toMatchObject({
      name: 'AccessibilityBridgeError',
      code: 'DEVICE_RESOLUTION_AMBIGUOUS',
    });
  });

  test('UDID targeting resolves distinct device windows', async () => {
    const bridge = new AccessibilityBridge();

    const iphoneTree = await bridge.dumpTree({ deviceId: iphoneId, maxDepth: 1 });
    const ipadTree = await bridge.dumpTree({ deviceId: ipadId, maxDepth: 1 });

    // We do not assert exact points because Simulator zoom / window scale can
    // vary by host, but iPad content must be materially larger than iPhone
    // content if the correct window was selected for each UDID.
    expect(ipadTree.frame.width).toBeGreaterThan(iphoneTree.frame.width + 100);
    expect(ipadTree.frame.height).toBeGreaterThan(iphoneTree.frame.height + 100);
  });

  test('device-name targeting resolves the exact booted simulator', async () => {
    const bridge = new AccessibilityBridge();

    const iphoneTree = await bridge.dumpTree({ deviceId: IPHONE_NAME, maxDepth: 1 });
    const ipadTree = await bridge.dumpTree({ deviceId: IPAD_NAME, maxDepth: 1 });

    expect(ipadTree.frame.width).toBeGreaterThan(iphoneTree.frame.width + 100);
    expect(ipadTree.frame.height).toBeGreaterThan(iphoneTree.frame.height + 100);
  });
});
