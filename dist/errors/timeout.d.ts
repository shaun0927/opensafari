/**
 * Typed timeout error for OpenSafari.
 * Replaces fragile string-based timeout detection across the codebase.
 */
export declare class OpenSafariTimeoutError extends Error {
    /** Whether the operation may have produced useful partial state (e.g., partial DOM load). */
    readonly recoverable: boolean;
    /** Original operation label for diagnostics. */
    readonly label: string;
    /** Timeout duration in milliseconds. */
    readonly timeoutMs: number;
    constructor(label: string, timeoutMs: number, recoverable?: boolean);
}
/**
 * Type guard for timeout errors. Checks for:
 * 1. OpenSafariTimeoutError instances (preferred)
 * 2. Legacy string-based patterns including "timed out" messages
 */
export declare function isTimeoutError(error: unknown): error is OpenSafariTimeoutError | Error;
//# sourceMappingURL=timeout.d.ts.map