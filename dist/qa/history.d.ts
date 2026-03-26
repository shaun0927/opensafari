import { AuditReport } from './audit.js';
export interface RegressionReport {
    currentScore: number;
    previousScore: number;
    scoreDelta: number;
    newIssues: Array<{
        detector: string;
        selector: string;
        problem: string;
        fingerprint: string;
    }>;
    fixedIssues: Array<{
        detector: string;
        selector: string;
        problem: string;
        fingerprint: string;
    }>;
    recurringIssues: Array<{
        detector: string;
        selector: string;
        problem: string;
        fingerprint: string;
    }>;
    summary: string;
}
export declare class QAHistory {
    private reportsDir;
    constructor(reportsDir?: string);
    save(report: AuditReport): Promise<string>;
    getLatest(url: string): Promise<AuditReport | null>;
    getPrevious(url: string): Promise<AuditReport | null>;
    detectRegressions(current: AuditReport, previous: AuditReport): Promise<RegressionReport>;
    getExitCode(report: AuditReport, options?: {
        failOnCritical?: boolean;
        failOnHigh?: boolean;
        minScore?: number;
    }): number;
    private buildFingerprints;
    private fingerprint;
    private sanitizeSite;
    private listReportFiles;
    private rotate;
}
//# sourceMappingURL=history.d.ts.map