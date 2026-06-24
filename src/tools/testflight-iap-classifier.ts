import type { VisibleNodeSummary } from './app-state-snapshot';

export type TestFlightIapPhase =
  | 'TESTFLIGHT_NOT_INSTALLED'
  | 'TESTFLIGHT_INSTALL_AVAILABLE'
  | 'TESTFLIGHT_UPDATE_AVAILABLE'
  | 'TESTFLIGHT_OPEN_AVAILABLE'
  | 'APPLE_ID_SIGN_IN_REQUIRED'
  | 'TWO_FACTOR_REQUIRED'
  | 'SANDBOX_SIGN_IN_REQUIRED'
  | 'STOREKIT_PURCHASE_SHEET_VISIBLE'
  | 'PURCHASE_SUCCESS_VISIBLE'
  | 'UNKNOWN_WITH_EVIDENCE';

export type TestFlightIapBlocker =
  | 'TESTFLIGHT_MISSING'
  | 'INSTALL_REQUIRED'
  | 'UPDATE_REQUIRED'
  | 'NONE'
  | 'APPLE_ID_AUTH'
  | 'TWO_FACTOR_AUTH'
  | 'SANDBOX_AUTH'
  | 'PURCHASE_CONFIRMATION_REQUIRED'
  | 'UNKNOWN';

export interface TestFlightIapClassification {
  phase: TestFlightIapPhase;
  blocker: TestFlightIapBlocker;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  nextSafeAction: string;
  matchedSignals: string[];
}

export interface TestFlightIapClassifierInput {
  visibleSummary: VisibleNodeSummary[];
  installedBundleIds?: string[];
}

const TESTFLIGHT_BUNDLE = 'com.apple.TestFlight';

type Rule = Omit<TestFlightIapClassification, 'matchedSignals'> & {
  all?: RegExp[];
  any?: RegExp[];
};

const RULES: Rule[] = [
  {
    phase: 'TWO_FACTOR_REQUIRED',
    blocker: 'TWO_FACTOR_AUTH',
    confidence: 'high',
    reason: 'Apple ID two-factor verification is blocking the flow.',
    nextSafeAction: 'Have a human complete 2FA, then snapshot again.',
    all: [/verification code|two[- ]factor|two factor|code sent/i],
  },
  {
    phase: 'SANDBOX_SIGN_IN_REQUIRED',
    blocker: 'SANDBOX_AUTH',
    confidence: 'high',
    reason: 'StoreKit sandbox account sign-in is required.',
    nextSafeAction: 'Have a human sign in to the sandbox account, then snapshot again.',
    all: [/sandbox/i, /sign in|apple id|account/i],
  },
  {
    phase: 'APPLE_ID_SIGN_IN_REQUIRED',
    blocker: 'APPLE_ID_AUTH',
    confidence: 'high',
    reason: 'Apple ID sign-in is required before TestFlight/IAP can continue.',
    nextSafeAction: 'Have a human sign in with Apple ID, then snapshot again.',
    all: [/apple id|sign in to.*apple|password/i, /sign in|continue|password/i],
  },
  {
    phase: 'PURCHASE_SUCCESS_VISIBLE',
    blocker: 'NONE',
    confidence: 'high',
    reason: 'The visible UI reports a completed purchase.',
    nextSafeAction: 'Continue with app/backend receipt verification.',
    any: [/purchase successful|you(?:'|’)re all set|thank you|subscription active/i],
  },
  {
    phase: 'STOREKIT_PURCHASE_SHEET_VISIBLE',
    blocker: 'PURCHASE_CONFIRMATION_REQUIRED',
    confidence: 'high',
    reason: 'A StoreKit purchase confirmation sheet is visible.',
    nextSafeAction: 'Use existing alert handling only if the test is authorized to confirm purchase.',
    all: [/confirm|buy|subscribe|purchase/i, /storekit|in-app purchase|payment|subscription|apple id/i],
  },
  {
    phase: 'TESTFLIGHT_INSTALL_AVAILABLE',
    blocker: 'INSTALL_REQUIRED',
    confidence: 'high',
    reason: 'TestFlight shows an install action for the build.',
    nextSafeAction: 'Install via existing user-approved app interaction, then snapshot again.',
    all: [/testflight/i, /\binstall\b/i],
  },
  {
    phase: 'TESTFLIGHT_UPDATE_AVAILABLE',
    blocker: 'UPDATE_REQUIRED',
    confidence: 'high',
    reason: 'TestFlight shows an update action for the build.',
    nextSafeAction: 'Update via existing user-approved app interaction, then snapshot again.',
    all: [/testflight/i, /\bupdate\b/i],
  },
  {
    phase: 'TESTFLIGHT_OPEN_AVAILABLE',
    blocker: 'NONE',
    confidence: 'high',
    reason: 'TestFlight shows the app can be opened.',
    nextSafeAction: 'Open or activate the app, then snapshot purchase state.',
    all: [/testflight/i, /\bopen\b/i],
  },
];

export function classifyTestFlightIap(input: TestFlightIapClassifierInput): TestFlightIapClassification {
  const signals = input.visibleSummary.map(signalText).filter(Boolean);
  const installed = input.installedBundleIds?.includes(TESTFLIGHT_BUNDLE);

  if (installed === false) {
    return {
      phase: 'TESTFLIGHT_NOT_INSTALLED',
      blocker: 'TESTFLIGHT_MISSING',
      confidence: 'high',
      reason: 'TestFlight is not installed on the simulator.',
      nextSafeAction: 'Install TestFlight manually or use a simulator with TestFlight already present.',
      matchedSignals: ['installedBundleIds excludes com.apple.TestFlight'],
    };
  }

  for (const rule of RULES) {
    const matchedSignals = matchRule(signals, rule);
    if (matchedSignals.length) return classificationFor(rule, matchedSignals);
  }

  return {
    phase: 'UNKNOWN_WITH_EVIDENCE',
    blocker: 'UNKNOWN',
    confidence: signals.length ? 'low' : 'medium',
    reason: signals.length
      ? 'Visible UI evidence did not match a known TestFlight/IAP state.'
      : 'No visible UI evidence was available for TestFlight/IAP classification.',
    nextSafeAction: 'Collect a debug bundle or broader app_state_snapshot evidence before mutating state.',
    matchedSignals: signals.slice(0, 10),
  };
}

function signalText(node: VisibleNodeSummary): string {
  return [node.role, node.label, node.identifier, node.text].filter(Boolean).join(' ').trim();
}

function matchRule(signals: string[], rule: Rule): string[] {
  if (rule.all) {
    const hits = rule.all.map((pattern) => signals.find((signal) => pattern.test(signal))).filter(Boolean) as string[];
    return hits.length === rule.all.length ? [...new Set(hits)] : [];
  }
  return signals.filter((signal) => rule.any?.some((pattern) => pattern.test(signal)));
}

function classificationFor(rule: Rule, matchedSignals: string[]): TestFlightIapClassification {
  return {
    phase: rule.phase,
    blocker: rule.blocker,
    confidence: rule.confidence,
    reason: rule.reason,
    nextSafeAction: rule.nextSafeAction,
    matchedSignals,
  };
}
