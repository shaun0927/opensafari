/**
 * Unit tests for flutter_widget_at_point (issue #436 follow-up).
 */

import {
  isUserDefinedWidget,
  flattenParentChain,
} from '../../src/tools/flutter-widget-at-point';
import { FlutterVMClient } from '../../src/flutter/vm-service-client';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: () => 'test-device-id' }),
}));

const mockIsConnected = jest.fn();
const mockEvaluate = jest.fn();
const mockSelectWidgetAtPoint = jest.fn();
const mockGetParentChain = jest.fn();

jest.mock('../../src/flutter', () => ({
  getFlutterVMClient: () => ({
    isConnected: mockIsConnected,
    evaluate: mockEvaluate,
    selectWidgetAtPoint: mockSelectWidgetAtPoint,
    getParentChain: mockGetParentChain,
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('isUserDefinedWidget', () => {
  it('keeps user-defined widgets (non-flutter path)', () => {
    expect(isUserDefinedWidget({
      type: 'HomePage',
      creationLocation: { file: 'package:myapp/home.dart', line: 10, column: 5 },
    })).toBe(true);
  });

  it('drops package:flutter/ widgets', () => {
    expect(isUserDefinedWidget({
      type: 'Padding',
      creationLocation: { file: 'package:flutter/src/widgets/basic.dart', line: 1, column: 1 },
    })).toBe(false);
  });

  it('drops framework localizations', () => {
    expect(isUserDefinedWidget({
      type: 'Localizations',
      creationLocation: { file: 'package:flutter_localizations/src/foo.dart', line: 1, column: 1 },
    })).toBe(false);
  });

  it('drops widgets from the Flutter SDK checkout', () => {
    expect(isUserDefinedWidget({
      type: 'Container',
      creationLocation: {
        file: '/Users/me/flutter/packages/flutter/lib/src/widgets/container.dart',
        line: 1,
        column: 1,
      },
    })).toBe(false);
  });

  it('drops nodes without a creationLocation', () => {
    expect(isUserDefinedWidget({ type: 'Anonymous' })).toBe(false);
    expect(isUserDefinedWidget(null)).toBe(false);
    expect(isUserDefinedWidget(undefined)).toBe(false);
  });
});

describe('flattenParentChain', () => {
  it('flattens {chain: [{node: {...}}, ...]}', () => {
    const raw = {
      chain: [
        { node: { type: 'A', creationLocation: { file: 'a.dart', line: 1, column: 1 } } },
        { node: { type: 'B', creationLocation: { file: 'b.dart', line: 2, column: 2 } } },
      ],
    };
    const out = flattenParentChain(raw);
    expect(out.map((n) => n.type)).toEqual(['A', 'B']);
  });

  it('tolerates a bare result.chain wrapper', () => {
    const raw = { result: { chain: [{ node: { type: 'X' } }] } };
    const out = flattenParentChain(raw as unknown as Record<string, unknown>);
    expect(out[0].type).toBe('X');
  });

  it('accepts the live Flutter 3.11+ shape where result itself is the chain array', () => {
    // Reproduces the real VM Service response from
    // ext.flutter.inspector.getParentChain on Flutter 3.11.3: the top-level
    // `result` key IS the chain array (not an object with a `chain` field).
    // Pre-fix flattenParentChain returned [] here, which made
    // `flutter_widget_at_point` report `ancestor_chain: []` on every live hit.
    const raw = {
      type: '_extensionType',
      result: [
        { node: { type: 'A', creationLocation: { file: 'a.dart', line: 1, column: 1 } } },
        { node: { type: 'B', creationLocation: { file: 'b.dart', line: 2, column: 2 } } },
      ],
    };
    const out = flattenParentChain(raw as unknown as Record<string, unknown>);
    expect(out.map((n) => n.type)).toEqual(['A', 'B']);
  });

  it('flattens the live result-array shape through the user-defined filter', () => {
    const raw = {
      type: '_extensionType',
      result: [
        { node: { type: 'RootWidget' } }, // no creationLocation — framework
        { node: { type: 'MyApp', creationLocation: { file: 'package:myapp/main.dart', line: 1, column: 1 } } },
        { node: { type: 'MaterialApp', creationLocation: { file: 'package:flutter/src/material/app.dart', line: 1, column: 1 } } },
        { node: { type: 'HomePage', creationLocation: { file: 'package:myapp/home.dart', line: 1, column: 1 } } },
      ],
    };
    const filtered = flattenParentChain(raw as unknown as Record<string, unknown>)
      .filter(isUserDefinedWidget);
    expect(filtered.map((n) => n.type)).toEqual(['MyApp', 'HomePage']);
  });

  it('returns [] for malformed input', () => {
    expect(flattenParentChain({})).toEqual([]);
    expect(flattenParentChain({ chain: 'nope' as unknown as unknown[] })).toEqual([]);
  });

  it('filters user-defined vs SDK widgets when composed with isUserDefinedWidget', () => {
    const raw = {
      chain: [
        { node: { type: 'HomePage', creationLocation: { file: 'package:myapp/home.dart', line: 1, column: 1 } } },
        { node: { type: 'Padding', creationLocation: { file: 'package:flutter/src/widgets/basic.dart', line: 1, column: 1 } } },
        { node: { type: 'MyButton', creationLocation: { file: 'package:myapp/widgets/button.dart', line: 1, column: 1 } } },
        { node: { type: 'SdkInternals' } }, // no creationLocation — framework
      ],
    };
    const filtered = flattenParentChain(raw).filter(isUserDefinedWidget);
    expect(filtered.map((n) => n.type)).toEqual(['HomePage', 'MyButton']);
  });
});

// ── FlutterVMClient.selectWidgetAtPoint ─────────────────────────────────────

describe('FlutterVMClient.selectWidgetAtPoint', () => {
  let client: FlutterVMClient;
  let evaluateSpy: jest.SpyInstance;
  let getSelectedSpy: jest.SpyInstance;
  let callMethodSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new FlutterVMClient();
    (client as unknown as Record<string, unknown>)['state'] = { mainIsolateId: 'isolate-1' };
    evaluateSpy = jest.spyOn(client, 'evaluate');
    getSelectedSpy = jest.spyOn(client, 'getSelectedWidget');
    callMethodSpy = jest.spyOn(
      client as unknown as { callMethod: (...args: unknown[]) => Promise<unknown> },
      'callMethod',
    );
    // Default: return an isolate that advertises the widget_inspector library
    // so selectWidgetAtPoint can resolve a targetId for the evaluate call.
    callMethodSpy.mockResolvedValue({
      libraries: [
        {
          uri: 'package:flutter/src/widgets/widget_inspector.dart',
          id: 'lib-inspector',
        },
      ],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('converts physical→logical using DPR=2 and forwards coords to evaluate', async () => {
    evaluateSpy.mockResolvedValue({ valueAsString: 'true', kind: 'Bool' });
    getSelectedSpy.mockResolvedValue({ type: 'ElevatedButton' });

    await client.selectWidgetAtPoint({
      physicalX: 200,
      physicalY: 400,
      devicePixelRatio: 2,
      objectGroup: 'g1',
    });

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    const expr = evaluateSpy.mock.calls[0][0] as string;
    const opts = evaluateSpy.mock.calls[0][1] as { targetId?: string } | undefined;
    expect(expr).toContain('Offset(100, 200)');
    expect(expr).toContain("'g1'");
    expect(opts?.targetId).toBe('lib-inspector');
  });

  it('converts physical→logical using DPR=3 with fractional results', async () => {
    evaluateSpy.mockResolvedValue({ valueAsString: 'true', kind: 'Bool' });
    getSelectedSpy.mockResolvedValue({ type: 'Text' });

    await client.selectWidgetAtPoint({
      physicalX: 200,
      physicalY: 400,
      devicePixelRatio: 3,
    });

    const expr = evaluateSpy.mock.calls[0][0] as string;
    // 200/3 = 66.666…, 400/3 = 133.333…
    expect(expr).toMatch(/Offset\(66\.6{3,}\d*, 133\.3{3,}\d*\)/);
  });

  it('returns {hit: false} when evaluate reports no hit and skips getSelectedWidget', async () => {
    evaluateSpy.mockResolvedValue({ valueAsString: 'false', kind: 'Bool' });

    const out = await client.selectWidgetAtPoint({
      physicalX: 10,
      physicalY: 20,
      devicePixelRatio: 2,
    });

    expect(out).toEqual({ hit: false });
    expect(getSelectedSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid devicePixelRatio', async () => {
    await expect(client.selectWidgetAtPoint({
      physicalX: 10, physicalY: 20, devicePixelRatio: 0,
    })).rejects.toThrow(/Invalid devicePixelRatio/);
    await expect(client.selectWidgetAtPoint({
      physicalX: 10, physicalY: 20, devicePixelRatio: Number.NaN,
    })).rejects.toThrow(/Invalid devicePixelRatio/);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('rejects objectGroup with characters that could break the Dart literal', async () => {
    // A quote-plus-injection payload should be refused before we ever build
    // the Dart expression.
    await expect(
      client.selectWidgetAtPoint({
        physicalX: 10,
        physicalY: 20,
        devicePixelRatio: 2,
        objectGroup: "x'); malicious('",
      }),
    ).rejects.toThrow(/Invalid objectGroup/);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('throws when the widget_inspector library is not loaded', async () => {
    callMethodSpy.mockResolvedValueOnce({ libraries: [] });
    await expect(
      client.selectWidgetAtPoint({
        physicalX: 10,
        physicalY: 20,
        devicePixelRatio: 2,
      }),
    ).rejects.toThrow(/widget_inspector library not loaded/);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });
});

describe('FlutterVMClient.getParentChain', () => {
  it('forwards inspectorRef and default objectGroup', async () => {
    const client = new FlutterVMClient();
    (client as unknown as Record<string, unknown>)['state'] = { mainIsolateId: 'isolate-1' };
    const spy = jest.spyOn(client as unknown as { callServiceExtension: (...args: unknown[]) => Promise<unknown> }, 'callServiceExtension');
    spy.mockResolvedValue({ chain: [] });

    await client.getParentChain({ inspectorRef: 'inspector-42' });
    expect(spy).toHaveBeenCalledWith('inspector.getParentChain', {
      arg: 'inspector-42',
      objectGroup: 'opensafari-parent-chain',
    });
  });

  it('forwards a custom objectGroup', async () => {
    const client = new FlutterVMClient();
    (client as unknown as Record<string, unknown>)['state'] = { mainIsolateId: 'isolate-1' };
    const spy = jest.spyOn(client as unknown as { callServiceExtension: (...args: unknown[]) => Promise<unknown> }, 'callServiceExtension');
    spy.mockResolvedValue({ chain: [] });

    await client.getParentChain({ inspectorRef: 'id-9', objectGroup: 'mine' });
    expect(spy).toHaveBeenCalledWith('inspector.getParentChain', {
      arg: 'id-9',
      objectGroup: 'mine',
    });
  });
});

// ── flutter_widget_at_point handler ─────────────────────────────────────────

describe('flutter_widget_at_point handler', () => {
  let handler: (s: string, p: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterWidgetAtPointTool } = require('../../src/tools/flutter-widget-at-point');
    registerFlutterWidgetAtPointTool(server);
    handler = server.registerTool.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
  });

  it('registers under the expected name with x,y required', () => {
    const server = { registerTool: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerFlutterWidgetAtPointTool } = require('../../src/tools/flutter-widget-at-point');
    registerFlutterWidgetAtPointTool(server);
    const def = server.registerTool.mock.calls[0][0];
    expect(def.name).toBe('flutter_widget_at_point');
    expect(def.inputSchema.required).toEqual(['x', 'y']);
  });

  it('returns widget_type=null reason=out-of-bounds for x<0 without hit-testing', async () => {
    // readViewMetrics → one evaluate call returning "3|1170|2532"
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '3|1170|2532' });

    const result = await handler('s', { x: -1, y: 100 });
    const body = JSON.parse(result.content[0].text);

    expect(body.widget_type).toBeNull();
    expect(body.reason).toBe('out-of-bounds');
    expect(mockSelectWidgetAtPoint).not.toHaveBeenCalled();
  });

  it('returns widget_type=null reason=out-of-bounds for x>=width', async () => {
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '2|750|1334' });
    const result = await handler('s', { x: 750, y: 100 });
    const body = JSON.parse(result.content[0].text);
    expect(body.reason).toBe('out-of-bounds');
    expect(mockSelectWidgetAtPoint).not.toHaveBeenCalled();
  });

  it('returns widget_type=null reason=no-hit when hit-test returns no widget', async () => {
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '2|750|1334' });
    mockSelectWidgetAtPoint.mockResolvedValueOnce({ hit: false });

    const result = await handler('s', { x: 100, y: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.widget_type).toBeNull();
    expect(body.reason).toBe('no-hit');
  });

  it('returns the widget + filtered ancestor_chain on a successful hit', async () => {
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '2|750|1334' });
    mockSelectWidgetAtPoint.mockResolvedValueOnce({
      hit: true,
      // Shape matches the live VM Service payload: every widget is wrapped in
      // `_ElementDiagnosticableTreeNode`, the user-visible widget name lives in
      // `widgetRuntimeType`, and `description` carries the formatted form.
      selection: {
        type: '_ElementDiagnosticableTreeNode',
        widgetRuntimeType: 'ElevatedButton',
        description: 'ElevatedButton',
        valueId: 'inspector-42',
        creationLocation: { file: 'package:myapp/home.dart', line: 47, column: 12 },
      },
    });
    mockGetParentChain.mockResolvedValueOnce({
      chain: [
        { node: { type: 'HomePage', creationLocation: { file: 'package:myapp/home.dart', line: 10, column: 1 } } },
        { node: { type: 'Padding', creationLocation: { file: 'package:flutter/src/widgets/basic.dart', line: 1, column: 1 } } },
        { node: { type: 'MyCard', creationLocation: { file: 'package:myapp/widgets/card.dart', line: 4, column: 1 } } },
      ],
    });

    const result = await handler('s', { x: 200, y: 400 });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('ok');
    expect(body.widget_type).toBe('ElevatedButton');
    expect(body.widget_id).toBe('inspector-42');
    expect(body.creation_location).toEqual({ file: 'package:myapp/home.dart', line: 47, column: 12 });
    expect(body.ancestor_chain.map((n: { widget_type: string }) => n.widget_type))
      .toEqual(['HomePage', 'MyCard']);
    expect(mockSelectWidgetAtPoint).toHaveBeenCalledWith(expect.objectContaining({
      physicalX: 200,
      physicalY: 400,
      devicePixelRatio: 2,
    }));
  });

  it('errors when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const result = await handler('s', { x: 10, y: 10 });
    expect(result.isError).toBe(true);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('rejects non-finite coordinates', async () => {
    const result = await handler('s', { x: Number.NaN, y: 10 });
    expect(result.isError).toBe(true);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('still returns the widget when getParentChain fails (best-effort)', async () => {
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '2|750|1334' });
    mockSelectWidgetAtPoint.mockResolvedValueOnce({
      hit: true,
      selection: {
        type: '_ElementDiagnosticableTreeNode',
        widgetRuntimeType: 'Text',
        description: 'Text',
        valueId: 'inspector-9',
        creationLocation: { file: 'package:myapp/home.dart', line: 1, column: 1 },
      },
    });
    mockGetParentChain.mockRejectedValueOnce(new Error('getParentChain not available'));

    const result = await handler('s', { x: 10, y: 20 });
    const body = JSON.parse(result.content[0].text);
    expect(body.widget_type).toBe('Text');
    expect(body.ancestor_chain).toEqual([]);
  });

  it('surfaces the user-visible widget in widget_type even when the inspector wraps the node', async () => {
    // Matches the Flutter 3.11.3 VM Service payload: the outer `type` is the
    // diagnostic wrapper, and the actual Flutter widget name only appears in
    // `widgetRuntimeType`. Callers expect `widget_type` to identify the
    // widget — not the inspector's bookkeeping class — so the tool must
    // prefer `widgetRuntimeType` / `description` over the wrapper `type`.
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '3|1179|2556' });
    mockSelectWidgetAtPoint.mockResolvedValueOnce({
      hit: true,
      selection: {
        type: '_ElementDiagnosticableTreeNode',
        widgetRuntimeType: 'ElevatedButton',
        description: 'ElevatedButton',
        valueId: 'inspector-199',
        creationLocation: { file: 'package:myapp/home.dart', line: 65, column: 22 },
      },
    });
    mockGetParentChain.mockResolvedValueOnce({ chain: [] });

    const result = await handler('s', { x: 80, y: 465 });
    const body = JSON.parse(result.content[0].text);

    expect(body.widget_type).toBe('ElevatedButton');
    expect(body.description).toBe('ElevatedButton');
    expect(body.widget_id).toBe('inspector-199');
  });

  it('falls back to description when widgetRuntimeType is absent', async () => {
    mockEvaluate.mockResolvedValueOnce({ valueAsString: '2|750|1334' });
    mockSelectWidgetAtPoint.mockResolvedValueOnce({
      hit: true,
      selection: {
        type: '_ElementDiagnosticableTreeNode',
        description: 'Scaffold',
        valueId: 'inspector-7',
        creationLocation: { file: 'package:myapp/home.dart', line: 2, column: 1 },
      },
    });
    mockGetParentChain.mockResolvedValueOnce({ chain: [] });

    const result = await handler('s', { x: 10, y: 20 });
    const body = JSON.parse(result.content[0].text);
    expect(body.widget_type).toBe('Scaffold');
  });
});

export {};
