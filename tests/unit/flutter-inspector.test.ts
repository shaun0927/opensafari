/**
 * Unit tests for flutter_root_widget + flutter_inspect_selection (issue #436).
 */

import { summariseNode } from '../../src/tools/flutter-inspector';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockGetRootWidgetSummaryTree = jest.fn();
const mockGetSelectedWidget = jest.fn();
const mockSetInspectorShow = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    getRootWidgetSummaryTree: mockGetRootWidgetSummaryTree,
    getSelectedWidget: mockGetSelectedWidget,
    setInspectorShow: mockSetInspectorShow,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── summariseNode ───────────────────────────────────────────────────────────

describe('summariseNode', () => {
  it('extracts type, description, creationLocation', () => {
    const summary = summariseNode({
      type: 'ElevatedButton',
      description: 'ElevatedButton(onPressed: ...)',
      valueId: 'inspector-42',
      creationLocation: { file: 'package:app/home.dart', line: 47, column: 12 },
      widgetRuntimeType: 'ElevatedButton',
      stateful: false,
    });
    expect(summary?.type).toBe('ElevatedButton');
    expect(summary?.creationLocation).toEqual({ file: 'package:app/home.dart', line: 47, column: 12 });
    expect(summary?.valueId).toBe('inspector-42');
  });

  it('drops creationLocation when fields are missing', () => {
    const summary = summariseNode({
      type: 'Text',
      creationLocation: { file: 'foo.dart' }, // missing line/column
    });
    expect(summary?.creationLocation).toBeUndefined();
  });

  it('falls back to description when type is missing', () => {
    const summary = summariseNode({ description: 'SomeWidget' });
    expect(summary?.type).toBe('SomeWidget');
  });

  it('returns null for non-object input', () => {
    expect(summariseNode(null)).toBeNull();
    expect(summariseNode('foo')).toBeNull();
    expect(summariseNode(42)).toBeNull();
  });

  it('recurses into children up to maxDepth', () => {
    const tree = {
      type: 'A',
      children: [
        { type: 'B', children: [{ type: 'C', children: [{ type: 'D' }] }] },
      ],
    };
    const s = summariseNode(tree, 2);
    expect(s?.type).toBe('A');
    expect(s?.children?.[0]?.type).toBe('B');
    expect(s?.children?.[0]?.children?.[0]?.type).toBe('C');
    // maxDepth=2 means we should not have grandchildren of B
    expect(s?.children?.[0]?.children?.[0]?.children).toBeUndefined();
  });

  it('respects maxDepth=0 by dropping children', () => {
    const s = summariseNode({ type: 'A', children: [{ type: 'B' }] }, 0);
    expect(s?.children).toBeUndefined();
  });

  it('detects cycles defensively', () => {
    const a: Record<string, unknown> = { type: 'A' };
    const b: Record<string, unknown> = { type: 'B', children: [a] };
    a.children = [b];

    const s = summariseNode(a, 10);
    expect(s?.type).toBe('A');
    expect(s?.children?.[0]?.type).toBe('B');
    expect(s?.children?.[0]?.children?.[0]?.type).toBe('CycleDetected');
  });
});

// ── flutter_root_widget handler ─────────────────────────────────────────────

describe('flutter_root_widget', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterRootWidgetTool } = require('../../src/tools/flutter-inspector');
    registerFlutterRootWidgetTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  it('registers under the expected name', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterRootWidgetTool } = require('../../src/tools/flutter-inspector');
    registerFlutterRootWidgetTool(server);
    expect(server.registerTool.mock.calls[0][0].name).toBe('flutter_root_widget');
  });

  it('returns a summarised tree', async () => {
    mockGetRootWidgetSummaryTree.mockResolvedValue({
      result: {
        type: 'MaterialApp',
        children: [
          {
            type: 'Scaffold',
            creationLocation: { file: 'a.dart', line: 1, column: 1 },
            children: [{ type: 'Text' }],
          },
        ],
      },
    });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.tree.type).toBe('MaterialApp');
    expect(body.tree.children[0].type).toBe('Scaffold');
    expect(body.tree.children[0].creationLocation.file).toBe('a.dart');
  });

  it('clamps max_depth upper bound and rejects NaN/Infinity', async () => {
    mockGetRootWidgetSummaryTree.mockResolvedValue({ type: 'A' });

    // Infinity and NaN should fall back to the default (8), not recurse forever.
    await handler('s', { max_depth: Infinity });
    await handler('s', { max_depth: Number.NaN });
    await handler('s', { max_depth: 1e9 }); // clamped to 64

    expect(mockGetRootWidgetSummaryTree).toHaveBeenCalledTimes(3);
  });

  it('forwards object_group to the VM client', async () => {
    mockGetRootWidgetSummaryTree.mockResolvedValue({ type: 'X' });
    await handler('s', { object_group: 'custom-group' });
    expect(mockGetRootWidgetSummaryTree).toHaveBeenCalledWith({ objectGroup: 'custom-group' });
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not connected');
    expect(mockGetRootWidgetSummaryTree).not.toHaveBeenCalled();
  });

  it('respects max_depth', async () => {
    mockGetRootWidgetSummaryTree.mockResolvedValue({
      result: {
        type: 'A',
        children: [{ type: 'B', children: [{ type: 'C' }] }],
      },
    });
    const result = await handler('s', { max_depth: 1 });
    const body = JSON.parse(result.content[0].text);
    expect(body.tree.children[0].type).toBe('B');
    expect(body.tree.children[0].children).toBeUndefined();
  });
});

// ── flutter_inspect_selection handler ───────────────────────────────────────

describe('flutter_inspect_selection', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterInspectSelectionTool } = require('../../src/tools/flutter-inspector');
    registerFlutterInspectSelectionTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockSetInspectorShow.mockResolvedValue({});
  });

  it('registers under the expected name', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterInspectSelectionTool } = require('../../src/tools/flutter-inspector');
    registerFlutterInspectSelectionTool(server);
    expect(server.registerTool.mock.calls[0][0].name).toBe('flutter_inspect_selection');
  });

  it('returns summarised selection when a widget is selected', async () => {
    mockGetSelectedWidget.mockResolvedValue({
      type: 'ElevatedButton',
      description: 'ElevatedButton(onPressed)',
      creationLocation: { file: 'x.dart', line: 42, column: 10 },
    });

    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.selection.type).toBe('ElevatedButton');
    expect(body.selection.creationLocation.line).toBe(42);
    expect(body.hint).toBeUndefined();
  });

  it('returns status=empty with a hint when nothing is selected', async () => {
    mockGetSelectedWidget.mockResolvedValue({}); // empty envelope
    const result = await handler('s', {});
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('empty');
    expect(body.selection).toBeNull();
    expect(body.hint).toContain('show=true');
  });

  it('toggles show before reading when show=true', async () => {
    mockGetSelectedWidget.mockResolvedValue({ type: 'Text' });
    await handler('s', { show: true });
    expect(mockSetInspectorShow).toHaveBeenCalledWith(true);
  });

  it('does not toggle show when not provided', async () => {
    mockGetSelectedWidget.mockResolvedValue({ type: 'Text' });
    await handler('s', {});
    expect(mockSetInspectorShow).not.toHaveBeenCalled();
  });

  it('forwards previous_selection_id', async () => {
    mockGetSelectedWidget.mockResolvedValue({ type: 'Text' });
    await handler('s', { previous_selection_id: 'inspector-123' });
    expect(mockGetSelectedWidget).toHaveBeenCalledWith(expect.objectContaining({
      previousSelectionId: 'inspector-123',
    }));
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', {});
    expect(result.isError).toBe(true);
  });
});
