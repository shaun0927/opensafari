import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { getFlutterVMClient } from '../flutter';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { classifyMobileContext } from './mobile-context';
import { probeToRawMobileContext, type RawMobileClassification } from './raw-mobile-context';
import { getAccessibilityBridgeErrorDiagnostics } from '../native/accessibility-bridge';

export interface VisibleNodeSummary {
  role?: string;
  label?: string;
  identifier?: string;
  text?: string;
  path?: string;
}

export interface AppSessionState {
  schemaVersion: '1';
  collectedAt: string;
  device: {
    id: string;
    name?: string;
    booted?: boolean;
  };
  app: {
    expectedBundleId?: string;
    inferredForegroundBundleId?: string;
    expectedBundleMatched?: boolean;
    contextVerified: boolean;
    classification: RawMobileClassification;
    reason: string;
    warnings: string[];
  };
  flutter?: {
    vmConnected: boolean;
    route?: string | null;
    routeSource?: string;
    semanticsActive?: boolean;
    dartVersion?: string;
    mainIsolateId?: string;
  };
  webview?: {
    available: boolean;
    connected?: boolean;
    targetCount?: number;
    classificationHint?: string;
  };
  ui: {
    visibleSummary: VisibleNodeSummary[];
    screenFingerprint?: string;
    keyboardVisible?: boolean;
    modalHints: string[];
    alertHints: string[];
    overlayHints: string[];
  };
  backend?: {
    selected?: string;
    headless?: boolean;
    availableBackends?: string[];
  };
  confidence: 'verified' | 'heuristic' | 'unknown';
  recoveryHints: Array<{
    action: string;
    reason: string;
    destructive: boolean;
  }>;
}

export interface AppStateSnapshotOptions {
  deviceId?: string;
  expectedBundleId?: string;
  includeFlutter?: boolean;
  includeWebView?: boolean;
  maxVisibleNodes?: number;
  maxDepth?: number;
}

export class AppStateSnapshotError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'AppStateSnapshotError';
  }
}

export async function collectAppSessionState(
  options: AppStateSnapshotOptions = {},
): Promise<AppSessionState> {
  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  const deviceId =
    options.deviceId ??
    getSessionManager().getSoleDeviceId() ??
    booted[0]?.udid;
  if (!deviceId) {
    throw new AppStateSnapshotError(
      'No booted simulator found. Call device_boot first or pass deviceId.',
      ErrorCode.DEVICE_NOT_BOOTED,
    );
  }

  const device = booted.find((d) => d.udid === deviceId);
  const bridge = getAccessibilityBridge();
  const tree = await bridge.dumpTree({
    deviceId,
    maxDepth: options.maxDepth ?? 8,
  });
  const runningApps = (await manager.listRunningApps(deviceId)).map((app) => ({
    bundleId: app.label,
    pid: app.pid,
  }));
  const probe = classifyMobileContext({
    deviceId,
    tree,
    runningApps,
    expectedBundle: options.expectedBundleId,
  });
  const raw = probeToRawMobileContext(probe);
  const visibleSummary = collectVisibleNodes(tree, options.maxVisibleNodes ?? 20);
  const confidence = confidenceFromProbe(probe.expectedBundleMatchConfidence, raw.verified);

  const state: AppSessionState = {
    schemaVersion: '1',
    collectedAt: new Date().toISOString(),
    device: {
      id: deviceId,
      name: device?.name,
      booted: Boolean(device),
    },
    app: {
      expectedBundleId: options.expectedBundleId,
      inferredForegroundBundleId: raw.frontmost.bundleId,
      expectedBundleMatched: raw.expectedBundleMatched,
      contextVerified: raw.contextVerified,
      classification: raw.classification,
      reason: raw.reason,
      warnings: raw.warnings,
    },
    ui: {
      visibleSummary,
      screenFingerprint: fingerprintVisibleNodes(visibleSummary),
      keyboardVisible: visibleSummary.some((n) => /keyboard/i.test(`${n.role ?? ''} ${n.label ?? ''} ${n.identifier ?? ''}`)),
      modalHints: visibleSummary.filter((n) => /sheet|dialog|modal/i.test(`${n.role ?? ''} ${n.label ?? ''}`)).map(nodeLabel).filter(Boolean),
      alertHints: visibleSummary.filter((n) => /alert|permission|allow|deny/i.test(`${n.role ?? ''} ${n.label ?? ''}`)).map(nodeLabel).filter(Boolean),
      overlayHints: visibleSummary.filter((n) => /close|dismiss|cancel|back/i.test(`${n.label ?? ''} ${n.identifier ?? ''}`)).map(nodeLabel).filter(Boolean),
    },
    backend: {
      availableBackends: inferAvailableBackends(options.includeFlutter !== false, deviceId),
    },
    confidence,
    recoveryHints: buildRecoveryHints(raw.classification, raw.expectedBundleMatched),
  };

  if (options.includeFlutter !== false) {
    state.flutter = await collectFlutterState(deviceId);
  }

  if (options.includeWebView) {
    state.webview = {
      available: visibleSummary.some((n) => /web/i.test(`${n.role ?? ''} ${n.label ?? ''} ${n.identifier ?? ''}`)),
      classificationHint: 'best_effort_ax_summary',
    };
  }

  return state;
}

