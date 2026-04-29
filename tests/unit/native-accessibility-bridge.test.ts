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
  });

  /**
   * Issue #693 WU1: the Swift bridge writes its structured ErrorJSON
   * (`{ error, code }`) to STDOUT on the typed-error path and then
   * `exit(1)`. Before this fix, the wrapper only inspected `error.stderr`
   * on a non-zero exit and every typed bridge error collapsed to the
   * generic `BRIDGE_EXEC_FAILED` / `Command failed: <cmd>` shape so the
   * caller could not branch on `code`. These tests prove the structured
   * error now passes through verbatim from either stream.
   */
  describe('non-zero exit error parsing (#693 WU1)', () => {
    function mockExecFailure(opts: { stdout?: string; stderr?: string; message?: string }) {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: ExecCallback) => {
          const err = Object.assign(new Error(opts.message ?? 'Command failed'), {
            stdout: opts.stdout ?? '',
            stderr: opts.stderr ?? '',
          });
          if (cb) cb(err, { stdout: opts.stdout ?? '', stderr: opts.stderr ?? '' });
          return { stdout: opts.stdout ?? '', stderr: opts.stderr ?? '' };
        },
      );
    }

    it('parses structured ErrorJSON from STDOUT on non-zero exit (DEVICE_CONTENT_ROOT_EMPTY)', async () => {
      mockExecFailure({
        stdout: JSON.stringify({
          error:
            'Matched simulator window, but no descendant exposes app-level accessibility semantics.',
          code: 'DEVICE_CONTENT_ROOT_EMPTY',
        }),
        message: 'Command failed',
      });

      const promise = bridge.dumpTree();
      await expect(promise).rejects.toBeInstanceOf(AccessibilityBridgeError);
      try {
        await promise;
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('DEVICE_CONTENT_ROOT_EMPTY');
        expect(e.message).toContain('no descendant exposes app-level accessibility semantics');
        expect(e.message).not.toMatch(/^ax-bridge failed/);
      }
    });

    it('falls back to STDERR-encoded ErrorJSON when STDOUT is empty', async () => {
      mockExecFailure({
        stderr: JSON.stringify({
          error: 'Simulator.app is not running.',
          code: 'SIMULATOR_NOT_RUNNING',
        }),
      });

      const promise = bridge.dumpTree();
      await expect(promise).rejects.toBeInstanceOf(AccessibilityBridgeError);
      try {
        await promise;
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('SIMULATOR_NOT_RUNNING');
        expect(e.message).toContain('Simulator.app is not running');
      }
    });

    it('surfaces both stdout and stderr tails when neither stream parses as ErrorJSON', async () => {
      mockExecFailure({
        stdout: 'partial output before crash',
        stderr: 'swift: dyld: Library not loaded',
        message: 'Command failed: ax-bridge-native dump',
      });

      const promise = bridge.dumpTree();
      await expect(promise).rejects.toBeInstanceOf(AccessibilityBridgeError);
      try {
        await promise;
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('BRIDGE_EXEC_FAILED');
        expect(e.message).toContain('stdout: partial output before crash');
        expect(e.message).toContain('stderr: swift: dyld: Library not loaded');
      }
    });

    it('surfaces captured stdout in error message when JSON.parse throws SyntaxError on successful exit', async () => {
      // Bridge exits 0 but stdout is not valid JSON (e.g. `swiftc` produced
      // a binary that printed a partial dump before crashing). The previous
      // implementation discarded the captured streams in this branch
      // because Node's `SyntaxError` does not carry stdout/stderr.
      mockExecSuccess('this is not json', 'some warning on stderr');

      const promise = bridge.dumpTree();
      try {
        await promise;
        throw new Error('expected throw');
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('BRIDGE_EXEC_FAILED');
        expect(e.message).toContain('stdout: this is not json');
        expect(e.message).toContain('stderr: some warning on stderr');
      }
    });

    it('truncates oversized single-line stdout in error tails', async () => {
      const longLine = 'x'.repeat(2000);
      mockExecFailure({
        stdout: longLine,
        stderr: '',
        message: 'Command failed',
      });

      const promise = bridge.dumpTree();
      try {
        await promise;
        throw new Error('expected throw');
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('BRIDGE_EXEC_FAILED');
        // Truncated form: 512 chars + ellipsis + `[+1488 chars]` marker.
        expect(e.message).toContain('…[+1488 chars]');
        // The full 2000-char line must not survive verbatim.
        expect(e.message).not.toContain(longLine);
      }
    });

    it('still surfaces a typed AX_TIMEOUT for killed processes', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: ExecCallback) => {
          const err = Object.assign(new Error('killed'), {
            killed: true,
            stdout: '',
            stderr: '',
          });
          if (cb) cb(err, { stdout: '', stderr: '' });
          return { stdout: '', stderr: '' };
        },
      );

      const promise = bridge.dumpTree();
      try {
        await promise;
        throw new Error('expected throw');
      } catch (err) {
        const e = err as AccessibilityBridgeError;
        expect(e.code).toBe('AX_TIMEOUT');
        expect(e.message).toContain('timed out');
      }
    });
  });
});
