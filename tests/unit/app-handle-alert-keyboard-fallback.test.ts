/**
 * Unit tests for the Tier 2.5 keyboard fallback in `app_handle_alert`.
 *
 * Covers the fix for issue #651:
 *   - AX-scan empty + AppleScript click miss → keyboard fallback fires
 *   - keyboardFallback: false preserves previous behavior exactly
 *   - AX-scan already succeeds → no keyboard fallback invoked
 *   - Correct keystroke for accept (Return) vs dismiss (Escape)
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppHandleAlertTool, _internal } from '../../src/tools/app-handle-alert';
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

type ExecFileCb = (err: Error | null, stdout?: string, stderr?: string) => void;

interface ExecFileCall {
  cmd: string;
  args: string[];
  outcome: 'ok' | 'fail';
}

const execFileCalls: ExecFileCall[] = [];

type ExecFileBehavior = (cmd: string, args: string[]) => 'ok' | 'fail';
let execFileBehavior: ExecFileBehavior = () => 'ok';

const execFileMock = jest.fn<void, [string, string[], unknown, ExecFileCb]>(
  (cmd, args, _opts, cb) => {
    const outcome = execFileBehavior(cmd, args);
    execFileCalls.push({ cmd, args, outcome });
    if (outcome === 'ok') {
      cb(null, '', '');
    } else {
      cb(new Error('simulated osascript failure'), '', 'no sheet');
    }
  },
);

jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) =>
    execFileMock(...(args as [string, string[], unknown, ExecFileCb])),
}));

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function emptyTree(): AXNode {
  return {
    role: 'AXApplication',
    label: 'SpringBoard',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '0',
    children: [],
  };
}

function treeWithAlertButton(label: string): AXNode {
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
        role: 'AXSheet',
        label: '',
        traits: [],
        frame: { x: 20, y: 300, width: 353, height: 200 },
        visible: true,
        enabled: true,
        focused: false,
        path: '0/0',
        children: [
          {
            role: 'AXButton',
            label,
            traits: [],
            frame: { x: 40, y: 450, width: 100, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0/0/0',
          },
        ],
      },
    ],
  };
}

let toolHandler: (
  sessionId: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

describe('app_handle_alert — Tier 2.5 keyboard fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileCalls.length = 0;
    execFileBehavior = () => 'ok';

    const registerToolMock = jest.fn((_schema: unknown, handler: unknown) => {
      toolHandler = handler as typeof toolHandler;
    });
    const fakeServer = { registerTool: registerToolMock } as unknown as MCPServer;
    registerAppHandleAlertTool(fakeServer);
  });

  it('fires keyboard fallback (Return) on accept when AX empty + AppleScript miss', async () => {
    mockDumpTree.mockResolvedValue(emptyTree());
    // First osascript call = AppleScript label match (Tier 2) → fail.
    // Second osascript call = keyboard fallback (Tier 2.5) → succeed.
    execFileBehavior = (_cmd, args) => {
      const script = args[1] ?? '';
      if (script.includes('click button')) return 'fail';
      return 'ok';
    };

    const result = await toolHandler('s1', { action: 'accept' });
    const body = parseResult(result);

    expect(body.dismissed).toBe(true);
    expect(body.strategy).toBe('keyboard-fallback');
    expect(body.strategy_attempted).toEqual([
      'ax-scan',
      'applescript-sheet',
      'keyboard-fallback',
    ]);

    const keyboardCall = execFileCalls.find((c) => c.args[1]?.includes('key code'));
    expect(keyboardCall).toBeDefined();
    expect(keyboardCall!.args[1]).toContain('key code 36'); // Return
  });

  it('fires keyboard fallback (Escape) on dismiss when AX empty + AppleScript miss', async () => {
    mockDumpTree.mockResolvedValue(emptyTree());
    execFileBehavior = (_cmd, args) => {
      const script = args[1] ?? '';
      if (script.includes('click button')) return 'fail';
      return 'ok';
    };

    const result = await toolHandler('s1', { action: 'dismiss' });
    const body = parseResult(result);

    expect(body.dismissed).toBe(true);
    expect(body.strategy).toBe('keyboard-fallback');
    const keyboardCall = execFileCalls.find((c) => c.args[1]?.includes('key code'));
    expect(keyboardCall!.args[1]).toContain('key code 53'); // Escape
  });

  it('keyboardFallback: false preserves previous failure behavior', async () => {
    mockDumpTree.mockResolvedValue(emptyTree());
    execFileBehavior = () => 'fail'; // every osascript fails

    const result = await toolHandler('s1', {
      action: 'dismiss',
      keyboardFallback: false,
    });
    const body = parseResult(result);

    expect(body.dismissed).toBe(false);
    expect(body.strategy).toBe('none');
    expect(body.strategy_attempted).toEqual(['ax-scan', 'applescript-sheet']);
    // Only one osascript call (the Tier 2 click button attempt).
    const osascriptCalls = execFileCalls.filter((c) => c.cmd === 'osascript');
    expect(osascriptCalls).toHaveLength(1);
    expect(osascriptCalls[0].args[1]).toContain('click button');
  });

  it('does not invoke keyboard fallback when AX-scan succeeds', async () => {
    mockDumpTree.mockResolvedValue(treeWithAlertButton('Allow'));
    mockPress.mockResolvedValue({ ok: true, code: 'OK' });
    // Simulate dialog dismissal on next poll.
    mockDumpTree.mockResolvedValueOnce(treeWithAlertButton('Allow'));
    mockDumpTree.mockResolvedValue(emptyTree());

    const result = await toolHandler('s1', { action: 'accept' });
    const body = parseResult(result);

    expect(body.strategy).toBe('ax-scan');
    expect(body.strategy_attempted).toEqual(['ax-scan']);
    // No osascript call at all.
    expect(execFileCalls.filter((c) => c.cmd === 'osascript')).toHaveLength(0);
  });

  it('reports dismissed=false when keyboard fallback itself fails', async () => {
    mockDumpTree.mockResolvedValue(emptyTree());
    execFileBehavior = () => 'fail';

    const result = await toolHandler('s1', { action: 'dismiss' });
    const body = parseResult(result);

    expect(body.dismissed).toBe(false);
    expect(body.strategy).toBe('none');
    expect(body.strategy_attempted).toEqual([
      'ax-scan',
      'applescript-sheet',
      'keyboard-fallback',
    ]);
  });
});

describe('buildKeyboardFallbackScript', () => {
  it('uses Return (key code 36) for accept', () => {
    const script = _internal.buildKeyboardFallbackScript('accept');
    expect(script).toContain('key code 36');
    expect(script).not.toContain('key code 53');
  });

  it('uses Escape (key code 53) for dismiss', () => {
    const script = _internal.buildKeyboardFallbackScript('dismiss');
    expect(script).toContain('key code 53');
    expect(script).not.toContain('key code 36');
  });

  it('activates Simulator so the keystroke reaches the frontmost app', () => {
    const script = _internal.buildKeyboardFallbackScript('accept');
    expect(script).toContain('tell application "Simulator" to activate');
    expect(script).toContain('tell process "Simulator"');
  });
});