async function collectFlutterState(deviceId: string): Promise<AppSessionState['flutter']> {
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) return { vmConnected: false };
  const state = client.getState();
  let route: string | null | undefined;
  let routeSource: string | undefined;
  try {
    const raw = await client.evaluate(ROUTE_EXPRESSION);
    const value = (raw as { valueAsString?: string }).valueAsString ?? '';
    const parsed = parseRoutePayload(value);
    route = parsed.name;
    routeSource = parsed.source;
  } catch {
    route = undefined;
    routeSource = 'unavailable';
  }
  return {
    vmConnected: true,
    route,
    routeSource,
    dartVersion: state?.dartVersionString,
    mainIsolateId: state?.mainIsolateId,
  };
}

function collectVisibleNodes(node: AXNode, limit: number): VisibleNodeSummary[] {
  const out: VisibleNodeSummary[] = [];
  function walk(n: AXNode): void {
    if (out.length >= limit) return;
    const text = n.value ?? n.label;
    if (n.visible && (n.role || n.label || n.identifier || text)) {
      out.push({
        role: n.role,
        label: n.label,
        identifier: n.identifier,
        text,
        path: n.path,
      });
    }
    for (const child of n.children ?? []) walk(child);
  }
  walk(node);
  return out;
}

function fingerprintVisibleNodes(nodes: VisibleNodeSummary[]): string {
  const basis = nodes
    .map((n) => `${n.role ?? ''}:${n.identifier ?? ''}:${n.label ?? ''}:${n.text ?? ''}`)
    .join('|');
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = ((hash << 5) - hash + basis.charCodeAt(i)) | 0;
  }
  return `ax-${Math.abs(hash).toString(36)}`;
}

function nodeLabel(node: VisibleNodeSummary): string {
  return node.identifier ?? node.label ?? node.text ?? node.role ?? '';
}

function confidenceFromProbe(
  matchConfidence: 'verified' | 'heuristic' | 'unknown' | undefined,
  rawVerified: boolean,
): 'verified' | 'heuristic' | 'unknown' {
  if (matchConfidence === 'verified' || rawVerified) return 'verified';
  if (matchConfidence === 'heuristic') return 'heuristic';
  return 'unknown';
}

