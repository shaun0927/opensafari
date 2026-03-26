/**
 * Set the list of blocked domain patterns.
 * Supports glob patterns like "*.bank.com".
 */
export declare function setBlockedDomains(domains: string[]): void;
/**
 * Check whether a URL's domain is blocked by the configured blocklist.
 * Returns false (allowed) if no blocked_domains are configured.
 */
export declare function isDomainBlocked(url: string): boolean;
/**
 * Assert that the given URL is not blocked.
 * Throws a descriptive error if the domain is on the blocklist.
 */
export declare function assertDomainAllowed(url: string): void;
//# sourceMappingURL=domain-guard.d.ts.map