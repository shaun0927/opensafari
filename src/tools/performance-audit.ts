import { MCPServer, getWebKitClient } from '../mcp-server';
import { BrowserBackend } from '../types/browser-backend';
import {
  OBSERVER_SETUP_SCRIPT,
  COLLECT_METRICS_SCRIPT,
  aggregateVitals,
  buildResourceBreakdown,
  generateRecommendations,
  SingleRunResult,
  PerformanceAuditResult,
} from '../performance/web-vitals';

export function registerPerformanceAuditTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'performance_audit',
      description:
        'Measure Web Vitals (LCP, CLS, INP, FCP, TTFB), resource breakdown, and long tasks for a page. ' +
        'Runs multiple times for statistical significance and returns p50/p95 percentiles with mobile-specific recommendations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'URL to audit' },
          runs: { type: 'number', description: 'Number of measurement runs (default: 3, max: 10)' },
          waitAfterLoad: { type: 'number', description: 'Milliseconds to wait after load for CLS/INP (default: 5000)' },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client) {
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      }

      const url = params.url as string;
      const runCount = Math.min(Math.max(Math.round(Number(params.runs) || 3), 1), 10);
      const waitAfterLoad = Math.max(Number(params.waitAfterLoad) || 5000, 1000);

      const runResults: SingleRunResult[] = [];

      for (let i = 0; i < runCount; i++) {
        try {
          const result = await collectSingleRun(client, url, waitAfterLoad);
          runResults.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[performance_audit] Run ${i + 1}/${runCount} failed: ${msg}`);
        }
      }

      if (runResults.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: All measurement runs failed. Ensure the URL is accessible in Safari.' }],
          isError: true,
        };
      }

      const vitals = aggregateVitals(runResults.map(r => r.webVitals));
      const lastRun = runResults[runResults.length - 1];
      const resourceBreakdown = buildResourceBreakdown(lastRun.resources);
      const totalTransferSize = lastRun.resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
      const allLongTasks = runResults.flatMap(r => r.longTasks);

      const auditResult: PerformanceAuditResult = {
        webVitals: vitals,
        resourceBreakdown,
        longTasks: allLongTasks,
        totalTransferSize,
        domNodeCount: lastRun.domNodeCount,
        recommendations: [],
        runs: runResults.length,
      };

      auditResult.recommendations = generateRecommendations({
        ...auditResult,
        resources: lastRun.resources,
      });

      const markdown = formatAuditMarkdown(auditResult, url);

      return {
        content: [{
          type: 'text' as const,
          text: markdown + '\n\n---\n\nJSON Report:\n```json\n' + JSON.stringify(auditResult, null, 2) + '\n```',
        }],
      };
    },
  );
}

async function collectSingleRun(
  client: BrowserBackend,
  url: string,
  waitAfterLoad: number,
): Promise<SingleRunResult> {
  await client.evaluate(OBSERVER_SETUP_SCRIPT);
  await client.navigate({ url, waitUntil: 'load' });
  await new Promise(resolve => setTimeout(resolve, waitAfterLoad));

  const raw = await client.evaluate<{
    webVitals: { lcp: number | null; cls: number | null; inp: number | null; fcp: number | null; ttfb: number | null };
    resources: Array<{ name: string; type: string; duration: number; transferSize: number }>;
    longTasks: Array<{ duration: number; startTime: number }>;
    domNodeCount: number;
  }>(COLLECT_METRICS_SCRIPT);

  const resourceBreakdown = buildResourceBreakdown(raw.resources);
  const totalTransferSize = raw.resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);

  return {
    webVitals: raw.webVitals,
    resources: raw.resources,
    resourceBreakdown,
    longTasks: raw.longTasks,
    totalTransferSize,
    domNodeCount: raw.domNodeCount,
  };
}

function formatAuditMarkdown(result: PerformanceAuditResult, url: string): string {
  const lines: string[] = [];
  lines.push(`# Performance Audit: ${url}`);
  lines.push(`_${result.runs} run(s) — p50 / p95 percentiles_\n`);

  lines.push('## Web Vitals\n');
  lines.push('| Metric | p50 | p95 | Rating |');
  lines.push('|--------|-----|-----|--------|');
  const v = result.webVitals;
  lines.push(formatVitalRow('LCP', v.lcp, 'ms', 2500, 4000));
  lines.push(formatVitalRow('CLS', v.cls, '', 0.1, 0.25, true));
  lines.push(formatVitalRow('INP', v.inp, 'ms', 200, 500));
  lines.push(formatVitalRow('FCP', v.fcp, 'ms', 1800, 3000));
  lines.push(formatVitalRow('TTFB', v.ttfb, 'ms', 800, 1800));

  lines.push('\n## Resource Breakdown\n');
  const rb = result.resourceBreakdown;
  lines.push('| Type | Size |');
  lines.push('|------|------|');
  lines.push(`| Scripts | ${formatBytes(rb.scripts)} |`);
  lines.push(`| Styles | ${formatBytes(rb.styles)} |`);
  lines.push(`| Images | ${formatBytes(rb.images)} |`);
  lines.push(`| Fonts | ${formatBytes(rb.fonts)} |`);
  lines.push(`| Other | ${formatBytes(rb.other)} |`);
  lines.push(`| **Total** | **${formatBytes(result.totalTransferSize)}** |`);

  if (result.longTasks.length > 0) {
    lines.push('\n## Long Tasks (> 50ms)\n');
    lines.push('| # | Start Time | Duration |');
    lines.push('|---|------------|----------|');
    const sorted = [...result.longTasks].sort((a, b) => b.duration - a.duration).slice(0, 10);
    sorted.forEach((t, i) => {
      lines.push(`| ${i + 1} | ${Math.round(t.startTime)}ms | ${Math.round(t.duration)}ms |`);
    });
  }

  lines.push('\n## DOM\n');
  lines.push(`- Node count: **${result.domNodeCount}**`);

  if (result.recommendations.length > 0) {
    lines.push('\n## Recommendations\n');
    result.recommendations.forEach((r, i) => { lines.push(`${i + 1}. ${r}`); });
  } else {
    lines.push('\n## Recommendations\n');
    lines.push('All metrics are within acceptable thresholds. No issues detected.');
  }
  return lines.join('\n');
}

function formatVitalRow(
  name: string, vals: { p50: number | null; p95: number | null },
  unit: string, goodThreshold: number, poorThreshold: number, isDecimal = false,
): string {
  const fmt = (v: number | null) => {
    if (v === null) return 'N/A';
    return isDecimal ? v.toFixed(3) : `${Math.round(v)}${unit}`;
  };
  const rating = (v: number | null) => {
    if (v === null) return '-';
    if (v <= goodThreshold) return 'Good';
    if (v <= poorThreshold) return 'Needs Improvement';
    return 'Poor';
  };
  return `| ${name} | ${fmt(vals.p50)} | ${fmt(vals.p95)} | ${rating(vals.p95)} |`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
