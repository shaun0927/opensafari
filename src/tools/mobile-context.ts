import type { AXNode } from '../native/ax-types';

export type MobileSurface =
  | 'app_content'
  | 'springboard_like'
  | 'simulator_chrome'
  | 'empty'
  | 'unknown';

export type BundleMatch = 'matched' | 'mismatch' | 'unknown';
export type MatchConfidence = 'verified' | 'heuristic' | 'unknown';

export interface RunningAppInfo {
  bundleId: string;
  pid: number;
}

export interface MobileContextProbe {
  deviceId: string;
  surface: MobileSurface;
  contextVerified: boolean;
  inferredBundleId?: string;
  expectedBundle?: string;
  expectedBundleMatch?: BundleMatch;
  expectedBundleMatchConfidence?: MatchConfidence;
  reason: string;
  warnings: string[];
  runningApps: RunningAppInfo[];
  visibleSummary: {
    buttonLabels: string[];
    staticTexts: string[];
    textFieldLabels: string[];
    nodeCount: number;
  };
}

interface VisibleSummary {
  buttonLabels: string[];
  staticTexts: string[];
  textFieldLabels: string[];
  nodeCount: number;
}

// Labels that only appear in Simulator chrome controls and never in real app UIs.
// A single match here is sufficient to classify the surface as simulator_chrome.
const CHROME_UNIQUE_LABELS = new Set([
  'save screen',
  'rotate',
  'volume up',
  'volume down',
  'sleep/wake',
  'shake gesture',
  'device rotation',
]);

// Labels that can appear both in Simulator chrome and in real app UIs.
// At least two distinct matches are required to avoid false positives.
const CHROME_AMBIGUOUS_LABELS = new Set([
  'home',
  'action',
]);

const SPRINGBOARD_HINTS = [
  'safari',
  '메시지',
  '설정',
  '사진',
  '지도',
  '건강',
  '캘린더',
  'contacts',
  'news',
  'watch',
  'spotlight',
  'search',
];

const IGNORED_RUNNING_APP_PREFIXES = [
  'com.apple.chrono.',
  'com.apple.spotlight',
  'com.apple.mobilecal',
  'com.apple.Preferences',
];

function collectVisibleSummary(
  node: AXNode,
  summary: VisibleSummary = {
    buttonLabels: [],
    staticTexts: [],
    textFieldLabels: [],
    nodeCount: 0,
  },
): VisibleSummary {
  if (node.visible) {
    summary.nodeCount += 1;
    const normalized = (node.label ?? node.value ?? '').trim();
    if (normalized) {
      if (node.role === 'AXButton') summary.buttonLabels.push(normalized);
      if (node.role === 'AXStaticText') summary.staticTexts.push(normalized);
      if (node.role === 'AXTextField') summary.textFieldLabels.push(normalized);
    }
  }
  for (const child of node.children ?? []) {
    collectVisibleSummary(child, summary);
  }
  return summary;
}

export function classifyMobileContext(params: {
  deviceId: string;
  tree: AXNode;
  runningApps: RunningAppInfo[];
  expectedBundle?: string;
}): MobileContextProbe {
  const { deviceId, tree, runningApps, expectedBundle } = params;
  const summary = collectVisibleSummary(tree);
  const buttonLabelsLower = summary.buttonLabels.map((v) => v.trim().toLowerCase());
  const staticTextsLower = summary.staticTexts.map((v) => v.trim().toLowerCase());
  const textFieldCount = summary.textFieldLabels.length;

  let surface: MobileSurface = 'unknown';
  let contextVerified = false;
  let inferredBundleId: string | undefined;
  let reason = 'No stable context classification matched.';
  const warnings: string[] = [];

  if (summary.nodeCount === 0) {
    surface = 'empty';
    reason = 'Accessibility tree exposed no visible nodes.';
  } else if (
    summary.nodeCount <= 20 &&
    (buttonLabelsLower.some((label) => CHROME_UNIQUE_LABELS.has(label)) ||
      buttonLabelsLower.filter((label) => CHROME_AMBIGUOUS_LABELS.has(label)).length >= 2)
  ) {
    surface = 'simulator_chrome';
    contextVerified = true;
    reason =
      'Visible buttons match Simulator chrome controls rather than app content.';
  } else if (
    textFieldCount === 0 &&
    summary.staticTexts.length <= 2 &&
    summary.buttonLabels.length >= 5 &&
    buttonLabelsLower.some((label) =>
      SPRINGBOARD_HINTS.some((hint) => label.includes(hint.toLowerCase())),
    )
  ) {
    surface = 'springboard_like';
    contextVerified = true;
    inferredBundleId = 'com.apple.springboard';
    reason =
      'Visible buttons look like a SpringBoard/app-grid surface rather than a single foreground app.';
  } else if (
    textFieldCount > 0 ||
    summary.staticTexts.length > 0 ||
    summary.buttonLabels.length > 0
  ) {
    surface = 'app_content';
    reason = 'Visible accessibility nodes look like app-owned content.';
  }

  let expectedBundleMatch: BundleMatch | undefined;
  let expectedBundleMatchConfidence: MatchConfidence | undefined;

  if (expectedBundle) {
    if (surface === 'springboard_like') {
      expectedBundleMatch = expectedBundle === 'com.apple.springboard' ? 'matched' : 'mismatch';
      expectedBundleMatchConfidence = 'verified';
    } else if (surface === 'simulator_chrome' || surface === 'empty') {
      expectedBundleMatch = 'mismatch';
      expectedBundleMatchConfidence = 'verified';
      warnings.push(
        'The visible surface is not actionable app content, so the expected bundle cannot be foreground.',
      );
    } else {
      const filteredApps = runningApps
        .map((app) => app.bundleId)
        .filter(
          (bundleId) =>
            !IGNORED_RUNNING_APP_PREFIXES.some((prefix) => bundleId.startsWith(prefix)),
        );

      if (filteredApps.length === 1 && filteredApps[0] === expectedBundle) {
        expectedBundleMatch = 'matched';
        expectedBundleMatchConfidence = 'heuristic';
        inferredBundleId = expectedBundle;
        warnings.push(
          'Expected bundle match is inferred heuristically from the running-app list, not directly verified from the foreground surface.',
        );
      } else if (!filteredApps.includes(expectedBundle)) {
        expectedBundleMatch = 'mismatch';
        expectedBundleMatchConfidence = 'heuristic';
        warnings.push(
          'Expected bundle is not present in the current running-app list.',
        );
      } else {
        expectedBundleMatch = 'unknown';
        expectedBundleMatchConfidence = 'unknown';
        warnings.push(
          'Expected bundle is present, but the current foreground surface cannot be tied to it with confidence.',
        );
      }
    }
  }

  return {
    deviceId,
    surface,
    contextVerified,
    inferredBundleId,
    expectedBundle,
    expectedBundleMatch,
    expectedBundleMatchConfidence,
    reason,
    warnings,
    runningApps,
    visibleSummary: summary,
  };
}
