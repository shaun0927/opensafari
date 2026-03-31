import { BrowserBackend } from '../types/browser-backend';
import { annotateScreenshot, detectorResultToAnnotations, formatLegend } from '../comparison/annotator';
import type { AnnotationIssue, AnnotationResult } from '../comparison/annotator';
import { DetectorResult, QAConfig, applyIgnoreRules } from './types';
import { detectAutoZoom } from './detectors/auto-zoom';
import { detectTouchTargets } from './detectors/touch-targets';
import { detectHoverOnly } from './detectors/hover-only';
import { detectInputType } from './detectors/input-type';
import { detectSafeArea } from './detectors/safe-area';
import { detectKeyboardOverlap } from './detectors/keyboard-overlap';
import { detectHorizontalOverflow } from './detectors/horizontal-overflow';
import { detect100vh } from './detectors/vh100';
import { detectFixedStacking } from './detectors/fixed-stacking';
import { detectScrollLock } from './detectors/scroll-lock';
import { detectDarkMode } from './detectors/dark-mode';
import { detectOrientation } from './detectors/orientation';
import { detectPwaMeta } from './detectors/pwa-meta';
import { detectAccessibility } from './detectors/accessibility';
import { SimulatorManager } from '../simulator/manager';

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

export interface AnnotatedAuditReport extends AuditReport {
  annotatedScreenshot: string;
  legend: string;
}

export interface AuditReport {
  url: string;
  device: string;
  viewport: { w: number; h: number };
  timestamp: string;
  duration: number;
  score: number;
  summary: AuditSummary;
  detectors: DetectorResult[];
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
};

export class QAAudit {
  constructor(
    private client: BrowserBackend,
    private config: QAConfig = {},
    private simulator?: SimulatorManager,
    private deviceId?: string,
    private deviceInfo?: { name: string; w: number; h: number },
  ) {}

  async runFullAudit(url?: string): Promise<AuditReport> {
    if (url) await this.client.navigate({ url, waitUntil: 'load' });

    const currentUrl = await this.client.evaluate<string>('window.location.href');
    const startTime = Date.now();

    // Parallel: stateless detectors (11)
    const parallelResults = await Promise.allSettled([
      detectAutoZoom(this.client),
      detectTouchTargets(this.client),
      detectHoverOnly(this.client),
      detectInputType(this.client),
      detectSafeArea(this.client),
      detectHorizontalOverflow(this.client),
      detect100vh(this.client),
      detectFixedStacking(this.client),
      detectScrollLock(this.client),
      detectPwaMeta(this.client),
      detectAccessibility(this.client),
    ]);

    // Sequential: stateful detectors (3)
    const sequentialResults: PromiseSettledResult<DetectorResult>[] = [];
    try {
      sequentialResults.push({ status: 'fulfilled', value: await detectKeyboardOverlap(this.client) });
    } catch (e) {
      sequentialResults.push({ status: 'rejected', reason: e });
    }
    try {
      sequentialResults.push({ status: 'fulfilled', value: await detectDarkMode(this.client, this.simulator, this.deviceId) });
    } catch (e) {
      sequentialResults.push({ status: 'rejected', reason: e });
    }
    try {
      sequentialResults.push({ status: 'fulfilled', value: await detectOrientation(this.client, this.simulator, this.deviceId) });
    } catch (e) {
      sequentialResults.push({ status: 'rejected', reason: e });
    }

    // Combine + apply ignore rules
    const allSettled = [...parallelResults, ...sequentialResults];
    const allResults: DetectorResult[] = allSettled.map((r, _i) => {
      if (r.status === 'fulfilled') {
        return applyIgnoreRules(r.value, this.config);
      }
      return {
        detector: 'unknown',
        severity: 'error' as const,
        issues: [],
        passed: false,
        totalScanned: 0,
        issueCount: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    const score = this.calculateScore(allResults);
    const summary = this.summarize(allResults);

    return {
      url: currentUrl,
      device: this.deviceInfo?.name ?? 'unknown',
      viewport: { w: this.deviceInfo?.w ?? 0, h: this.deviceInfo?.h ?? 0 },
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      score,
      summary,
      detectors: allResults,
    };
  }

  async annotateReport(report: AuditReport, screenshotBase64: string, safeArea?: { top: number; bottom: number; left: number; right: number }): Promise<AnnotatedAuditReport> {
    const annotations: AnnotationIssue[] = [];
    for (const result of report.detectors) {
      if (result.passed || result.severity === 'pass' || result.severity === 'error') continue;
      const severity = result.severity as 'critical' | 'high' | 'medium' | 'low';
      const converted = detectorResultToAnnotations(result.detector, severity, result.issues);
      annotations.push(...converted);
    }

    const annotationResult = annotateScreenshot(screenshotBase64, annotations, {
      safeArea,
      showLabels: true,
    });

    return {
      ...report,
      annotatedScreenshot: annotationResult.annotatedImage,
      legend: formatLegend(annotationResult.legend),
    };
  }

  private calculateScore(results: DetectorResult[]): number {
    let penalty = 0;
    for (const result of results) {
      if (result.severity && result.severity !== 'pass' && result.severity !== 'error') {
        penalty += (SEVERITY_WEIGHTS[result.severity] ?? 0) * result.issueCount;
      }
    }
    return Math.max(0, 100 - penalty);
  }

  private summarize(results: DetectorResult[]): AuditSummary {
    return {
      totalIssues: results.reduce((s, r) => s + r.issueCount, 0),
      critical: results.filter(r => r.severity === 'critical').reduce((s, r) => s + r.issueCount, 0),
      high: results.filter(r => r.severity === 'high').reduce((s, r) => s + r.issueCount, 0),
      medium: results.filter(r => r.severity === 'medium').reduce((s, r) => s + r.issueCount, 0),
      low: results.filter(r => r.severity === 'low').reduce((s, r) => s + r.issueCount, 0),
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      errors: results.filter(r => r.severity === 'error').length,
    };
  }
}
