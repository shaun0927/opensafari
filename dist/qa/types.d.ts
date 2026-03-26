export interface DetectorIssue {
    selector: string;
    element?: string;
    problem: string;
    fix: string;
    [key: string]: unknown;
}
export interface DetectorResult {
    detector: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'pass' | 'error';
    issues: DetectorIssue[];
    passed: boolean;
    totalScanned: number;
    issueCount: number;
    metadata?: Record<string, unknown>;
    error?: string;
}
export interface QAConfig {
    thresholds?: {
        touchTargetMinSize?: number;
        inputMinFontSize?: number;
    };
    ignore?: Array<{
        detector: string;
        selector: string;
    }>;
}
export declare function applyIgnoreRules(result: DetectorResult, config: QAConfig): DetectorResult;
//# sourceMappingURL=types.d.ts.map