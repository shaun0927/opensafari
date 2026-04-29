import { AccessibilityBridge, AccessibilityBridgeError } from '../../src/native';
import { execFile } from 'child_process';

jest.mock('child_process');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
}));

const mockExecFile = execFile as unknown as jest.Mock;

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function mockExecSuccess(stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: ExecCallback) => {
    if (cb) {
      cb(null, { stdout, stderr });
    }
    return { stdout, stderr };
  });
}

describe('AccessibilityBridge', () => {
  let bridge: AccessibilityBridge;

  beforeEach(() => {
    jest.clearAllMocks();
    bridge = new AccessibilityBridge();
  });

  describe('dumpTree', () => {
    it('returns parsed AXNode tree from bridge output', async () => {
      const mockTree = {
        role: 'AXGroup',
        label: 'App Content',
        value: null,
        identifier: null,
        traits: [],
        frame: { x: 0, y: 0, width: 390, height: 844 },
        visible: true,
        enabled: true,
        focused: false,
        children: [
          {
            role: 'AXButton',
            label: 'Submit',
            value: null,
            identifier: 'submit-btn',
            traits: ['AXButtonSubrole'],
            frame: { x: 100, y: 200, width: 180, height: 44 },
            visible: true,
            enabled: true,
            focused: false,
            children: null,
            path: '0',
          },
        ],
        path: '',
      };

      mockExecSuccess(JSON.stringify(mockTree));

      const result = await bridge.dumpTree({ deviceId: 'test-udid' });

      expect(result.role).toBe('AXGroup');
      expect(result.children).toHaveLength(1);
      expect(result.children![0].role).toBe('AXButton');
      expect(result.children![0].identifier).toBe('submit-btn');
    });

    it('passes maxDepth option to bridge', async () => {
      mockExecSuccess(JSON.stringify({
        role: 'AXGroup', label: null, value: null, identifier: null,
        traits: [], frame: { x: 0, y: 0, width: 390, height: 844 },
        visible: true, enabled: true, focused: false, children: null, path: '',
      }));

      await bridge.dumpTree({ deviceId: 'test-udid', maxDepth: 5 });

      // Verify exec was called with correct args
      expect(mockExecFile).toHaveBeenCalled();
      const callArgs = mockExecFile.mock.calls[0];
      const args: string[] = callArgs[1];
      expect(args).toContain('--max-depth');
      expect(args).toContain('5');
    });

    it('throws AccessibilityBridgeError on bridge error response', async () => {
      mockExecSuccess(JSON.stringify({
        error: 'Simulator.app is not running',
        code: 'SIMULATOR_NOT_RUNNING',
      }));

      await expect(bridge.dumpTree()).rejects.toThrow(AccessibilityBridgeError);
      await expect(bridge.dumpTree()).rejects.toThrow('Simulator.app is not running');
    });

    it('throws on timeout (killed process)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: ExecCallback) => {
        const err = Object.assign(new Error('killed'), { killed: true, stderr: '' });
        if (cb) cb(err, { stdout: '', stderr: '' });
        return { stdout: '', stderr: '' };
      });

      await expect(bridge.dumpTree()).rejects.toThrow('timed out');
    });

    /**
     * Issue #693 WU3-prep: the dump root carries the device-content-root
     * size in macOS-points. The wrapper passes the field through verbatim
     * so the coordinate-tap code path can convert AX frames to iOS-points
     * before forwarding to `sim-hid-bridge`.
     */
    it('passes through deviceContentMacOSPt on the dump root (#693)', async () => {
      mockExecSuccess(JSON.stringify({
        role: 'AXGroup',
        label: null,
        value: null,
        identifier: null,
        traits: [],
        frame: { x: 0, y: 0, width: 697, height: 1515 },
        visible: true,
        enabled: true,
        focused: false,
        children: null,
        path: '',
        deviceContentMacOSPt: { width: 697, height: 1515 },
      }));

      const result = await bridge.dumpTree({ deviceId: 'test-udid' });

      expect(result.deviceContentMacOSPt).toEqual({ width: 697, height: 1515 });
    });

    /**
     * Issue #693 WU3-prep: the field is optional. Older bridge binaries
     * that pre-date this PR (or running against `swift` interpreter source
     * pinned to develop) MUST keep the wrapper surface usable without it.
     */
    it('treats deviceContentMacOSPt as optional on legacy bridge output', async () => {
      mockExecSuccess(JSON.stringify({
        role: 'AXGroup',
        label: null,
        value: null,
        identifier: null,
        traits: [],
        frame: { x: 0, y: 0, width: 393, height: 852 },
        visible: true,
        enabled: true,
        focused: false,
        children: null,
        path: '',
        // no deviceContentMacOSPt
      }));

      const result = await bridge.dumpTree();

      expect(result.deviceContentMacOSPt).toBeUndefined();
    });
  });

  describe('query', () => {
    const mockQueryResult = {
      matches: [
        {
          role: 'AXButton',
          label: 'Login',
          value: null,
          identifier: 'login-btn',
          traits: [],
          frame: { x: 50, y: 300, width: 200, height: 44 },
          visible: true,
          enabled: true,
          focused: false,
          children: null,
          path: '0/1',
        },
      ],
      total: 1,
      query: { identifier: 'login-btn', label: null, text: null, role: null, traits: null },
      ambiguous: false,
    };

    it('queries by identifier', async () => {
      mockExecSuccess(JSON.stringify(mockQueryResult));

      const result = await bridge.query({ identifier: 'login-btn' });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].identifier).toBe('login-btn');
      expect(result.ambiguous).toBe(false);
    });

    it('queries by label', async () => {
      mockExecSuccess(JSON.stringify({
        ...mockQueryResult,
        query: { identifier: null, label: 'Login', text: null, role: null, traits: null },
      }));

      const result = await bridge.query({ label: 'Login' });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].label).toBe('Login');
    });

    it('queries by role', async () => {
      mockExecSuccess(JSON.stringify({
        ...mockQueryResult,
        query: { identifier: null, label: null, text: null, role: 'AXButton', traits: null },
      }));

      const result = await bridge.query({ role: 'AXButton' });

      expect(result.total).toBe(1);
    });

    it('reports ambiguous identifier matches', async () => {
      const ambiguousResult = {
        matches: [
          { ...mockQueryResult.matches[0], path: '0/1' },
          { ...mockQueryResult.matches[0], path: '0/3', label: 'Login 2' },
        ],
        total: 2,
        query: { identifier: 'login-btn', label: null, text: null, role: null, traits: null },
        ambiguous: true,
      };
      mockExecSuccess(JSON.stringify(ambiguousResult));

      const result = await bridge.query({ identifier: 'login-btn' });

      expect(result.ambiguous).toBe(true);
      expect(result.total).toBe(2);
    });

    it('passes maxResults to bridge', async () => {
      mockExecSuccess(JSON.stringify(mockQueryResult));

      await bridge.query({ label: 'test' }, { maxResults: 10 });

      const callArgs = mockExecFile.mock.calls[0];
      const args: string[] = callArgs[1];
      expect(args).toContain('--max-results');
      expect(args).toContain('10');
    });

    /**
     * Issue #693 WU3-prep (gemini PR #695 follow-up): query results carry
     * `deviceContentMacOSPt` so a caller that found an element via `query`
     * and then performs a coordinate tap doesn't need a separate `dump`.
     */
    it('passes through deviceContentMacOSPt on query results (#693)', async () => {
      mockExecSuccess(JSON.stringify({
        ...mockQueryResult,
        deviceContentMacOSPt: { width: 697, height: 1515 },
      }));

      const result = await bridge.query({ identifier: 'login-btn' });

      expect(result.deviceContentMacOSPt).toEqual({ width: 697, height: 1515 });
    });
  });

  describe('inspect', () => {
    it('returns detailed element metadata by path', async () => {
      const mockNode = {
        role: 'AXTextField',
        label: 'Email',
        value: 'user@example.com',
        identifier: 'email-field',
        traits: ['AXSearchField'],
        frame: { x: 20, y: 150, width: 350, height: 44 },
        visible: true,
        enabled: true,
        focused: true,
        children: null,
        path: '0/2',
      };

      mockExecSuccess(JSON.stringify(mockNode));

      const result = await bridge.inspect('0/2', 'test-udid');

      expect(result.role).toBe('AXTextField');
      expect(result.identifier).toBe('email-field');
      expect(result.value).toBe('user@example.com');
      expect(result.focused).toBe(true);
    });

    it('throws on element not found', async () => {
      mockExecSuccess(JSON.stringify({
        error: 'Element not found at path: 99/99',
        code: 'ELEMENT_NOT_FOUND',
      }));

      await expect(bridge.inspect('99/99')).rejects.toThrow('Element not found');
    });

    /**
     * Issue #693 WU3-prep (gemini PR #695 follow-up): inspect results carry
     * `deviceContentMacOSPt` so a caller that navigated to an element via
     * `inspect` and then performs a coordinate tap doesn't need a separate
     * `dump` for the conversion factor.
     */
    it('passes through deviceContentMacOSPt on inspect results (#693)', async () => {
      const mockNode = {
        role: 'AXTextField',
        label: 'Email',
        value: 'user@example.com',
        identifier: 'email-field',
        traits: [],
        frame: { x: 20, y: 150, width: 350, height: 44 },
        visible: true,
        enabled: true,
        focused: true,
        children: null,
        path: '0/2',
        deviceContentMacOSPt: { width: 697, height: 1515 },
      };

      mockExecSuccess(JSON.stringify(mockNode));

      const result = await bridge.inspect('0/2', 'test-udid');

      expect(result.deviceContentMacOSPt).toEqual({ width: 697, height: 1515 });
    });
  });
});
