/**
 * Unit tests for Flutter QA detectors:
 *   qa_flutter_touch_targets, qa_flutter_semantics, qa_flutter_dark_mode
 */

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

// Mock SimctlExecutor for dark mode tests before importing.
const mockSimctlExec = jest.fn();
jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockSimctlExec,
  })),
}));

// Mock fs for dark mode tests (screenshots / file sizes).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    statSync: jest.fn(),
    readFileSync: jest.fn(),
    unlinkSync: jest.fn(),
  };
});

import * as fs from 'fs';
import { MCPServer } from '../../src/mcp-server';
import { registerQaFlutterTouchTargetsTool } from '../../src/tools/qa-flutter-touch-targets';
import { registerQaFlutterSemanticsTool } from '../../src/tools/qa-flutter-semantics';
import { registerQaFlutterDarkModeTool } from '../../src/tools/qa-flutter-dark-mode';
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

// ── Dark Mode Tests ──────────────────────────────────────────────────────────

describe('qa_flutter_dark_mode', () => {
  type DarkToolResult = {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    >;
    isError?: boolean;
  };
  type DarkHandler = (s: string, p: Record<string, unknown>) => Promise<DarkToolResult>;
  let handler: DarkHandler;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    registerQaFlutterDarkModeTool(server as unknown as MCPServer);
    handler = (server.registerTool as jest.Mock).mock.calls[0][1] as DarkHandler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: current appearance = light
    mockSimctlExec.mockImplementation(async (args: string[]) => {
      // First 'ui appearance' query returns current appearance (no 4th arg).
      if (args[0] === 'ui' && args[2] === 'appearance' && args.length === 3) {
        return 'light';
      }
      return '';
    });
    (fs.statSync as jest.Mock).mockImplementation(() => ({ size: 100000 }));
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('PNGDATA'));
    (fs.unlinkSync as jest.Mock).mockImplementation(() => undefined);
  });

  it('returns light and dark screenshots as base64 image content', async () => {
    mockDumpTree.mockResolvedValue(makeNode({
      children: [makeNode({ role: 'AXButton', label: 'A', path: '0' })],
    }));
    // Light screenshot size 100 KB, dark 150 KB → 50% diff = responds to dark mode.
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ size: 100000 })  // light
      .mockReturnValueOnce({ size: 150000 }); // dark

    const result = await handler('s', { settle_time: 0 });

    // content[0] = text, content[1] = light image, content[2] = dark image
    expect(result.content.length).toBeGreaterThanOrEqual(3);
    expect(result.content[0].type).toBe('text');
    const images = result.content.filter((c) => c.type === 'image') as Array<{
      type: 'image'; data: string; mimeType: string;
    }>;
    expect(images.length).toBe(2);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[1].mimeType).toBe('image/png');
    // base64 encoding of 'PNGDATA'
    expect(images[0].data).toBe(Buffer.from('PNGDATA').toString('base64'));
  });

  it('restores original appearance after check', async () => {
    mockDumpTree.mockResolvedValue(makeNode());
    mockSimctlExec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ui' && args[2] === 'appearance' && args.length === 3) {
        return 'dark'; // simulator starts in dark
      }
      return '';
    });

    await handler('s', { settle_time: 0 });

    // Find the final appearance call (should set to 'dark' to restore).
    const appearanceSetCalls = mockSimctlExec.mock.calls
      .filter((c) => c[0][0] === 'ui' && c[0][2] === 'appearance' && c[0][3])
      .map((c) => c[0][3]);
    // Sequence: light, dark, dark (restore)
    expect(appearanceSetCalls[appearanceSetCalls.length - 1]).toBe('dark');
  });

  it('detects elements missing in dark mode', async () => {
    const lightTree = makeNode({
      children: [
        makeNode({ role: 'AXStaticText', label: 'Hello', path: '0' }),
        makeNode({ role: 'AXStaticText', label: 'World', path: '1' }),
      ],
    });
    const darkTree = makeNode({
      children: [
        makeNode({ role: 'AXStaticText', label: 'Hello', path: '0' }),
        // 'World' is missing in dark
      ],
    });
    mockDumpTree
      .mockResolvedValueOnce(lightTree)
      .mockResolvedValueOnce(darkTree);

    // Meaningful size diff so dark mode is considered responsive.
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ size: 100000 })
      .mockReturnValueOnce({ size: 150000 });

    const result = await handler('s', { settle_time: 0 });
    const textContent = result.content[0] as { type: 'text'; text: string };
    const body = JSON.parse(textContent.text);

    expect(body.passed).toBe(false);
    expect(body.issues_count).toBeGreaterThan(0);
    const missing = body.issues.find((i: { type: string }) => i.type === 'element_missing_in_dark');
    expect(missing).toBeDefined();
    expect(missing.label).toBe('World');
  });

  it('passes when app responds to dark mode and tree is stable', async () => {
    const tree = makeNode({
      children: [makeNode({ role: 'AXButton', label: 'A', path: '0' })],
    });
    mockDumpTree.mockResolvedValue(tree);
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ size: 100000 })
      .mockReturnValueOnce({ size: 150000 }); // 50% diff

    const result = await handler('s', { settle_time: 0 });
    const textContent = result.content[0] as { type: 'text'; text: string };
    const body = JSON.parse(textContent.text);

    expect(body.passed).toBe(true);
    expect(body.responds_to_dark_mode).toBe(true);
  });

  it('flags no_response_to_dark_mode when size diff is below threshold', async () => {
    mockDumpTree.mockResolvedValue(makeNode());
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ size: 100000 })
      .mockReturnValueOnce({ size: 100500 }); // <1% diff

    const result = await handler('s', { settle_time: 0 });
    const textContent = result.content[0] as { type: 'text'; text: string };
    const body = JSON.parse(textContent.text);

    expect(body.responds_to_dark_mode).toBe(false);
    expect(body.passed).toBe(false);
    const noResp = body.issues.find(
      (i: { type: string }) => i.type === 'no_response_to_dark_mode',
    );
    expect(noResp).toBeDefined();
  });

  it('omits screenshots when return_screenshots is false', async () => {
    mockDumpTree.mockResolvedValue(makeNode());
    (fs.statSync as jest.Mock)
      .mockReturnValueOnce({ size: 100000 })
      .mockReturnValueOnce({ size: 150000 });

    const result = await handler('s', { settle_time: 0, return_screenshots: false });

    const images = result.content.filter((c) => c.type === 'image');
    expect(images.length).toBe(0);
    expect(result.content[0].type).toBe('text');
  });
});
