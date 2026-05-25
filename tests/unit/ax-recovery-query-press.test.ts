/**
 * Unit tests for PR11 — queryWithRecovery / pressWithRecovery /
 * runAxOperationWithRecovery.
 *
 * Mirrors the policy already proven by dumpTreeWithRecovery: recoverable
 * errors trigger backoff + reactivation + retry; non-recoverable errors
 * surface immediately with the diagnostics report attached.
 */

import {
  queryWithRecovery,
  pressWithRecovery,
  runAxOperationWithRecovery,
} from '../../src/native/ax-bridge-recovery';
import { AccessibilityBridgeError } from '../../src/native/accessibility-bridge';

describe('queryWithRecovery', () => {
  it('returns the result and reports a successful first attempt', async () => {
    const bridge = {
      query: jest.fn().mockResolvedValue({ matches: [{ role: 'AXButton' }], ambiguous: false }),
    };
    const { result, recovery } = await queryWithRecovery(
      bridge,
      { label: 'OK' },
      { deviceId: 'DEV-1', sleep: async () => undefined },
    );
    expect(result).toEqual({ matches: [{ role: 'AXButton' }], ambiguous: false });
    expect(recovery.attempts).toBe(1);
    expect(recovery.recovered).toBe(true);
    expect(bridge.query).toHaveBeenCalledTimes(1);
  });

  it('retries on recoverable errors and succeeds on the second attempt', async () => {
    const bridge = {
      query: jest
        .fn()
        .mockRejectedValueOnce(new AccessibilityBridgeError('content root empty', 'DEVICE_CONTENT_ROOT_EMPTY'))
        .mockResolvedValueOnce({ matches: [], ambiguous: false }),
    };
    const reactivate = jest.fn().mockResolvedValue(true);

    const { result, recovery } = await queryWithRecovery(
      bridge,
      { label: 'OK' },
      {
        deviceId: 'DEV-1',
        bundleId: 'com.example.app',
        sleep: async () => undefined,
        reactivate,
      },
    );

    expect(result).toEqual({ matches: [], ambiguous: false });
    expect(bridge.query).toHaveBeenCalledTimes(2);
    expect(reactivate).toHaveBeenCalledTimes(1);
    expect(recovery.attempts).toBe(2);
    expect(recovery.stages.map((s) => s.action)).toEqual(
      expect.arrayContaining(['query', 'reactivate', 'sleep']),
    );
  });

  it('surfaces non-recoverable errors immediately', async () => {
    const bridge = {
      query: jest.fn().mockRejectedValue(
        new AccessibilityBridgeError('xcode missing', 'XCODE_NOT_FOUND'),
      ),
    };
    await expect(
      queryWithRecovery(bridge, { label: 'OK' }, { deviceId: 'DEV-1', sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: 'XCODE_NOT_FOUND' });
    expect(bridge.query).toHaveBeenCalledTimes(1);
  });

  it('attaches the recovery report when the budget is exhausted', async () => {
    const bridge = {
      query: jest.fn().mockRejectedValue(
        new AccessibilityBridgeError('timeout', 'AX_TIMEOUT'),
      ),
    };
    await expect(
      queryWithRecovery(bridge, { label: 'OK' }, {
        deviceId: 'DEV-1',
        maxAttempts: 2,
        sleep: async () => undefined,
        reactivate: async () => true,
      }),
    ).rejects.toMatchObject({
      code: 'AX_TIMEOUT',
      recovery: expect.objectContaining({ recovered: false }),
    });
  });
});

describe('pressWithRecovery', () => {
  it('passes the element path + deviceId through and returns the response', async () => {
    const bridge = { press: jest.fn().mockResolvedValue({ ok: true }) };
    const { result } = await pressWithRecovery(bridge, '/AXButton[1]', {
      deviceId: 'DEV-1',
      sleep: async () => undefined,
    });
    expect(result).toEqual({ ok: true });
    expect(bridge.press).toHaveBeenCalledWith('/AXButton[1]', 'DEV-1');
  });
});

describe('runAxOperationWithRecovery', () => {
  it('exposes the generalised wrapper for arbitrary AX ops', async () => {
    let calls = 0;
    const { result, recovery } = await runAxOperationWithRecovery(
      async () => {
        calls += 1;
        if (calls === 1) throw new AccessibilityBridgeError('rooted empty', 'DEVICE_CONTENT_ROOT_EMPTY');
        return 'final-value';
      },
      {
        deviceId: 'DEV-1',
        sleep: async () => undefined,
        reactivate: async () => true,
      },
      'query',
    );
    expect(result).toBe('final-value');
    expect(recovery.recovered).toBe(true);
    expect(recovery.attempts).toBe(2);
  });
});
