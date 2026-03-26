/**
 * Typed timeout error for OpenSafari.
 * Replaces fragile string-based timeout detection across the codebase.
 */
export class OpenSafariTimeoutError extends Error {
  /** Whether the operation may have produced useful partial state (e.g., partial DOM load). */
  readonly recoverable: boolean;
  /** Original operation label for diagnostics. */
  readonly label: string;
  /** Timeout duration in milliseconds. */
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number, recoverable = false) {
    super(`${label} timed out after ${timeoutMs}ms`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'OpenSafariTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.recoverable = recoverable;
  }
}

/**
 * Type guard for timeout errors. Checks for:
 * 1. OpenSafariTimeoutError instances (preferred)
 * 2. Legacy string-based patterns including "timed out" messages
 */
export function isTimeoutError(error: unknown): error is OpenSafariTimeoutError | Error {
  if (error instanceof OpenSafariTimeoutError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timed out');
  }
  return false;
}
