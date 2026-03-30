import { generateMarkdownReport } from '../../src/comparison/report';
import { ViewportCapture } from '../../src/comparison/cross-viewport';
import { PairwiseComparisonMatrix, VisualDiffResult } from '../../src/comparison/visual-diff';
import { DOMDiffResult, DOMDifference } from '../../src/comparison/dom-diff';

function makeCapture(overrides: Partial<ViewportCapture> = {}): ViewportCapture {
  return {
    device: 'iPhone 15',
    viewport: { w: 390, h: 844 },
    breakpoint: 'sm',
    screenshot: '',
    metadata: {
      title: 'Test Page',
      scrollHeight: 844,
      scrollWidth: 390,
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
      hasHorizontalOverflow: false,
    },
    timing: 250,
    ...overrides,
  };
}

function makeVisualDiffResult(overrides: Partial<VisualDiffResult> = {}): VisualDiffResult {
  return {
    similarity: 0.98,
    diffPercentage: 2.0,
    diffPixelCount: 200,
    totalPixels: 10000,
    diffRegions: [],
    deviceA: 'iPhone 15',
    deviceB: 'iPad Air',
    normalizedSize: { width: 390, height: 844 },
    ...overrides,
  };
}

function makeMatrix(overrides: Partial<PairwiseComparisonMatrix> = {}): PairwiseComparisonMatrix {
  return {
    devices: ['iPhone 15', 'iPad Air'],
    results: [makeVisualDiffResult()],
    flaggedPairs: [],
    threshold: 0.95,
    ...overrides,
  };
}

function makeDOMDiffResult(overrides: Partial<DOMDiffResult> = {}): DOMDiffResult {
  return {
    differences: [],
    deviceA: 'iPhone 15',
    deviceB: 'iPad Air',
    summary: 'Compared iPhone 15 vs iPad Air: 0 differences found (0 high, 0 medium, 0 low) across 5 elements',
    totalElementsCompared: 5,
    ...overrides,
  };
}

function makeDOMDifference(overrides: Partial<DOMDifference> = {}): DOMDifference {
  return {
    type: 'missing',
    selector: 'nav#sidebar',
    description: 'Element "nav#sidebar" exists in iPhone 15 but missing in iPad Air',
    deviceA: { device: 'iPhone 15', value: 'present' },
    deviceB: { device: 'iPad Air', value: 'missing' },
    severity: 'high',
    ...overrides,
  };
}

