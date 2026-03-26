import { AuditReport } from './audit';

export function generateAuditMarkdown(report: AuditReport): string {
  const emoji = report.score >= 90 ? 'V' : report.score >= 70 ? '!' : 'X';
  const lines = [
    `## ${emoji} iOS QA Audit Report`,
    '',
    `**Score: ${report.score}/100** | Device: ${report.device} (${report.viewport.w}x${report.viewport.h}) | ${report.timestamp}`,
    `**URL:** ${report.url} | Duration: ${report.duration}ms`,
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| Critical | ${report.summary.critical} |`,
    `| High | ${report.summary.high} |`,
    `| Medium | ${report.summary.medium} |`,
    `| Low | ${report.summary.low} |`,
    `| Passed | ${report.summary.passed}/13 detectors |`,
  ];

  const failed = report.detectors.filter(d => !d.passed);
  if (failed.length > 0) {
    lines.push('', '### Issues Found', '');
    for (const det of failed) {
      lines.push(`#### [${det.severity.toUpperCase()}] ${det.detector} (${det.issueCount} issues)`);
      for (const issue of det.issues.slice(0, 5)) {
        lines.push(`- \`${issue.selector}\`: ${issue.problem}`);
        lines.push(`  - **Fix:** ${issue.fix}`);
      }
      if (det.issues.length > 5) lines.push(`- ... and ${det.issues.length - 5} more`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
