/**
 * Unit tests for AccessibilityBridge.resolveBridgePath() (issue #495).
 *
 * Verifies that the path resolution logic correctly walks the candidate list,
 * applies the dev-mode env-var gate, caches the result, and surfaces a useful
 * error with the searched paths when nothing is found.
 */

import { AccessibilityBridge, AccessibilityBridgeError } from '../../src/native/accessibility-bridge';

/* eslint-disable no-var */
var execFileMock = jest.fn();
/* eslint-enable no-var */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execFileMock(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

import { existsSync } from 'fs';

const existsSyncMock = existsSync as jest.MockedFunction<typeof existsSync>;

// Access the private resolveBridgePath via exec (dumpTree calls exec internally).
// We test resolution by calling dumpTree and inspecting which path execFile receives.

function makeSuccessResult(): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ role: 'Application', children: [] }),
    stderr: '',
  };
}

describe('AccessibilityBridge path resolution', () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    origEnv = process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER;
    delete process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER = origEnv;
    } else {
      delete process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER;
    }
  });

  test('compiled binary in same dir (candidate 2) is used when it exists', async () => {
    // Only candidate 2 (same dir, compiled binary) exists.
    existsSyncMock.mockImplementation((p) => {
      return typeof p === 'string' && p.endsWith('/ax-bridge') && !p.includes('/../ax-bridge');
    });
    execFileMock.mockResolvedValueOnce(makeSuccessResult());

    const bridge = new AccessibilityBridge();
    await bridge.dumpTree();

    const [cmd] = execFileMock.mock.calls[0];
    expect(cmd).toMatch(/ax-bridge$/);
    expect(cmd).not.toMatch(/\.swift$/);
  });

  test('swift source in same dir (candidate 4) is used when it exists', async () => {
    // Only candidate 4 (same dir, .swift) exists.
    existsSyncMock.mockImplementation((p) => {
      return typeof p === 'string' && p.endsWith('/ax-bridge.swift') && !p.includes('/../ax-bridge.swift');
    });
    execFileMock.mockResolvedValueOnce(makeSuccessResult());

    const bridge = new AccessibilityBridge();
    await bridge.dumpTree();

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('swift');
    expect(args[0]).toMatch(/ax-bridge\.swift$/);
  });

  test('with env var set, a 5th path (dev source tree) is checked when all 4 candidates miss', async () => {
    // When OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1 and all 4 normal candidates miss,
    // the implementation checks a 5th path: the dev source tree.
    // We verify this by counting existsSync calls: exactly 5 should be made
    // (4 candidates + 1 dev path), and the last one should end in src/native/ax-bridge.swift.
    process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER = '1';
    existsSyncMock.mockReturnValue(false);

    const bridge = new AccessibilityBridge();
    await expect(bridge.dumpTree()).rejects.toMatchObject({
      code: 'BRIDGE_NOT_FOUND',
    });

    expect(existsSyncMock).toHaveBeenCalledTimes(5);
    const lastChecked = existsSyncMock.mock.calls[4][0] as string;
    expect(lastChecked).toMatch(/src[\\/]native[\\/]ax-bridge\.swift$/);
  });

  test('without env var, only 4 candidates are checked (dev source tree skipped)', async () => {
    // Without the env-var gate, the dev fallback must not be attempted at all.
    existsSyncMock.mockReturnValue(false);

    const bridge = new AccessibilityBridge();
    await expect(bridge.dumpTree()).rejects.toMatchObject({
      name: 'AccessibilityBridgeError',
      code: 'BRIDGE_NOT_FOUND',
    });

    // Exactly 4 existsSync calls — the dev path must not be checked.
    expect(existsSyncMock).toHaveBeenCalledTimes(4);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('all candidates missing → throws BRIDGE_NOT_FOUND with searched paths listed', async () => {
    existsSyncMock.mockReturnValue(false);

    const bridge = new AccessibilityBridge();
    let err: AccessibilityBridgeError | undefined;
    try {
      await bridge.dumpTree();
    } catch (e) {
      err = e as AccessibilityBridgeError;
    }

    expect(err).toBeInstanceOf(AccessibilityBridgeError);
    expect(err?.code).toBe('BRIDGE_NOT_FOUND');
    expect(err?.message).toMatch(/ax-bridge not found/);
    expect(err?.message).toMatch(/Searched:/);
    expect(err?.message).toMatch(/ax-bridge/);
  });

  test('second call returns cached path without re-scanning fs', async () => {
    existsSyncMock.mockImplementation((p) => {
      return typeof p === 'string' && p.endsWith('/ax-bridge');
    });
    execFileMock.mockResolvedValue(makeSuccessResult());

    const bridge = new AccessibilityBridge();
    await bridge.dumpTree();
    await bridge.dumpTree();

    // existsSync should only be called during the first resolution, not the second.
    // The bridge candidates list has 4 entries; after the first hit existsSync stops.
    // On the second call it should not be called at all (cache hit).
    const callsAfterFirst = existsSyncMock.mock.calls.length;
    // Both dumpTree calls complete — check execFileMock called twice (proves resolution ran once).
    expect(execFileMock).toHaveBeenCalledTimes(2);
    // All existsSync calls happened during the first resolution only.
    await bridge.dumpTree();
    expect(existsSyncMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
