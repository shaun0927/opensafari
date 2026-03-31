import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditReport } from './audit';
import { DetectorResult, DetectorIssue } from './types';
import { QAHistory, RegressionReport } from './history';

export interface HtmlReportOptions {
  /** Include score trend chart from history (default: true) */
  includeTrend?: boolean;
  /** Maximum history entries for trend chart (default: 10) */
  maxTrendEntries?: number;
  /** Output directory (default: ~/.opensafari/reports/html) */
  outputDir?: string;
}

interface TrendEntry {
  timestamp: string;
  score: number;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  pass: '#16a34a',
  error: '#6b7280',
};

const SEVERITY_BG: Record<string, string> = {
  critical: '#fef2f2',
  high: '#fff7ed',
  medium: '#fefce8',
  low: '#eff6ff',
  pass: '#f0fdf4',
  error: '#f9fafb',
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scoreColor(score: number): string {
  if (score >= 90) return '#16a34a';
  if (score >= 70) return '#ca8a04';
  return '#dc2626';
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Needs Work';
  return 'Critical';
}

function generateSvgTrendChart(entries: TrendEntry[]): string {
  if (entries.length < 2) return '';

  const width = 600;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const scores = entries.map((e) => e.score);
  const minScore = Math.max(0, Math.min(...scores) - 10);
  const maxScore = Math.min(100, Math.max(...scores) + 10);
  const range = maxScore - minScore || 1;

  const points = entries.map((e, i) => {
    const x = padding.left + (i / (entries.length - 1)) * chartW;
    const y = padding.top + chartH - ((e.score - minScore) / range) * chartH;
    return { x, y, score: e.score, timestamp: e.timestamp };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const areaPath = [
    `M ${points[0].x.toFixed(1)},${(padding.top + chartH).toFixed(1)}`,
    ...points.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `L ${points[points.length - 1].x.toFixed(1)},${(padding.top + chartH).toFixed(1)}`,
    'Z',
  ].join(' ');

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let s = Math.ceil(minScore / 10) * 10; s <= maxScore; s += 10) {
    const y = padding.top + chartH - ((s - minScore) / range) * chartH;
    gridLines.push(
      `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-dasharray="4,4"/>`,
    );
    yLabels.push(
      `<text x="${padding.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${s}</text>`,
    );
  }

  const xLabels = points
    .filter(
      (_, i) =>
        i === 0 || i === points.length - 1 || entries.length <= 5 || i % Math.ceil(entries.length / 5) === 0,
    )
    .map((p) => {
      const date = new Date(p.timestamp);
      const label = `${date.getMonth() + 1}/${date.getDate()}`;
      return `<text x="${p.x.toFixed(1)}" y="${height - 5}" text-anchor="middle" font-size="10" fill="#6b7280">${label}</text>`;
    });

  const dots = points.map(
    (p) =>
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${scoreColor(p.score)}" stroke="white" stroke-width="2"/>` +
      `<title>${p.score}/100 - ${new Date(p.timestamp).toLocaleDateString()}</title>`,
  );

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;">
      <rect width="${width}" height="${height}" fill="white" rx="8"/>
      ${gridLines.join('\n      ')}
      ${yLabels.join('\n      ')}
      ${xLabels.join('\n      ')}
      <path d="${areaPath}" fill="url(#trendGradient)" opacity="0.3"/>
      <polyline points="${polyline}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots.join('\n      ')}
      <defs>
        <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
        </linearGradient>
      </defs>
    </svg>`;
}

function generateIssueCard(detector: DetectorResult): string {
  const color = SEVERITY_COLORS[detector.severity] ?? '#6b7280';
  const bg = SEVERITY_BG[detector.severity] ?? '#f9fafb';

  const issueRows = detector.issues
    .slice(0, 10)
    .map(
      (issue: DetectorIssue) => `
        <div style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">
          <code style="font-size:12px;color:#374151;background:#f3f4f6;padding:2px 6px;border-radius:3px;">${escapeHtml(issue.selector)}</code>
          <p style="margin:4px 0 2px;font-size:13px;color:#374151;">${escapeHtml(issue.problem)}</p>
          <p style="margin:0;font-size:12px;color:#16a34a;">Fix: ${escapeHtml(issue.fix)}</p>
        </div>`,
    )
    .join('');

  const overflow =
    detector.issues.length > 10
      ? `<div style="padding:8px 12px;font-size:12px;color:#6b7280;">... and ${detector.issues.length - 10} more issues</div>`
      : '';

  return `
      <div style="border:1px solid ${color}33;border-radius:8px;margin-bottom:12px;overflow:hidden;">
        <div style="background:${bg};padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="this.parentElement.querySelector('.issue-body').classList.toggle('collapsed')">
          <div>
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${color};color:white;font-size:11px;font-weight:600;text-transform:uppercase;margin-right:8px;">${escapeHtml(detector.severity)}</span>
            <span style="font-weight:600;color:#111827;">${escapeHtml(detector.detector)}</span>
          </div>
          <span style="font-size:13px;color:#6b7280;">${detector.issueCount} issue${detector.issueCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="issue-body">
          ${issueRows}
          ${overflow}
        </div>
      </div>`;
}

function generateScoreRing(score: number): string {
  const color = scoreColor(score);
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (score / 100) * circumference;

  return `
    <svg width="140" height="140" viewBox="0 0 140 140">
      <circle cx="70" cy="70" r="54" fill="none" stroke="#e5e7eb" stroke-width="12"/>
      <circle cx="70" cy="70" r="54" fill="none" stroke="${color}" stroke-width="12"
        stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        stroke-linecap="round" transform="rotate(-90 70 70)"/>
      <text x="70" y="64" text-anchor="middle" font-size="32" font-weight="700" fill="${color}">${score}</text>
      <text x="70" y="84" text-anchor="middle" font-size="12" fill="#6b7280">${scoreLabel(score)}</text>
    </svg>`;
}

function generateSummaryCards(report: AuditReport): string {
  const cards = [
    { label: 'Critical', count: report.summary.critical, color: SEVERITY_COLORS.critical },
    { label: 'High', count: report.summary.high, color: SEVERITY_COLORS.high },
    { label: 'Medium', count: report.summary.medium, color: SEVERITY_COLORS.medium },
    { label: 'Low', count: report.summary.low, color: SEVERITY_COLORS.low },
    { label: 'Passed', count: report.summary.passed, color: SEVERITY_COLORS.pass },
  ];

  return cards
    .map(
      (c) => `
      <div style="text-align:center;padding:16px;background:white;border-radius:8px;border:1px solid #e5e7eb;min-width:100px;">
        <div style="font-size:28px;font-weight:700;color:${c.color};">${c.count}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">${c.label}</div>
      </div>`,
    )
    .join('');
}

function generateDeviceInfo(report: AuditReport): string {
  return `
    <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:#374151;">
      <div><strong>Device:</strong> ${escapeHtml(report.device)}</div>
      <div><strong>Viewport:</strong> ${report.viewport.w}x${report.viewport.h}</div>
      <div><strong>URL:</strong> <a href="${escapeHtml(report.url)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(report.url)}</a></div>
      <div><strong>Time:</strong> ${new Date(report.timestamp).toLocaleString()}</div>
      <div><strong>Duration:</strong> ${(report.duration / 1000).toFixed(1)}s</div>
    </div>`;
}

function generateRegressionSection(regression: RegressionReport): string {
  const trendIcon = regression.scoreDelta > 0 ? '&#9650;' : regression.scoreDelta < 0 ? '&#9660;' : '&#9644;';
  const trendColor = regression.scoreDelta > 0 ? '#16a34a' : regression.scoreDelta < 0 ? '#dc2626' : '#6b7280';

  let html = `
    <div style="margin-top:32px;">
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:16px;">Regression Analysis</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        <div style="padding:12px 20px;background:white;border-radius:8px;border:1px solid #e5e7eb;">
          <span style="font-size:24px;font-weight:700;color:${trendColor};">${trendIcon} ${regression.scoreDelta >= 0 ? '+' : ''}${regression.scoreDelta}</span>
          <div style="font-size:12px;color:#6b7280;">Score Delta</div>
        </div>
        <div style="padding:12px 20px;background:white;border-radius:8px;border:1px solid #e5e7eb;">
          <span style="font-size:24px;font-weight:700;color:#16a34a;">${regression.fixedIssues.length}</span>
          <div style="font-size:12px;color:#6b7280;">Fixed</div>
        </div>
        <div style="padding:12px 20px;background:white;border-radius:8px;border:1px solid #e5e7eb;">
          <span style="font-size:24px;font-weight:700;color:#dc2626;">${regression.newIssues.length}</span>
          <div style="font-size:12px;color:#6b7280;">New</div>
        </div>
        <div style="padding:12px 20px;background:white;border-radius:8px;border:1px solid #e5e7eb;">
          <span style="font-size:24px;font-weight:700;color:#6b7280;">${regression.recurringIssues.length}</span>
          <div style="font-size:12px;color:#6b7280;">Recurring</div>
        </div>
      </div>`;

  if (regression.newIssues.length > 0) {
    html += `
      <h3 style="font-size:14px;font-weight:600;color:#dc2626;margin:12px 0 8px;">New Issues</h3>
      <ul style="margin:0;padding-left:20px;">
        ${regression.newIssues
          .slice(0, 10)
          .map(
            (i) =>
              `<li style="margin-bottom:4px;font-size:13px;"><strong>${escapeHtml(i.detector)}</strong>: ${escapeHtml(i.selector)} - ${escapeHtml(i.problem)}</li>`,
          )
          .join('')}
      </ul>`;
  }

  if (regression.fixedIssues.length > 0) {
    html += `
      <h3 style="font-size:14px;font-weight:600;color:#16a34a;margin:12px 0 8px;">Fixed Issues</h3>
      <ul style="margin:0;padding-left:20px;">
        ${regression.fixedIssues
          .slice(0, 10)
          .map(
            (i) =>
              `<li style="margin-bottom:4px;font-size:13px;"><strong>${escapeHtml(i.detector)}</strong>: ${escapeHtml(i.selector)} - ${escapeHtml(i.problem)}</li>`,
          )
          .join('')}
      </ul>`;
  }

  html += '</div>';
  return html;
}

export function generateAuditHtml(
  report: AuditReport,
  options?: {
    trendEntries?: TrendEntry[];
    regression?: RegressionReport;
    screenshotBase64?: string;
    annotatedScreenshotBase64?: string;
  },
): string {
  const failed = report.detectors.filter((d) => !d.passed);
  const passed = report.detectors.filter((d) => d.passed);

  const trendChart =
    options?.trendEntries && options.trendEntries.length >= 2
      ? generateSvgTrendChart(options.trendEntries)
      : '';

  const regressionSection = options?.regression ? generateRegressionSection(options.regression) : '';

  const screenshotSection = options?.screenshotBase64 ? `
    <div class="section">
      <h2>Page Screenshot</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:280px;">
          <h3 style="font-size:14px;font-weight:600;margin-bottom:8px;">Original</h3>
          <img src="data:image/png;base64,${options.screenshotBase64}"
               style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;"
               alt="Page screenshot"/>
        </div>
        ${options?.annotatedScreenshotBase64 ? `
        <div style="flex:1;min-width:280px;">
          <h3 style="font-size:14px;font-weight:600;margin-bottom:8px;">Annotated Issues</h3>
          <img src="data:image/png;base64,${options.annotatedScreenshotBase64}"
               style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;"
               alt="Annotated screenshot with issues"/>
        </div>` : ''}
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Audit Report - ${escapeHtml(report.url)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; color: #111827; line-height: 1.5; }
    .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
    .header { margin-bottom: 32px; }
    .header h1 { font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 8px; }
    .dashboard { display: flex; align-items: center; gap: 32px; margin: 24px 0; flex-wrap: wrap; }
    .summary-cards { display: flex; gap: 12px; flex-wrap: wrap; flex: 1; }
    .section { margin-top: 32px; }
    .section h2 { font-size: 20px; font-weight: 600; color: #111827; margin-bottom: 16px; }
    .collapsed { display: none !important; }
    .passed-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .passed-badge { padding: 4px 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px; font-size: 12px; color: #16a34a; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
    @media (max-width: 640px) {
      .dashboard { flex-direction: column; align-items: flex-start; }
      .summary-cards { width: 100%; }
    }
    @media print { body { background: white; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>iOS QA Audit Report</h1>
      ${generateDeviceInfo(report)}
    </div>

    <div class="dashboard">
      ${generateScoreRing(report.score)}
      <div class="summary-cards">
        ${generateSummaryCards(report)}
      </div>
    </div>

    ${screenshotSection}

    ${trendChart ? `
    <div class="section">
      <h2>Score Trend</h2>
      ${trendChart}
    </div>` : ''}

    ${regressionSection}

    ${failed.length > 0 ? `
    <div class="section">
      <h2>Issues Found (${report.summary.totalIssues})</h2>
      ${failed.map((d) => generateIssueCard(d)).join('')}
    </div>` : ''}

    ${passed.length > 0 ? `
    <div class="section">
      <h2>Passed Detectors (${passed.length}/13)</h2>
      <div class="passed-list">
        ${passed.map((d) => `<span class="passed-badge">${escapeHtml(d.detector)}</span>`).join('')}
      </div>
    </div>` : ''}

    <div class="footer">
      Generated by OpenSafari QA &middot; ${new Date(report.timestamp).toISOString()}
    </div>
  </div>
</body>
</html>`;
}

export async function saveHtmlReport(
  report: AuditReport,
  options?: HtmlReportOptions & {
    screenshotBase64?: string;
    annotatedScreenshotBase64?: string;
  },
): Promise<string> {
  const opts = {
    includeTrend: true,
    maxTrendEntries: 10,
    outputDir: path.join(os.homedir(), '.opensafari', 'reports', 'html'),
    ...options,
  };

  let trendEntries: TrendEntry[] | undefined;
  let regression: RegressionReport | undefined;

  if (opts.includeTrend) {
    const history = new QAHistory();
    const previous = await history.getPrevious(report.url);

    if (previous) {
      regression = await history.detectRegressions(report, previous);
    }

    trendEntries = await loadTrendEntries(report.url, opts.maxTrendEntries);
  }

  const html = generateAuditHtml(report, {
    trendEntries,
    regression,
    screenshotBase64: options?.screenshotBase64,
    annotatedScreenshotBase64: options?.annotatedScreenshotBase64,
  });

  await fs.mkdir(opts.outputDir, { recursive: true });
  const filename = `report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
  const filePath = path.join(opts.outputDir, filename);
  await fs.writeFile(filePath, html, 'utf-8');

  return filePath;
}

async function loadTrendEntries(url: string, max: number): Promise<TrendEntry[]> {
  const entries: TrendEntry[] = [];
  const reportsDir = path.join(os.homedir(), '.opensafari', 'reports');
  const hostname = sanitizeHostname(url);
  const siteDir = path.join(reportsDir, hostname);

  try {
    const files = await fs.readdir(siteDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().slice(-max);

    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(path.join(siteDir, file), 'utf-8');
        const report: AuditReport = JSON.parse(content);
        entries.push({ timestamp: report.timestamp, score: report.score });
      } catch {
        /* skip corrupt files */
      }
    }
  } catch {
    /* no history directory yet */
  }

  return entries;
}

function sanitizeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}
