/**
 * Unit tests for qa_flutter_orientation detector.
 *
 * Verifies detection of overflow, missing elements, orientation lock,
 * and that portrait orientation is restored after the check.
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerQaFlutterOrientationTool } from '../../src/tools/qa-flutter-orientation';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDumpTree = jest.fn();
const mockExec = jest.fn().mockResolvedValue('');

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
    exec: mockExec,
  })),
}));

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

function makeButton(label: string, frame: { x: number; y: number; width: number; height: number }, path: string): AXNode {
  return makeNode({
    role: 'AXButton',
    label,
    frame,
    path,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('qa_flutter_orientation', () => {
  let handler: ToolHandler;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    registerQaFlutterOrientationTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('detects missing elements in landscape', async () => {
    // Portrait tree has 3 interactive elements
    const portraitTree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeButton('Login', { x: 20, y: 100, width: 200, height: 48 }, '0'),
        makeButton('Register', { x: 20, y: 200, width: 200, height: 48 }, '1'),
        makeButton('Help', { x: 20, y: 300, width: 200, height: 48 }, '2'),
      ],
    });

    // Landscape tree has only 2 — "Help" is missing
    const landscapeTree = makeNode({
      frame: { x: 0, y: 0, width: 852, height: 393 },
      children: [
        makeButton('Login', { x: 20, y: 50, width: 300, height: 48 }, '0'),
        makeButton('Register', { x: 20, y: 120, width: 300, height: 48 }, '1'),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(portraitTree)
      .mockResolvedValueOnce(landscapeTree);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.portrait_interactive_count).toBe(3);
    expect(body.landscape_interactive_count).toBe(2);
    expect(body.missing_in_landscape).toContain('Help');
    expect(body.orientation_locked).toBe(false);
  });

  it('detects overflow in landscape', async () => {
    // Portrait — everything fits
    const portraitTree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeButton('Wide Button', { x: 20, y: 100, width: 350, height: 48 }, '0'),
      ],
    });

    // Landscape — element extends beyond screen bounds
    const landscapeTree = makeNode({
      frame: { x: 0, y: 0, width: 852, height: 393 },
      children: [
        makeButton('Wide Button', { x: 20, y: 100, width: 350, height: 320 }, '0'),
        // This element overflows: right edge = 500 + 400 = 900 > 862 (852 + 10 tolerance)
        makeButton('Overflow', { x: 500, y: 50, width: 400, height: 48 }, '1'),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(portraitTree)
      .mockResolvedValueOnce(landscapeTree);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.overflow_violations.length).toBeGreaterThan(0);
    expect(body.overflow_violations.some((v: { label: string }) => v.label === 'Overflow')).toBe(true);
  });

  it('reports orientation locked when trees are identical', async () => {
    // Both trees have identical frames — orientation is locked
    const tree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeButton('Login', { x: 20, y: 100, width: 200, height: 48 }, '0'),
        makeButton('Register', { x: 20, y: 200, width: 200, height: 48 }, '1'),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(tree)
      .mockResolvedValueOnce(tree);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.orientation_locked).toBe(true);
    expect(body.passed).toBe(false);
    expect(body.summary).toContain('locked');
  });

  it('restores orientation after check', async () => {
    const portraitTree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeButton('Login', { x: 20, y: 100, width: 200, height: 48 }, '0'),
      ],
    });

    const landscapeTree = makeNode({
      frame: { x: 0, y: 0, width: 852, height: 393 },
      children: [
        makeButton('Login', { x: 20, y: 50, width: 300, height: 48 }, '0'),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(portraitTree)
      .mockResolvedValueOnce(landscapeTree);

    await handler('s', {});

    // Verify simctl was called: first to rotate to landscape, then to restore portrait
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(1, ['io', 'test-device-id', 'setorientation', 'landscapeLeft']);
    expect(mockExec).toHaveBeenNthCalledWith(2, ['io', 'test-device-id', 'setorientation', 'portrait']);
  });

  it('passes when layout adapts correctly', async () => {
    const portraitTree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeButton('Login', { x: 20, y: 100, width: 200, height: 48 }, '0'),
        makeButton('Register', { x: 20, y: 200, width: 200, height: 48 }, '1'),
      ],
    });

    // Landscape adapts: different frames, same elements, no overflow
    const landscapeTree = makeNode({
      frame: { x: 0, y: 0, width: 852, height: 393 },
      children: [
        makeButton('Login', { x: 20, y: 50, width: 400, height: 48 }, '0'),
        makeButton('Register', { x: 20, y: 120, width: 400, height: 48 }, '1'),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(portraitTree)
      .mockResolvedValueOnce(landscapeTree);

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.orientation_locked).toBe(false);
    expect(body.missing_in_landscape).toEqual([]);
    expect(body.overflow_violations).toEqual([]);
  });

  it('handles errors gracefully', async () => {
    mockDumpTree.mockRejectedValueOnce(new Error('Simulator not running'));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error).toBe('APP_STATE_UNKNOWN');
    expect(body.message).toBe('Simulator not running');
  });
});
