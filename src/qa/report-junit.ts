import { AuditReport } from './audit';

export interface JUnitOptions {
  /** Severities that map to <failure> elements (default: ['critical', 'high']) */
  failureSeverities?: string[];
  /** Severities that map to <skipped> elements (default: ['low']) */
  skippedSeverities?: string[];
  /** Test suite name (default: 'opensafari-qa') */
  suiteName?: string;
}

const DEFAULT_OPTIONS: Required<JUnitOptions> = {
  failureSeverities: ['critical', 'high'],
  skippedSeverities: ['low'],
  suiteName: 'opensafari-qa',
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateAuditJUnit(report: AuditReport, options?: JUnitOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const detectors = report.detectors;
  const totalTests = detectors.length;
  const failures = detectors.filter(
    d => !d.passed && opts.failureSeverities.includes(d.severity),
  ).length;
  const skipped = detectors.filter(
    d => !d.passed && opts.skippedSeverities.includes(d.severity),
  ).length;
  const errors = detectors.filter(d => d.severity === 'error').length;
  const time = (report.duration / 1000).toFixed(3);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(opts.suiteName)}" tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">`,
    `  <testsuite name="${escapeXml(report.device)}" tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${escapeXml(report.timestamp)}">`,
    `    <properties>`,
    `      <property name="url" value="${escapeXml(report.url)}" />`,
    `      <property name="device" value="${escapeXml(report.device)}" />`,
    `      <property name="viewport" value="${report.viewport.w}x${report.viewport.h}" />`,
    `      <property name="score" value="${report.score}" />`,
    `    </properties>`,
  ];

  for (const det of detectors) {
    const classname = `qa.detectors`;
    const detName = escapeXml(det.detector);

    if (det.severity === 'error') {
      lines.push(`    <testcase name="${detName}" classname="${classname}">`);
      lines.push(`      <error message="${escapeXml(det.error ?? 'Detector error')}" type="error">${escapeXml(det.error ?? '')}</error>`);
      lines.push(`    </testcase>`);
    } else if (!det.passed && opts.failureSeverities.includes(det.severity)) {
      const issueDetails = det.issues
        .map(i => `${i.selector}: ${i.problem}`)
        .join('\n');
      const message = `${det.issueCount} issue(s) found [${det.severity}]`;
      lines.push(`    <testcase name="${detName}" classname="${classname}">`);
      lines.push(`      <failure message="${escapeXml(message)}" type="${escapeXml(det.severity)}">${escapeXml(issueDetails)}</failure>`);
      lines.push(`    </testcase>`);
    } else if (!det.passed && opts.skippedSeverities.includes(det.severity)) {
      lines.push(`    <testcase name="${detName}" classname="${classname}">`);
      lines.push(`      <skipped message="${escapeXml(`${det.issueCount} low-severity issue(s)`)}" />`);
      lines.push(`    </testcase>`);
    } else {
      lines.push(`    <testcase name="${detName}" classname="${classname}" />`);
    }
  }

  lines.push(`  </testsuite>`);
  lines.push(`</testsuites>`);

  return lines.join('\n');
}
