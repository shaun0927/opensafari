import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';

export type SettleCondition = 'exists' | 'not_exists' | 'visible' | 'enabled';

export interface SettleQuery {
  identifier?: string;
  label?: string;
  text?: string;
  role?: string;
}

export interface SettlePolicy {
  query?: SettleQuery;
  condition?: SettleCondition;
  timeoutMs?: number;
  intervalMs?: number;
  stableMs?: number;
  allowTransientErrors?: boolean;
  maxRecoverableRetries?: number;
}

export interface SettleSample {
  role: string;
  label?: string;
  identifier?: string;
  visible?: boolean;
  enabled?: boolean;
  frame?: AXNode['frame'];
  path?: string;
}

export interface SettleResult {
  requested: SettlePolicy;
  met: boolean;
  stableForMs: number;
  polls: number;
  elapsedMs: number;
  matchingCount: number;
  lastObserved: SettleSample[];
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_SAMPLE_LIMIT = 5;

export function evaluateSettleCondition(
  matches: AXNode[],
  condition: SettleCondition = 'exists',
): boolean {
  switch (condition) {
    case 'not_exists':
      return matches.length === 0;
    case 'visible':
      return matches.some((m) => m.visible !== false);
    case 'enabled':
      return matches.some((m) => m.enabled !== false);
    case 'exists':
    default:
      return matches.length > 0;
  }
}

export function updateStableWindow(
  conditionMet: boolean,
  firstMetAtMs: number | null,
  nowMs: number,
  stableMs: number,
): { stable: boolean; firstMetAtMs: number | null; stableForMs: number } {
  if (!conditionMet) {
    return { stable: false, firstMetAtMs: null, stableForMs: 0 };
  }
  const nextFirstMetAtMs = firstMetAtMs ?? nowMs;
  const stableForMs = nowMs - nextFirstMetAtMs;
  return {
    stable: stableForMs >= Math.max(0, stableMs),
    firstMetAtMs: nextFirstMetAtMs,
    stableForMs,
  };
}

export function sampleSettleMatches(matches: AXNode[], limit = DEFAULT_SAMPLE_LIMIT): SettleSample[] {
  return matches.slice(0, Math.max(0, limit)).map((m) => ({
    role: m.role,
    label: m.label,
    identifier: m.identifier,
    visible: m.visible,
    enabled: m.enabled,
    frame: m.frame,
    path: m.path,
  }));
}

export async function waitForSettle(
  deviceId: string,
  policy: SettlePolicy,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
): Promise<SettleResult> {
  if (!policy.query || !hasQuerySignal(policy.query)) {
    throw new Error('settle policy requires at least one query field');
  }

  const bridge = getAccessibilityBridge();
  const timeoutMs = Math.max(0, Math.floor(policy.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const intervalMs = Math.max(25, Math.floor(policy.intervalMs ?? DEFAULT_INTERVAL_MS));
  const stableMs = Math.max(0, Math.floor(policy.stableMs ?? 0));
  const condition = policy.condition ?? 'exists';
  const start = Date.now();
  const deadline = start + timeoutMs;
  let polls = 0;
  let firstMetAtMs: number | null = null;
  let stableForMs = 0;
  let matchingCount = 0;
  let lastObserved: SettleSample[] = [];
  const errors: string[] = [];

  while (Date.now() <= deadline) {
    polls++;
    try {
      const result = await bridge.query(policy.query, { deviceId });
      matchingCount = result.matches.length;
      lastObserved = sampleSettleMatches(result.matches, sampleLimit);
      const met = evaluateSettleCondition(result.matches, condition);
      const stable = updateStableWindow(met, firstMetAtMs, Date.now(), stableMs);
      firstMetAtMs = stable.firstMetAtMs;
      stableForMs = stable.stableForMs;
      if (stable.stable) {
        return {
          requested: policy,
          met: true,
          stableForMs,
          polls,
          elapsedMs: Date.now() - start,
          matchingCount,
          lastObserved,
          errors,
        };
      }
    } catch (err) {
      firstMetAtMs = null;
      stableForMs = 0;
      errors.push(err instanceof Error ? err.message : String(err));
      if (!policy.allowTransientErrors && errors.length > (policy.maxRecoverableRetries ?? 0)) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    requested: policy,
    met: false,
    stableForMs,
    polls,
    elapsedMs: Date.now() - start,
    matchingCount,
    lastObserved,
    errors,
  };
}

function hasQuerySignal(query: SettleQuery): boolean {
  return Boolean(query.identifier || query.label || query.text || query.role);
}
