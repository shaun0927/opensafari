import { generateAuditJSON, QAReport } from '../../src/qa/report-json';
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
          { selector: 'button.submit', problem: '32x28px below 44px minimum', fix: 'Increase size' },
          { selector: 'a.nav-link', problem: '40x20px below 44px minimum', fix: 'Increase size' },
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
          { selector: '.dropdown', element: '<div class="dropdown">', problem: 'Hover-only', fix: 'Add touch' },
        ],
        passed: false,
        totalScanned: 10,
        issueCount: 1,
      },
    ],
    ...overrides,
  };
}

describe('generateAuditJSON', () => {
  let result: QAReport;

  beforeAll(() => {
    result = generateAuditJSON(makeReport());
  });

  it('includes schema version', () => {
    expect(result.version).toBe('1.0.0');
  });

  it('maps timestamp and url', () => {
    expect(result.timestamp).toBe('2026-03-30T12:00:00.000Z');
    expect(result.url).toBe('https://example.com');
  });

  it('maps device with normalized viewport keys', () => {
    expect(result.device).toEqual({
      name: 'iPhone 16 Pro',
      viewport: { width: 393, height: 852 },
    });
  });

  it('preserves score and duration', () => {
    expect(result.score).toBe(85);
    expect(result.duration).toBe(2400);
  });

  it('maps detector status correctly', () => {
    expect(result.detectors[0].status).toBe('fail');  // touch-targets
    expect(result.detectors[1].status).toBe('pass');  // auto-zoom
    expect(result.detectors[2].status).toBe('fail');  // hover-only
  });

  it('maps detector names', () => {
    expect(result.detectors.map(d => d.name)).toEqual([
      'touch-targets', 'auto-zoom', 'hover-only',
    ]);
  });

  it('includes issues with correct fields', () => {
    const touchIssues = result.detectors[0].issues;
    expect(touchIssues).toHaveLength(2);
    expect(touchIssues[0]).toEqual({
      selector: 'button.submit',
      problem: '32x28px below 44px minimum',
      fix: 'Increase size',
    });
  });

  it('includes element field when present', () => {
    const hoverIssues = result.detectors[2].issues;
    expect(hoverIssues[0].element).toBe('<div class="dropdown">');
  });

  it('omits element field when absent', () => {
    const touchIssues = result.detectors[0].issues;
    expect(touchIssues[0]).not.toHaveProperty('element');
  });

  it('produces correct summary counts', () => {
    expect(result.summary).toEqual({
      total: 3,
      pass: 1,
      fail: 2,
      error: 0,
      issues: { critical: 0, high: 2, medium: 1, low: 0 },
    });
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
    const json = generateAuditJSON(report);
    expect(json.detectors[0].status).toBe('error');
    expect(json.detectors[0].error).toBe('Simulator not available');
    expect(json.summary.error).toBe(1);
  });

  it('includes metadata when present', () => {
    const report = makeReport({
      detectors: [
        {
          detector: 'touch-targets',
          severity: 'high',
          issues: [],
          passed: false,
          totalScanned: 5,
          issueCount: 0,
          metadata: { threshold: 44 },
        },
      ],
    });
    const json = generateAuditJSON(report);
    expect(json.detectors[0].metadata).toEqual({ threshold: 44 });
  });

  it('handles empty detectors', () => {
    const json = generateAuditJSON(makeReport({ detectors: [] }));
    expect(json.detectors).toEqual([]);
    expect(json.summary.total).toBe(0);
  });

  it('produces valid JSON when serialized', () => {
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.detectors).toHaveLength(3);
  });
});
