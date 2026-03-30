import { detectAccessibility } from '../../src/qa/detectors/accessibility';
import { BrowserBackend } from '../../src/types/browser-backend';
import { DetectorResult } from '../../src/qa/types';

function createMockClient(evaluateResult: DetectorResult): BrowserBackend {
  return {
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
    connect: jest.fn(), disconnect: jest.fn(), isConnected: jest.fn().mockReturnValue(true),
    navigate: jest.fn(), screenshot: jest.fn(), readPage: jest.fn(),
    querySelector: jest.fn(), querySelectorAll: jest.fn(), inspect: jest.fn(), waitFor: jest.fn(),
    click: jest.fn(), type: jest.fn(), scroll: jest.fn(), longPress: jest.fn(),
    swipe: jest.fn(), press: jest.fn(), dismissKeyboard: jest.fn(), selectOption: jest.fn(),
    getCookies: jest.fn(), setCookies: jest.fn(), clearCookies: jest.fn(),
  } as unknown as BrowserBackend;
}

describe('detectAccessibility', () => {
  it('returns pass when no issues found', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'pass', issues: [], passed: true, totalScanned: 25, issueCount: 0, metadata: { checksPerformed: 9, wcagVersion: '2.1', conformanceLevel: 'AA' } };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.detector).toBe('accessibility');
    expect(output.severity).toBe('pass');
    expect(output.passed).toBe(true);
    expect(output.issueCount).toBe(0);
    expect(output.metadata).toEqual({ checksPerformed: 9, wcagVersion: '2.1', conformanceLevel: 'AA' });
  });

  it('detects missing alt text (WCAG 1.1.1)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'img[src="/hero.jpg"]', problem: 'Image missing alt attribute (WCAG 2.1 SC 1.1.1 Non-text Content)', fix: 'Add alt', wcag: '1.1.1' }], passed: false, totalScanned: 3, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.severity).toBe('high');
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 1.1.1');
  });

  it('detects missing form labels (WCAG 1.3.1)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'input[name="email"]', problem: 'Form input missing associated label (WCAG 2.1 SC 1.3.1 Info and Relationships)', fix: 'Add label', wcag: '1.3.1' }], passed: false, totalScanned: 5, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 1.3.1');
  });

  it('detects insufficient color contrast (WCAG 1.4.3)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'p.light', problem: 'Color contrast ratio 2.50:1 is below 4.5:1 minimum (WCAG 2.1 SC 1.4.3 Contrast Minimum)', fix: 'Increase contrast', wcag: '1.4.3', contrastRatio: 2.5 }], passed: false, totalScanned: 10, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 1.4.3');
    expect(output.issues[0]).toHaveProperty('contrastRatio', 2.5);
  });

  it('detects heading hierarchy violations', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'h3', problem: 'Heading level skipped from h1 to h3 (WCAG 2.1 SC 1.3.1)', fix: 'Use sequential headings', wcag: '1.3.1', skippedFrom: 1, skippedTo: 3 }], passed: false, totalScanned: 4, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.issues[0]).toHaveProperty('skippedFrom', 1);
    expect(output.issues[0]).toHaveProperty('skippedTo', 3);
  });

  it('detects interactive elements without accessible names (WCAG 4.1.2)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'button.icon', problem: 'Interactive element has no accessible name (WCAG 2.1 SC 4.1.2)', fix: 'Add aria-label', wcag: '4.1.2' }], passed: false, totalScanned: 8, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 4.1.2');
  });

  it('detects missing lang attribute (WCAG 3.1.1)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'medium', issues: [{ selector: 'html', problem: 'Missing lang attribute on <html> element (WCAG 2.1 SC 3.1.1)', fix: 'Add lang', wcag: '3.1.1' }], passed: false, totalScanned: 1, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.severity).toBe('medium');
  });

  it('detects ARIA roles with missing required attributes', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [{ selector: 'div[role="slider"]', problem: 'Role slider missing required attributes (WCAG 2.1 SC 4.1.2)', fix: 'Add aria-valuenow', wcag: '4.1.2', role: 'slider', missingAttributes: ['aria-valuenow'] }], passed: false, totalScanned: 3, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.issues[0]).toHaveProperty('role', 'slider');
    expect(output.issues[0]).toHaveProperty('missingAttributes');
  });

  it('detects non-descriptive link text (WCAG 2.4.4)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'low', issues: [{ selector: 'a[href="/about"]', problem: 'Non-descriptive link text click here (WCAG 2.1 SC 2.4.4)', fix: 'Use descriptive text', wcag: '2.4.4' }], passed: false, totalScanned: 5, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.severity).toBe('low');
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 2.4.4');
  });

  it('detects positive tabindex (WCAG 2.4.3)', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'medium', issues: [{ selector: 'input[tabindex="5"]', problem: 'Positive tabindex (5) disrupts focus order (WCAG 2.1 SC 2.4.3)', fix: 'Remove positive tabindex', wcag: '2.4.3' }], passed: false, totalScanned: 2, issueCount: 1 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.severity).toBe('medium');
    expect(output.issues[0].problem).toContain('WCAG 2.1 SC 2.4.3');
  });

  it('reports multiple issues with severity escalation', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'high', issues: [
      { selector: 'img', problem: 'Missing alt (1.1.1)', fix: 'Add alt', wcag: '1.1.1' },
      { selector: 'a', problem: 'Non-descriptive (2.4.4)', fix: 'Fix', wcag: '2.4.4' },
    ], passed: false, totalScanned: 15, issueCount: 2 };
    const output = await detectAccessibility(createMockClient(r));
    expect(output.severity).toBe('high');
    expect(output.issueCount).toBe(2);
  });

  it('calls client.evaluate with IIFE containing all WCAG checks', async () => {
    const r: DetectorResult = { detector: 'accessibility', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 };
    const client = createMockClient(r);
    await detectAccessibility(client);
    expect(client.evaluate).toHaveBeenCalledTimes(1);
    const expr = (client.evaluate as jest.Mock).mock.calls[0][0] as string;
    expect(expr).toContain('(function()');
    expect(expr).toContain('1.1.1');
    expect(expr).toContain('1.3.1');
    expect(expr).toContain('1.4.3');
    expect(expr).toContain('4.1.2');
    expect(expr).toContain('3.1.1');
    expect(expr).toContain('2.4.4');
    expect(expr).toContain('2.4.3');
  });
});
