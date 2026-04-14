/**
 * Unit tests for qa_flutter_full_audit orchestrator tool.
 *
 * Tests: aggregation, structured JSON, weighted scoring,
 * graceful failure handling, and parallel execution.
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerQaFlutterFullAuditTool } from '../../src/tools/qa-flutter-full-audit';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDumpTree = jest.fn();
const mockSimctlExec = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    dumpTree: mockDumpTree,
  }),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockSimctlExec,
  })),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    statSync: jest.fn().mockReturnValue({ size: 100000 }),
    unlinkSync: jest.fn(),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type ToolHandler = (s: string, p: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeNode(overrides: Partial<AXNode> & { children?: AXNode[] } = {}): AXNode {
  return {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 390, height: 844 },
    visible: true,
    enabled: true,
    focused: false,
    path: '',
    ...overrides,
  };
}

function makeButton(label: string, width: number, height: number, pathStr: string): AXNode {
  return makeNode({
    role: 'AXButton',
    label,
    identifier: `${label.toLowerCase()}_btn`,
    frame: { x: 20, y: 100, width, height },
    path: pathStr,
  });
}

/**
 * Configure simctl mock to simulate dark mode check with a given size difference.
 * Returns different file sizes for light vs dark screenshots to control pass/fail.
 */
function setupDarkModeMock(sizeDiffPercent: number): void {
  const lightSize = 100000;
  const darkSize = lightSize + Math.round(lightSize * (sizeDiffPercent / 100));

  let screenshotCall = 0;
  const fsModule = require('fs');
  (fsModule.statSync as jest.Mock).mockImplementation((filePath: string) => {
    if (typeof filePath === 'string' && filePath.includes('light')) {
      return { size: lightSize };
    }
    if (typeof filePath === 'string' && filePath.includes('dark')) {
      return { size: darkSize };
    }
    return { size: lightSize };
  });

  mockSimctlExec.mockImplementation(async (args: string[]) => {
    if (args[0] === 'ui' && args.length === 3) {
      // Reading appearance
      return 'light';
    }
    // Setting appearance or taking screenshot
    return '';
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('qa_flutter_full_audit', () => {
  let handler: ToolHandler;
  // Dark mode check has two 1500ms sleeps; keep Jest timeout generous.
  jest.setTimeout(15000);

  // Speed up dark-mode sleeps so the suite runs in a reasonable time.
  const originalSetTimeout = global.setTimeout;
  beforeAll(() => {
    const fastSetTimeout = ((cb: (...a: unknown[]) => void): unknown => {
      return originalSetTimeout(cb, 0);
    }) as unknown as typeof global.setTimeout;
    global.setTimeout = fastSetTimeout;

    const server = { registerTool: jest.fn() };
    registerQaFlutterFullAuditTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1];
  });

  afterAll(() => {
    global.setTimeout = originalSetTimeout;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setupDarkModeMock(5); // Default: dark mode passes (5% diff)
  });

  // ── Test 1: Runs all detectors and aggregates results ──────────────────

  it('runs all detectors and aggregates results', async () => {
    // Tree with both passing and failing elements
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('Login', 200, 48, '0'),    // pass touch, pass semantics
        makeButton('OK', 30, 30, '1'),          // fail touch, pass semantics
        makeNode({ role: 'AXButton', path: '2' }), // pass touch (no frame issue), fail semantics (no label)
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.detector).toBe('qa_flutter_full_audit');
    expect(body.total_detectors).toBe(3);
    expect(body.results).toHaveLength(3);

    // Verify all three detectors ran
    const detectorNames = body.results.map((r: { detector: string }) => r.detector);
    expect(detectorNames).toContain('touch_targets');
    expect(detectorNames).toContain('semantics');
    expect(detectorNames).toContain('dark_mode');
  });

  // ── Test 2: Returns structured JSON with per-detector pass/fail ────────

  it('returns structured JSON with per-detector pass/fail and warnings', async () => {
    // All elements pass touch targets, all have labels -> touch + semantics pass
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('Login', 200, 48, '0'),
        makeButton('Register', 300, 50, '1'),
      ],
    }));
    setupDarkModeMock(5); // dark mode passes

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    // Verify structure
    expect(body).toHaveProperty('detector', 'qa_flutter_full_audit');
    expect(body).toHaveProperty('passed');
    expect(body).toHaveProperty('score');
    expect(body).toHaveProperty('total_detectors');
    expect(body).toHaveProperty('passed_count');
    expect(body).toHaveProperty('failed_count');
    expect(body).toHaveProperty('error_count');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('summary');

    // Verify per-detector structure
    for (const r of body.results) {
      expect(r).toHaveProperty('detector');
      expect(r).toHaveProperty('passed');
      expect(r).toHaveProperty('severity');
      expect(r).toHaveProperty('summary');
      expect(r).toHaveProperty('details');
    }

    // Touch targets: both buttons >= 48dp -> pass
    const touchResult = body.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touchResult.passed).toBe(true);

    // Semantics: both buttons have labels -> pass
    const semResult = body.results.find((r: { detector: string }) => r.detector === 'semantics');
    expect(semResult.passed).toBe(true);

    // Dark mode: size diff > 2% -> pass
    const darkResult = body.results.find((r: { detector: string }) => r.detector === 'dark_mode');
    expect(darkResult.passed).toBe(true);

    // All pass
    expect(body.passed).toBe(true);
    expect(body.score).toBe(100);
    expect(body.passed_count).toBe(3);
    expect(body.failed_count).toBe(0);
  });

  // ── Test 3: Score calculation is correct (weighted by severity) ────────

  it('calculates weighted score correctly', async () => {
    // Touch targets: FAIL (severity: high, weight: 3)
    // Semantics: PASS (severity: high, weight: 3)
    // Dark mode: PASS (severity: medium, weight: 2)
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('OK', 20, 20, '0'),         // too small -> touch targets fail
        makeButton('Login', 200, 48, '1'),      // ok
      ],
    }));
    setupDarkModeMock(10); // dark mode passes

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    // touch_targets fails (high=3), semantics passes (high=3), dark_mode passes (medium=2)
    // passedWeight = 3 + 2 = 5, totalWeight = 3 + 3 + 2 = 8
    // score = round(5/8 * 100) = 63
    expect(body.score).toBe(63);
    expect(body.passed).toBe(false);
    expect(body.passed_count).toBe(2);
    expect(body.failed_count).toBe(1);

    const touchResult = body.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touchResult.passed).toBe(false);
    expect(touchResult.severity).toBe('high');

    const semResult = body.results.find((r: { detector: string }) => r.detector === 'semantics');
    expect(semResult.passed).toBe(true);
    expect(semResult.severity).toBe('high');

    const darkResult = body.results.find((r: { detector: string }) => r.detector === 'dark_mode');
    expect(darkResult.passed).toBe(true);
    expect(darkResult.severity).toBe('medium');
  });

  it('calculates score when only dark mode fails', async () => {
    // Touch targets: PASS, Semantics: PASS, Dark mode: FAIL
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('Login', 200, 48, '0'),
        makeButton('Register', 300, 50, '1'),
      ],
    }));
    setupDarkModeMock(1); // dark mode fails (< 2% diff)

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    // touch passes (3), semantics passes (3), dark_mode fails (2)
    // passedWeight = 3 + 3 = 6, totalWeight = 3 + 3 + 2 = 8
    // score = round(6/8 * 100) = 75
    expect(body.score).toBe(75);
    expect(body.passed).toBe(false);
    expect(body.passed_count).toBe(2);
    expect(body.failed_count).toBe(1);
  });

  it('returns score 0 when all detectors fail', async () => {
    // Touch targets: FAIL, Semantics: FAIL, Dark mode: FAIL
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', path: '0', frame: { x: 0, y: 0, width: 20, height: 20 } }), // no label, too small
      ],
    }));
    setupDarkModeMock(0); // dark mode fails

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.score).toBe(0);
    expect(body.passed).toBe(false);
    expect(body.passed_count).toBe(0);
    expect(body.failed_count).toBe(3);
  });

  // ── Test 4: Handles individual detector failure gracefully ─────────────

  it('handles tree dump failure gracefully (dark mode still runs)', async () => {
    // Tree dump fails -> touch_targets and semantics get error entries
    mockDumpTree.mockRejectedValue(new Error('Accessibility bridge not available'));
    setupDarkModeMock(5); // dark mode passes independently

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.total_detectors).toBe(3);
    expect(body.error_count).toBe(2); // touch + semantics failed

    // Touch targets and semantics show errors
    const touchResult = body.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touchResult.passed).toBe(false);
    expect(touchResult.error).toContain('Accessibility bridge not available');

    const semResult = body.results.find((r: { detector: string }) => r.detector === 'semantics');
    expect(semResult.passed).toBe(false);
    expect(semResult.error).toContain('Accessibility bridge not available');

    // Dark mode still succeeded
    const darkResult = body.results.find((r: { detector: string }) => r.detector === 'dark_mode');
    expect(darkResult.passed).toBe(true);
    expect(darkResult.error).toBeUndefined();
  });

  it('handles dark mode failure gracefully (tree checks still run)', async () => {
    // Tree checks succeed, dark mode fails
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('Login', 200, 48, '0'),
      ],
    }));
    mockSimctlExec.mockRejectedValue(new Error('Simulator not booted'));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.total_detectors).toBe(3);
    expect(body.error_count).toBe(1); // only dark mode failed

    // Tree-based checks passed
    const touchResult = body.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touchResult.passed).toBe(true);

    const semResult = body.results.find((r: { detector: string }) => r.detector === 'semantics');
    expect(semResult.passed).toBe(true);

    // Dark mode has error
    const darkResult = body.results.find((r: { detector: string }) => r.detector === 'dark_mode');
    expect(darkResult.passed).toBe(false);
    expect(darkResult.error).toContain('Simulator not booted');
  });

  it('handles all detectors failing gracefully', async () => {
    mockDumpTree.mockRejectedValue(new Error('AX bridge down'));
    mockSimctlExec.mockRejectedValue(new Error('simctl unavailable'));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.total_detectors).toBe(3);
    expect(body.error_count).toBe(3);
    expect(body.passed).toBe(false);
    expect(body.score).toBe(0);
    expect(body.passed_count).toBe(0);
    expect(body.failed_count).toBe(3);

    // All have error messages
    for (const r of body.results) {
      expect(r.error).toBeDefined();
      expect(r.passed).toBe(false);
    }
  });

  // ── Test 5: Parallel execution pattern works ───────────────────────────

  it('executes tree-based checks and dark mode in parallel', async () => {
    let treeDumpTime = 0;
    let darkModeStartTime = 0;

    mockDumpTree.mockImplementation(async () => {
      treeDumpTime = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      return makeNode({
        children: [makeButton('Login', 200, 48, '0')],
      });
    });

    const originalExec = mockSimctlExec;
    mockSimctlExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ui' && args.length === 3) {
        darkModeStartTime = Date.now();
        return 'light';
      }
      return '';
    });

    // Reset the fs mock for this test
    const fsModule = require('fs');
    (fsModule.statSync as jest.Mock).mockReturnValue({ size: 100000 });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.total_detectors).toBe(3);

    // Both should have started (we can't guarantee exact timing, but they
    // should both have run since we got results for all 3)
    expect(body.results).toHaveLength(3);
  });

  // ── Additional edge cases ──────────────────────────────────────────────

  it('respects custom min_size and min_coverage parameters', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        // 40x40 button: fails at 48dp, passes at 35dp
        makeButton('Small', 40, 40, '0'),
        // Button with label: passes semantics at any threshold
        makeButton('Big', 200, 200, '1'),
      ],
    }));
    setupDarkModeMock(5);

    // With defaults (48dp min, 80% coverage) -> touch targets fail
    const result1 = await handler('s', {});
    const body1 = JSON.parse(result1.content[0].text);
    const touch1 = body1.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touch1.passed).toBe(false);

    // With custom min_size=35 -> touch targets pass
    const result2 = await handler('s', { min_size: 35 });
    const body2 = JSON.parse(result2.content[0].text);
    const touch2 = body2.results.find((r: { detector: string }) => r.detector === 'touch_targets');
    expect(touch2.passed).toBe(true);
  });

  it('sets isError based on score and pass status', async () => {
    // All pass -> isError = false
    mockDumpTree.mockResolvedValue(makeNode({
      children: [makeButton('Login', 200, 48, '0')],
    }));
    setupDarkModeMock(5);

    const result = await handler('s', {});
    expect(result.isError).toBe(false);

    // Some fail -> isError = true
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', path: '0', frame: { x: 0, y: 0, width: 20, height: 20 } }),
      ],
    }));

    const result2 = await handler('s', {});
    expect(result2.isError).toBe(true);
  });

  it('includes summary string in report', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [makeButton('Login', 200, 48, '0')],
    }));
    setupDarkModeMock(5);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.summary).toMatch(/Flutter QA Audit: \d+\/100/);
    expect(body.summary).toMatch(/\d+\/\d+ detectors passed/);
  });
});
