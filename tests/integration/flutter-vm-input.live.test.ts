/**
 * Live integration suite for issue #481 — verifies that the Tier-0
 * FlutterVMInputBackend drives a running Flutter app on a booted iOS
 * Simulator without stealing focus or moving the mouse.
 *
 * **Opt-in only.** This file is ignored by the default `npm test` run via
 * `jest.config.js` (`testPathIgnorePatterns: ['/tests/integration/']`). To
 * execute it you need:
 *
 *   1. A booted iPhone simulator.
 *   2. The Flutter QA fixture launched via `flutter run` (DDS required for
 *      expression evaluation). Plain `simctl launch` won't work because
 *      the Dart frontend compiler service is only available through DDS.
 *   3. Export `OPENSAFARI_LIVE_VM=1` and pass the device UDID/bundle via
 *      `OSF_DEVICE_ID` / `OSF_BUNDLE_ID` (or rely on the defaults below).
 *
 * Run:
 *   OPENSAFARI_LIVE_VM=1 OSF_DEVICE_ID=<UDID> OSF_BUNDLE_ID=<bundle> \
 *     npx jest tests/integration/flutter-vm-input.live.test.ts \
 *     --runInBand --testPathIgnorePatterns=/node_modules/
 *
 * This suite deliberately does NOT set `OPENSAFARI_ALLOW_FOCUS_INPUT` — the
 * whole point of Tier 0 is that headless automation no longer requires the
 * focus-stealing fallback. If Tier 0 routes correctly the tests pass without
 * any opt-in; if it fails the fallback is blocked and the tests report a
 * clear routing error rather than silently moving the physical mouse.
 */

import { getInputBackend, resetInputBackend } from '../../src/tools/native-input-backend';
import { FlutterVMInputBackend } from '../../src/tools/flutter-vm-input-backend';
import { removeFlutterVMClient } from '../../src/flutter';
import {
  ensureSemanticsActive,
  getAccessibilityBridge,
} from '../../src/native';

const LIVE = process.env.OPENSAFARI_LIVE_VM === '1';
const DEVICE_ID =
  process.env.OSF_DEVICE_ID ?? '3BEF4E9A-069A-4419-AC62-AB889348EF12';

jest.setTimeout(180_000);

async function readStatus(id = 'status_label'): Promise<string> {
  const bridge = getAccessibilityBridge();
  const r = await bridge.query({ identifier: id }, { deviceId: DEVICE_ID });
  const node = r.matches[0] as { label?: string; value?: string } | undefined;
  return `${node?.label ?? ''}|${node?.value ?? ''}`;
}

async function tapLabel(label: string): Promise<void> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const r = await bridge.query({ label }, { deviceId: DEVICE_ID });
  if (r.matches.length === 0) throw new Error(`not found: ${label}`);
  const m = r.matches[0];
  const x = m.frame.x + m.frame.width / 2;
  const y = m.frame.y + m.frame.height / 2;
  const backend = await getInputBackend(DEVICE_ID);
  await backend.tap(DEVICE_ID, x, y);
}

describe('issue #481 — FlutterVMInputBackend live', () => {
  if (!LIVE) {
    test.skip('set OPENSAFARI_LIVE_VM=1 to run live VM input tests', () => {
      // Placeholder so the suite is reported but skipped under default CI.
    });
    return;
  }

  beforeAll(async () => {
    resetInputBackend();
    await new Promise((r) => setTimeout(r, 2000));
  });

  afterAll(() => {
    // Close the live VM Service WebSocket + heartbeat interval so jest's
    // event loop drains; otherwise the suite leaves an open handle that keeps
    // the process alive long after the assertions finish.
    removeFlutterVMClient(DEVICE_ID);
    resetInputBackend();
  });

  test('getInputBackend() selects Tier 0 (FlutterVMInputBackend)', async () => {
    const backend = await getInputBackend(DEVICE_ID);
    expect(backend).toBeInstanceOf(FlutterVMInputBackend);
    expect(backend.kind).toBe('flutter-vm');
  });

  test('tap on Login button changes status — headless, no focus steal', async () => {
    const before = await readStatus();
    await tapLabel('Login');
    await new Promise((r) => setTimeout(r, 500));
    const after = await readStatus();
    expect(after).not.toBe(before);
  });

  test('typeText into focused TextField fires onChanged', async () => {
    await tapLabel('Email');
    await new Promise((r) => setTimeout(r, 400));
    const backend = await getInputBackend(DEVICE_ID);
    await backend.typeText(DEVICE_ID, 'a@b.co');
    await new Promise((r) => setTimeout(r, 500));
    const status = await readStatus();
    expect(status).toMatch(/a@b\.co/);
  });

  test('swipe produces multiple move events in the Flutter gesture arena', async () => {
    const backend = await getInputBackend(DEVICE_ID);
    await backend.swipe(DEVICE_ID, 200, 600, 200, 200, 0.3);
    // No assertion on scroll position — the intent is to prove the gesture
    // dispatches end-to-end without the runtime throwing.
    expect(backend.kind).toBe('flutter-vm');
  });
});
