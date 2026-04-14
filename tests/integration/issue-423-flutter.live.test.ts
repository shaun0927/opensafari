/**
 * Live integration suite for issue #423 — exercises `app_tap_element` and
 * `app_type_element` against a real Flutter sample app on a booted iOS
 * Simulator. See ./README.md for setup; this file is opt-in only and is
 * excluded from the default `npm test` run.
 *
 * Each test relaunches the fixture so cases stay independent: a flake in
 * one case does not poison the next case's starting state.
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

jest.setTimeout(180_000);

interface TapResult {
  x: number;
  y: number;
  element: { role?: string; label?: string; identifier?: string };
}

async function tap(query: {
  label?: string;
  identifier?: string;
  role?: string;
  text?: string;
  index?: number;
}): Promise<TapResult> {
  await ensureSemanticsActive(DEVICE_ID);
  const bridge = getAccessibilityBridge();
  const result = await bridge.query(query, { deviceId: DEVICE_ID });
  if (result.matches.length === 0) {
    throw new Error(`element not found: ${JSON.stringify(query)}`);
  }
  const m = result.matches[query.index ?? 0];
  if (!m.visible || m.frame.width <= 0 || m.frame.height <= 0) {
    throw new Error(`element not visible: ${JSON.stringify(m)}`);
  }
  const x = m.frame.x + m.frame.width / 2;
  const y = m.frame.y + m.frame.height / 2;
  const backend = await getInputBackend(DEVICE_ID);
  await backend.tap(DEVICE_ID, x, y);
  return { x, y, element: m };
}

async function typeInto(
  query: { label?: string; identifier?: string; role?: string },
  text: string,
): Promise<TapResult> {
  const target = await tap(query);
  await new Promise((r) => setTimeout(r, 250));
  const backend = await getInputBackend(DEVICE_ID);
  await backend.typeText(DEVICE_ID, text);
  return target;
}

async function readStatus(id = 'status_label'): Promise<string> {
  const bridge = getAccessibilityBridge();
  const r = await bridge.query({ identifier: id }, { deviceId: DEVICE_ID });
  // Flutter occasionally surfaces dynamic text in `value` rather than
  // `label`; concatenate both so the status check is resilient.
  const node = r.matches[0] as { label?: string; value?: string } | undefined;
  return `${node?.label ?? ''}|${node?.value ?? ''}`;
}

async function relaunch(): Promise<void> {
  try {
    execSync(`xcrun simctl terminate ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  } catch {
    /* not running — nothing to do */
  }
  execSync(`xcrun simctl launch ${DEVICE_ID} ${BUNDLE}`, { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1500));
}

beforeAll(async () => {
  await relaunch();
});

afterAll(() => {
  try {
    execSync(`xcrun simctl rotate ${DEVICE_ID} portrait`, { stdio: 'pipe' });
  } catch {
    /* simctl rotate is unavailable on some Xcode versions — ignore */
  }
});

describe('issue #423 — Flutter integration on iOS simulator', () => {
  test('Flutter ElevatedButton by label — tap changes status', async () => {
    await relaunch();
    const before = await readStatus();
    await tap({ label: 'Login', index: 0 });
    await new Promise((r) => setTimeout(r, 500));
    const after = await readStatus();
    expect(after).not.toBe(before);
  });

  test('Flutter TextField by identifier — gains focus after tap', async () => {
    await relaunch();
    await tap({ identifier: 'email_field' });
    await new Promise((r) => setTimeout(r, 700));
    const bridge = getAccessibilityBridge();
    const r = await bridge.query(
      { identifier: 'email_field' },
      { deviceId: DEVICE_ID },
    );
    expect(r.matches[0]?.focused).toBe(true);
  });

  test('app_type_element — types into Flutter TextField by label', async () => {
    await relaunch();
    await typeInto({ label: 'Email' }, 'a@b.co');
    await new Promise((r) => setTimeout(r, 600));
    const status = await readStatus();
    expect(status).toMatch(/a@b\.co/);
  });

  test('tap works after device rotation', async () => {
    await relaunch();
    try {
      execSync(`xcrun simctl rotate ${DEVICE_ID} landscape-left`, { stdio: 'pipe' });
    } catch {
      /* older Xcode — ignore */
    }
    await new Promise((r) => setTimeout(r, 800));
    const before = await readStatus();
    await tap({ label: 'Login', index: 0 });
    await new Promise((r) => setTimeout(r, 500));
    const after = await readStatus();
    try {
      execSync(`xcrun simctl rotate ${DEVICE_ID} portrait`, { stdio: 'pipe' });
    } catch {
      /* ignore */
    }
    expect(after).not.toBe(before);
  });

  test('scrolled-off-screen / absent element — surfaces helpful error', async () => {
    await relaunch();
    await expect(tap({ label: 'NonexistentElementXYZ' })).rejects.toThrow(
      /not found/,
    );
  });

  test('tap inside ListView — by label + index', async () => {
    await relaunch();
    await tap({ label: 'Row Item', index: 0 });
    await new Promise((r) => setTimeout(r, 500));
    const status = await readStatus();
    expect(status).toMatch(/row:/);
  });

  test('multi-step navigation — Email → Login → Continue → Next → Name → Finish', async () => {
    await relaunch();
    await typeInto({ label: 'Email' }, 'me@x.io');
    await new Promise((r) => setTimeout(r, 300));
    await tap({ label: 'Login', index: 0 });
    await new Promise((r) => setTimeout(r, 400));
    await tap({ label: 'Continue', index: 0 });
    await new Promise((r) => setTimeout(r, 400));
    await tap({ label: 'Next', index: 0 });
    await new Promise((r) => setTimeout(r, 1000));
    await typeInto({ identifier: 'name_field' }, 'Alice');
    await new Promise((r) => setTimeout(r, 300));
    await tap({ identifier: 'finish_btn' });
    await new Promise((r) => setTimeout(r, 700));
    const s2 = await readStatus('second_status');
    expect(s2).toMatch(/finished/);
  });
});