function buildRecoveryHints(
  classification: RawMobileClassification,
  expectedBundleMatched?: boolean,
): AppSessionState['recoveryHints'] {
  const hints: AppSessionState['recoveryHints'] = [];
  if (classification === 'SPRINGBOARD_FOREGROUND' || expectedBundleMatched === false) {
    hints.push({
      action: 'app_switch_app',
      reason: 'Expected app is not confidently foregrounded.',
      destructive: false,
    });
  }
  if (classification === 'TRANSITIONAL_STATE_TIMEOUT' || classification === 'FOREGROUND_CONTEXT_UNAVAILABLE') {
    hints.push({
      action: 'app_wait_for',
      reason: 'Foreground context is unavailable or still transitioning; wait for a stable postcondition.',
      destructive: false,
    });
  }
  hints.push({
    action: 'debug_bundle_collect',
    reason: 'Collect compact local evidence before destructive recovery such as relaunch/reset.',
    destructive: false,
  });
  return hints;
}

function inferAvailableBackends(includeFlutter: boolean, deviceId: string): string[] {
  const backends = ['ax'];
  if (includeFlutter && getFlutterVMClient(deviceId).isConnected()) backends.push('flutter-vm');
  backends.push('simctl');
  return backends;
}

const ROUTE_EXPRESSION = `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_route:{"name":null,"source":"no_root"}';
    String? name;
    void visit(Element el) {
      if (name != null) return;
      final type = el.widget.runtimeType.toString();
      if (type == '_ModalScopeStatus') {
        final s = el.toString();
        final match = RegExp(r'name:\\s*"([^"]+)"').firstMatch(s)
            ?? RegExp(r"name:\\s*'([^']+)'").firstMatch(s)
            ?? RegExp(r'RouteSettings\\("([^"]+)"').firstMatch(s);
        if (match != null) name = match.group(1);
      }
      el.visitChildren(visit);
    }
    visit(root);
    return name == null
        ? 'opensafari_route:{"name":null,"source":"unknown"}'
        : 'opensafari_route:{"name":"' + name! + '","source":"modal_route"}';
  } catch (e) {
    return 'opensafari_route:{"name":null,"source":"error"}';
  }
})()
`.replace(/\s+/g, ' ').trim();

function parseRoutePayload(raw: string): { name: string | null; source: string } {
  const prefix = 'opensafari_route:';
  const idx = raw.indexOf(prefix);
  if (idx < 0) return { name: null, source: 'unknown' };
  try {
    return JSON.parse(raw.slice(idx + prefix.length)) as { name: string | null; source: string };
  } catch {
    return { name: null, source: 'unknown' };
  }
}

export function registerAppStateSnapshotTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_state_snapshot',
      description:
        'Read-only mobile QA state snapshot: foreground context, visible AX summary, Flutter VM/route hints, confidence, and recovery hints. Does not launch, relaunch, tap, or mutate app state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Simulator UDID (defaults to active/sole booted device)' },
          expectedBundleId: { type: 'string', description: 'Expected foreground bundle id for match/confidence hints' },
          includeFlutter: { type: 'boolean', description: 'Include Flutter VM/route hints when connected (default true)' },
          includeWebView: { type: 'boolean', description: 'Include best-effort WebView availability hints (default false)' },
          maxVisibleNodes: { type: 'number', description: 'Maximum visible AX nodes in compact summary (default 20)' },
          maxDepth: { type: 'number', description: 'AX tree dump depth for classification (default 8)' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const snapshot = await collectAppSessionState({
          deviceId: params.deviceId as string | undefined,
          expectedBundleId: params.expectedBundleId as string | undefined,
          includeFlutter: params.includeFlutter as boolean | undefined,
          includeWebView: params.includeWebView as boolean | undefined,
          maxVisibleNodes: params.maxVisibleNodes as number | undefined,
          maxDepth: params.maxDepth as number | undefined,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(snapshot, null, 2) }] };
      } catch (err) {
        const code = err instanceof AppStateSnapshotError
          ? err.code
          : ErrorCode.APP_STATE_UNKNOWN;
        return respondWithStructuredError(
          code,
          err instanceof Error ? err.message : String(err),
          getAccessibilityBridgeErrorDiagnostics(err),
        );
      }
    },
  );
}
