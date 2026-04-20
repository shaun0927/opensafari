import type { AXNode } from '../native/ax-types';
import {
  classifyMobileContext,
  type MobileContextProbe,
  type RunningAppInfo,
} from './mobile-context';

const IGNORED_RUNNING_APP_PREFIXES = [
  'com.apple.chrono.',
  'com.apple.spotlight',
  'com.apple.mobilecal',
  'com.apple.Preferences',
];

export type RawMobileClassification =
  | 'TARGET_BUNDLE_CONFIRMED'
  | 'EXPECTED_BUNDLE_MISMATCH'
  | 'SPRINGBOARD_FOREGROUND'
  | 'SIMULATOR_CHROME_FOREGROUND'
  | 'APP_CONTENT_FOREGROUND'
  | 'APP_CONTENT_UNVERIFIED'
  | 'FOREGROUND_CONTEXT_UNAVAILABLE';

export interface RawMobileContextResult {
  deviceId: string;
  frontmost: {
    bundleId?: string;
  };
  contextVerified: boolean;
  expectedBundle?: string;
  expectedBundleMatched?: boolean;
  classification: RawMobileClassification;
  verified: boolean;
  reason: string;
  warnings: string[];
  runningApps: RunningAppInfo[];
  visibleSummary: MobileContextProbe['visibleSummary'];
}

export function probeToRawMobileContext(probe: MobileContextProbe): RawMobileContextResult {
  const frontmostBundleId = inferFrontmostBundleId(probe);
  let classification: RawMobileClassification = 'FOREGROUND_CONTEXT_UNAVAILABLE';
  let verified = false;

  switch (probe.surface) {
    case 'springboard_like':
      classification = 'SPRINGBOARD_FOREGROUND';
      verified = true;
      break;
    case 'simulator_chrome':
      classification = 'SIMULATOR_CHROME_FOREGROUND';
      verified = false;
      break;
    case 'app_content':
      if (probe.expectedBundle) {
        if (probe.expectedBundleMatch === 'matched') {
          classification = 'TARGET_BUNDLE_CONFIRMED';
          verified = true;
        } else if (probe.expectedBundleMatch === 'mismatch') {
          classification = 'EXPECTED_BUNDLE_MISMATCH';
          verified = false;
        } else if (frontmostBundleId) {
          classification = 'APP_CONTENT_FOREGROUND';
          verified = false;
        } else {
          classification = 'APP_CONTENT_UNVERIFIED';
          verified = false;
        }
      } else {
        classification = frontmostBundleId ? 'APP_CONTENT_FOREGROUND' : 'APP_CONTENT_UNVERIFIED';
        verified = probe.contextVerified;
      }
      break;
    case 'empty':
    case 'unknown':
      classification = 'FOREGROUND_CONTEXT_UNAVAILABLE';
      verified = false;
      break;
  }

  return {
    deviceId: probe.deviceId,
    frontmost: frontmostBundleId ? { bundleId: frontmostBundleId } : {},
    contextVerified: probe.contextVerified,
    expectedBundle: probe.expectedBundle,
    expectedBundleMatched:
      probe.expectedBundleMatch === 'matched'
        ? true
        : probe.expectedBundleMatch === 'mismatch'
          ? false
          : undefined,
    classification,
    verified,
    reason: probe.reason,
    warnings: probe.warnings,
    runningApps: probe.runningApps,
    visibleSummary: probe.visibleSummary,
  };
}

export function buildRawMobileContext(args: {
  deviceId: string;
  tree: AXNode;
  runningApps: RunningAppInfo[];
  expectedBundle?: string;
}): RawMobileContextResult {
  const probe = classifyMobileContext(args);
  return probeToRawMobileContext(probe);
}

function inferFrontmostBundleId(probe: MobileContextProbe): string | undefined {
  if (probe.inferredBundleId) return probe.inferredBundleId;
  if (probe.surface === 'springboard_like') return 'com.apple.springboard';
  if (probe.expectedBundle && probe.expectedBundleMatch === 'matched') return probe.expectedBundle;

  const filteredApps = probe.runningApps.filter(
    (app) => !IGNORED_RUNNING_APP_PREFIXES.some((prefix) => app.bundleId.startsWith(prefix)),
  );
  if (filteredApps.length === 1) {
    return filteredApps[0].bundleId;
  }
  return undefined;
}
