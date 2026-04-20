import { MCPServer } from '../../src/mcp-server';
import { registerAppHandleAlertTool } from '../../src/tools/app-handle-alert';
import type { AXNode } from '../../src/native/ax-types';

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

type ExecFileCb = (
  err: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

const execFileMock = jest.fn<
  void,
  [string, string[], unknown, ExecFileCb]
>((_cmd, _args, _opts, cb) => {
  if (_cmd === 'xcrun') {
    cb(null, '', '');
    return;
  }
  cb(new Error('no sheet'), '', 'no sheet');
});

jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...(args as [string, string[], unknown, ExecFileCb])),
}));

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function makeTreeWithStaticTexts(texts: string[]): AXNode {
  return {
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
        role: 'AXGroup',
        label: '',
        traits: [],
        frame: { x: 0, y: 0, width: 393, height: 852 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/0',
        children: texts.map((t, i) => ({
          role: 'AXStaticText',
          label: t,
          traits: [],
          frame: { x: 40, y: 300 + i * 40, width: 313, height: 24 },
          visible: true,
          enabled: true,
          focused: false,
          path: `0/0/${i}`,
        })),
      },
    ],
  };
}

describe('app_handle_alert — Tier 3 permission_reset fallback', () => {
  let server: MCPServer;
  let handler: ReturnType<MCPServer['getToolHandler']>;

  beforeAll(() => {
    server = new MCPServer();
    registerAppHandleAlertTool(server);
    handler = server.getToolHandler('app_handle_alert');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
      if (cmd === 'xcrun') cb(null, '', '');
      else cb(new Error('no sheet'), '', 'no sheet');
    });
  });

  test('fallback defaults to "none" — Tier 3 not attempted even when both tiers miss', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(["'지도' 앱이 사용자의 위치를 사용하도록 허용하겠습니까?"]),
    );

    const result = await handler!('s', { action: 'accept' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.strategy_attempted).toEqual(['ax-scan', 'applescript-sheet']);
    expect(body.permissionReset).toBeUndefined();
    expect(body.fallbackAvailable).toContain('permission_reset');
  });

  test('fallback=permission_reset — inferred service runs simctl and reports dismissed=true', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(["'지도' 앱이 사용자의 위치를 사용하도록 허용하겠습니까?"]),
    );

    const result = await handler!('s', { action: 'accept', fallback: 'permission_reset' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.strategy).toBe('permission-reset');
    expect(body.strategy_attempted).toEqual(['ax-scan', 'applescript-sheet', 'permission-reset']);
    expect(body.dismissed).toBe(true);
    expect(body.reason).toBe('ok');
    expect(body.permissionReset.service).toBe('location');
    expect(body.permissionReset.executed).toBe(true);
    expect(body.permissionReset.command).toContain('xcrun simctl privacy TEST-UDID reset location');

    expect(execFileMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'privacy', 'TEST-UDID', 'reset', 'location'],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });

  test('fallback=permission_reset + dryRun=true — reports command, does not execute simctl', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(['Allow access to your Photos']),
    );

    const result = await handler!('s', {
      action: 'accept',
      fallback: 'permission_reset',
      dryRun: true,
    });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.strategy).toBe('permission-reset');
    expect(body.dismissed).toBe(false);
    expect(body.permissionReset.service).toBe('photos');
    expect(body.permissionReset.executed).toBe(false);
    expect(body.permissionReset.dryRun).toBe(true);
    expect(body.permissionReset.command).toBe('xcrun simctl privacy TEST-UDID reset photos');

    // Only the AppleScript probe should have been exec'd, not xcrun.
    const xcrunCalls = execFileMock.mock.calls.filter(([cmd]) => cmd === 'xcrun');
    expect(xcrunCalls).toHaveLength(0);
  });

  test('fallback=permission_reset — ambiguous (>=2 services) refuses to act', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(['Allow access to your Location and Photos']),
    );

    const result = await handler!('s', { action: 'accept', fallback: 'permission_reset' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.reason).toBe('permission_reset_ambiguous');
    expect(body.strategy).toBe('none');
    expect(body.dismissed).toBe(false);
    expect(body.permissionReset.service).toBeNull();
    expect(body.permissionReset.servicesConsidered).toEqual(
      expect.arrayContaining(['location', 'photos']),
    );
    expect(body.permissionReset.executed).toBe(false);
  });

  test('fallback=permission_reset — no service inferred returns permission_reset_unknown_service', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(['Welcome to the onboarding flow']),
    );

    const result = await handler!('s', { action: 'accept', fallback: 'permission_reset' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.reason).toBe('permission_reset_unknown_service');
    expect(body.strategy).toBe('none');
    expect(body.permissionReset.service).toBeNull();
    expect(body.permissionReset.servicesConsidered).toEqual([]);
    expect(body.permissionReset.executed).toBe(false);
  });

  test('fallback=permission_reset — simctl failure is surfaced in permissionReset.error', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(['Allow tracking across apps?']),
    );
    execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
      if (cmd === 'xcrun') cb(new Error('simctl: service not supported'), '', 'err');
      else cb(new Error('no sheet'), '', 'no sheet');
    });

    const result = await handler!('s', { action: 'accept', fallback: 'permission_reset' });
    const body = parseResult(result as { content: Array<{ type: string; text: string }> });

    expect(body.strategy).toBe('none');
    expect(body.dismissed).toBe(false);
    expect(body.permissionReset.service).toBe('tracking');
    expect(body.permissionReset.executed).toBe(false);
    expect(body.permissionReset.error).toContain('simctl');
  });

  test('fallback=permission_reset — service map normalizes tracking→userTracking and calendars→calendar', async () => {
    mockDumpTree.mockResolvedValue(
      makeTreeWithStaticTexts(['Allow tracking across other apps?']),
    );

    await handler!('s', { action: 'accept', fallback: 'permission_reset' });

    expect(execFileMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'privacy', 'TEST-UDID', 'reset', 'userTracking'],
      expect.anything(),
      expect.any(Function),
    );
  });
});
