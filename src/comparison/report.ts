import { ViewportCapture } from './cross-viewport';
import { PairwiseComparisonMatrix } from './visual-diff';
import { DOMDiffResult } from './dom-diff';

export interface ReportOptions {
  visualDiff?: PairwiseComparisonMatrix;
  domDiffs?: DOMDiffResult[];
}

export function generateMarkdownReport(captures: ViewportCapture[], url: string, options?: ReportOptions): string {
  const lines = [
    '# Cross-Viewport Comparison Report',
    '',
    `**URL:** ${url}`,
    `**Captured:** ${new Date().toISOString()}`,
    `**Devices:** ${captures.length}`,
    '',
    '## Device Summary',
    '',
    '| Device | Viewport | Breakpoint | Overflow | Load Time |',
    '|--------|----------|------------|----------|-----------|',
  ];

  for (const cap of captures) {
    const overflow = cap.metadata?.hasHorizontalOverflow ? 'YES' : 'No';
    lines.push(
      `| ${cap.device} | ${cap.viewport.w}x${cap.viewport.h} | ${cap.breakpoint} | ${overflow} | ${cap.timing}ms |`
    );
  }

  // Visual Diff Summary section
  if (options?.visualDiff) {
    const matrix = options.visualDiff;
    const hasFlagged = matrix.flaggedPairs.length > 0;
    const overallStatus = hasFlagged ? 'FAIL' : 'PASS';

    lines.push('', '## Visual Diff Summary', '');
    lines.push(`**Overall Result:** ${overallStatus}`);
    lines.push(`**Similarity Threshold:** ${(matrix.threshold * 100).toFixed(0)}%`);
    lines.push(`**Pairs Compared:** ${matrix.results.length}`);
    lines.push(`**Flagged Pairs:** ${matrix.flaggedPairs.length}`);

    if (matrix.results.length > 0) {
      lines.push('', '### Pairwise Similarity Matrix', '');
      lines.push('| Device A | Device B | Similarity | Diff % | Status |');
      lines.push('|----------|----------|------------|--------|--------|');

      for (const result of matrix.results) {
        const similarity = (result.similarity * 100).toFixed(1);
        const diffPct = result.diffPercentage.toFixed(1);
        const status = result.similarity >= matrix.threshold ? 'PASS' : 'FAIL';
        lines.push(`| ${result.deviceA} | ${result.deviceB} | ${similarity}% | ${diffPct}% | ${status} |`);
      }
    }

    if (matrix.flaggedPairs.length > 0) {
      lines.push('', '### Flagged Pairs', '');

      for (const flagged of matrix.flaggedPairs) {
        lines.push(`- **${flagged.deviceA}** vs **${flagged.deviceB}**: ${(flagged.similarity * 100).toFixed(1)}% similarity, ${flagged.diffPercentage.toFixed(1)}% pixels differ, ${flagged.diffRegions.length} diff region(s)`);
      }
    }
  }

  // DOM Differences section
  if (options?.domDiffs && options.domDiffs.length > 0) {
    const diffsWithIssues = options.domDiffs.filter(d => d.differences.length > 0);

    lines.push('', '## DOM Differences', '');
    lines.push(`**Pairs Analyzed:** ${options.domDiffs.length}`);
    lines.push(`**Pairs With Differences:** ${diffsWithIssues.length}`);

    for (const domDiff of options.domDiffs) {
      if (domDiff.differences.length === 0) continue;

      lines.push('', `### ${domDiff.deviceA} vs ${domDiff.deviceB}`, '');
      lines.push(domDiff.summary);
      lines.push('');
      lines.push('| Type | Selector | Severity | Description |');
      lines.push('|------|----------|----------|-------------|');

      for (const diff of domDiff.differences) {
        lines.push(`| ${diff.type} | ${diff.selector} | ${diff.severity} | ${diff.description} |`);
      }
    }
  }

  // Responsive Breakpoint Analysis section
  if (captures.length > 1) {
    const breakpointGroups = new Map<string, ViewportCapture[]>();
    for (const cap of captures) {
      const group = breakpointGroups.get(cap.breakpoint) ?? [];
      group.push(cap);
      breakpointGroups.set(cap.breakpoint, group);
    }

    if (breakpointGroups.size > 0) {
      lines.push('', '## Responsive Breakpoint Analysis', '');

      for (const [breakpoint, caps] of breakpointGroups) {
        const deviceList = caps.map(c => c.device).join(', ');
        const hasIssues = caps.some(c => c.metadata?.hasHorizontalOverflow || c.error);
        const statusIcon = hasIssues ? 'Issues detected' : 'OK';
        lines.push(`- **${breakpoint}** (${caps.length} device(s): ${deviceList}): ${statusIcon}`);
      }

      // Check for flagged visual diffs within same breakpoint
      if (options?.visualDiff) {
        const breakpointIssues: string[] = [];
        for (const [breakpoint, caps] of breakpointGroups) {
          const deviceNames = new Set(caps.map(c => c.device));
          const flaggedInBreakpoint = options.visualDiff.flaggedPairs.filter(
            fp => deviceNames.has(fp.deviceA) && deviceNames.has(fp.deviceB)
          );
          if (flaggedInBreakpoint.length > 0) {
            breakpointIssues.push(`- **${breakpoint}**: ${flaggedInBreakpoint.length} flagged pair(s) within same breakpoint`);
          }
        }
        if (breakpointIssues.length > 0) {
          lines.push('', '**Breakpoint Issues:**');
          lines.push(...breakpointIssues);
        }
      }
    }
  }

  // Issues section (existing)
  const issues = captures.filter(c => c.metadata?.hasHorizontalOverflow || c.error);
  if (issues.length > 0) {
    lines.push('', '## Issues Found', '');
    for (const issue of issues) {
      if (issue.error) lines.push(`- **${issue.device}**: ${issue.error}`);
      if (issue.metadata?.hasHorizontalOverflow) {
        lines.push(`- **${issue.device}**: Horizontal overflow (scrollWidth: ${issue.metadata.scrollWidth}px > viewport: ${issue.metadata.innerWidth}px)`);
      }
    }
  }

  return lines.join('\n');
}

export interface MCPContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export function formatForClaudeVision(captures: ViewportCapture[]): MCPContent[] {
  const content: MCPContent[] = [];

  // Text summary
  content.push({
    type: 'text',
    text: `Cross-viewport comparison of ${captures.length} devices. Analyze each screenshot for layout consistency, broken elements, overflow, and responsive issues.\n\n` +
      captures.map(c => `- ${c.device}: ${c.viewport.w}x${c.viewport.h} (Tailwind: ${c.breakpoint})`).join('\n'),
  });

  // Each screenshot
  for (const cap of captures) {
    if (cap.error) {
      content.push({ type: 'text', text: `[${cap.device} failed: ${cap.error}]` });
      continue;
    }

    content.push({
      type: 'text',
      text: `--- ${cap.device} (${cap.viewport.w}x${cap.viewport.h}, ${cap.breakpoint}) ---`,
    });

    content.push({
      type: 'image',
      data: cap.screenshot,
      mimeType: 'image/png',
    });
  }

  return content;
}
