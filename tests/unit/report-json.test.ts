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
        ],
        passed: false, totalScanned: 20, issueCount: 1,
      },
      {
        detector: 'auto-zoom',
        severity: 'pass',
        issues: [],
        passed: true, totalScanned: 5, issueCount: 0,
      },
      {
        detector: 'hover-only',
        severity: 'medium',
        issues: [
          { selector: '.dropdown', element: '<div class="dropdown">', problem: 'Hover-only', fix: 'Add touch' },
        ],
        passed: false, totalScanned: 10, issueCount: 1,
      },
    ],
    ...overrides,
  };
}

describe('generateAuditJSON', () => {
  let result: QAReport;
  beforeAll(() => { result = generateAuditJSON(makeReport()); });

  it('includes schema version', () => {
    expect(result.version).toBe('1.0.0');
  });

  it('maps device with normalized viewport keys', () => {
    expect(result.device).toEqual({
      name: 'iPhone 16 Pro',
      viewport: { width: 393, height: 852 },
    });
  });

  it('maps detector status correctly', () => {
    expect(result.detectors[0].status).toBe('fail');
    expect(result.detectors[1].status).toBe('pass');
    expect(result.detectors[2].status).toBe('fail');
  });

  it('includes element field when present', () => {
    expect(result.detectors[2].issues[0].element).toBe('<div class="dropdown">');
  });

  it('omits element field when absent', () => {
    expect(result.detectors[0].issues[0]).not.toHaveProperty('element');
  });

  it('produces correct summary counts', () => {
    expect(result.summary.pass).toBe(1);
    expect(result.summary.fail).toBe(2);
    expect(result.summary.error).toBe(0);
  });

  it('handles error severity detectors', () => {
    const json = generateAuditJSON(makeReport({
      detectors: [{
        detector: 'orientation', severity: 'error',
        issues: [], passed: false, totalScanned: 0, issueCount: 0,
        error: 'Simulator not available',
      }],
    }));
    expect(json.detectors[0].status).toBe('error');
    expect(json.detectors[0].error).toBe('Simulator not available');
  });

  it('handles empty detectors', () => {
    const json = generateAuditJSON(makeReport({ detectors: [] }));
    expect(json.detectors).toEqual([]);
    expect(json.summary.total).toBe(0);
  });

  it('produces valid JSON when serialized', () => {
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.version).toBe('1.0.0');
  });
});
