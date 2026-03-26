/**
 * Content Sanitizer - Strips hidden/invisible content from page output
 * to mitigate indirect prompt injection attacks.
 *
 * Attack vector: Malicious websites embed invisible instructions (hidden text,
 * HTML comments, zero-width characters) that the LLM processes as if they were
 * legitimate user-visible content, potentially executing unauthorized actions.
 *
 * This sanitizer runs on read_page output before it reaches the LLM.
 *
 * @see https://owasp.org/www-project-top-10-for-large-language-model-applications/
 * @see https://openai.com/index/hardening-atlas-against-prompt-injection/
 */
export interface SanitizeResult {
    /** Sanitized text output */
    text: string;
    /** Number of suspicious patterns detected */
    suspiciousPatternCount: number;
    /** Whether any content was removed */
    contentRemoved: boolean;
    /** Summary of what was removed/flagged for the LLM's awareness */
    sanitizationNote: string;
}
/**
 * Sanitize page content to remove hidden/invisible elements that could
 * carry prompt injection payloads.
 *
 * This is a defense-in-depth measure — it reduces the attack surface but
 * cannot fully prevent prompt injection (an architecturally unsolvable problem).
 */
export declare function sanitizeContent(text: string): SanitizeResult;
//# sourceMappingURL=content-sanitizer.d.ts.map