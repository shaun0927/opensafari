/**
 * Race a promise against a timeout. Rejects with an OpenSafariTimeoutError if the timeout fires first.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T>;
//# sourceMappingURL=with-timeout.d.ts.map