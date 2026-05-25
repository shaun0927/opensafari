/**
 * Unit test for PR7 — `device_boot` short-circuits when the target is
 * already booted AND has a healthy WebKit connection + proxy.
 *
 * We can't realistically test the long-path boot here (it spans
 * SimulatorManager, proxy-manager, WebKitClient, etc.), but the fast
 * path is a pure decision over already-mocked dependencies and is the
 * surface that catches the "every device_boot call rebuilds the
 * WebKit connection" regression.
 */

jest.mock('../../src/simulator', () => {
  const listBooted = jest.fn();
  const boot = jest.fn().mockRejectedValue(new Error('test bail-out'));
  return {
    getDefaultSimulatorManager: jest.fn(() => ({ listBooted, boot })),
    __mocks: { listBooted, boot },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const simulatorMocks = (require('../../src/simulator') as unknown as {
  __mocks: { listBooted: jest.Mock; boot: jest.Mock };
}).__mocks;
const mockListBooted = simulatorMocks.listBooted;
const mockBoot = simulatorMocks.boot;
const mockGetConnection = jest.fn();
const mockPeekProxyForDevice = jest.fn();

jest.mock('../../src/simulator/proxy-manager', () => ({
  getProxyForDevice: jest.fn(),
  stopProxyForDevice: jest.fn(),
  peekProxyForDevice: (id: string) => mockPeekProxyForDevice(id),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getConnection: (id: string) => mockGetConnection(id),
  }),
}));

import { registerDeviceBootTool } from '../../src/tools/device-boot';

type Handler = (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_d: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as Parameters<typeof registerDeviceBootTool>[0];
  registerDeviceBootTool(server);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

describe('device_boot fast path', () => {
  beforeEach(() => {
    mockListBooted.mockReset();
    mockGetConnection.mockReset();
    mockPeekProxyForDevice.mockReset();
    mockBoot.mockReset();
    mockBoot.mockRejectedValue(new Error('test bail-out'));
  });

  it('short-circuits when device already booted + healthy connection + running proxy', async () => {
    mockListBooted.mockResolvedValue([
      { udid: 'DEV-1', name: 'iPhone 16', state: 'Booted' },
    ]);
    mockGetConnection.mockReturnValue({ isConnected: () => true });
    mockPeekProxyForDevice.mockReturnValue({ running: true, pid: 4242, port: 9322 });

    const handler = captureHandler();
    const result = await handler('s', { device: 'iPhone 16' });
    const body = JSON.parse(result.content[0].text);

    expect(body.alreadyBootedAndHealthy).toBe(true);
    expect(body.udid).toBe('DEV-1');
    expect(body.proxy).toEqual({ running: true, pid: 4242, port: 9322 });
    // No further boot/connect work should have been triggered — the fast
    // path returns before touching proxy-manager.
    expect(jest.requireMock('../../src/simulator/proxy-manager').getProxyForDevice).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when the WebKit connection has dropped', async () => {
    mockListBooted.mockResolvedValue([
      { udid: 'DEV-1', name: 'iPhone 16', state: 'Booted' },
    ]);
    mockGetConnection.mockReturnValue({ isConnected: () => false });
    mockPeekProxyForDevice.mockReturnValue({ running: true, pid: 4242, port: 9322 });

    const handler = captureHandler();
    // boot() is mocked to reject; the fast path was NOT taken precisely
    // because the connection is unhealthy — so the handler tries to
    // re-boot, hits the rejection, and that confirms the decision logic.
    await handler('s', { device: 'iPhone 16' }).catch(() => undefined);
    expect(mockBoot).toHaveBeenCalledWith('iPhone 16');
  });

  it('does NOT short-circuit when the device is not booted', async () => {
    mockListBooted.mockResolvedValue([]);

    const handler = captureHandler();
    // boot is mocked to reject (in the jest.mock factory), so calling the
    // handler bubbles that — we just need to verify the fast path was not
    // taken, i.e. mockBoot was actually reached.
    await handler('s', { device: 'iPhone 16' }).catch(() => undefined);
    expect(mockBoot).toHaveBeenCalledWith('iPhone 16');
  });
});
