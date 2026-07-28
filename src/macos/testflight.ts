import * as fs from 'fs';
import { HostAXNode, dumpHostTree, queryHostTree, HostAXTarget, collectHostBundle, pressHostElement } from './host-ax';

export type MacTestFlightState =
  | 'HOST_TESTFLIGHT_MISSING' | 'APP_NOT_FOUND' | 'BUILD_AVAILABLE' | 'INSTALL_AVAILABLE'
  | 'UPDATE_AVAILABLE' | 'OPEN_AVAILABLE' | 'APPLE_ID_REQUIRED' | 'TWO_FACTOR_REQUIRED'
  | 'INVITE_OR_GROUP_BLOCKED' | 'TERMS_REQUIRED' | 'UNKNOWN_WITH_EVIDENCE';

export interface MacTestFlightClassification {
  state: MacTestFlightState;
  confidence: 'high' | 'medium' | 'low';
  matchedSignals: string[];
  nextSafeAction: string;
  artifactPaths?: Record<string, unknown>;
}

const TESTFLIGHT_TARGET: HostAXTarget = { bundleId: 'com.apple.TestFlight' };

export function testFlightExists(): boolean { return fs.existsSync('/Applications/TestFlight.app'); }

export function flattenLabels(root: HostAXNode): string[] {
  const out: string[] = [];
  const visit = (n: HostAXNode) => { const s = [n.role, n.label, n.value, n.identifier].filter(Boolean).join(' ').trim(); if (s) out.push(s); for (const c of n.children ?? []) visit(c); };
  visit(root); return out;
}

export function classifyMacTestFlight(root: HostAXNode | null, appName: string, hostTestFlightPresent = testFlightExists()): MacTestFlightClassification {
  if (!hostTestFlightPresent) return cls('HOST_TESTFLIGHT_MISSING', 'high', ['/Applications/TestFlight.app missing'], 'Install TestFlight on the host Mac.');
  const signals = root ? flattenLabels(root) : [];
  const has = (r: RegExp) => signals.filter((s) => r.test(s));
  if (has(/two[- ]factor|verification code|code sent/i).length) return cls('TWO_FACTOR_REQUIRED', 'high', has(/two[- ]factor|verification code|code sent/i), 'Human completes 2FA, then rerun snapshot.');
  if (has(/apple id|sign in/i).length && has(/password|sign in|continue/i).length) return cls('APPLE_ID_REQUIRED', 'high', [...has(/apple id|sign in/i), ...has(/password|sign in|continue/i)], 'Human signs in; OpenSafari will not enter credentials.');
  if (has(/terms|agree/i).length) return cls('TERMS_REQUIRED', 'high', has(/terms|agree/i), 'Human reviews/accepts TestFlight terms if appropriate.');
  if (has(/invite|join.*beta|not available|removed|beta group|testing group/i).length) return cls('INVITE_OR_GROUP_BLOCKED', 'medium', has(/invite|join.*beta|not available|removed|beta group|testing group/i), 'Fix TestFlight invite/group access, then rerun.');
  const appSignals = signals.filter((s) => s.toLowerCase().includes(appName.toLowerCase()));
  if (!appSignals.length) return cls('APP_NOT_FOUND', 'medium', signals.slice(0, 20), `Find ${appName} in TestFlight or fix invite access.`);
  for (const [state, re, action] of [
    ['INSTALL_AVAILABLE', /\binstall\b/i, 'Press Install.'], ['UPDATE_AVAILABLE', /\bupdate\b/i, 'Press Update.'], ['OPEN_AVAILABLE', /\bopen\b/i, 'Press Open.'], ['BUILD_AVAILABLE', /build|version|what to test/i, 'Inspect build or choose Install/Update/Open.'],
  ] as const) { const hits = has(re); if (hits.length) return cls(state, 'high', [...appSignals, ...hits], action); }
  return cls('UNKNOWN_WITH_EVIDENCE', signals.length ? 'low' : 'medium', signals.slice(0, 20), 'Collect evidence; do not mutate state.');
}

export async function snapshotTestFlight(appName: string, artifactDir?: string): Promise<MacTestFlightClassification & { tree?: HostAXNode }> {
  if (!testFlightExists()) return classifyMacTestFlight(null, appName);
  const tree = await dumpHostTree({ ...TESTFLIGHT_TARGET, maxDepth: 10 });
  const c = classifyMacTestFlight(tree, appName);
  if (artifactDir) c.artifactPaths = await collectHostBundle({ ...TESTFLIGHT_TARGET, artifactDir, maxDepth: 10 });
  return { ...c, tree };
}

export async function pressTestFlightAction(tree: HostAXNode, action: 'Install' | 'Update' | 'Open'): Promise<Record<string, unknown>> {
  const match = queryHostTree(tree, { text: action, role: 'AXButton', index: 0 })[0] ?? queryHostTree(tree, { text: action, index: 0 })[0];
  if (!match) return { ok: false, code: 'ACTION_NOT_FOUND', action };
  return pressHostElement(TESTFLIGHT_TARGET, match.path);
}

function cls(state: MacTestFlightState, confidence: MacTestFlightClassification['confidence'], matchedSignals: string[], nextSafeAction: string): MacTestFlightClassification {
  return { state, confidence, matchedSignals: [...new Set(matchedSignals)].slice(0, 30), nextSafeAction };
}
