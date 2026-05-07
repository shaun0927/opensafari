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
