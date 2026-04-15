/**
 * Live integration suite for issue #423 — proves that `app_tap_element`
 * works identically against a native (non-Flutter) iOS app, using the
 * bundled Settings.app (`com.apple.Preferences`) as the target. The
 * `AccessibilityBridge` path has no Flutter-specific branching, so this
 * test only needs to walk one well-known UIKit surface to demonstrate
 * parity.
 *
 * Locale-awareness: primary queries use accessibility identifiers which
 * are locale-independent. Label-based assertions fall back to environment
 * variable overrides so the suite runs correctly on non-English simulators
 * (e.g. Korean ko_KR). Override example:
 *   SETTINGS_GENERAL=일반 SETTINGS_ABOUT=정보 npx jest ...
 *
 * Setup prerequisites (see tests/integration/README.md for the full
 * rationale):
 *   - booted iOS Simulator with a visible device window
 *   - `OPENSAFARI_ALLOW_FOCUS_INPUT=1` so the Tier-3 CGEvent backend is
 *     allowed (Xcode 26+ removed `simctl io input`)
 *
 * Run:
 *   OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest \
 *     tests/integration/issue-423-native.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 */
process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';

import { execSync } from 'child_process';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';
import { getInputBackend } from '../../src/tools/native-input-backend';

const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';
const BUNDLE = 'com.apple.Preferences';

const SETTINGS_GENERAL_ID = 'com.apple.settings.general';
const SETTINGS_ABOUT_LABEL = process.env.SETTINGS_ABOUT ?? 'About';

jest.setTimeout(120_000);

async function launchSettings(): Promise<void> {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  } catch {
    /* not running — fine */
  }
  execSync(`xcrun simctl launch ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1800));
}

async function tap(query: {
  label?: string;
  identifier?: string;
  role?: string;
  text?: string;
  index?: number;
}): Promise<void> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(query, { deviceId: DEVICE_ID });
  if (result.matches.length === 0) {
    throw new Error(`element not found: ${JSON.stringify(query)}`);
  }
  const m = result.matches[query.index ?? 0];
  const x = m.frame.x + m.frame.width / 2;
  const y = m.frame.y + m.frame.height / 2;
  const backend = await getInputBackend(DEVICE_ID);
  await backend.tap(DEVICE_ID, x, y);
}

beforeAll(async () => {
  await launchSettings();
});

describe('issue #423 — native (non-Flutter) app via AccessibilityBridge', () => {
  test('app_query finds a UIKit row by identifier (Settings → General)', async () => {
    await launchSettings();
    const bridge = getAccessibilityBridge();
    const r = await bridge.query({ identifier: SETTINGS_GENERAL_ID }, { deviceId: DEVICE_ID });
    // Settings.app exposes "General" as a top-level cell on every
    // recent iOS release; at least one match is expected.
    expect(r.matches.length).toBeGreaterThan(0);
    const node = r.matches[0];
    expect(node.visible).toBe(true);
    expect(node.frame.width).toBeGreaterThan(0);
    expect(node.frame.height).toBeGreaterThan(0);
  });

  test('app_tap_element taps a UIKit row (Settings → General) and advances navigation', async () => {
    await launchSettings();
    await tap({ identifier: SETTINGS_GENERAL_ID });
    await new Promise((r) => setTimeout(r, 900));
    // After tapping General, the Settings app pushes the General sub-screen,
    // which contains an "About" cell. Matching on that label (locale-aware via
    // SETTINGS_ABOUT env var) proves the tap landed on a UIKit cell and
    // advanced the navigation stack — exactly the same code path as Flutter.
    const bridge = getAccessibilityBridge();
    const r = await bridge.query({ label: SETTINGS_ABOUT_LABEL }, { deviceId: DEVICE_ID });
    expect(r.matches.length).toBeGreaterThan(0);
  });
});
