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
}

interface EnsureTargetContextResult {
  tree: AXNode;
  meta: NativeContextMeta;
}

const SIMULATOR_CHROME_LABELS = ['Home', 'Save Screen', 'Rotate'];
const SPRINGBOARD_IDENTIFIERS = ['spotlight-pill'];
const SPRINGBOARD_LABELS = ['Safari', 'Messages', '메시지', 'Settings', '설정'];

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

  const hasSpotlightPill = texts.some((value) => value === 'spotlight-pill');
  const springboardLabelHits = SPRINGBOARD_LABELS.filter((label) =>
    texts.some((value) => value === label),
  );
  if (hasSpotlightPill || springboardLabelHits.length >= 2) {
    if (hasSpotlightPill) heuristics.push('springboard-identifier:spotlight-pill');
    if (springboardLabelHits.length >= 2) {
      heuristics.push(`springboard-labels:${springboardLabelHits.join(',')}`);
    }
    return { sourceKind: 'springboard', heuristics };
  }

  return {
    sourceKind: 'target-app',
    heuristics: heuristics.length > 0 ? heuristics : ['default:target-app'],
  };
}

export async function ensureTargetAppContext(
  params: EnsureTargetContextParams,
): Promise<EnsureTargetContextResult> {
  const { bridge, deviceId, bundleId, maxDepth, ensureSemanticsActive } = params;

  const meta: NativeContextMeta = {
    requestedBundleId: bundleId,
    deviceId,
    sourceKind: 'unknown',
    heuristics: [],
    activationAttempted: Boolean(bundleId),
    activationRetries: 0,
  };

  const manager = bundleId ? new SimulatorManager() : null;

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
