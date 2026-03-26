/**
 * Token bucket rate limiter for per-session request throttling.
 * Protects the server against request floods from runaway agents.
 */
export interface RateLimiterOptions {
    /** Maximum tokens (= max burst size). Default: 60 */
    maxTokens: number;
    /** Tokens refilled per second. Default: maxTokens / 60 (= 1/sec for 60/min) */
    refillRatePerSec: number;
}
export declare class TokenBucket {
    private tokens;
    private lastRefillAt;
    private lastUsedAt;
    private readonly maxTokens;
    private readonly refillRatePerSec;
    constructor(opts: RateLimiterOptions);
    /**
     * Try to consume one token.
     * Returns true if token was consumed; false if the bucket is empty.
     */
    consume(): boolean;
    /**
     * Returns the timestamp (ms since epoch) when this bucket was last used.
     */
    getLastUsedAt(): number;
    /**
     * Returns the number of seconds until the next token is available.
     * Returns 0 if tokens are available now.
     */
    retryAfterSec(): number;
    /**
     * Current token count (for monitoring/health).
     */
    get availableTokens(): number;
    private refill;
}
/**
 * Manages per-session rate limiters.
 * Creates a bucket for each session on first use; cleans up when sessions are removed.
 */
export declare class SessionRateLimiter {
    private buckets;
    private readonly options;
    constructor(maxRequestsPerMinute: number);
    /**
     * Check if a request from the given session is allowed.
     * Returns { allowed: true } or { allowed: false, retryAfterSec }.
     */
    check(sessionId: string): {
        allowed: true;
    } | {
        allowed: false;
        retryAfterSec: number;
    };
    /**
     * Remove a session's bucket (call on session cleanup).
     */
    removeSession(sessionId: string): void;
    /**
     * Remove buckets that have not been used for longer than maxIdleMs.
     * Call periodically to reclaim memory from abandoned sessions that never
     * received an explicit DELETE (e.g. clients that silently disconnected).
     * Returns the number of buckets removed.
     */
    sweep(maxIdleMs: number): number;
    /**
     * Number of tracked sessions (for monitoring).
     */
    get sessionCount(): number;
}
//# sourceMappingURL=rate-limiter.d.ts.map