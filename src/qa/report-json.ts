import { AuditReport } from './audit';
import { DetectorResult, DetectorIssue } from './types';

export interface QAReportDevice {
  name: string;
  viewport: { width: number; height: number };
}

export interface QAReportIssue {
  selector: string;
  element?: string;
  problem: string;
  fix: string;
}

export interface QAReportDetector {
  name: string;
  status: 'pass' | 'fail' | 'error';
  severity: string;
  scanned: number;
  issueCount: number;
  issues: QAReportIssue[];
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface QAReport {
  version: string;
  timestamp: string;
  url: string;
  device: QAReportDevice;
  duration: number;
  score: number;
  detectors: QAReportDetector[];
  summary: {
    total: number;
    pass: number;
    fail: number;
    error: number;
    issues: {
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
  };
}

function mapIssue(issue: DetectorIssue): QAReportIssue {
  return {
    selector: issue.selector,
    ...(issue.element ? { element: issue.element } : {}),
    problem: issue.problem,
    fix: issue.fix,
  };
}

function mapDetector(det: DetectorResult): QAReportDetector {
  const result: QAReportDetector = {
    name: det.detector,
    status: det.severity === 'error' ? 'error' : det.passed ? 'pass' : 'fail',
    severity: det.severity,
    scanned: det.totalScanned,
    issueCount: det.issueCount,
    issues: det.issues.map(mapIssue),
  };
  if (det.error) result.error = det.error;
  if (det.metadata) result.metadata = det.metadata;
  return result;
}

export function generateAuditJSON(report: AuditReport): QAReport {
  return {
    version: '1.0.0',
    timestamp: report.timestamp,
    url: report.url,
    device: {
      name: report.device,
      viewport: { width: report.viewport.w, height: report.viewport.h },
    },
    duration: report.duration,
    score: report.score,
    detectors: report.detectors.map(mapDetector),
    summary: {
      total: report.detectors.length,
      pass: report.detectors.filter(d => d.passed).length,
      fail: report.detectors.filter(d => !d.passed && d.severity !== 'error').length,
      error: report.detectors.filter(d => d.severity === 'error').length,
      issues: {
        critical: report.summary.critical,
        high: report.summary.high,
        medium: report.summary.medium,
        low: report.summary.low,
      },
    },
  };
}
