/**
 * Unit tests for FlutterVMClient.probeEvaluateCompile (issue #553).
 *
 * `probeEvaluateCompile` is the gate that stops `defaultFlutterVMResolver`
 * from picking Tier 0 when the connected VM cannot actually compile
 * `evaluate` expressions — the situation that applies to release builds and
 * any Flutter app launched via `xcrun simctl launch` instead of
 * `flutter run`. The behaviour we care about here is narrow:
 *
 *   - success on a debug-style VM → `{ available: true }`
 *   - VM Service code 113 (compile error) → `{ available: false,
 *     reason: 'compile-error-113' }`
 *   - any other rejection → `{ available: false, reason: 'other' }`
 *
 * We construct a minimal `FlutterVMClient` instance and replace its
 * `evaluate` method with a jest mock — no real socket, no real VM.
 */

import { FlutterVMClient } from '../../src/flutter/vm-service-client';

function makeClient(
  evaluate: jest.Mock,
): FlutterVMClient & { evaluate: jest.Mock } {
  const client = new FlutterVMClient();
  // `evaluate` is declared as a method on the class prototype; override it
  // on the instance so the probe reaches the mock without constructing a
  // real VM connection.
  (client as unknown as { evaluate: jest.Mock }).evaluate = evaluate;
  return client as FlutterVMClient & { evaluate: jest.Mock };
}

describe('FlutterVMClient.probeEvaluateCompile', () => {
  test('reports available=true when evaluate resolves', async () => {
    const evaluate = jest.fn().mockResolvedValue({
      type: '@Instance',
      kind: 'Int',
      valueAsString: '1',
    });
    const client = makeClient(evaluate);

    const result = await client.probeEvaluateCompile();

    expect(result).toEqual({ available: true });
    // Probe issues exactly one evaluate against the root library.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith('1');
  });

  test('classifies code-113 rejection as compile-error-113', async () => {
    // Error shape mirrors what `FlutterVMClient.callMethod` produces when
    // the underlying JSON-RPC call is rejected with RPCError code 113
    // ("Expression compilation error"). This is the signature we expect on
    // release builds and simctl-launched apps.
    const evaluate = jest.fn().mockRejectedValue(
      new Error(
        'VM Service error: Expression compilation error (code: 113)',
      ),
    );
    const client = makeClient(evaluate);

    const result = await client.probeEvaluateCompile();

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('compile-error-113');
      expect(result.message).toMatch(/\(code:\s*113\)/);
    }
  });

  test('classifies non-113 rejections as `other`', async () => {
    const evaluate = jest
      .fn()
      .mockRejectedValue(new Error('socket closed'));
    const client = makeClient(evaluate);

    const result = await client.probeEvaluateCompile();

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('other');
      expect(result.message).toBe('socket closed');
    }
  });

  test('non-Error thrown values still produce a structured reason', async () => {
    const evaluate = jest.fn().mockRejectedValue('plain string failure');
    const client = makeClient(evaluate);

    const result = await client.probeEvaluateCompile();

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('other');
      expect(result.message).toBe('plain string failure');
    }
  });
});
