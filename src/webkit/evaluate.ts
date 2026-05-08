/**
 * evaluate.ts — evaluateValue<T> helper for WebKit Runtime evaluation.
 *
 * Handles the three-step pattern required by WebKit Inspector:
 *   1. Runtime.evaluate with returnByValue:false (preserves objectId for Promises)
 *   2. Runtime.awaitPromise (as a separate command) for Promise results
 *   3. Runtime.callFunctionOn to serialize non-primitive object results
 *
 * (#706 4/5 — extracted from client.ts)
 */

import { EvaluationError } from './errors';

/**
 * Minimal interface for sending protocol commands needed by evaluateValue.
 * Using an interface avoids a circular dependency on WebKitClient.
 */
export interface EvaluateSender {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Evaluate a JS expression in the page context and return its value.
 *
 * - Handles Promise results via a separate Runtime.awaitPromise call (WebKit requirement).
 * - Serializes non-primitive object results via Runtime.callFunctionOn.
 * - Throws EvaluationError if the expression throws or the Promise rejects.
 *
 * @param sender   Object with a send() method (typically WebKitClient or BrowserCommands)
 * @param expression  JS expression string to evaluate
 * @param options.emulateUserGesture  Pass true for touch-dispatching scripts
 */
export async function evaluateValue<T = unknown>(
  sender: EvaluateSender,
  expression: string,
  options?: { emulateUserGesture?: boolean },
): Promise<T> {
  // Step 1: Evaluate with returnByValue:false to preserve objectId for Promises.
  // WebKit serializes Promises as {} when returnByValue:true, losing the objectId
  // needed for Runtime.awaitPromise.
  const result = await sender.send<{
    result: {
      type: string;
      subtype?: string;
      className?: string;
      value?: unknown;
      objectId?: string;
      description?: string;
    };
    wasThrown: boolean;
  }>('Runtime.evaluate', {
    expression,
    returnByValue: false,
    emulateUserGesture: options?.emulateUserGesture ?? false,
  });

  if (result.wasThrown) {
    throw new EvaluationError(result.result?.description ?? 'Evaluation failed');
  }

  // Step 2: If result is a Promise, use awaitPromise to get the resolved value.
  // WebKit Inspector may use subtype:'promise' OR className:'Promise' depending on version.
  // Note: awaitPromise blocks until the Promise settles. Never-resolving Promises
  // will block for the full send() timeout (DEFAULT_WEBKIT_SEND_TIMEOUT_MS, typically 15s).
  const isPromise =
    result.result?.type === 'object' &&
    result.result?.objectId &&
    (result.result?.subtype === 'promise' || result.result?.className === 'Promise');

  if (isPromise) {
    const awaited = await sender.send<{
      result: {
        type: string;
        value?: unknown;
        objectId?: string;
        description?: string;
      };
      wasThrown: boolean;
    }>('Runtime.awaitPromise', {
      promiseObjectId: result.result.objectId,
      returnByValue: true,
    });

    if (awaited.wasThrown) {
      throw new EvaluationError(awaited.result?.description ?? 'Promise rejected');
    }
    return awaited.result?.value as T;
  }

  // Step 3: For non-Promise object results, use callFunctionOn to serialize the value
  // without re-executing the expression (avoids double side effects).
  if (result.result?.objectId && result.result?.value === undefined) {
    const valued = await sender.send<{
      result: { type: string; value?: unknown; description?: string };
      wasThrown: boolean;
    }>('Runtime.callFunctionOn', {
      objectId: result.result.objectId,
      functionDeclaration: 'function() { return this; }',
      returnByValue: true,
    });
    return valued.result?.value as T;
  }

  return result.result?.value as T;
}