describe('generateMarkdownReport (enhanced)', () => {
  const url = 'https://example.com';

  describe('backward compatibility', () => {
    it('should produce expected output without options (same as original)', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15', viewport: { w: 390, h: 844 }, breakpoint: 'sm' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const report = generateMarkdownReport(captures, url);

      expect(report).toContain('# Cross-Viewport Comparison Report');
      expect(report).toContain(`**URL:** ${url}`);
      expect(report).toContain('**Devices:** 2');
      expect(report).toContain('## Device Summary');
      expect(report).toContain('| iPhone 15 |');
      expect(report).toContain('| iPad Air |');
      // Should NOT contain diff sections
      expect(report).not.toContain('## Visual Diff Summary');
      expect(report).not.toContain('## DOM Differences');
    });

    it('should produce same output when options is undefined', () => {
      const captures = [makeCapture()];
      const report1 = generateMarkdownReport(captures, url);
      const report2 = generateMarkdownReport(captures, url, undefined);

      // Both should have the same structure (timestamps may differ)
      expect(report1).toContain('## Device Summary');
      expect(report2).toContain('## Device Summary');
      expect(report1).not.toContain('## Visual Diff Summary');
      expect(report2).not.toContain('## Visual Diff Summary');
    });

    it('should produce same output when options is empty object', () => {
      const captures = [makeCapture()];
      const report = generateMarkdownReport(captures, url, {});

      expect(report).toContain('## Device Summary');
      expect(report).not.toContain('## Visual Diff Summary');
      expect(report).not.toContain('## DOM Differences');
    });
  });

  describe('visual diff results', () => {
    it('should include similarity matrix when visual diff is provided', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const matrix = makeMatrix({
        results: [makeVisualDiffResult({ similarity: 0.97, diffPercentage: 3.0 })],
        flaggedPairs: [],
      });

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix });

      expect(report).toContain('## Visual Diff Summary');
      expect(report).toContain('**Overall Result:** PASS');
      expect(report).toContain('**Similarity Threshold:** 95%');
      expect(report).toContain('**Pairs Compared:** 1');
      expect(report).toContain('**Flagged Pairs:** 0');
      expect(report).toContain('### Pairwise Similarity Matrix');
      expect(report).toContain('| iPhone 15 | iPad Air | 97.0% | 3.0% | PASS |');
    });

    it('should show FAIL status when flagged pairs exist', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const flaggedResult = makeVisualDiffResult({
        similarity: 0.80,
        diffPercentage: 20.0,
        diffRegions: [{ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 200, width: 50, height: 50 }],
      });

      const matrix = makeMatrix({
        results: [flaggedResult],
        flaggedPairs: [flaggedResult],
      });

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix });

      expect(report).toContain('**Overall Result:** FAIL');
      expect(report).toContain('**Flagged Pairs:** 1');
      expect(report).toContain('### Flagged Pairs');
      expect(report).toContain('80.0% similarity');
      expect(report).toContain('20.0% pixels differ');
      expect(report).toContain('2 diff region(s)');
    });

    it('should show PASS for each pair above threshold', () => {
      const captures = [
        makeCapture({ device: 'DeviceA' }),
        makeCapture({ device: 'DeviceB' }),
        makeCapture({ device: 'DeviceC' }),
      ];

      const matrix = makeMatrix({
        devices: ['DeviceA', 'DeviceB', 'DeviceC'],
        results: [
          makeVisualDiffResult({ deviceA: 'DeviceA', deviceB: 'DeviceB', similarity: 0.99, diffPercentage: 1.0 }),
          makeVisualDiffResult({ deviceA: 'DeviceA', deviceB: 'DeviceC', similarity: 0.96, diffPercentage: 4.0 }),
          makeVisualDiffResult({ deviceA: 'DeviceB', deviceB: 'DeviceC', similarity: 0.97, diffPercentage: 3.0 }),
        ],
        flaggedPairs: [],
        threshold: 0.95,
      });

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix });

      expect(report).toContain('**Pairs Compared:** 3');
      expect(report).toContain('| DeviceA | DeviceB | 99.0% | 1.0% | PASS |');
      expect(report).toContain('| DeviceA | DeviceC | 96.0% | 4.0% | PASS |');
      expect(report).toContain('| DeviceB | DeviceC | 97.0% | 3.0% | PASS |');
      expect(report).not.toContain('### Flagged Pairs');
    });
  });

  describe('DOM diff results', () => {
    it('should include DOM differences table when provided', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const domDiffs = [
        makeDOMDiffResult({
          deviceA: 'iPhone 15',
          deviceB: 'iPad Air',
          summary: 'Compared iPhone 15 vs iPad Air: 2 differences found (1 high, 1 medium, 0 low) across 10 elements',
          differences: [
            makeDOMDifference({
              type: 'missing',
              selector: 'nav#sidebar',
              severity: 'high',
              description: 'Element "nav#sidebar" exists in iPhone 15 but missing in iPad Air',
            }),
            makeDOMDifference({
              type: 'hidden',
              selector: 'button#menu',
              severity: 'medium',
              description: 'Element "button#menu" visibility differs',
            }),
          ],
        }),
      ];

      const report = generateMarkdownReport(captures, url, { domDiffs });

      expect(report).toContain('## DOM Differences');
      expect(report).toContain('**Pairs Analyzed:** 1');
      expect(report).toContain('**Pairs With Differences:** 1');
      expect(report).toContain('### iPhone 15 vs iPad Air');
      expect(report).toContain('| Type | Selector | Severity | Description |');
      expect(report).toContain('| missing | nav#sidebar | high |');
      expect(report).toContain('| hidden | button#menu | medium |');
    });

    it('should skip pairs with no differences', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const domDiffs = [
        makeDOMDiffResult({ differences: [] }),
      ];

      const report = generateMarkdownReport(captures, url, { domDiffs });

      expect(report).toContain('## DOM Differences');
      expect(report).toContain('**Pairs With Differences:** 0');
      expect(report).not.toContain('### iPhone 15 vs iPad Air');
    });
  });

  describe('combined visual and DOM diffs', () => {
    it('should include both sections when both are provided', () => {
      const captures = [
        makeCapture({ device: 'iPhone 15' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const matrix = makeMatrix();
      const domDiffs = [
        makeDOMDiffResult({
          differences: [makeDOMDifference()],
          summary: 'Compared iPhone 15 vs iPad Air: 1 differences found',
        }),
      ];

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix, domDiffs });

      expect(report).toContain('## Visual Diff Summary');
      expect(report).toContain('## DOM Differences');
      // Visual diff should come before DOM diff
      const visualIdx = report.indexOf('## Visual Diff Summary');
      const domIdx = report.indexOf('## DOM Differences');
      expect(visualIdx).toBeLessThan(domIdx);
    });
  });

  describe('responsive breakpoint analysis', () => {
    it('should show breakpoint analysis when multiple devices exist', () => {
      const captures = [
        makeCapture({ device: 'iPhone SE', viewport: { w: 375, h: 667 }, breakpoint: 'sm' }),
        makeCapture({ device: 'iPhone 15', viewport: { w: 390, h: 844 }, breakpoint: 'sm' }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const report = generateMarkdownReport(captures, url);

      expect(report).toContain('## Responsive Breakpoint Analysis');
      expect(report).toContain('**sm**');
      expect(report).toContain('2 device(s)');
      expect(report).toContain('iPhone SE, iPhone 15');
      expect(report).toContain('**md**');
      expect(report).toContain('1 device(s)');
    });

    it('should mark breakpoints with issues', () => {
      const captures = [
        makeCapture({
          device: 'iPhone SE',
          viewport: { w: 375, h: 667 },
          breakpoint: 'sm',
          metadata: {
            title: 'Test',
            scrollHeight: 667,
            scrollWidth: 500,
            innerWidth: 375,
            innerHeight: 667,
            devicePixelRatio: 2,
            hasHorizontalOverflow: true,
          },
        }),
        makeCapture({ device: 'iPad Air', viewport: { w: 820, h: 1180 }, breakpoint: 'md' }),
      ];

      const report = generateMarkdownReport(captures, url);

      expect(report).toContain('Issues detected');
    });

    it('should not show breakpoint analysis for single device', () => {
      const captures = [makeCapture()];

      const report = generateMarkdownReport(captures, url);

      expect(report).not.toContain('## Responsive Breakpoint Analysis');
    });

    it('should note flagged pairs within same breakpoint', () => {
      const captures = [
        makeCapture({ device: 'iPhone SE', viewport: { w: 375, h: 667 }, breakpoint: 'sm' }),
        makeCapture({ device: 'iPhone 15', viewport: { w: 390, h: 844 }, breakpoint: 'sm' }),
      ];

      const flagged = makeVisualDiffResult({
        deviceA: 'iPhone SE',
        deviceB: 'iPhone 15',
        similarity: 0.80,
        diffPercentage: 20.0,
      });

      const matrix = makeMatrix({
        devices: ['iPhone SE', 'iPhone 15'],
        results: [flagged],
        flaggedPairs: [flagged],
        threshold: 0.95,
      });

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix });

      expect(report).toContain('**Breakpoint Issues:**');
      expect(report).toContain('**sm**');
      expect(report).toContain('flagged pair(s) within same breakpoint');
    });
  });

  describe('edge cases', () => {
    it('should handle empty captures array', () => {
      const report = generateMarkdownReport([], url);

      expect(report).toContain('**Devices:** 0');
      expect(report).toContain('## Device Summary');
    });

    it('should handle empty visual diff results', () => {
      const captures = [makeCapture(), makeCapture({ device: 'iPad Air' })];

      const matrix = makeMatrix({
        results: [],
        flaggedPairs: [],
      });

      const report = generateMarkdownReport(captures, url, { visualDiff: matrix });

      expect(report).toContain('## Visual Diff Summary');
      expect(report).toContain('**Pairs Compared:** 0');
      expect(report).not.toContain('### Pairwise Similarity Matrix');
    });

    it('should handle empty DOM diffs array', () => {
      const captures = [makeCapture()];

      const report = generateMarkdownReport(captures, url, { domDiffs: [] });

      // Empty array should not produce the section
      expect(report).not.toContain('## DOM Differences');
    });

    it('should handle captures with errors in issues section', () => {
      const captures = [
        makeCapture({ device: 'Broken Device', error: 'Connection timeout' }),
      ];

      const report = generateMarkdownReport(captures, url);

      expect(report).toContain('## Issues Found');
      expect(report).toContain('**Broken Device**: Connection timeout');
    });
  });
});
