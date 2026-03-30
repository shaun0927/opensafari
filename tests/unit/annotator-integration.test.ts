import { annotateScreenshot, detectorResultToAnnotations, AnnotationIssue } from '../../src/comparison/annotator';
import { DetectorResult } from '../../src/qa/types';
import { PNG } from 'pngjs';

function createTestPNG(w: number, h: number): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; png.data[i] = 200; png.data[i+1] = 200; png.data[i+2] = 200; png.data[i+3] = 255; }
  return PNG.sync.write(png).toString('base64');
}

describe('QA audit annotation integration', () => {
  const screenshot = createTestPNG(390, 844);

  it('converts detector results to annotations and annotates screenshot', () => {
    const detectorResults: DetectorResult[] = [
      {
        detector: 'touch_targets',
        severity: 'high',
        issues: [
          { selector: '#btn', problem: '32x28px below 44px minimum', fix: 'Increase size', boundingBox: { x: 100, y: 200, width: 32, height: 28 } },
          { selector: '#link', problem: '38x20px below 44px minimum', fix: 'Increase size', boundingBox: { x: 50, y: 400, width: 38, height: 20 } },
        ],
        passed: false,
        totalScanned: 10,
        issueCount: 2,
      },
      {
        detector: 'safe_area',
        severity: 'high',
        issues: [
          { selector: '.footer', problem: 'Missing safe-area-inset-bottom', fix: 'Add padding', rect: { x: 0, y: 800, width: 390, height: 44 } },
        ],
        passed: false,
        totalScanned: 5,
        issueCount: 1,
      },
      {
        detector: 'hover_only',
        severity: 'medium',
        issues: [
          { selector: '.tooltip', problem: 'Uses :hover for visibility', fix: 'Add touch handler' },
        ],
        passed: false,
        totalScanned: 3,
        issueCount: 1,
      },
      {
        detector: 'pwa_meta',
        severity: 'pass',
        issues: [],
        passed: true,
        totalScanned: 8,
        issueCount: 0,
      },
    ];

    // Convert all non-passing detector results
    const annotations: AnnotationIssue[] = [];
    for (const result of detectorResults) {
      if (result.passed || result.severity === 'pass' || result.severity === 'error') continue;
      const severity = result.severity as 'critical' | 'high' | 'medium' | 'low';
      annotations.push(...detectorResultToAnnotations(result.detector, severity, result.issues));
    }

    // Should have 3 annotations (2 touch + 1 safe_area; hover_only has no bbox)
    expect(annotations).toHaveLength(3);
    expect(annotations[0].label).toBe('touch_targets');
    expect(annotations[1].label).toBe('touch_targets');
    expect(annotations[2].label).toBe('safe_area');

    // Annotate the screenshot
    const result = annotateScreenshot(screenshot, annotations, {
      safeArea: { top: 47, bottom: 34, left: 0, right: 0 },
    });

    expect(result.width).toBe(390);
    expect(result.height).toBe(844);
    expect(result.legend).toHaveLength(3);
    expect(result.annotatedImage).toBeTruthy();

    // Verify annotated image is valid PNG
    const decoded = PNG.sync.read(Buffer.from(result.annotatedImage, 'base64'));
    expect(decoded.width).toBe(390);
    expect(decoded.height).toBe(844);
  });

  it('handles audit with no issues gracefully', () => {
    const passingResults: DetectorResult[] = [
      { detector: 'touch_targets', severity: 'pass', issues: [], passed: true, totalScanned: 10, issueCount: 0 },
      { detector: 'safe_area', severity: 'pass', issues: [], passed: true, totalScanned: 5, issueCount: 0 },
    ];

    const annotations: AnnotationIssue[] = [];
    for (const result of passingResults) {
      if (result.passed) continue;
      annotations.push(...detectorResultToAnnotations(result.detector, result.severity as 'critical' | 'high' | 'medium' | 'low', result.issues));
    }

    expect(annotations).toHaveLength(0);
    const result = annotateScreenshot(screenshot, annotations);
    expect(result.legend).toHaveLength(0);
    expect(result.annotatedImage).toBeTruthy();
  });

  it('handles mixed severity annotations on real-size screenshot', () => {
    const annotations: AnnotationIssue[] = [
      { boundingBox: { x: 10, y: 50, width: 100, height: 40 }, severity: 'critical', label: 'keyboard_overlap', description: 'Input hidden' },
      { boundingBox: { x: 200, y: 300, width: 30, height: 25 }, severity: 'high', label: 'touch_targets', description: 'Too small' },
      { boundingBox: { x: 0, y: 780, width: 390, height: 64 }, severity: 'medium', label: 'safe_area', description: 'No bottom inset' },
      { boundingBox: { x: 150, y: 500, width: 80, height: 15 }, severity: 'low', label: 'auto_zoom', description: 'Font too small' },
    ];

    const result = annotateScreenshot(screenshot, annotations);
    expect(result.legend).toHaveLength(4);
    expect(result.legend[0].severity).toBe('critical');
    expect(result.legend[1].severity).toBe('high');
    expect(result.legend[2].severity).toBe('medium');
    expect(result.legend[3].severity).toBe('low');
  });

  it('handles audit with no issues', () => {
    const passing: DetectorResult[] = [
      { detector: 'touch_targets', severity: 'pass', issues: [], passed: true, totalScanned: 10, issueCount: 0 },
    ];
    const annotations: AnnotationIssue[] = [];
    for (const r of passing) { if (r.passed) continue; annotations.push(...detectorResultToAnnotations(r.detector, r.severity as any, r.issues)); }
    expect(annotations).toHaveLength(0);
    const result = annotateScreenshot(screenshot, annotations);
    expect(result.legend).toHaveLength(0);
  });

  it('handles mixed severity annotations', () => {
    const annotations: AnnotationIssue[] = [
      { boundingBox: { x: 10, y: 50, width: 100, height: 40 }, severity: 'critical', label: 'keyboard_overlap' },
      { boundingBox: { x: 200, y: 300, width: 30, height: 25 }, severity: 'high', label: 'touch_targets' },
      { boundingBox: { x: 0, y: 780, width: 390, height: 64 }, severity: 'medium', label: 'safe_area' },
      { boundingBox: { x: 150, y: 500, width: 80, height: 15 }, severity: 'low', label: 'auto_zoom' },
    ];
    const result = annotateScreenshot(screenshot, annotations);
    expect(result.legend).toHaveLength(4);
    expect(result.legend.map(l => l.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });
});
