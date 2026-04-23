/**
 * Unit tests for `app_screenshot_native` — retry + stderr filter behavior.
 *
 * Covers the fix for issue #651:
 *   - Retry on transient `Timeout waiting for screen surfaces` simctl errors.
 *   - Strip informational `Note: No display specified.` line from error output.
 *   - Surface a clean error when retries are exhausted.
 */

const readFileMock = jest.fn();
const unlinkMock = jest.fn();

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    readFile: (...args: unknown[]) => readFileMock(...args),
    unlink: (...args: unknown[]) => unlinkMock(...args),
  };
});

const execMock = jest.fn();

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: execMock,
  })),
}));

const listBootedMock = jest.fn();
jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: listBootedMock,
  })),
}));

const getSoleDeviceIdMock = jest.fn();
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: getSoleDeviceIdMock,
  }),
}));

jest.mock('../../src/mcp-server', () => ({
  MCPServer: jest.fn(),
  getWebKitClient: jest.fn().mockReturnValue(null),
}));

// Capture the tool handler during registration
let toolHandler: (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}>;
const registerToolMock = jest.fn((_schema: unknown, handler: unknown) => {
  toolHandler = handler as typeof toolHandler;
});

// Import after mocks
import { registerAppScreenshotNativeTool, _internal } from '../../src/tools/app-screenshot-native';

const DEVICE_ID = 'AAAA-BBBB-CCCC';

describe('app_screenshot_native — retry + stderr filter (issue #651)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBootedMock.mockResolvedValue([{ udid: DEVICE_ID }]);
    getSoleDeviceIdMock.mockReturnValue(null);
    readFileMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    unlinkMock.mockResolvedValue(undefined);

    const fakeServer = { registerTool: registerToolMock } as unknown;
    registerAppScreenshotNativeTool(
      fakeServer as Parameters<typeof registerAppScreenshotNativeTool>[0],
    );
  });

  it('registers tool with correct name', () => {
    expect(registerToolMock).toHaveBeenCalledTimes(1);
    const schema = registerToolMock.mock.calls[0][0] as { name: string };
    expect(schema.name).toBe('app_screenshot_native');
  });

  it('retries once when simctl emits "Timeout waiting for screen surfaces", then succeeds', async () => {
    execMock
      .mockRejectedValueOnce(
        new Error(
          'simctl io DEV screenshot --type=png /tmp/x failed: The operation couldn’t be completed. Timeout waiting for screen surfaces',
        ),
      )
      .mockResolvedValueOnce('');

    const result = await toolHandler('s1', { deviceId: DEVICE_ID });

    expect(result.isError).toBeUndefined();
    expect(execMock).toHaveBeenCalledTimes(2);
    const meta = JSON.parse(result.content[1].text!);
    expect(meta.retries).toBe(1);
    expect(meta.format).toBe('png');
  }, 15_000);

  it('retries up to SCREENSHOT_MAX_RETRIES then surfaces a clean error', async () => {
    const transient = new Error(
      'simctl io DEV screenshot failed: Timeout waiting for screen surfaces',
    );
    execMock.mockRejectedValue(transient);

    const result = await toolHandler('s1', { deviceId: DEVICE_ID });

    expect(result.isError).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(_internal.SCREENSHOT_MAX_RETRIES + 1);
    expect(result.content[0].text).toContain('Error capturing screenshot:');
    expect(result.content[0].text).toContain('Timeout waiting for screen surfaces');
  }, 15_000);

  it('does not retry on non-transient simctl errors', async () => {
    execMock.mockRejectedValue(
      new Error('simctl io DEV screenshot failed: Invalid device state: Shutdown'),
    );

    const result = await toolHandler('s1', { deviceId: DEVICE_ID });

    expect(result.isError).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Invalid device state: Shutdown');
  });

  it('filters informational "Note: No display specified." line from error output', async () => {
    execMock.mockRejectedValue(
      new Error(
        'simctl io DEV screenshot failed: Note: No display specified. Defaulting to display: <uuid> (screenID: 1, name: LCD)\nInvalid device state: Shutdown',
      ),
    );

    const result = await toolHandler('s1', { deviceId: DEVICE_ID });

    expect(result.isError).toBe(true);
    const text = result.content[0].text!;
    expect(text).toContain('Invalid device state: Shutdown');
    expect(text).not.toContain('Note: No display specified.');
  });

  it('succeeds on first attempt without retry when simctl returns OK', async () => {
    execMock.mockResolvedValue('');

    const result = await toolHandler('s1', { deviceId: DEVICE_ID, format: 'jpeg' });

    expect(result.isError).toBeUndefined();
    expect(execMock).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(result.content[1].text!);
    expect(meta.retries).toBe(0);
    expect(meta.format).toBe('jpeg');
  });
});

describe('stripInformationalStderr', () => {
  it('removes the Note: No display specified. line', () => {
    const input =
      'simctl io DEV screenshot failed: Note: No display specified. Defaulting to display: abc\nTimeout waiting for screen surfaces';
    const cleaned = _internal.stripInformationalStderr(input);
    expect(cleaned).not.toContain('Note: No display specified.');
    expect(cleaned).toContain('Timeout waiting for screen surfaces');
  });

  it('leaves messages without noise untouched', () => {
    const input = 'simctl io DEV screenshot failed: Invalid device state: Shutdown';
    expect(_internal.stripInformationalStderr(input)).toBe(input);
  });
});

describe('isTransientScreenshotError', () => {
  it('matches the documented transient message', () => {
    expect(_internal.isTransientScreenshotError('Timeout waiting for screen surfaces')).toBe(true);
    expect(
      _internal.isTransientScreenshotError(
        "simctl io DEV screenshot failed: The operation couldn’t be completed. Timeout waiting for screen surfaces",
      ),
    ).toBe(true);
  });

  it('rejects unrelated simctl errors', () => {
    expect(_internal.isTransientScreenshotError('Invalid device state: Shutdown')).toBe(false);
    expect(_internal.isTransientScreenshotError('')).toBe(false);
  });
});
