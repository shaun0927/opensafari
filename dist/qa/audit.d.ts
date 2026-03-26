import { BrowserBackend } from '../types/browser-backend.js';
import { DetectorResult, QAConfig } from './types.js';
import { SimulatorManager } from '../simulator/manager.js';
export interface AuditSummary {
    totalIssues: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    passed: number;
    failed: number;
    errors: number;
}
export interface AuditReport {
    url: string;
    device: string;
    viewport: {
        w: number;
        h: number;
    };
    timestamp: string;
    duration: number;
    score: number;
    summary: AuditSummary;
    detectors: DetectorResult[];
}
export declare class QAAudit {
    private client;
    private config;
    private simulator?;
    private deviceId?;
    private deviceInfo?;
    constructor(client: BrowserBackend, config?: QAConfig, simulator?: SimulatorManager | undefined, deviceId?: string | undefined, deviceInfo?: {
        name: string;
        w: number;
        h: number;
    } | undefined);
    runFullAudit(url?: string): Promise<AuditReport>;
    private calculateScore;
    private summarize;
}
//# sourceMappingURL=audit.d.ts.map