/**
 * Unit tests for Flutter QA detectors:
 *   qa_flutter_touch_targets, qa_flutter_semantics, qa_flutter_dark_mode
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerQaFlutterTouchTargetsTool } from '../../src/tools/qa-flutter-touch-targets';
import { registerQaFlutterSemanticsTool } from '../../src/tools/qa-flutter-semantics';
import type { AXNode } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDumpTree = jest.fn();

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

function makeButton(label: string, width: number, height: number, path: string): AXNode {
  return makeNode({
    role: 'AXButton',
    label,
    frame: { x: 20, y: 100, width, height },
    path,
  });
}

// ── Touch Targets Tests ──────────────────────────────────────────────────────

describe('qa_flutter_touch_targets', () => {
  let handler: ToolHandler;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    registerQaFlutterTouchTargetsTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('passes when all buttons meet minimum size', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('Login', 200, 48, '0'),
        makeButton('Register', 300, 50, '1'),
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.violations_count).toBe(0);
    expect(body.total_interactive).toBe(2);
  });

  it('detects buttons smaller than 48dp', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('OK', 30, 30, '0'),        // too small
        makeButton('Login', 200, 48, '1'),     // ok
        makeButton('X', 20, 20, '2'),          // too small
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.violations_count).toBe(2);
    expect(body.violations[0].label).toBe('OK');
    expect(body.violations[1].label).toBe('X');
  });

  it('supports custom minimum size', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeButton('OK', 40, 40, '0'), // fails at 48, passes at 40
      ],
    }));

    const result = await handler('s', { min_size: 40 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
  });

  it('ignores non-interactive elements', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXStaticText', label: 'Hello', frame: { x: 0, y: 0, width: 10, height: 10 }, path: '0' }),
        makeButton('Login', 200, 48, '1'),
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.total_interactive).toBe(1); // only the button
  });

  it('ignores hidden elements', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Hidden', visible: false, frame: { x: 0, y: 0, width: 10, height: 10 }, path: '0' }),
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.total_interactive).toBe(0);
  });
});

// ── Semantics Coverage Tests ─────────────────────────────────────────────────

describe('qa_flutter_semantics', () => {
  let handler: ToolHandler;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    registerQaFlutterSemanticsTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1];
  });

  beforeEach(() => jest.clearAllMocks());

  it('passes when all elements have labels', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Login', identifier: 'login_btn', path: '0' }),
        makeNode({ role: 'AXTextField', label: 'Email', identifier: 'email_field', path: '1' }),
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.coverage_percent).toBe(100);
  });

  it('fails when elements lack labels', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Login', path: '0' }),
        makeNode({ role: 'AXButton', path: '1' }), // no label or identifier
        makeNode({ role: 'AXTextField', path: '2' }), // no label or identifier
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(false);
    expect(body.coverage_percent).toBeLessThan(80);
    expect(body.issues_count).toBeGreaterThan(0);
  });

  it('supports custom min_coverage', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'A', path: '0' }),
        makeNode({ role: 'AXButton', path: '1' }), // unlabeled
      ],
    }));

    // 50% coverage — fails at 80%, passes at 50%
    const result = await handler('s', { min_coverage: 50 });
    const body = JSON.parse(result.content[0].text);

    expect(body.passed).toBe(true);
    expect(body.coverage_percent).toBe(50);
  });

  it('reports identifier coverage separately', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [
        makeNode({ role: 'AXButton', label: 'Login', identifier: 'login_btn', path: '0' }),
        makeNode({ role: 'AXButton', label: 'Register', path: '1' }), // label but no identifier
      ],
    }));

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.coverage_percent).toBe(100); // all have labels
    expect(body.identifier_coverage_percent).toBe(50); // only half have identifiers
  });
});
