import { calculateScrollEndpoint } from '../../src/tools/app-scroll-native';

// --- Mocks ---

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

// Capture the tool handler during registration
let toolHandler: (sessionId: string, params: Record<string, unknown>) => Promise<unknown>;
const registerToolMock = jest.fn((_schema: unknown, handler: unknown) => {
  toolHandler = handler as typeof toolHandler;
});

jest.mock('../../src/mcp-server', () => ({
  MCPServer: jest.fn(),
  getWebKitClient: jest.fn().mockReturnValue(null),
}));

// Import after mocks
import { registerAppScrollNativeTool } from '../../src/tools/app-scroll-native';

const DEVICE_ID = 'AAAA-BBBB-CCCC';

describe('app_scroll_native', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listBootedMock.mockResolvedValue([{ udid: DEVICE_ID }]);
    getSoleDeviceIdMock.mockReturnValue(null);
    execMock.mockResolvedValue('');

    const fakeServer = { registerTool: registerToolMock } as unknown;
    registerAppScrollNativeTool(fakeServer as Parameters<typeof registerAppScrollNativeTool>[0]);
  });

  it('registers tool with correct name', () => {
    expect(registerToolMock).toHaveBeenCalledTimes(1);
    const schema = registerToolMock.mock.calls[0][0] as { name: string };
    expect(schema.name).toBe('app_scroll_native');
  });

  // --- Direction tests ---

  it('scrolls up with correct simctl args', async () => {
    const result = await toolHandler('s1', { direction: 'up' }) as { content: { text: string }[] };
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '195', '422', '195', '122',
    ]);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('scrolled');
    expect(body.direction).toBe('up');
    expect(body.backend).toBe('simctl');
  });

  it('scrolls down with correct simctl args', async () => {
    await toolHandler('s1', { direction: 'down' });
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '195', '422', '195', '722',
    ]);
  });

  it('scrolls left with correct simctl args', async () => {
    await toolHandler('s1', { direction: 'left' });
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '195', '422', '-105', '422',
    ]);
  });

  it('scrolls right with correct simctl args', async () => {
    await toolHandler('s1', { direction: 'right' });
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '195', '422', '495', '422',
    ]);
  });

  // --- Custom amount ---

  it('respects custom amount', async () => {
    await toolHandler('s1', { direction: 'up', amount: 500 });
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '195', '422', '195', '-78',
    ]);
  });

  // --- Custom coordinates ---

  it('respects custom x and y coordinates', async () => {
    await toolHandler('s1', { direction: 'down', x: 100, y: 200, amount: 150 });
    expect(execMock).toHaveBeenCalledWith([
      'io', DEVICE_ID, 'input', 'swipe',
      '100', '200', '100', '350',
    ]);
  });

  // --- Explicit deviceId ---

  it('uses explicit deviceId when provided', async () => {
    const customDevice = 'CUSTOM-DEVICE-ID';
    await toolHandler('s1', { direction: 'up', deviceId: customDevice });
    expect(execMock).toHaveBeenCalledWith(
      expect.arrayContaining(['io', customDevice, 'input', 'swipe']),
    );
  });

  // --- Active device fallback ---

  it('uses active device from session manager', async () => {
    const activeDevice = 'ACTIVE-DEVICE';
    getSoleDeviceIdMock.mockReturnValue(activeDevice);
    await toolHandler('s1', { direction: 'down' });
    expect(execMock).toHaveBeenCalledWith(
      expect.arrayContaining(['io', activeDevice, 'input', 'swipe']),
    );
  });

  // --- Error: no device ---

  it('returns error when no device is available', async () => {
    listBootedMock.mockResolvedValue([]);
    getSoleDeviceIdMock.mockReturnValue(null);
    const result = await toolHandler('s1', { direction: 'up' }) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('DEVICE_NOT_FOUND');
  });

  // --- Error: invalid direction ---

  it('returns error for invalid direction', async () => {
    const result = await toolHandler('s1', { direction: 'diagonal' }) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('Invalid direction');
  });

  // --- Error: simctl failure ---

  it('returns error when simctl exec fails', async () => {
    execMock.mockRejectedValue(new Error('simctl io failed'));
    const result = await toolHandler('s1', { direction: 'up' }) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('simctl io failed');
  });
});

describe('calculateScrollEndpoint', () => {
  it('calculates up endpoint', () => {
    expect(calculateScrollEndpoint(100, 200, 'up', 50)).toEqual({ endX: 100, endY: 150 });
  });

  it('calculates down endpoint', () => {
    expect(calculateScrollEndpoint(100, 200, 'down', 50)).toEqual({ endX: 100, endY: 250 });
  });

  it('calculates left endpoint', () => {
    expect(calculateScrollEndpoint(100, 200, 'left', 50)).toEqual({ endX: 50, endY: 200 });
  });

  it('calculates right endpoint', () => {
    expect(calculateScrollEndpoint(100, 200, 'right', 50)).toEqual({ endX: 150, endY: 200 });
  });
});
