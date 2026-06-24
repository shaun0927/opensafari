import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { SimctlNativeBackend } from '../native/simctl-backend';
import { REDACTION_POLICY_VERSION, redactText } from '../observability/redaction';
import {
  AppStateSnapshotError,
  collectAppSessionState,
  type AppSessionState,
} from './app-state-snapshot';
import { collectDebugBundle, type DebugBundle } from './debug-bundle-collect';
import {
  classifyTestFlightIap,
  type TestFlightIapClassification,
} from './testflight-iap-classifier';

const TESTFLIGHT_BUNDLE_ID = 'com.apple.TestFlight';
const SNAPSHOT_SCHEMA_VERSION = '1';

export interface AppTestFlightIapSnapshotOptions {
  deviceId?: string;
  expectedAppBundleId?: string;
  testflightBundleId?: string;
  includeEvidence?: boolean;
  maxVisibleNodes?: number;
  maxDepth?: number;
}

export interface AppTestFlightIapSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  collectedAt: string;
  device: AppSessionState['device'];
  expectedAppBundleId?: string;
  testflightBundleId: string;
  installedApps: {
    available: boolean;
    source: 'simctl_listapps';
    count?: number;
    testflightInstalled?: boolean;
    expectedAppInstalled?: boolean;
    bundleIds?: string[];
    error?: string;
  };
  foreground: {
    inferredForegroundBundleId?: string;
    expectedBundleMatched?: boolean;
    contextVerified: boolean;
    classification: AppSessionState['app']['classification'];
    reason: string;
    warnings: string[];
  };
  classifier: TestFlightIapClassification;
  recoveryHints: Array<{
    action: 'app_alert_handle' | 'app_activate' | 'debug_bundle_collect';
    reason: string;
    destructive: false;
  }>;
  debugBundle?: {
    schemaVersion?: DebugBundle['schemaVersion'];
    collectedAt?: string;
    device?: DebugBundle['device'];
    artifactDir?: string;
    screenshotPath?: string;
    axTreePath?: string;
    logsPath?: string;
    crashCount?: number;
    redactions?: DebugBundle['redactions'];
    error?: string;
  };
  redactions: {
    applied: string[];
    policy: typeof REDACTION_POLICY_VERSION;
  };
}

interface InstalledAppHint {
  available: boolean;
  source: 'simctl_listapps';
  count?: number;
  testflightInstalled?: boolean;
  expectedAppInstalled?: boolean;
  bundleIds?: string[];
  error?: string;
}

export async function collectAppTestFlightIapSnapshot(
  options: AppTestFlightIapSnapshotOptions = {},
): Promise<AppTestFlightIapSnapshot> {
  const testflightBundleId = options.testflightBundleId ?? TESTFLIGHT_BUNDLE_ID;
  const state = await collectAppSessionState({
    deviceId: options.deviceId,
    expectedBundleId: options.expectedAppBundleId,
    includeFlutter: false,
    includeWebView: false,
    maxVisibleNodes: options.maxVisibleNodes,
    maxDepth: options.maxDepth,
  });

  const installedApps = await collectInstalledAppHint(
    state.device.id,
    testflightBundleId,
    options.expectedAppBundleId,
  );
  const installedBundleIds = installedApps.available
    ? bundleIdsForClassifier(installedApps.bundleIds, testflightBundleId)
    : undefined;
  const classifier = sanitizeClassification(
    classifyTestFlightIap({
      visibleSummary: state.ui.visibleSummary,
      installedBundleIds,
    }),
  );

  const snapshot: AppTestFlightIapSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    device: state.device,
    expectedAppBundleId: options.expectedAppBundleId,
    testflightBundleId,
    installedApps,
    foreground: {
      inferredForegroundBundleId: state.app.inferredForegroundBundleId,
      expectedBundleMatched: state.app.expectedBundleMatched,
      contextVerified: state.app.contextVerified,
      classification: state.app.classification,
      reason: sanitizeUiText(state.app.reason),
      warnings: state.app.warnings.map(sanitizeUiText),
    },
    classifier,
    recoveryHints: buildSafeRecoveryHints(classifier, options.expectedAppBundleId, testflightBundleId),
    redactions: {
      applied: collectRedactionTagsFromClassification(classifier),
      policy: REDACTION_POLICY_VERSION,
    },
  };

  if (options.includeEvidence === true) {
    const bundle = await collectDebugBundle({
      deviceId: state.device.id,
      bundleId: options.expectedAppBundleId ?? testflightBundleId,
      includeNetwork: false,
    });
    snapshot.debugBundle = summarizeDebugBundle(bundle);
  }

  return snapshot;
}

async function collectInstalledAppHint(
  deviceId: string,
  testflightBundleId: string,
  expectedAppBundleId?: string,
): Promise<InstalledAppHint> {
  try {
    const apps = await new SimctlNativeBackend().listApps(deviceId);
    const bundleIds = apps.map((app) => app.bundleId).filter(Boolean).sort();
    return {
      available: true,
      source: 'simctl_listapps',
      count: bundleIds.length,
      testflightInstalled: bundleIds.includes(testflightBundleId),
      expectedAppInstalled: expectedAppBundleId ? bundleIds.includes(expectedAppBundleId) : undefined,
      bundleIds,
    };
  } catch (err) {
    return {
      available: false,
      source: 'simctl_listapps',
      error: sanitizeUiText(err instanceof Error ? err.message : String(err)),
    };
  }
}

function bundleIdsForClassifier(bundleIds: string[] | undefined, testflightBundleId: string): string[] | undefined {
  if (!bundleIds) return undefined;
  if (testflightBundleId === TESTFLIGHT_BUNDLE_ID || !bundleIds.includes(testflightBundleId)) return bundleIds;
  return Array.from(new Set([...bundleIds, TESTFLIGHT_BUNDLE_ID]));
}

