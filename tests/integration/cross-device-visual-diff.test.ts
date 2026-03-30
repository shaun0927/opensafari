import { PNG } from 'pngjs';
import { VisualDiffEngine } from '../../src/comparison/visual-diff';
import { DOMDiffEngine, DOMSnapshot, DOMElementSnapshot } from '../../src/comparison/dom-diff';
import { generateMarkdownReport, ReportOptions } from '../../src/comparison/report';
import { ViewportCapture, PageMetadata } from '../../src/comparison/cross-viewport';

/** Create a solid-color PNG and return it as base64 */
function createTestPNG(width: number, height: number, color: { r: number; g: number; b: number }): string {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

/** Create a PNG with a colored region on a white background */
function createTestPNGWithRegion(
  width: number,
  height: number,
  region: { x: number; y: number; w: number; h: number },
  regionColor: { r: number; g: number; b: number },
): string {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inRegion =
        x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h;

      if (inRegion) {
        png.data[idx] = regionColor.r;
        png.data[idx + 1] = regionColor.g;
        png.data[idx + 2] = regionColor.b;
      } else {
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
      }
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

function makeMetadata(overrides: Partial<PageMetadata> = {}): PageMetadata {
  return {
    title: 'Test Page',
    scrollHeight: 844,
    scrollWidth: 390,
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    hasHorizontalOverflow: false,
    ...overrides,
  };
}

function makeElement(overrides: Partial<DOMElementSnapshot> = {}): DOMElementSnapshot {
  return {
    tag: 'div',
    selector: 'div#main',
    rect: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    childCount: 0,
    ...overrides,
  };
}

interface MockDevice {
  name: string;
  viewport: { w: number; h: number };
  breakpoint: string;
  screenshotImage: string;
  metadata: PageMetadata;
  domElements: DOMElementSnapshot[];
}

/**
 * Simulate the full cross-device comparison pipeline without real simulators.
 *
 * This mimics what CrossViewportCapture + VisualDiffEngine + DOMDiffEngine + report
 * would do in production, but uses mock data instead of real devices.
 */
async function runMockCrossDevicePipeline(
  url: string,
  devices: MockDevice[],
  options: { similarityThreshold?: number } = {},
) {
  // Step 1: Simulate CrossViewportCapture.capture() output
  const captures: ViewportCapture[] = devices.map(d => ({
    device: d.name,
    viewport: d.viewport,
    breakpoint: d.breakpoint,
    screenshot: d.screenshotImage,
    metadata: d.metadata,
    timing: Math.floor(Math.random() * 500) + 100,
  }));

  // Step 2: Run VisualDiffEngine on screenshots
  const visualEngine = new VisualDiffEngine();
  const screenshots = captures.map(c => ({
    device: c.device,
    imageBase64: c.screenshot,
  }));
  const visualDiff = await visualEngine.compareAll(screenshots, {
    similarityThreshold: options.similarityThreshold ?? 0.95,
  });

  // Step 3: Run DOMDiffEngine on DOM snapshots
  const domEngine = new DOMDiffEngine();
  const domSnapshots: DOMSnapshot[] = devices.map(d => ({
    device: d.name,
    viewport: d.viewport,
    elements: d.domElements,
  }));
  const domDiffs = domEngine.compareAll(domSnapshots);

  // Step 4: Generate enhanced report
  const reportOptions: ReportOptions = { visualDiff, domDiffs };
  const report = generateMarkdownReport(captures, url, reportOptions);

  return { captures, visualDiff, domDiffs, report };
}

describe('Cross-Device Visual Diff Integration', () => {
  const url = 'https://example.com/test';

  describe('identical pages on different device sizes', () => {
    it('should produce a valid report with high similarity for same-color screenshots', async () => {
      const sharedImage = createTestPNG(200, 400, { r: 240, g: 240, b: 240 });
      const sharedElements = [
        makeElement({ selector: 'h1#title', rect: { x: 10, y: 10, width: 180, height: 40 } }),
        makeElement({ selector: 'p.content', rect: { x: 10, y: 60, width: 180, height: 300 } }),
      ];

      const devices: MockDevice[] = [
        {
          name: 'iPhone SE',
          viewport: { w: 375, h: 667 },
          breakpoint: 'sm',
          screenshotImage: sharedImage,
          metadata: makeMetadata({ innerWidth: 375, innerHeight: 667, scrollWidth: 375 }),
          domElements: sharedElements,
        },
        {
          name: 'iPhone 15',
          viewport: { w: 390, h: 844 },
          breakpoint: 'sm',
          screenshotImage: sharedImage,
          metadata: makeMetadata({ innerWidth: 390, innerHeight: 844, scrollWidth: 390 }),
          domElements: sharedElements,
        },
      ];

      const { visualDiff, domDiffs, report } = await runMockCrossDevicePipeline(url, devices);

      // Visual diff: identical images should have similarity = 1
      expect(visualDiff.results).toHaveLength(1);
      expect(visualDiff.results[0].similarity).toBe(1);
      expect(visualDiff.flaggedPairs).toHaveLength(0);

      // DOM diff: identical elements should have 0 differences
      expect(domDiffs).toHaveLength(1);
      expect(domDiffs[0].differences).toHaveLength(0);

      // Report structure
      expect(report).toContain('# Cross-Viewport Comparison Report');
      expect(report).toContain('## Visual Diff Summary');
      expect(report).toContain('**Overall Result:** PASS');
      expect(report).toContain('## DOM Differences');
      expect(report).toContain('**Pairs With Differences:** 0');
      expect(report).toContain('## Responsive Breakpoint Analysis');
    });
  });

  describe('different pages with visual differences', () => {
    it('should flag pairs when images differ significantly', async () => {
      const phoneImage = createTestPNG(200, 400, { r: 255, g: 255, b: 255 });
      const tabletImage = createTestPNGWithRegion(
        200,
        400,
        { x: 0, y: 0, w: 200, h: 200 },
        { r: 255, g: 0, b: 0 },
      );

      const devices: MockDevice[] = [
        {
          name: 'iPhone 15',
          viewport: { w: 390, h: 844 },
          breakpoint: 'sm',
          screenshotImage: phoneImage,
          metadata: makeMetadata(),
          domElements: [
            makeElement({ selector: 'h1#title' }),
            makeElement({ selector: 'nav#menu', visible: true }),
          ],
        },
        {
          name: 'iPad Air',
          viewport: { w: 820, h: 1180 },
          breakpoint: 'md',
          screenshotImage: tabletImage,
          metadata: makeMetadata({ innerWidth: 820, innerHeight: 1180, scrollWidth: 820 }),
          domElements: [
            makeElement({ selector: 'h1#title' }),
            makeElement({ selector: 'nav#menu', visible: false }),
          ],
        },
      ];

      const { visualDiff, domDiffs, report } = await runMockCrossDevicePipeline(url, devices);

      // Visual diff: significantly different images should be flagged
      expect(visualDiff.results).toHaveLength(1);
      expect(visualDiff.results[0].similarity).toBeLessThan(0.95);
      expect(visualDiff.flaggedPairs).toHaveLength(1);
      expect(visualDiff.flaggedPairs[0].diffRegions.length).toBeGreaterThan(0);

      // DOM diff: visibility difference should be detected
      expect(domDiffs).toHaveLength(1);
      const visibilityDiff = domDiffs[0].differences.find(d => d.type === 'hidden');
      expect(visibilityDiff).toBeDefined();
      expect(visibilityDiff!.selector).toBe('nav#menu');

      // Report should reflect failures
      expect(report).toContain('**Overall Result:** FAIL');
      expect(report).toContain('### Flagged Pairs');
      expect(report).toContain('iPhone 15');
      expect(report).toContain('iPad Air');
      expect(report).toContain('## DOM Differences');
      expect(report).toContain('### iPhone 15 vs iPad Air');
    });
  });

  describe('three devices with mixed results', () => {
    it('should produce 3 pairs and correctly identify flagged ones', async () => {
      const whiteImage = createTestPNG(100, 200, { r: 255, g: 255, b: 255 });
      const grayImage = createTestPNG(100, 200, { r: 200, g: 200, b: 200 });
      const redImage = createTestPNG(100, 200, { r: 255, g: 0, b: 0 });

      const baseElements = [
        makeElement({ selector: 'header#top', rect: { x: 0, y: 0, width: 100, height: 30 } }),
        makeElement({ selector: 'main#content', rect: { x: 0, y: 30, width: 100, height: 170 } }),
      ];

      const devices: MockDevice[] = [
        {
          name: 'iPhone SE',
          viewport: { w: 375, h: 667 },
          breakpoint: 'sm',
          screenshotImage: whiteImage,
          metadata: makeMetadata({ innerWidth: 375, innerHeight: 667, scrollWidth: 375 }),
          domElements: baseElements,
        },
        {
          name: 'iPhone 15',
          viewport: { w: 390, h: 844 },
          breakpoint: 'sm',
          screenshotImage: grayImage,
          metadata: makeMetadata({ innerWidth: 390, innerHeight: 844, scrollWidth: 390 }),
          domElements: baseElements,
        },
        {
          name: 'iPad Air',
          viewport: { w: 820, h: 1180 },
          breakpoint: 'md',
          screenshotImage: redImage,
          metadata: makeMetadata({ innerWidth: 820, innerHeight: 1180, scrollWidth: 820 }),
          domElements: [
            ...baseElements,
            makeElement({ selector: 'aside#sidebar', rect: { x: 0, y: 0, width: 200, height: 500 } }),
          ],
        },
      ];

      const { visualDiff, domDiffs, report } = await runMockCrossDevicePipeline(url, devices);

      // Should have C(3,2) = 3 pairs
      expect(visualDiff.results).toHaveLength(3);
      expect(domDiffs).toHaveLength(3);

      // White vs gray might pass (close colors)
      // White vs red and gray vs red should definitely fail
      expect(visualDiff.flaggedPairs.length).toBeGreaterThanOrEqual(1);

      // DOM: iPad has extra aside#sidebar element
      const ipadDiffs = domDiffs.filter(
        d => d.deviceA === 'iPad Air' || d.deviceB === 'iPad Air'
      );
      const hasMissingSidebar = ipadDiffs.some(
        d => d.differences.some(diff => diff.selector === 'aside#sidebar' && diff.type === 'missing')
      );
      expect(hasMissingSidebar).toBe(true);

      // Report should have all sections
      expect(report).toContain('**Devices:** 3');
      expect(report).toContain('**Pairs Compared:** 3');
      expect(report).toContain('## Visual Diff Summary');
      expect(report).toContain('## DOM Differences');
      expect(report).toContain('## Responsive Breakpoint Analysis');
      expect(report).toContain('**sm**');
      expect(report).toContain('**md**');
    });
  });

  describe('report completeness', () => {
    it('should include all required report sections in order', async () => {
      const image = createTestPNG(100, 100, { r: 128, g: 128, b: 128 });
      const elements = [makeElement({ selector: 'div#app' })];

      const devices: MockDevice[] = [
        {
          name: 'Device A',
          viewport: { w: 375, h: 667 },
          breakpoint: 'sm',
          screenshotImage: image,
          metadata: makeMetadata({ innerWidth: 375, innerHeight: 667, scrollWidth: 375 }),
          domElements: elements,
        },
        {
          name: 'Device B',
          viewport: { w: 768, h: 1024 },
          breakpoint: 'md',
          screenshotImage: image,
          metadata: makeMetadata({ innerWidth: 768, innerHeight: 1024, scrollWidth: 768 }),
          domElements: elements,
        },
      ];

      const { report } = await runMockCrossDevicePipeline(url, devices);

      // Verify section order
      const sections = [
        '# Cross-Viewport Comparison Report',
        '## Device Summary',
        '## Visual Diff Summary',
        '## DOM Differences',
        '## Responsive Breakpoint Analysis',
      ];

      let lastIdx = -1;
      for (const section of sections) {
        const idx = report.indexOf(section);
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });

    it('should include device info in the summary table', async () => {
      const image = createTestPNG(50, 50, { r: 100, g: 100, b: 100 });

      const devices: MockDevice[] = [
        {
          name: 'iPhone SE',
          viewport: { w: 375, h: 667 },
          breakpoint: 'sm',
          screenshotImage: image,
          metadata: makeMetadata({
            innerWidth: 375,
            innerHeight: 667,
            scrollWidth: 500,
            hasHorizontalOverflow: true,
          }),
          domElements: [],
        },
        {
          name: 'iPad Air',
          viewport: { w: 820, h: 1180 },
          breakpoint: 'md',
          screenshotImage: image,
          metadata: makeMetadata({ innerWidth: 820, innerHeight: 1180, scrollWidth: 820 }),
          domElements: [],
        },
      ];

      const { report } = await runMockCrossDevicePipeline(url, devices);

      expect(report).toContain('| iPhone SE | 375x667 | sm | YES |');
      expect(report).toContain('| iPad Air | 820x1180 | md | No |');
      expect(report).toContain('## Issues Found');
      expect(report).toContain('Horizontal overflow');
    });
  });
});
