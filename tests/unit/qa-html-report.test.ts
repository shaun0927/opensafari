import { generateAuditHtml } from '../../src/qa/report-html';
import { AuditReport } from '../../src/qa/audit';

function createMockReport(overrides?: Partial<AuditReport>): AuditReport {
  return {
    url: 'https://example.com',
    device: 'iPhone 15',
    viewport: { w: 390, h: 844 },
    timestamp: '2025-01-15T10:00:00.000Z',
    duration: 3500,
    score: 85,
    summary: {
      totalIssues: 3,
      critical: 0,
      high: 1,
      medium: 1,
      low: 1,
      passed: 10,
      failed: 3,
      errors: 0,
    },
    detectors: [
      {
        detector: 'touch-targets',
        severity: 'high',
        issues: [
          { selector: 'button.small', problem: 'Touch target too small (30x30)', fix: 'Increase to at least 44x44' },
        ],
        passed: false,
        totalScanned: 20,
        issueCount: 1,
      },
      {
        detector: 'safe-area',
        severity: 'medium',
        issues: [
          { selector: '.footer', problem: 'Content overlaps safe area', fix: 'Add safe-area-inset-bottom padding' },
        ],
        passed: false,
        totalScanned: 5,
        issueCount: 1,
      },
      {
        detector: 'pwa-meta',
        severity: 'low',
        issues: [
          { selector: 'head', problem: 'Missing apple-mobile-web-app-capable', fix: 'Add meta tag' },
        ],
        passed: false,
        totalScanned: 1,
        issueCount: 1,
      },
      {
        detector: 'auto-zoom',
        severity: 'pass',
        issues: [],
        passed: true,
        totalScanned: 15,
        issueCount: 0,
      },
    ],
    ...overrides,
  };
}

describe('generateAuditHtml', () => {
  it('should generate valid HTML document', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('should include report metadata', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('iPhone 15');
    expect(html).toContain('390x844');
    expect(html).toContain('https://example.com');
  });

  it('should include score ring with correct score', () => {
    const report = createMockReport({ score: 85 });
    const html = generateAuditHtml(report);

    expect(html).toContain('>85<');
  });

  it('should include severity summary counts', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('Critical');
    expect(html).toContain('High');
    expect(html).toContain('Medium');
    expect(html).toContain('Low');
    expect(html).toContain('Passed');
  });

  it('should render issue cards for failed detectors', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('touch-targets');
    expect(html).toContain('Touch target too small');
    expect(html).toContain('button.small');
  });

  it('should render passed detector badges', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('auto-zoom');
    expect(html).toContain('passed-badge');
  });

  it('should escape HTML in user content', () => {
    const report = createMockReport({
      url: 'https://example.com/<script>alert(1)</script>',
    });
    const html = generateAuditHtml(report);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should include SVG trend chart when trend entries provided', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report, {
      trendEntries: [
        { timestamp: '2025-01-14T10:00:00.000Z', score: 70 },
        { timestamp: '2025-01-15T10:00:00.000Z', score: 85 },
      ],
    });

    expect(html).toContain('<svg');
    expect(html).toContain('Score Trend');
  });

  it('should not include trend chart with less than 2 entries', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report, {
      trendEntries: [{ timestamp: '2025-01-15T10:00:00.000Z', score: 85 }],
    });

    expect(html).not.toContain('Score Trend');
  });

  it('should include regression analysis when provided', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report, {
      regression: {
        currentScore: 85,
        previousScore: 70,
        scoreDelta: 15,
        newIssues: [],
        fixedIssues: [{ detector: 'vh100', selector: '.hero', problem: '100vh used', fingerprint: 'abc' }],
        recurringIssues: [],
        summary: 'Score improved 70 -> 85',
      },
    });

    expect(html).toContain('Regression Analysis');
    expect(html).toContain('+15');
    expect(html).toContain('Score Delta');
  });

  it('should have no external dependencies', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    // No external CSS/JS references (ignore the report's own URL link)
    const withoutReportUrl = html.replace(/href="https:\/\/example\.com"/g, '');
    expect(withoutReportUrl).not.toMatch(/href="https?:\/\//);
    expect(html).not.toMatch(/src="https?:\/\//);
    // Has inline styles
    expect(html).toContain('<style>');
  });

  it('should be responsive with media queries', () => {
    const report = createMockReport();
    const html = generateAuditHtml(report);

    expect(html).toContain('@media');
  });

  it('should handle score labels correctly', () => {
    const excellent = generateAuditHtml(createMockReport({ score: 95 }));
    expect(excellent).toContain('Excellent');

    const needsWork = generateAuditHtml(createMockReport({ score: 75 }));
    expect(needsWork).toContain('Needs Work');

    const critical = generateAuditHtml(createMockReport({ score: 50 }));
    expect(critical).toContain('Critical');
  });
});
