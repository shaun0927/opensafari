import type { AXNode } from '../native';
import type { AccessibilityBridge } from '../native/accessibility-bridge';
import { SimulatorManager } from '../simulator';

export type NativeContextSourceKind =
  | 'target-app'
  | 'springboard'
  | 'simulator-window'
  | 'unknown';

export interface NativeContextMeta {
  requestedBundleId?: string;
  deviceId: string;
  sourceKind: NativeContextSourceKind;
  heuristics: string[];
  activationAttempted: boolean;
  activationRetries: number;
}

interface EnsureTargetContextParams {
  bridge: AccessibilityBridge;
  deviceId: string;
  bundleId?: string;
  maxDepth?: number;
  ensureSemanticsActive: () => Promise<unknown>;
  /** Optional pre-created SimulatorManager; a new one is created when omitted. */
  manager?: SimulatorManager;
}

interface EnsureTargetContextResult {
  tree: AXNode;
  meta: NativeContextMeta;
}

interface ActivateAndClassifyParams {
  bridge: AccessibilityBridge;
  deviceId: string;
  bundleId: string;
  ensureSemanticsActive: () => Promise<unknown>;
  /** Optional pre-created SimulatorManager; a new one is created when omitted. */
  manager?: SimulatorManager;
}

interface ActivateAndClassifyResult {
  meta: NativeContextMeta;
}

const SIMULATOR_CHROME_LABELS = ['Home', 'Save Screen', 'Rotate'];
const SPRINGBOARD_DOCK_IDENTIFIERS = ['dock', 'floating-dock'];
const SPRINGBOARD_LABELS = ['Safari', 'Messages', '메시지', 'Settings', '설정', 'Phone', 'Mail', 'Maps', 'Photos', 'Camera'];

export function classifyNativeContext(tree: AXNode): {
  sourceKind: NativeContextSourceKind;
  heuristics: string[];
} {
  const texts = collectTreeText(tree).map((v) => v.trim()).filter(Boolean);
  const heuristics: string[] = [];

  const hasAllSimulatorChrome = SIMULATOR_CHROME_LABELS.every((label) =>
    texts.some((value) => value === label),
  );
  if (hasAllSimulatorChrome) {
    if (hasAllSimulatorChrome) heuristics.push('chrome-labels:Home/Save Screen/Rotate');
    return { sourceKind: 'simulator-window', heuristics };
  }

  // Strong structural signal: spotlight-pill identifier is exclusive to SpringBoard search bar
  const hasSpotlightPill = texts.some((value) => value === 'spotlight-pill');
  // Secondary structural signal: dock identifier is exclusive to the SpringBoard home-screen dock
  const hasDock = SPRINGBOARD_DOCK_IDENTIFIERS.some((id) => texts.some((value) => value === id));
  // SpringBoard-specific bundle-id prefix in any identifier
  const hasSpringboardBundleId = texts.some((value) =>
    value.startsWith('com.apple.springboard'),
  );

  if (hasSpotlightPill || hasSpringboardBundleId) {
    if (hasSpotlightPill) heuristics.push('springboard-identifier:spotlight-pill');
    if (hasSpringboardBundleId) heuristics.push('springboard-bundle-id:com.apple.springboard');
    return { sourceKind: 'springboard', heuristics };
  }

  // Label co-occurrence only counts when combined with the dock structural signal, AND requires
  // at least 3 distinct home-screen app labels. This prevents in-app screens (e.g. a chat app
  // that lists "Messages" or a settings screen listing "Settings") from being misclassified.
  const springboardLabelHits = SPRINGBOARD_LABELS.filter((label) =>
    texts.some((value) => value === label),
  );
  if (hasDock && springboardLabelHits.length >= 3) {
    heuristics.push('springboard-identifier:dock');
    heuristics.push(`springboard-labels:${springboardLabelHits.join(',')}`);
    return { sourceKind: 'springboard', heuristics };
  }

  return {
    sourceKind: 'target-app',
    heuristics: heuristics.length > 0 ? heuristics : ['default:target-app'],
  };
}

/**
 * Activate a specific app by bundle ID, ensure semantics, dump the tree, and
 * classify the native context. Returns both the tree and meta. Use this when
 * the caller needs the tree (e.g. app_tree tool).
 */
export async function ensureTargetAppContext(
  params: EnsureTargetContextParams,
): Promise<EnsureTargetContextResult> {
  const { bridge, deviceId, bundleId, maxDepth, ensureSemanticsActive, manager: injectedManager } = params;

  const meta: NativeContextMeta = {
    requestedBundleId: bundleId,
    deviceId,
    sourceKind: 'unknown',
    heuristics: [],
    activationAttempted: Boolean(bundleId),
    activationRetries: 0,
  };

  const manager = bundleId ? (injectedManager ?? new SimulatorManager()) : null;

  if (bundleId && manager) {
    await manager.activateApp(deviceId, bundleId);
  }
  await ensureSemanticsActive();
  let tree = await bridge.dumpTree({ deviceId, maxDepth });
  let classification = classifyNativeContext(tree);

  if (bundleId && classification.sourceKind !== 'target-app' && manager) {
    meta.activationRetries = 1;
    await sleep(250);
    await manager.activateApp(deviceId, bundleId);
    await ensureSemanticsActive();
    tree = await bridge.dumpTree({ deviceId, maxDepth });
    classification = classifyNativeContext(tree);
  }

  meta.sourceKind = classification.sourceKind;
  meta.heuristics = classification.heuristics;

  return { tree, meta };
}

/**
 * Activate a specific app by bundle ID, ensure semantics, dump a single tree
 * snapshot to classify the native context, then discard the tree.
 *
 * Callers that only need `meta` (query/assert/wait/tap-element/inspect) should
 * use this lighter form and call `bridge.dumpTree()` themselves when they need
 * the tree, avoiding a redundant dump.
 */
export async function activateAndClassify(
  params: ActivateAndClassifyParams,
): Promise<ActivateAndClassifyResult> {
  const { tree, meta } = await ensureTargetAppContext(params);
  // tree is discarded; callers obtain their own snapshot
  void tree;
  return { meta };
}

export function createContextMismatchError(meta: NativeContextMeta): Error {
  const bundle = meta.requestedBundleId ?? 'unknown';
  const heuristics = meta.heuristics.length > 0 ? meta.heuristics.join(', ') : 'none';
  return new Error(
    `Native context mismatch for bundle "${bundle}": resolved ${meta.sourceKind} on device ` +
      `${meta.deviceId} (heuristics: ${heuristics})`,
  );
}

function collectTreeText(node: AXNode): string[] {
  const values: string[] = [];
  if (node.label) values.push(node.label);
  if (node.identifier) values.push(node.identifier);
  if (node.value) values.push(node.value);
  for (const child of node.children ?? []) {
    values.push(...collectTreeText(child));
  }
  return values;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
