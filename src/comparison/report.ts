import { ViewportCapture } from './cross-viewport';

export function generateMarkdownReport(captures: ViewportCapture[], url: string): string {
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
