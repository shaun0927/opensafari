import { dumpTreeWithRetry } from '../../src/tools/app-tree';
import { AccessibilityBridgeError } from '../../src/native/accessibility-bridge';
import { DEVICE_CONTENT_ROOT_EMPTY } from '../../src/native/ax-bridge-content-root';

describe('dumpTreeWithRetry (issue #639 Problem 4a — AX recovery after alert)', () => {
  test('returns immediately on success without retrying', async () => {
    const dumpTree = jest.fn().mockResolvedValue({ root: { id: 'ok' } });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await dumpTreeWithRetry({ dumpTree }, { deviceId: 'dev' }, 3, sleep);
    expect(result).toEqual({ root: { id: 'ok' } });
    expect(dumpTree).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('retries on DEVICE_CONTENT_ROOT_EMPTY then succeeds', async () => {
    const emptyError = new AccessibilityBridgeError(
      'no app semantics in tree',
      DEVICE_CONTENT_ROOT_EMPTY,
    );
    const dumpTree = jest
      .fn()
      .mockRejectedValueOnce(emptyError)
      .mockRejectedValueOnce(emptyError)
      .mockResolvedValue({ root: { id: 'ok-after-retry' } });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await dumpTreeWithRetry({ dumpTree }, { deviceId: 'dev' }, 3, sleep);
    expect(result).toEqual({ root: { id: 'ok-after-retry' } });
    expect(dumpTree).toHaveBeenCalledTimes(3);
    // Two backoffs should have fired (250 ms then 500 ms per the schedule).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(250);
    expect(sleep.mock.calls[1]?.[0]).toBe(500);
  });

  test('surfaces DEVICE_CONTENT_ROOT_EMPTY after exhausting retries', async () => {
    const emptyError = new AccessibilityBridgeError(
      'no app semantics in tree',
      DEVICE_CONTENT_ROOT_EMPTY,
    );
    const dumpTree = jest.fn().mockRejectedValue(emptyError);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(
      dumpTreeWithRetry({ dumpTree }, { deviceId: 'dev' }, 2, sleep),
    ).rejects.toBe(emptyError);
    // 1 initial + 2 retries = 3 total invocations.
    expect(dumpTree).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('does NOT retry on non-empty-root errors (re-throws immediately)', async () => {
    const otherError = new AccessibilityBridgeError(
      'bridge crashed',
      'BRIDGE_CRASHED',
    );
    const dumpTree = jest.fn().mockRejectedValue(otherError);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(
      dumpTreeWithRetry({ dumpTree }, { deviceId: 'dev' }, 3, sleep),
    ).rejects.toBe(otherError);
    expect(dumpTree).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('does NOT retry on plain Error (only AccessibilityBridgeError with empty-root code)', async () => {
    const plainError = new Error('something else');
    const dumpTree = jest.fn().mockRejectedValue(plainError);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(
      dumpTreeWithRetry({ dumpTree }, { deviceId: 'dev' }, 3, sleep),
    ).rejects.toBe(plainError);
    expect(dumpTree).toHaveBeenCalledTimes(1);
  });
});
