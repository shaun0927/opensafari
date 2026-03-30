export { CrossViewportCapture } from './cross-viewport';
export type { ViewportCapture, PageMetadata, CaptureOptions } from './cross-viewport';
export { generateMarkdownReport, formatForClaudeVision } from './report';
export {
  annotateScreenshot,
  detectorResultToAnnotations,
  formatLegend,
} from './annotator';
export type {
  AnnotationIssue,
  AnnotationOptions,
  AnnotationResult,
  LegendEntry,
} from './annotator';
export { VisualDiffEngine } from './visual-diff';
export type { VisualDiffResult, VisualDiffOptions, BoundingBox, PairwiseComparisonMatrix } from './visual-diff';
export { DOMDiffEngine, DOM_SNAPSHOT_SCRIPT } from './dom-diff';
export type { DOMDiffResult, DOMDifference, DOMSnapshot, DOMElementSnapshot, DOMDiffOptions } from './dom-diff';
