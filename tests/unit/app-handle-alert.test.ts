import { MCPServer } from '../../src/mcp-server';
import { registerAppHandleAlertTool, buildAlertScript, _internal } from '../../src/tools/app-handle-alert';
import type { AXNode } from '../../src/native/ax-types';
import mapsKoFixture from '../fixtures/ax-trees/maps-ko-location.json';
import photosEnFixture from '../fixtures/ax-trees/photos-en-permission.json';
import inAppOkFixture from '../fixtures/ax-trees/in-app-ok.json';

const mockDumpTree = jest.fn();
const mockPress = jest.fn();

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: jest.fn(() => ({
    dumpTree: mockDumpTree,
    press: mockPress,
    query: jest.fn(),
    inspect: jest.fn(),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID'),
  }),
}));

jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    // Default: AppleScript always fails (no sheet present in unit test envs).
    cb(new Error('no sheet'), '', 'no sheet');
  }),
}));

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mapsKoTree(): AXNode {
  return JSON.parse(JSON.stringify(mapsKoFixture)) as AXNode;
}

function photosEnTree(): AXNode {
  return JSON.parse(JSON.stringify(photosEnFixture)) as AXNode;
}

function inAppOkTree(): AXNode {
  return JSON.parse(JSON.stringify(inAppOkFixture)) as AXNode;
}

describe('app_handle_alert tool', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppHandleAlertTool(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPress.mockResolvedValue({
      ok: true,
      code: 'OK',
      path: '0/1/2',
      actions: ['AXPress'],
      role: 'AXButton',
      identifier: null,
      label: null,
      message: null,
      axErrorCode: null,
    });
  });

  test('is registered with correct name', () => {
    expect(server.getRegisteredTools()).toContain('app_handle_alert');
  });

  test('rejects invalid action', async () => {
    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('s', { action: 'nope' });
    expect(result.isError).toBe(true);
  });

  test('Tier 1: Maps ko_KR accept finds localized button and records strategy=ax-scan', async () => {
    const before = mapsKoTree();
    const after = mapsKoTree();
    // Simulate dismissal by removing buttons in the post-tree
    if (after.children) after.children = [];
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('s', { action: 'accept' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(body.strategy).toBe('ax-scan');
    expect(body.strategy_attempted).toEqual(['ax-scan']);
    expect(body.dismissed).toBe(true);
    expect(body.reason).toBe('ok');
    expect(['한 번 허용', '앱을 사용하는 동안 허용']).toContain(body.matchedButton);
    expect(mockPress).toHaveBeenCalledTimes(1);
  });

  test('Tier 1: Photos en_US accept presses Allow', async () => {
    const before = photosEnTree();
    const after = photosEnTree();
    if (after.children) after.children = [];
    mockDumpTree.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('s', { action: 'accept' });

    const body = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(body.matchedButton).toBe('Allow');
    expect(body.strategy).toBe('ax-scan');
  });

  test('Tier 1 → Tier 2 → diagnostics: no candidate, AppleScript also fails', async () => {
    mockDumpTree.mockResolvedValue(inAppOkTree());

    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('s', { action: 'accept', keyboardFallback: false });

    const body = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(body.dismissed).toBe(false);
    expect(body.strategy).toBe('none');
    expect(body.strategy_attempted).toEqual(['ax-scan', 'applescript-sheet']);
    expect(body.reason).toBe('no_candidate_button');
    expect(body.visibleButtons).toContain('OK');
    expect(body.fallbackAvailable).toEqual(expect.arrayContaining(['permission_reset', 'simulator_reboot']));
  });

  test('diagnostics: suggestedLabelsToAdd lists non-corpus labels', async () => {
    const tree: AXNode = {
      role: 'AXApplication',
      label: 'SpringBoard',
      traits: [],
      frame: { x: 0, y: 0, width: 393, height: 852 },
      visible: true,
      enabled: true,
      focused: false,
      path: '0',
      children: [
        {
          role: 'AXButton',
          label: 'Novel Action',
          identifier: 'custom.action',
          traits: [],
          frame: { x: 100, y: 500, width: 200, height: 44 },
          visible: true,
          enabled: true,
          focused: false,
          path: '0/0',
        },
      ],
    };
    mockDumpTree.mockResolvedValue(tree);

    const handler = server.getToolHandler('app_handle_alert')!;
    const result = await handler('s', { action: 'accept' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.suggestedLabelsToAdd).toContain('Novel Action');
  });

  test('surface: SpringBoard-only → simulator_chrome', async () => {
    const tree: AXNode = {
      role: 'AXApplication',
      label: 'SpringBoard',
      traits: [],
      frame: { x: 0, y: 0, width: 393, height: 852 },
      visible: true,
      enabled: true,
      focused: false,
      path: '0',
    };
    expect(_internal.inferSurface(tree)).toBe('simulator_chrome');
  });

  test('surface: tree with AXSheet → system_dialog_unknown', () => {
    const tree = mapsKoTree();
    expect(_internal.inferSurface(tree)).toBe('system_dialog_unknown');
  });

  test('buildAlertScript includes localized labels for accept', () => {
    const script = buildAlertScript('accept');
    expect(script).toContain('허용');
    expect(script).toContain('許可');
    expect(script).toContain('允许');
    expect(script).toContain('Allow');
  });

  test('buildAlertScript escapes double-quoted label correctly', () => {
    const script = buildAlertScript('dismiss');
    // "Don't Allow" apostrophe is not a quote; must appear verbatim
    expect(script).toContain("Don't Allow");
  });
});