function buildSafeRecoveryHints(
  classifier: TestFlightIapClassification,
  expectedAppBundleId: string | undefined,
  testflightBundleId: string,
): AppTestFlightIapSnapshot['recoveryHints'] {
  const hints: AppTestFlightIapSnapshot['recoveryHints'] = [];
  if (classifier.blocker === 'PURCHASE_CONFIRMATION_REQUIRED') {
    hints.push({
      action: 'app_alert_handle',
      reason: 'A StoreKit or purchase sheet is visible; only use an authorized alert handler policy outside this read-only snapshot.',
      destructive: false,
    });
  }
  if (
    classifier.blocker === 'INSTALL_REQUIRED' ||
    classifier.blocker === 'UPDATE_REQUIRED' ||
    classifier.phase === 'TESTFLIGHT_OPEN_AVAILABLE'
  ) {
    hints.push({
      action: 'app_activate',
      reason: `Bring ${testflightBundleId} to the foreground for human-approved TestFlight continuation.`,
      destructive: false,
    });
  } else if (expectedAppBundleId && classifier.blocker === 'NONE') {
    hints.push({
      action: 'app_activate',
      reason: `Bring ${expectedAppBundleId} to the foreground to continue app/backend verification.`,
      destructive: false,
    });
  }
  hints.push({
    action: 'debug_bundle_collect',
    reason: 'Collect compact local evidence before any mutating recovery or human handoff.',
    destructive: false,
  });
  return hints;
}

function sanitizeClassification(classification: TestFlightIapClassification): TestFlightIapClassification {
  return {
    ...classification,
    reason: sanitizeUiText(classification.reason),
    nextSafeAction: sanitizeUiText(classification.nextSafeAction),
    matchedSignals: classification.matchedSignals.map(sanitizeUiText),
  };
}

function collectRedactionTagsFromClassification(classification: TestFlightIapClassification): string[] {
  const tags = new Set<string>();
  for (const signal of classification.matchedSignals) {
    if (signal.includes('[REDACTED')) tags.add('classifier.sensitive_ui_text');
    for (const tag of redactText(signal, 'classifier').applied) tags.add(tag);
  }
  return Array.from(tags).sort();
}

function sanitizeUiText(input: string): string {
  const redacted = redactText(input, 'ui').text;
  if (looksLikeSensitiveUiText(redacted)) {
    return redacted.replace(sensitiveUiTextPattern(), '$1[REDACTED_SENSITIVE_UI_TEXT]');
  }
  return redacted;
}

function looksLikeSensitiveUiText(input: string): boolean {
  return sensitiveUiTextPattern().test(input);
}

function sensitiveUiTextPattern(): RegExp {
  return /\b(password|passcode|verification code|token|secret|credential)\b\s*[:=]?\s*\S+/gi;
}

function summarizeDebugBundle(bundle: DebugBundle | { error: string }): AppTestFlightIapSnapshot['debugBundle'] {
  if ('error' in bundle) return { error: sanitizeUiText(bundle.error) };
  const screenshotPath = 'path' in bundle.screenshot ? bundle.screenshot.path : undefined;
  const axTreePath = 'path' in bundle.ax ? bundle.ax.path : undefined;
  const logsPath = 'path' in bundle.logs ? bundle.logs.path : undefined;
  return {
    schemaVersion: bundle.schemaVersion,
    collectedAt: bundle.collectedAt,
    device: bundle.device,
    artifactDir: firstDirectory(screenshotPath, axTreePath, logsPath),
    screenshotPath,
    axTreePath,
    logsPath,
    crashCount: Array.isArray(bundle.crashes) ? bundle.crashes.length : undefined,
    redactions: bundle.redactions,
  };
}

function firstDirectory(...paths: Array<string | undefined>): string | undefined {
  const first = paths.find(Boolean);
  if (!first) return undefined;
  const idx = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
  return idx >= 0 ? first.slice(0, idx) : undefined;
}

export function registerAppTestFlightIapSnapshotTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_testflight_iap_snapshot',
      description:
        'Read-only TestFlight/IAP state snapshot: installed-app hints, foreground/context hints, merged TestFlight/IAP classifier result, safe recovery hints, and optional debug-bundle reference. Does not tap, type credentials, install/update apps, confirm purchases, or query App Store Connect.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Simulator UDID (defaults to active/sole booted device)' },
          expectedAppBundleId: { type: 'string', description: 'Expected app bundle id for foreground and installed-app hints' },
          testflightBundleId: { type: 'string', description: 'TestFlight bundle id (default com.apple.TestFlight)' },
          includeEvidence: { type: 'boolean', description: 'Attach an existing debug-bundle path/summary reference (default false)' },
          maxVisibleNodes: { type: 'number', description: 'Maximum visible AX nodes to inspect through app_state_snapshot' },
          maxDepth: { type: 'number', description: 'AX tree dump depth for app_state_snapshot' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const snapshot = await collectAppTestFlightIapSnapshot({
          deviceId: params.deviceId as string | undefined,
          expectedAppBundleId: params.expectedAppBundleId as string | undefined,
          testflightBundleId: params.testflightBundleId as string | undefined,
          includeEvidence: params.includeEvidence as boolean | undefined,
          maxVisibleNodes: params.maxVisibleNodes as number | undefined,
          maxDepth: params.maxDepth as number | undefined,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(snapshot, null, 2) }] };
      } catch (err) {
        const code = err instanceof AppStateSnapshotError ? err.code : ErrorCode.APP_STATE_UNKNOWN;
        return respondWithStructuredError(code, sanitizeUiText(err instanceof Error ? err.message : String(err)));
      }
    },
  );
}

export const __test__ = {
  sanitizeUiText,
};
