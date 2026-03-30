import { generateAuditHtml } from '../../src/qa/report-html';
import { AuditReport } from '../../src/qa/audit';

function mockReport(overrides?: Partial<AuditReport>): AuditReport {
  return {
    url: 'https://example.com',
    device: 'iPhone 15 Pro',
    viewport: { w: 393, h: 852 },
    timestamp: '2026-03-31T00:00:00.000Z',
    duration: 4500,
    score: 78,
    summary: {
      totalIssues: 8,
      critical: 1,
      high: 2,
      medium: 3,
      low: 2,
      passed: 10,
      failed: 3,
      errors: 0,
    },
    detectors: [
      {
        detector: 'touch-targets',
        severity: 'critical',
        issues: [
          { selector: '.btn-small', problem: 'Touch target 32x32px below 44x44px minimum', fix: 'Increase size to 44x44px' },
        ],
        passed: false,
        totalScanned: 50,
        issueCount: 1,
      },
      {
        detector: 'auto-zoom',
        severity: 'high',
        issues: [
          { selector: 'input.search', problem: 'Font size 14px triggers auto-zoom', fix: 'Set font-size to 16px' },
          { selector: 'textarea.comment', problem: 'Font size 12px triggers auto-zoom', fix: 'Set font-size to 16px' },
        ],
        passed: false,
        totalScanned: 20,
        issueCount: 2,
      },
      {
        detector: 'hover-only',
        severity: 'medium',
        issues: [
          { selector: '.tooltip-trigger', problem: 'Hover-only interaction', fix: 'Add touch event handler' },
          { selector: '.dropdown-menu', problem: 'Hover-only interaction', fix: 'Add touch event handler' },
          { selector: '.nav-submenu', problem: 'Hover-only interaction', fix: 'Add touch event handler' },
        ],
        passed: false,
        totalScanned: 100,
        issueCount: 3,
      },
      {
        detector: 'safe-area',
        severity: 'pass',
        issues: [],
        passed: true,
        totalScanned: 10,
        issueCount: 0,
      },
      {
        detector: 'pwa-meta',
        severity: 'pass',
        issues: [],
        passed: true,
        totalScanned: 5,
        issueCount: 0,
      },
    ],
    ...overrides,
  };
}

describe('generateAuditHtml', () => {
  it('should generate valid self-contained HTML', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script src=');
  });

  it('should display score and device info', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('78');
    expect(html).toContain('iPhone 15 Pro');
    expect(html).toContain('393x852');
    expect(html).toContain('example.com');
  });

  it('should show correct score label for different ranges', () => {
    const excellent = generateAuditHtml(mockReport({ score: 95 }));
    expect(excellent).toContain('Excellent');

    const needsWork = generateAuditHtml(mockReport({ score: 75 }));
    expect(needsWork).toContain('Needs Work');

    const critical = generateAuditHtml(mockReport({ score: 45 }));
    expect(critical).toContain('Critical');
  });

  it('should render severity-colored issue cards', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('touch-targets');
    expect(html).toContain('#dc2626');
    expect(html).toContain('auto-zoom');
    expect(html).toContain('#ea580c');
    expect(html).toContain('hover-only');
    expect(html).toContain('#ca8a04');
  });

  it('should display issue details with selectors and fixes', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('.btn-small');
    expect(html).toContain('Touch target 32x32px below 44x44px minimum');
    expect(html).toContain('Increase size to 44x44px');
  });

  it('should show passed detectors as badges', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('safe-area');
    expect(html).toContain('pwa-meta');
    expect(html).toContain('passed-badge');
  });

  it('should escape HTML in user-supplied data', () => {
    const report = mockReport({
      url: 'https://example.com/<script>alert("xss")</script>',
      device: 'iPhone <b>15</b>',
    });
    const html = generateAuditHtml(report);

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('should generate SVG trend chart when entries provided', () => {
    const report = mockReport();
    const trendEntries = [
      { timestamp: '2026-03-28T00:00:00Z', score: 65 },
      { timestamp: '2026-03-29T00:00:00Z', score: 72 },
      { timestamp: '2026-03-30T00:00:00Z', score: 78 },
    ];
    const html = generateAuditHtml(report, { trendEntries });

    expect(html).toContain('<svg');
    expect(html).toContain('Score Trend');
    expect(html).toContain('polyline');
    expect(html).toContain('trendGradient');
  });

  it('should not render trend chart with fewer than 2 entries', () => {
    const report = mockReport();
    const html = generateAuditHtml(report, { trendEntries: [{ timestamp: '2026-03-30T00:00:00Z', score: 78 }] });

    expect(html).not.toContain('Score Trend');
    expect(html).not.toContain('polyline');
  });

  it('should render regression analysis when provided', () => {
    const report = mockReport();
    const regression = {
      currentScore: 78,
      previousScore: 65,
      scoreDelta: 13,
      newIssues: [{ detector: 'hover-only', selector: '.nav-submenu', problem: 'Hover-only', fingerprint: 'abc' }],
      fixedIssues: [{ detector: 'vh100', selector: '.hero', problem: '100vh issue', fingerprint: 'def' }],
      recurringIssues: [],
      summary: 'Score improved 65 -> 78 (+13)',
    };
    const html = generateAuditHtml(report, { regression });

    expect(html).toContain('Regression Analysis');
    expect(html).toContain('+13');
    expect(html).toContain('Score Delta');
    expect(html).toContain('New Issues');
    expect(html).toContain('Fixed Issues');
  });

  it('should include score ring SVG', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('viewBox="0 0 140 140"');
    expect(html).toContain('stroke-dasharray');
    expect(html).toContain('stroke-dashoffset');
  });

  it('should be responsive with media queries', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('@media (max-width: 640px)');
    expect(html).toContain('@media print');
  });

  it('should include collapsible issue sections', () => {
    const report = mockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('onclick');
    expect(html).toContain('.collapsed');
    expect(html).toContain('issue-body');
  });
});
