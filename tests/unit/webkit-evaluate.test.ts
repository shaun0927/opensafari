/**
 * Tests for evaluateValue() fast-path helper.
 *
 * Covers:
 * - Primitive return (number, string, boolean).
 * - Plain object return.
 * - Error propagation when wasThrown:true.
 * - contextId option pass-through.
 * - Screenshot viewport query uses evaluateValue (1 RPC, not 2+).
 * - Existing evaluate() tests via WebKitClient still pass (regression).
 */

import { evaluateValue, EvaluateSender } from '../../src/webkit/evaluate';
import { EvaluationError } from '../../src/webkit/client';

// ---------------------------------------------------------------------------
// Minimal fake sender
// ---------------------------------------------------------------------------

function makeSender(impl: (method: string, params?: Record<string, unknown>) => unknown): EvaluateSender & { calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      return impl(method, params) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// evaluateValue unit tests
// ---------------------------------------------------------------------------

describe('evaluateValue', () => {
  it('returns a primitive number from a simple expression', async () => {
    const sender = makeSender(() => ({
      result: { type: 'number', value: 42 },
      wasThrown: false,
    }));

    const result = await evaluateValue<number>(sender, '21 + 21');
    expect(result).toBe(42);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].method).toBe('Runtime.evaluate');
    expect(sender.calls[0].params?.returnByValue).toBe(true);
    expect(sender.calls[0].params?.expression).toBe('21 + 21');
  });

  it('returns a string primitive', async () => {
    const sender = makeSender(() => ({
      result: { type: 'string', value: 'hello' },
      wasThrown: false,
    }));

    const result = await evaluateValue<string>(sender, '"hello"');
    expect(result).toBe('hello');
  });

  it('returns a boolean primitive', async () => {
    const sender = makeSender(() => ({
      result: { type: 'boolean', value: true },
      wasThrown: false,
    }));

    const result = await evaluateValue<boolean>(sender, 'true');
    expect(result).toBe(true);
  });

  it('returns a plain object', async () => {
    const payload = { w: 375, h: 812 };
    const sender = makeSender(() => ({
      result: { type: 'object', value: payload },
      wasThrown: false,
    }));

    const result = await evaluateValue<{ w: number; h: number }>(
      sender,
      '({w: window.innerWidth, h: window.innerHeight})',
    );
    expect(result).toEqual({ w: 375, h: 812 });
  });

  it('throws EvaluationError when wasThrown is true', async () => {
    const sender = makeSender(() => ({
      result: { type: 'object', description: 'ReferenceError: foo is not defined' },
      wasThrown: true,
    }));

    await expect(evaluateValue(sender, 'foo')).rejects.toThrow(EvaluationError);
    await expect(evaluateValue(sender, 'foo')).rejects.toThrow(
      'ReferenceError: foo is not defined',
    );
  });

  it('throws EvaluationError with fallback message when description is absent', async () => {
    const sender = makeSender(() => ({
      result: { type: 'object' },
      wasThrown: true,
    }));

    await expect(evaluateValue(sender, 'bad')).rejects.toThrow('Evaluation failed');
  });

  it('passes contextId in params when provided', async () => {
    const sender = makeSender(() => ({
      result: { type: 'number', value: 1 },
      wasThrown: false,
    }));

    await evaluateValue(sender, '1', { contextId: 7 });
    expect(sender.calls[0].params?.contextId).toBe(7);
  });

  it('does not include contextId in params when omitted', async () => {
    const sender = makeSender(() => ({
      result: { type: 'number', value: 1 },
      wasThrown: false,
    }));

    await evaluateValue(sender, '1');
    expect(sender.calls[0].params).not.toHaveProperty('contextId');
  });

  it('issues exactly one RPC for a serializable value (fast path)', async () => {
    const sender = makeSender(() => ({
      result: { type: 'object', value: { w: 390, h: 844 } },
      wasThrown: false,
    }));

    await evaluateValue(sender, '({w: window.innerWidth, h: window.innerHeight})');
    // Fast path: only Runtime.evaluate — no callFunctionOn or awaitPromise
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].method).toBe('Runtime.evaluate');
  });
});

