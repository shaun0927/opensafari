import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAccessibilityBridge } from '../native';
import { getFlutterVMClient } from '../flutter';
import { getInputBackend } from './native-input-utils';
import { waitForSettle, type SettlePolicy } from './settle-policy';
import { collectAppSessionState } from './app-state-snapshot';
import { getWebKitClient } from '../mcp-server';

const execFileAsync = promisify(execFile);

export interface ScreenTargetPostcondition {
  identifier?: string;
  label?: string;
  text?: string;
  role?: string;
  route?: string;
  timeoutMs?: number;
  stableMs?: number;
}

export interface NativeFallbackQuery {
  identifier?: string;
  label?: string;
  text?: string;
  role?: string;
}

export interface SemanticNavigationTarget {
  deviceId: string;
  url?: string;
  bundleId?: string;
  postcondition: ScreenTargetPostcondition;
  allowNativeFallback?: boolean;
  nativeFallbackQueries?: NativeFallbackQuery[];
  maxNativeAttempts?: number;
  includeFlutter?: boolean;
  collectState?: boolean;
}

export interface SemanticNavigationAttempt {
  strategy: 'state_snapshot' | 'already_on_target' | 'flutter_route' | 'deeplink' | 'deeplink_postcondition' | 'native_fallback';
  elapsedMs: number;
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  verification?: unknown;
  error?: string;
  detail?: string;
}

export interface SemanticNavigationResult {
  navigated: boolean;
  strategy: string;
  deviceId: string;
  url?: string;
  route?: string;
  beforeState?: unknown;
  afterState?: unknown;
  attempts: SemanticNavigationAttempt[];
  verification?: unknown;
  waitFor: Record<string, unknown>;
  recoveryHints: Array<{ action: string; reason: string; destructive: boolean }>;
}

export function hasScreenPostconditionSignal(spec: ScreenTargetPostcondition | undefined): spec is ScreenTargetPostcondition {
  return Boolean(spec && (spec.identifier || spec.label || spec.text || spec.role || spec.route));
}

export function settlePolicyFromPostcondition(spec: ScreenTargetPostcondition, overrides: Partial<SettlePolicy> = {}): SettlePolicy {
  if (!(spec.identifier || spec.label || spec.text || spec.role)) {
    throw new Error('AX settle policy requires identifier, label, text, or role');
  }
  return {
    query: {
      identifier: spec.identifier,
      label: spec.label,
      text: spec.text,
      role: spec.role,
    },
    condition: 'exists',
    timeoutMs: spec.timeoutMs ?? 5000,
    intervalMs: 250,
    stableMs: spec.stableMs ?? 0,
    allowTransientErrors: true,
    maxRecoverableRetries: 3,
    ...overrides,
  };
}

async function verifyRoute(deviceId: string, route: string, timeoutMs = 1000): Promise<{ met: boolean; route: string; elapsedMs: number; raw?: string; error?: string }> {
  const start = Date.now();
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    return { met: false, route, elapsedMs: Date.now() - start, error: 'Flutter VM is not connected' };
  }
  const escaped = route.replace(/'/g, "\\'");
  const expr = `(() { try { final binding = WidgetsBinding.instance; final root = binding.rootElement; if (root == null) return 'opensafari_route:no_root'; String? name; void visit(Element el) { if (name != null) return; final type = el.widget.runtimeType.toString(); if (type == '_ModalScopeStatus') { final s = el.toString(); final m = RegExp(r'name:\\s*"([^"]+)"').firstMatch(s) ?? RegExp(r"name:\\s*'([^']+)'").firstMatch(s); if (m != null) name = m.group(1); } el.visitChildren(visit); } visit(root); return name == '${escaped}' ? 'opensafari_route:ok' : 'opensafari_route:mismatch:' + (name ?? 'null').toString(); } catch (e) { return 'opensafari_route:error:' + e.toString().replaceAll(':', '_'); } })()`;
  const deadline = Date.now() + timeoutMs;
  let raw = '';
  let error: string | undefined;
  while (Date.now() <= deadline) {
    try {
      const result = await client.evaluate(expr);
      raw = (result as { valueAsString?: string }).valueAsString ?? '';
      if (raw.includes('opensafari_route:ok')) return { met: true, route, elapsedMs: Date.now() - start, raw };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(0, deadline - Date.now()))));
  }
  return { met: false, route, elapsedMs: Date.now() - start, raw, error };
}

