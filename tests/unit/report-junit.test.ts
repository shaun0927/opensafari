import { generateAuditJUnit } from '../../src/qa/report-junit';
import { AuditReport } from '../../src/qa/audit';

function makeReport(overrides?: Partial<AuditReport>): AuditReport {
  return {
    url: 'https://example.com',
    device: 'iPhone 16 Pro',
    viewport: { w: 393, h: 852 },
    timestamp: '2026-03-30T12:00:00.000Z',
    duration: 2400,
    score: 85,
    summary: { totalIssues: 3, critical: 0, high: 2, medium: 1, low: 0, passed: 10, failed: 3, errors: 0 },
    detectors: [
      {
        detector: 'touch-targets',
        severity: 'high',
        issues: [
          { selector: 'button.submit', problem: '32x28px below 44px minimum', fix: 'Increase tap target size' },
          { selector: 'a.nav-link', problem: '40x20px below 44px minimum', fix: 'Increase tap target size' },
        ],
        passed: false,
        totalScanned: 20,
        issueCount: 2,
      },
      {
        detector: 'auto-zoom',
        severity: 'pass',
        issues: [],
        passed: true,
        totalScanned: 5,
        issueCount: 0,
      },
      {
        detector: 'hover-only',
        severity: 'medium',
        issues: [
          { selector: '.dropdown', problem: 'Hover-only interaction', fix: 'Add touch handler' },
        ],
        passed: false,
        totalScanned: 10,
        issueCount: 1,
      },
    ],
    ...overrides,
  };
}

describe('generateAuditJUnit', () => {
  it('generates valid XML structure', () => {
    const xml = generateAuditJUnit(makeReport());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('</testsuites>');
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('</testsuite>');
  });

  it('includes correct test counts', () => {
    const xml = generateAuditJUnit(makeReport());
    // 3 detectors total, 1 failure (touch-targets is high severity)
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('errors="0"');
  });

  it('maps high severity to failure', () => {
    const xml = generateAuditJUnit(makeReport());
    expect(xml).toContain('<failure');
    expect(xml).toContain('type="high"');
    expect(xml).toContain('button.submit: 32x28px below 44px minimum');
  });

  it('maps passing detectors to empty testcase', () => {
    const xml = generateAuditJUnit(makeReport());
    expect(xml).toContain('<testcase name="auto-zoom" classname="qa.detectors" />');
  });

  it('medium severity is neither failure nor skipped by default', () => {
    const xml = generateAuditJUnit(makeReport());
    // hover-only (medium) should just be an empty testcase by default
    expect(xml).toContain('<testcase name="hover-only" classname="qa.detectors" />');
  });

  it('respects custom failureSeverities', () => {
    const xml = generateAuditJUnit(makeReport(), {
      failureSeverities: ['critical', 'high', 'medium'],
    });
    expect(xml).toContain('failures="2"');
    // hover-only should now be a failure
    expect(xml).toMatch(/<testcase name="hover-only"[\s\S]*?<failure/);
  });

  it('respects custom skippedSeverities', () => {
    const xml = generateAuditJUnit(makeReport(), {
      skippedSeverities: ['medium'],
    });
    expect(xml).toContain('skipped="1"');
    expect(xml).toMatch(/<testcase name="hover-only"[\s\S]*?<skipped/);
  });

  it('includes properties with report metadata', () => {
    const xml = generateAuditJUnit(makeReport());
    expect(xml).toContain('<property name="url" value="https://example.com"');
    expect(xml).toContain('<property name="device" value="iPhone 16 Pro"');
    expect(xml).toContain('<property name="viewport" value="393x852"');
    expect(xml).toContain('<property name="score" value="85"');
  });

  it('converts duration to seconds', () => {
    const xml = generateAuditJUnit(makeReport({ duration: 2400 }));
    expect(xml).toContain('time="2.400"');
  });

  it('escapes XML special characters', () => {
    const report = makeReport({
      url: 'https://example.com?a=1&b=2',
      detectors: [
        {
          detector: 'test<detector>',
          severity: 'high',
          issues: [{ selector: 'div>"quoted"', problem: 'Problem with <html> & "quotes"', fix: 'Fix' }],
          passed: false,
          totalScanned: 1,
          issueCount: 1,
        },
      ],
    });
    const xml = generateAuditJUnit(report);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&quot;');
    expect(xml).not.toContain('<detector>');
    expect(xml).not.toContain('a=1&b=2');
  });

  it('handles error severity detectors', () => {
    const report = makeReport({
      detectors: [
        {
          detector: 'orientation',
          severity: 'error',
          issues: [],
          passed: false,
          totalScanned: 0,
          issueCount: 0,
          error: 'Simulator not available',
        },
      ],
    });
    const xml = generateAuditJUnit(report);
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('<error');
    expect(xml).toContain('Simulator not available');
  });

  it('allows custom suite name', () => {
    const xml = generateAuditJUnit(makeReport(), { suiteName: 'my-custom-suite' });
    expect(xml).toContain('name="my-custom-suite"');
  });

  it('handles critical severity as failure by default', () => {
    const report = makeReport({
      detectors: [
        {
          detector: 'scroll-lock',
          severity: 'critical',
          issues: [{ selector: 'body', problem: 'Page scroll locked', fix: 'Remove overflow:hidden' }],
          passed: false,
          totalScanned: 1,
          issueCount: 1,
        },
      ],
    });
    const xml = generateAuditJUnit(report);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('type="critical"');
  });

  it('handles empty detectors array', () => {
    const report = makeReport({ detectors: [] });
    const xml = generateAuditJUnit(report);
    expect(xml).toContain('tests="0"');
    expect(xml).toContain('failures="0"');
  });
});
