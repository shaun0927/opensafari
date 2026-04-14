/**
 * Live performance harness for issue #423 — sets a concrete budget on
 * the three performance checklist items for `app_tap_element` and the
 * shared accessibility bridge:
 *
 *   - Single tap completes in < 2s (query + tap)
 *   - Bridge query on a present element returns in < 1500ms
 *   - No obvious memory leak on repeated calls (RSS delta over 50
 *     queries is < 50MB)
 *
 * Budgets are intentionally loose so the harness is useful on
 * developer machines and CI hardware of mixed speeds; the tight
 * per-op timing belongs to unit tests and mocks, not to a live-sim
 * smoke check. If any budget fails the suite surfaces the actual
 * measured value so trend drift can be investigated.
 *
 * Depends on the Flutter fixture committed in the companion integration
 * PR (`tests/integration/fixtures/flutter_sample/`). Build and install
 * per tests/integration/README.md:
 *
 *   cd tests/integration/fixtures/flutter_sample
 *   flutter create --platforms ios --project-name osftest .
 *   flutter build ios --simulator --debug
 *   xcrun simctl install booted build/ios/iphonesimulator/Runner.app
 *
 * Run:
 *   OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest \
 *     tests/integration/issue-423-perf.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 *
 * For the RSS check, enabling `--expose-gc` gives a more accurate
 * baseline:
 *   NODE_OPTIONS=--expose-gc OPENSAFARI_ALLOW_FOCUS_INPUT=1 npx jest …
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
const BUNDLE = process.env.OSF_BUNDLE_ID ?? 'com.example.osftest';

jest.setTimeout(120_000);

async function relaunch(): Promise<void> {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  } catch {
    /* not running — fine */
  }
  execSync(`xcrun simctl launch ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1500));
}

async function singleTap(): Promise<void> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(
    { label: 'Login' },
    { deviceId: DEVICE_ID },
  );
  expect(result.matches.length).toBeGreaterThan(0);
  const m = result.matches[0];
  const x = m.frame.x + m.frame.width / 2;
  const y = m.frame.y + m.frame.height / 2;
  const backend = await getInputBackend(DEVICE_ID);
  await backend.tap(DEVICE_ID, x, y);
}

beforeAll(async () => {
  await relaunch();
});

describe('issue #423 — app_tap_element performance budgets', () => {
  test('single tap (query + tap) completes in < 2s', async () => {
    await relaunch();
    // Warm the simctl-detection cache so the probe is not billed on
    // the very first measurement.
    await ensureSemanticsActive(DEVICE_ID);
    await getAccessibilityBridge().query(
      { label: 'Login' },
      { deviceId: DEVICE_ID },
    );

    const start = Date.now();
    await singleTap();
    const elapsed = Date.now() - start;
    // eslint-disable-next-line no-console
    console.error(`[perf] single tap: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(2000);
  });

  test('bridge query on a present element returns in < 1500ms', async () => {
    const bridge = getAccessibilityBridge();
    // Warm.
    await bridge.query({ label: 'Login' }, { deviceId: DEVICE_ID });

    const start = Date.now();
    const r = await bridge.query({ label: 'Login' }, { deviceId: DEVICE_ID });
    const elapsed = Date.now() - start;
    // eslint-disable-next-line no-console
    console.error(`[perf] bridge query: ${elapsed}ms`);
    expect(r.matches.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });

  test('50 repeated queries — RSS delta stays below 50MB', async () => {
    const gc = (global as { gc?: () => void }).gc;
    if (gc) gc();
    const before = process.memoryUsage().rss;

    const bridge = getAccessibilityBridge();
    for (let i = 0; i < 50; i++) {
      await bridge.query({ label: 'Login' }, { deviceId: DEVICE_ID });
    }

    if (gc) gc();
    const after = process.memoryUsage().rss;
    const deltaMb = (after - before) / 1024 / 1024;
    // eslint-disable-next-line no-console
    console.error(
      `[perf] RSS delta over 50 queries: ${deltaMb.toFixed(2)}MB ` +
        `(before=${(before / 1024 / 1024).toFixed(1)}MB, ` +
        `after=${(after / 1024 / 1024).toFixed(1)}MB)`,
    );
    expect(deltaMb).toBeLessThan(50);
  });
});