// ---------------------------------------------------------------------------
// Screenshot viewport fast-path regression test
// ---------------------------------------------------------------------------

/**
 * Verify that WebKitClient.screenshot() uses evaluateValue for the viewport
 * query (1 RPC for the eval) rather than the 2-RPC generic evaluate() path
 * (Runtime.evaluate + Runtime.callFunctionOn).
 *
 * We mock client.send() directly to count calls and intercept protocol messages.
 */
describe('WebKitClient.screenshot viewport fast path', () => {
  it('issues exactly 1 RPC for viewport query + 1 for Page.snapshotRect (2 total)', async () => {
    // Import after describe so Jest module isolation works correctly.
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

    // Spy on send to intercept all protocol calls
    jest.spyOn(client as any, 'send').mockImplementation(
      async (...args: unknown[]) => {
        const method = args[0] as string;
        const params = args[1] as Record<string, unknown> | undefined;
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          // Return viewport dimensions
          return {
            result: { type: 'object', value: { w: 375, h: 812 } },
            wasThrown: false,
          };
        }
        if (method === 'Page.snapshotRect') {
          // Return a minimal valid dataURL
          const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
          return { dataURL: `data:image/png;base64,${pngBase64}` };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    );

    const buffer = await client.screenshot();

    expect(Buffer.isBuffer(buffer)).toBe(true);

    // Exactly 2 RPCs: 1 Runtime.evaluate (viewport via evaluateValue) + 1 Page.snapshotRect
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('Runtime.evaluate');
    expect(calls[0].params?.returnByValue).toBe(true);
    expect(calls[1].method).toBe('Page.snapshotRect');

    // The old generic evaluate() path would have issued a 3rd call:
    // Runtime.callFunctionOn to serialise the objectId. Verify that is absent.
    const callFunctionOnCalls = calls.filter(c => c.method === 'Runtime.callFunctionOn');
    expect(callFunctionOnCalls).toHaveLength(0);

    jest.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Navigation final state batch read — RPC count assertions
// ---------------------------------------------------------------------------

/**
 * Verify that navigate() reads the final navigation state (url, readyState,
 * status) with exactly ONE Runtime.evaluate call (via evaluateValue) rather
 * than the previous three separate evaluate() calls.
 *
 * Pre-change baseline issued:
 *   1. Runtime.evaluate (readyState check — finalReadyState)
 *   2. Runtime.evaluate + Runtime.callFunctionOn (currentUrl via evaluate())
 *   3. Runtime.evaluate + Runtime.callFunctionOn (status via evaluate())
 * = 5 RPCs for final state alone.
 *
 * Post-change: exactly 1 Runtime.evaluate (returnByValue:true) for all three.
 */
describe('WebKitClient.navigate final state batch read', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues exactly ONE Runtime.evaluate for url+readyState+status after navigation', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

    jest.spyOn(client as any, 'send').mockImplementation(
      async (...args: unknown[]) => {
        const method = args[0] as string;
        const params = args[1] as Record<string, unknown> | undefined;
        calls.push({ method, params });

        if (method === 'Page.enable' || method === 'Network.enable') {
          return {};
        }
        if (method === 'Page.navigate') {
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = (params?.expression as string) ?? '';
          // Polling loop call: plain readyState check (returnByValue:false or no returnByValue)
          if (!params?.returnByValue && expr.includes('readyState')) {
            return {
              result: { type: 'string', value: 'complete' },
              wasThrown: false,
            };
          }
          // Batch final state call (returnByValue:true)
          if (params?.returnByValue) {
            return {
              result: {
                type: 'object',
                value: { url: 'https://example.com/', readyState: 'complete', status: 200 },
              },
              wasThrown: false,
            };
          }
          // Generic evaluate() fallback (returnByValue:false)
          return {
            result: { type: 'string', value: 'complete' },
            wasThrown: false,
          };
        }
        return {};
      },
    );

    const result = await client.navigate({ url: 'https://example.com/' });

    expect(result.url).toBe('https://example.com/');
    expect(result.status).toBe(200);

    // Exactly one returnByValue:true Runtime.evaluate for the final batch state read.
    const batchEvals = calls.filter(
      c => c.method === 'Runtime.evaluate' && c.params?.returnByValue === true,
    );
    expect(batchEvals).toHaveLength(1);

    // No Runtime.callFunctionOn emitted for the final state read (old multi-RPC path).
    const callFnCalls = calls.filter(c => c.method === 'Runtime.callFunctionOn');
    expect(callFnCalls).toHaveLength(0);
  });

  it('batches url, readyState and status into a single expression (no separate calls)', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const batchExpressions: string[] = [];

    jest.spyOn(client as any, 'send').mockImplementation(
      async (...args: unknown[]) => {
        const method = args[0] as string;
        const params = args[1] as Record<string, unknown> | undefined;

        if (method === 'Page.enable' || method === 'Network.enable') return {};
        if (method === 'Page.navigate') return {};
        if (method === 'Runtime.evaluate') {
          const expr = (params?.expression as string) ?? '';
          if (params?.returnByValue) {
            batchExpressions.push(expr);
            return {
              result: {
                type: 'object',
                value: { url: 'https://test.example/', readyState: 'complete', status: 404 },
              },
              wasThrown: false,
            };
          }
          return { result: { type: 'string', value: 'complete' }, wasThrown: false };
        }
        return {};
      },
    );

    const result = await client.navigate({ url: 'https://test.example/' });

    // The single batch expression must reference all three fields.
    expect(batchExpressions).toHaveLength(1);
    const expr = batchExpressions[0];
    expect(expr).toMatch(/readyState/);
    expect(expr).toMatch(/document\.URL/);
    expect(expr).toMatch(/responseStatus/);

    // Correct values from the batched result propagate to NavigateResult.
    expect(result.url).toBe('https://test.example/');
    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Domain enable dedup — no duplicate protocol round-trips
// ---------------------------------------------------------------------------

/**
 * Verify that enableDomain() and enableDomainForTarget() skip the protocol
 * round-trip when a domain is already enabled for the same target/connection.
 *
 * Acceptance criteria from issue #702 b:
 *   - Calling Page.enable twice for the same (global) connection → 1 RPC.
 *   - Calling Page.enable twice for the same target via enableDomainForTarget → 1 RPC.
 *   - After target disconnect (targetDestroyed), enabled-domain cache is cleared
 *     so a new target for the same id re-enables fresh.
 */
describe('WebKitClient domain enable dedup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enableDomain skips the second Page.enable call for the same global connection', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendCalls: string[] = [];
    jest.spyOn(client as any, 'send').mockImplementation(async (...args: unknown[]) => {
      sendCalls.push(args[0] as string);
      return {};
    });

    await (client as any).enableDomain('Page');
    await (client as any).enableDomain('Page'); // second call — must be no-op

    const pageEnableCalls = sendCalls.filter(m => m === 'Page.enable');
    expect(pageEnableCalls).toHaveLength(1);
  });

  it('enableDomain allows different domains independently', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendCalls: string[] = [];
    jest.spyOn(client as any, 'send').mockImplementation(async (...args: unknown[]) => {
      sendCalls.push(args[0] as string);
      return {};
    });

    await (client as any).enableDomain('Page');
    await (client as any).enableDomain('Network');
    await (client as any).enableDomain('Page'); // duplicate — no-op
    await (client as any).enableDomain('Network'); // duplicate — no-op

    expect(sendCalls.filter(m => m === 'Page.enable')).toHaveLength(1);
    expect(sendCalls.filter(m => m === 'Network.enable')).toHaveLength(1);
  });

  it('enableDomainForTarget skips the second enable for the same domain+target', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendToCalls: Array<{ method: string; targetId: string | null | undefined }> = [];
    jest.spyOn(client as any, 'sendToTarget').mockImplementation(
      async (...args: unknown[]) => {
        sendToCalls.push({ method: args[0] as string, targetId: args[2] as string });
        return {};
      },
    );

    await (client as any).enableDomainForTarget('Page', 'target-abc');
    await (client as any).enableDomainForTarget('Page', 'target-abc'); // duplicate — no-op

    const pageEnableCalls = sendToCalls.filter(c => c.method === 'Page.enable' && c.targetId === 'target-abc');
    expect(pageEnableCalls).toHaveLength(1);
  });

  it('enableDomainForTarget allows same domain on different targets independently', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendToCalls: Array<{ method: string; targetId: string | null | undefined }> = [];
    jest.spyOn(client as any, 'sendToTarget').mockImplementation(
      async (...args: unknown[]) => {
        sendToCalls.push({ method: args[0] as string, targetId: args[2] as string });
        return {};
      },
    );

    await (client as any).enableDomainForTarget('Page', 'target-1');
    await (client as any).enableDomainForTarget('Page', 'target-2');
    await (client as any).enableDomainForTarget('Page', 'target-1'); // duplicate for target-1 — no-op

    expect(sendToCalls.filter(c => c.targetId === 'target-1')).toHaveLength(1);
    expect(sendToCalls.filter(c => c.targetId === 'target-2')).toHaveLength(1);
  });

  it('enabled-domain cache is cleared for a target when it is destroyed', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendToCalls: Array<{ method: string; targetId: string | null | undefined }> = [];
    jest.spyOn(client as any, 'sendToTarget').mockImplementation(
      async (...args: unknown[]) => {
        sendToCalls.push({ method: args[0] as string, targetId: args[2] as string });
        return {};
      },
    );

    // Enable Page for target-xyz once.
    await (client as any).enableDomainForTarget('Page', 'target-xyz');
    expect(sendToCalls.filter(c => c.method === 'Page.enable')).toHaveLength(1);

    // Simulate target destruction — the cache for this target should be cleared.
    (client as any).handleMessage(
      JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'target-xyz' } }),
    );

    // After destruction, enabling the same domain should issue a new RPC (fresh target).
    await (client as any).enableDomainForTarget('Page', 'target-xyz');
    expect(sendToCalls.filter(c => c.method === 'Page.enable')).toHaveLength(2);
  });

  it('enableDomainForTarget cleans up cache entry when sendToTarget rejects on first enable', async () => {
    // Regression: an invalid/closed targetId never receives Target.targetDestroyed,
    // so the freshly-created Set must be removed by the failure path itself —
    // otherwise enabledDomainsPerTarget grows without bound for callers retrying
    // unrelated targets.
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    jest.spyOn(client as any, 'sendToTarget').mockRejectedValue(
      new Error('No target with given id'),
    );

    await expect(
      (client as any).enableDomainForTarget('Page', 'invalid-target'),
    ).rejects.toThrow('No target with given id');

    const enabledForInvalid = (client as any).getEnabledDomainsForTarget('invalid-target');
    expect(enabledForInvalid.size).toBe(0);
    // The internal map must NOT retain an entry for the invalid target.
    expect((client as any).enabledDomainsPerTarget.has('invalid-target')).toBe(false);
  });

  it('enableDomainForTarget preserves prior entries when a later enable fails', async () => {
    const { WebKitClient } = await import('../../src/webkit/client');

    const client = new WebKitClient({ host: 'localhost', port: 9221 });

    const sendToTargetSpy = jest.spyOn(client as any, 'sendToTarget')
      .mockResolvedValueOnce({}) // Page.enable succeeds
      .mockRejectedValueOnce(new Error('domain rejected')); // Network.enable fails

    await (client as any).enableDomainForTarget('Page', 'target-keep');
    await expect(
      (client as any).enableDomainForTarget('Network', 'target-keep'),
    ).rejects.toThrow('domain rejected');

    // Prior successful Page.enable entry survives the second-call failure.
    const enabled = (client as any).getEnabledDomainsForTarget('target-keep');
    expect(enabled.has('Page')).toBe(true);
    expect(enabled.has('Network')).toBe(false);
    expect(sendToTargetSpy).toHaveBeenCalledTimes(2);
  });
});
