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

export function applyIgnoreRules(result: DetectorResult, config: QAConfig): DetectorResult {
  const ignores = config.ignore?.filter(r => r.detector === result.detector) ?? [];
  if (ignores.length > 0) {
    result.issues = result.issues.filter(issue =>
      !ignores.some(ign => issue.selector.includes(ign.selector))
    );
    result.issueCount = result.issues.length;
    result.passed = result.issueCount === 0;
    if (result.passed) result.severity = 'pass';
  }
  return result;
}
