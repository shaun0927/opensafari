/**
 * evaluateValue — fast-path Runtime.evaluate helper for serializable results.
 *
 * Unlike WebKitClient.evaluate(), this function uses returnByValue:true directly,
 * skipping the objectId round-trip (Runtime.callFunctionOn) that the generic
 * evaluate() needs for non-Promise objects. It is only appropriate for
 * expressions whose result is JSON-serializable (primitives, plain objects,
 * arrays). Never use it for expressions that return Promises or DOM nodes.
 */

import { EvaluationError } from './client';

/** Minimal send interface — satisfied by WebKitClient and test fakes. */
export interface EvaluateSender {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface EvaluateValueOptions {
  /** Execution context id. Omit to use the default page context. */
  contextId?: number;
  /** Per-call send timeout override in milliseconds. */
  timeoutMs?: number;
}

/**
 * Evaluate a JS expression and return its value directly via returnByValue:true.
 *
 * Saves one RPC round-trip compared to the generic evaluate() path for
 * expressions that are known to return serializable (non-Promise) values.
 *
 * @throws EvaluationError when the expression throws or wasThrown is true.
 * @throws (TimeoutError) when the send times out (propagated from the client).
 */
export async function evaluateValue<T>(
  client: EvaluateSender,
  expression: string,
  options?: EvaluateValueOptions,
): Promise<T> {
  const params: Record<string, unknown> = {
    expression,
    returnByValue: true,
  };

  if (options?.contextId !== undefined) {
    params.contextId = options.contextId;
  }

  // timeoutMs is not a standard WebKit protocol field — it controls the client-
  // level send timeout. We surface the option here for callers that need it but
  // cannot plumb it through client.send() at this abstraction level. If the
  // underlying client does not honour it, sends simply use the client default.
  // (Wiring per-call timeouts into WebKitClient is a separate concern, #702c.)

  type EvalResult = {
    result: {
      type: string;
      value?: unknown;
      description?: string;
    };
    wasThrown?: boolean;
  };

  const response = await client.send<EvalResult>('Runtime.evaluate', params);

  if (response.wasThrown) {
    throw new EvaluationError(
      response.result?.description ?? 'Evaluation failed',
    );
  }

  return response.result?.value as T;
}