async function verifyPostcondition(deviceId: string, spec: ScreenTargetPostcondition): Promise<unknown> {
  if (spec.route && !(spec.identifier || spec.label || spec.text || spec.role)) {
    return verifyRoute(deviceId, spec.route, spec.timeoutMs ?? 1000);
  }
  const settle = await waitForSettle(deviceId, settlePolicyFromPostcondition(spec));
  if (spec.route) {
    const route = await verifyRoute(deviceId, spec.route, spec.timeoutMs ?? 1000);
    return { ax: settle, route, met: settle.met && route.met };
  }
  return settle;
}

function postconditionMet(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { met?: boolean; ax?: { met?: boolean }; route?: { met?: boolean } };
  if ('ax' in r && 'route' in r) return r.ax?.met === true && r.route?.met === true;
  return r.met === true || r.ax?.met === true || r.route?.met === true;
}

async function tryNativeFallback(args: SemanticNavigationTarget, attempts: SemanticNavigationAttempt[]): Promise<{ ok: boolean; verification?: unknown; detail?: string }> {
  if (!args.allowNativeFallback) {
    attempts.push({ strategy: 'native_fallback', elapsedMs: 0, ok: false, skipped: true, skipReason: 'Native fallback not allowed by target spec.' });
    return { ok: false };
  }
  const queries = args.nativeFallbackQueries ?? [];
  if (queries.length === 0) {
    attempts.push({ strategy: 'native_fallback', elapsedMs: 0, ok: false, skipped: true, skipReason: 'No native fallback queries were supplied.' });
    return { ok: false };
  }
  const bridge = getAccessibilityBridge();
  const backend = await getInputBackend(args.deviceId, getWebKitClient(args.deviceId));
  const max = Math.max(1, Math.min(args.maxNativeAttempts ?? 3, queries.length));
  for (let i = 0; i < max; i++) {
    const query = queries[i];
    const start = Date.now();
    try {
      const result = await bridge.query(query, { deviceId: args.deviceId, maxResults: 1 });
      const match = result.matches[0];
      if (!match) {
        attempts.push({ strategy: 'native_fallback', elapsedMs: Date.now() - start, ok: false, skipped: true, skipReason: 'query matched no element', detail: JSON.stringify(query) });
        continue;
      }
      const press = await bridge.press(match.path, args.deviceId).catch(() => ({ ok: false }));
      if (!press.ok) {
        await backend.tap(args.deviceId, match.frame.x + match.frame.width / 2, match.frame.y + match.frame.height / 2);
      }
      const verification = await verifyPostcondition(args.deviceId, args.postcondition);
      const ok = postconditionMet(verification);
      attempts.push({ strategy: 'native_fallback', elapsedMs: Date.now() - start, ok, verification, detail: press.ok ? `ax-press:${match.path}` : `tap:${match.path}` });
      if (ok) return { ok: true, verification, detail: press.ok ? 'ax-press' : 'coordinate-tap' };
    } catch (err) {
      attempts.push({ strategy: 'native_fallback', elapsedMs: Date.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: false };
}

export async function navigateSemantically(args: SemanticNavigationTarget): Promise<SemanticNavigationResult> {
  if (!hasScreenPostconditionSignal(args.postcondition)) {
    throw new Error('semantic navigation requires route or AX postcondition');
  }
  const attempts: SemanticNavigationAttempt[] = [];
  let beforeState: unknown;
  if (args.collectState !== false) {
    const start = Date.now();
    try {
      beforeState = await collectAppSessionState({ deviceId: args.deviceId, expectedBundleId: args.bundleId, includeFlutter: args.includeFlutter !== false, maxVisibleNodes: 12 });
      attempts.push({ strategy: 'state_snapshot', elapsedMs: Date.now() - start, ok: true, verification: beforeState });
    } catch (err) {
      attempts.push({ strategy: 'state_snapshot', elapsedMs: Date.now() - start, ok: false, skipped: true, skipReason: err instanceof Error ? err.message : String(err) });
    }
  }

  const alreadyStart = Date.now();
  const pre = await verifyPostcondition(args.deviceId, args.postcondition).catch((err) => ({ met: false, error: err instanceof Error ? err.message : String(err) }));
  attempts.push({ strategy: 'already_on_target', elapsedMs: Date.now() - alreadyStart, ok: postconditionMet(pre), verification: pre });
  if (postconditionMet(pre)) {
    return { navigated: false, strategy: 'already_on_target', deviceId: args.deviceId, url: args.url, route: args.postcondition.route, beforeState, afterState: beforeState, attempts, verification: pre, waitFor: args.postcondition as Record<string, unknown>, recoveryHints: [] };
  }

  const hasAxPostcondition = Boolean(args.postcondition.identifier || args.postcondition.label || args.postcondition.text || args.postcondition.role);
  if (args.postcondition.route) {
    const routeStart = Date.now();
    const route = await verifyRoute(args.deviceId, args.postcondition.route, args.postcondition.timeoutMs ?? 1000);
    attempts.push({ strategy: 'flutter_route', elapsedMs: Date.now() - routeStart, ok: route.met && !hasAxPostcondition, verification: route, skipped: !getFlutterVMClient(args.deviceId).isConnected() || hasAxPostcondition, skipReason: hasAxPostcondition ? 'Route evidence alone is insufficient because AX postcondition was also requested.' : (getFlutterVMClient(args.deviceId).isConnected() ? undefined : 'Flutter VM is not connected.') });
    if (route.met && !hasAxPostcondition) return { navigated: false, strategy: 'flutter_route', deviceId: args.deviceId, url: args.url, route: args.postcondition.route, beforeState, afterState: beforeState, attempts, verification: route, waitFor: args.postcondition as Record<string, unknown>, recoveryHints: [] };
  }

  if (args.url) {
    const openStart = Date.now();
    let openOk = false;
    try {
      await execFileAsync('xcrun', ['simctl', 'openurl', args.deviceId, args.url]);
      openOk = true;
      attempts.push({ strategy: 'deeplink', elapsedMs: Date.now() - openStart, ok: true });
    } catch (err) {
      attempts.push({ strategy: 'deeplink', elapsedMs: Date.now() - openStart, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    if (openOk) {
      const verifyStart = Date.now();
      const verification = await verifyPostcondition(args.deviceId, args.postcondition);
      const ok = postconditionMet(verification);
      attempts.push({ strategy: 'deeplink_postcondition', elapsedMs: Date.now() - verifyStart, ok, verification });
      if (ok) {
        const afterState = args.collectState === false ? undefined : await collectAppSessionState({ deviceId: args.deviceId, expectedBundleId: args.bundleId, includeFlutter: args.includeFlutter !== false, maxVisibleNodes: 12 }).catch(() => undefined);
        return { navigated: true, strategy: 'deeplink_postcondition', deviceId: args.deviceId, url: args.url, route: args.postcondition.route, beforeState, afterState, attempts, verification, waitFor: args.postcondition as Record<string, unknown>, recoveryHints: [] };
      }
    }
  } else {
    attempts.push({ strategy: 'deeplink', elapsedMs: 0, ok: false, skipped: true, skipReason: 'No deeplink URL supplied.' });
  }

  const fallback = await tryNativeFallback(args, attempts);
  if (fallback.ok) {
    const afterState = args.collectState === false ? undefined : await collectAppSessionState({ deviceId: args.deviceId, expectedBundleId: args.bundleId, includeFlutter: args.includeFlutter !== false, maxVisibleNodes: 12 }).catch(() => undefined);
    return { navigated: true, strategy: 'native_fallback', deviceId: args.deviceId, url: args.url, route: args.postcondition.route, beforeState, afterState, attempts, verification: fallback.verification, waitFor: args.postcondition as Record<string, unknown>, recoveryHints: [] };
  }

  const afterState = args.collectState === false ? undefined : await collectAppSessionState({ deviceId: args.deviceId, expectedBundleId: args.bundleId, includeFlutter: args.includeFlutter !== false, maxVisibleNodes: 12 }).catch(() => undefined);
  const lastVerification = [...attempts].reverse().find((a) => a.verification)?.verification;
  return {
    navigated: false,
    strategy: 'failed',
    deviceId: args.deviceId,
    url: args.url,
    route: args.postcondition.route,
    beforeState,
    afterState,
    attempts,
    verification: lastVerification,
    waitFor: args.postcondition as Record<string, unknown>,
    recoveryHints: [
      { action: 'debug_bundle_collect', reason: 'Collect evidence before destructive recovery.', destructive: false },
      { action: 'app_state_snapshot', reason: 'Refresh current state and choose a narrower target or fallback query.', destructive: false },
    ],
  };
}

export const __forTests = { verifyRoute, verifyPostcondition };
