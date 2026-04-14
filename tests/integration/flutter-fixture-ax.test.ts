// Integration test — requires booted iOS simulator and Flutter SDK. Gated by default. See issue #422.

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

import { ensureSemanticsActive } from '../../src/native/semantics-activator';
import { getAccessibilityBridge } from '../../src/native/accessibility-bridge';
import type { AXNode } from '../../src/native/ax-types';

jest.setTimeout(240000);

const execFileAsync = promisify(execFile);

const BUNDLE_ID = 'com.opensafari.fixtures.flutterQaApp';
const BUILD_SCRIPT = path.resolve(__dirname, '../fixtures/flutter-qa-app/build.sh');

// ---------------------------------------------------------------------------
// Gate: skip the suite unless we have both flutter on PATH and a booted device.
// ---------------------------------------------------------------------------

function flutterOnPath(): boolean {
  const bin = process.env.FLUTTER_BIN ?? 'flutter';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function resolveBootedDeviceId(): string | null {
  const fromEnv = process.env.FIXTURE_DEVICE_ID;
  if (fromEnv) return fromEnv;

  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const match = out.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// Gate check (synchronous, evaluated at load time).
const hasFlutter = flutterOnPath();
const resolvedDeviceId = resolveBootedDeviceId();
const shouldRun = hasFlutter && resolvedDeviceId !== null;

if (!shouldRun && !process.env.CI) {
  if (!hasFlutter) {
    console.error(
      '[flutter-fixture-ax] SKIP: flutter not found on PATH (set FLUTTER_BIN to override)',
    );
  } else {
    console.error(
      '[flutter-fixture-ax] SKIP: no booted iOS simulator found and FIXTURE_DEVICE_ID is not set',
    );
  }
}

// Use describe.skip when the gate conditions are not met.
const describeFn = shouldRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeFn('Flutter fixture integration — accessibility tree and query', () => {
  let deviceId: string;

  // Flatten an AXNode tree into a list of all nodes (breadth-first).
  function flattenTree(root: AXNode): AXNode[] {
    const result: AXNode[] = [];
    const queue: AXNode[] = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);
      if (node.children) {
        for (const child of node.children) {
          queue.push(child);
        }
      }
    }
    return result;
  }

  beforeAll(async () => {
    // resolvedDeviceId is guaranteed non-null inside describeFn (gate above).
    deviceId = resolvedDeviceId!;

    // Build and install the fixture (build.sh handles flutter pub get + build + xcrun simctl install).
    console.error(`[flutter-fixture-ax] Building and installing fixture on device ${deviceId} …`);
    await execFileAsync(
      '/bin/sh',
      [BUILD_SCRIPT, '--mode', 'release', '--device-id', deviceId, '--install'],
      { timeout: 180000 },
    );

    // Terminate any previous running instance (ignore errors if not running).
    try {
      await execFileAsync('xcrun', ['simctl', 'terminate', deviceId, BUNDLE_ID], {
        timeout: 10000,
      });
    } catch {
      // Not running — fine.
    }

    // Launch the fixture.
    console.error(`[flutter-fixture-ax] Launching ${BUNDLE_ID} …`);
    await execFileAsync('xcrun', ['simctl', 'launch', deviceId, BUNDLE_ID], { timeout: 15000 });

    // Allow the first frame to render.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 180000);

  afterAll(async () => {
    try {
      await execFileAsync('xcrun', ['simctl', 'terminate', deviceId, BUNDLE_ID], {
        timeout: 10000,
      });
    } catch {
      // Best-effort.
    }
  });

  // -------------------------------------------------------------------------
  // Test 1 — app_tree populates without VM Service fallback
  // -------------------------------------------------------------------------
  test('app_tree populates without VM Service fallback (release-constraint simulation)', async () => {
    // useVMServiceFallback: false mimics a true Flutter release build where the
    // Dart VM Service is stripped. The simctl-path activation must succeed on
    // its own to prove standalone readiness.
    const activated = await ensureSemanticsActive(deviceId, {
      useVMServiceFallback: false,
      timeout: 5000,
    });
    expect(activated).toBe(true);

    const bridge = getAccessibilityBridge();
    const tree = await bridge.dumpTree({ deviceId, maxDepth: 6 });
    const allNodes = flattenTree(tree);

    // The fixture renders a "Log in" / "Submit" button and a live Counter text.
    const hasLoginNode = allNodes.some(
      (n) =>
        (n.label && /log\s*in|login|submit/i.test(n.label)) ||
        (n.value && /log\s*in|login|submit/i.test(n.value)),
    );
    const hasCounterNode = allNodes.some(
      (n) =>
        (n.label && /Counter:/i.test(n.label)) ||
        (n.value && /Counter:/i.test(n.value)),
    );

    expect(hasLoginNode).toBe(true);
    expect(hasCounterNode).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2 — app_query finds Semantics(identifier:) widgets
  // -------------------------------------------------------------------------
  test('app_query finds Semantics(identifier:) widgets', async () => {
    const bridge = getAccessibilityBridge();

    // Query for 'login-btn' — declared as Semantics(identifier: 'login-btn') in the fixture.
    const loginResult = await bridge.query({ identifier: 'login-btn' }, { deviceId });

    expect(loginResult.matches.length).toBeGreaterThanOrEqual(1);
    expect(loginResult.matches[0].identifier).toBe('login-btn');
    // Flutter's Semantics wrapper overrides the native button role; the bridge
    // reports AXButton for unwrapped buttons but AXGenericElement when a
    // Semantics widget is placed around an ElevatedButton without explicit
    // button: true. Either is acceptable — what matters is the element is
    // found, enabled, and visible.
    expect(
      loginResult.matches[0].role === 'AXButton' ||
        loginResult.matches[0].role === 'AXGenericElement' ||
        (loginResult.matches[0].traits ?? []).some((t) => /button/i.test(t)),
    ).toBe(true);
    expect(loginResult.matches[0].enabled).toBe(true);
    expect(loginResult.matches[0].visible).toBe(true);
    expect(loginResult.ambiguous).toBe(false);

    // Query for 'email-field' — declared as Semantics(identifier: 'email-field') in the fixture.
    const emailResult = await bridge.query({ identifier: 'email-field' }, { deviceId });

    expect(emailResult.matches.length).toBeGreaterThanOrEqual(1);
    expect(emailResult.matches[0].identifier).toBe('email-field');
  });
});
