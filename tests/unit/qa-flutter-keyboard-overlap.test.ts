/**
 * Unit tests for qa_flutter_keyboard_overlap detector.
 *
 * Covers: obscured input detection, overlap pixel reporting,
 * scrollable form detection, and passing when all inputs are above keyboard.
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerQaFlutterKeyboardOverlapTool } from '../../src/tools/qa-flutter-keyboard-overlap';
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

function makeInput(
  label: string,
  y: number,
  path: string,
  role: string = 'AXTextField',
): AXNode {
  return makeNode({
    role,
    label,
    frame: { x: 20, y, width: 350, height: 44 },
    path,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('qa_flutter_keyboard_overlap', () => {
  let handler: ToolHandler;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    registerQaFlutterKeyboardOverlapTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('detects input obscured by keyboard', async () => {
    // Screen height 844, keyboard_height 300 => keyboard_top = 544
    // Input at y=600 with height 44 => bottom = 644, overlaps by 100px
    const tree = makeNode({
      children: [
        makeInput('Email', 600, '0/0'),
      ],
    });
    // First dump returns the initial tree; second dump (after tap) returns same positions
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.violations_count).toBe(1);
    expect(body.violations[0].label).toBe('Email');
    expect(body.violations[0].overlap_pixels).toBe(100);
    expect(body.violations[0].issue).toContain('100 pixels');
  });

  it('passes when all inputs are above keyboard area', async () => {
    // Screen height 844, keyboard_height 300 => keyboard_top = 544
    // Input at y=100 with height 44 => bottom = 144, well above keyboard
    const tree = makeNode({
      children: [
        makeInput('Name', 100, '0/0'),
        makeInput('Email', 200, '0/1'),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.violations_count).toBe(0);
    expect(body.total_inputs).toBe(2);
  });

  it('reports overlap in pixels correctly', async () => {
    // Screen height 844, keyboard_height 300 => keyboard_top = 544
    // Input at y=520, height 44 => bottom = 564 => overlap = 20px
    const tree = makeNode({
      children: [
        makeInput('Phone', 520, '0/0'),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.violations[0].overlap_pixels).toBe(20);
    expect(body.violations[0].role).toBe('AXTextField');
  });

  it('detects when form scrolls (frame.y changes between dumps)', async () => {
    // Initial tree: input at y=700
    const initialTree = makeNode({
      children: [
        makeInput('Address', 700, '0/0'),
      ],
    });

    // After tapping: input scrolled up to y=300 (form scrolled)
    const scrolledTree = makeNode({
      children: [
        makeNode({
          role: 'AXTextField',
          label: 'Address',
          frame: { x: 20, y: 300, width: 350, height: 44 },
          path: '0/0',
          traits: [],
          visible: true,
          enabled: true,
          focused: true,
        }),
      ],
    });

    // First call returns initial tree, subsequent calls return scrolled tree
    mockDumpTree
      .mockResolvedValueOnce(initialTree)
      .mockResolvedValueOnce(scrolledTree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    // After scrolling, bottom = 300 + 44 = 344, which is above keyboard_top (544)
    expect(body.passed).toBe(true);
    expect(body.violations_count).toBe(0);
  });

  it('reports scrolled=true when field position changes after focus', async () => {
    // Initial tree: input at y=600
    const initialTree = makeNode({
      children: [
        makeInput('Notes', 600, '0/0', 'AXTextArea'),
      ],
    });

    // After tapping: input scrolled to y=500 but still overlaps
    // keyboard_top = 544, bottom = 500 + 44 = 544 — exactly at boundary, no overlap
    // Let's make it still overlap: y=510, bottom = 554 > 544 => overlap 10px
    const scrolledTree = makeNode({
      children: [
        makeNode({
          role: 'AXTextArea',
          label: 'Notes',
          frame: { x: 20, y: 510, width: 350, height: 44 },
          path: '0/0',
          traits: [],
          visible: true,
          enabled: true,
          focused: true,
        }),
      ],
    });

    mockDumpTree
      .mockResolvedValueOnce(initialTree)
      .mockResolvedValueOnce(scrolledTree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.violations[0].scrolled).toBe(true);
    expect(body.violations[0].overlap_pixels).toBe(10);
    expect(body.violations[0].role).toBe('AXTextArea');
  });

  it('uses simctl to tap and dismiss keyboard', async () => {
    const tree = makeNode({
      children: [
        makeInput('Email', 100, '0/0'),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    await handler('s', { device_id: 'DEV-123', keyboard_height: 300 });

    // Should have called simctl tap on the input center
    expect(mockExec).toHaveBeenCalledWith(
      expect.arrayContaining(['io', 'DEV-123', 'input', 'tap']),
    );
    // Should have called simctl sendkey to dismiss keyboard
    expect(mockExec).toHaveBeenCalledWith(
      ['io', 'DEV-123', 'sendkey', '41'],
    );
  });

  it('ignores non-input elements', async () => {
    const tree = makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Submit', frame: { x: 20, y: 700, width: 350, height: 44 }, path: '0/0' }),
        makeNode({ role: 'AXStaticText', label: 'Title', frame: { x: 20, y: 750, width: 350, height: 20 }, path: '0/1' }),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.total_inputs).toBe(0);
    expect(body.passed).toBe(true);
  });

  it('ignores hidden input fields', async () => {
    const tree = makeNode({
      children: [
        makeNode({
          role: 'AXTextField',
          label: 'Hidden',
          visible: false,
          frame: { x: 20, y: 700, width: 350, height: 44 },
          path: '0/0',
        }),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.total_inputs).toBe(0);
    expect(body.passed).toBe(true);
  });

  it('derives screen height from root node frame', async () => {
    // Root node with non-default height
    const tree = makeNode({
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        makeInput('Email', 600, '0/0'),
      ],
    });
    mockDumpTree.mockResolvedValue(tree);

    const result = await handler('s', { keyboard_height: 300 });
    const body = JSON.parse(result.content[0].text);

    // keyboard_top = 852 - 300 = 552
    // bottom = 600 + 44 = 644 > 552 => overlap = 92
    expect(body.screen_height).toBe(852);
    expect(body.violations[0].overlap_pixels).toBe(92);
  });
});
