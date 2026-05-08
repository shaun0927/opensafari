/**
 * Shared error classes for the webkit package.
 *
 * Extracted here to break the circular dependency between client.ts and
 * evaluate.ts: evaluate.ts threw EvaluationError but had to import it from
 * client.ts, which in turn imported evaluateValue from evaluate.ts.
 */

// ========== Error Classes ==========

/** Thrown when a WebSocket connection cannot be established or is lost. */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Thrown when a protocol command or navigation exceeds the allowed time. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Thrown when the WebKit Remote Debugging Protocol returns an error response. */
export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Thrown when a Runtime.evaluate call throws or rejects inside the page. */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}
