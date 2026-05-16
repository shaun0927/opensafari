import { MCPServer } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { registerDeviceBootTool } from '../../src/tools/device-boot';

const listBooted = jest.fn();
const boot = jest.fn();
const openUrl = jest.fn();
const getProxyForDevice = jest.fn();
const stopProxyForDevice = jest.fn();
const addManagedDevice = jest.fn();
const disableBackgroundServices = jest.fn();
const connect = jest.fn();
const disconnect = jest.fn();

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted,
    boot,
    openUrl,
  })),
}));

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn(),
}));

jest.mock('../../src/simulator/proxy-manager', () => ({
  getProxyForDevice: (...args: unknown[]) => getProxyForDevice(...args),
  stopProxyForDevice: (...args: unknown[]) => stopProxyForDevice(...args),
}));

jest.mock('../../src/reliability/zombie-cleanup', () => ({
  addManagedDevice: (...args: unknown[]) => addManagedDevice(...args),
}));

jest.mock('../../src/simulator/post-boot-optimize', () => ({
  disableBackgroundServices: (...args: unknown[]) => disableBackgroundServices(...args),
}));

jest.mock('../../src/webkit/client', () => ({
  WebKitClient: jest.fn().mockImplementation(() => ({
    connect,
    disconnect,
    backendType: 'safari',
  })),
}));

function parseToolText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text: string }> }).content;
  if (!content?.[0]?.text) throw new Error('missing tool text content');
  return JSON.parse(content[0].text);
}

describe('device_boot WebKit recovery', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await getSessionManager().shutdown();
    listBooted.mockResolvedValue([]);
    boot.mockResolvedValue({
      udid: 'DEVICE-1',
      name: 'iPhone 16',
      state: 'Booted',
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      runtimeVersion: '26.4',
    });
    openUrl.mockResolvedValue(undefined);
    disableBackgroundServices.mockResolvedValue(undefined);
    stopProxyForDevice.mockResolvedValue(undefined);
  });

  it('keeps the booted simulator registered when WebKit never connects', async () => {
    getProxyForDevice.mockRejectedValue(new Error('socket unavailable'));

    const server = new MCPServer();
    registerDeviceBootTool(server);
    const handler = server.getToolHandler('device_boot');
    expect(handler).toBeDefined();

    const result = await handler!('session-1', { device: 'iPhone 16' });
    const body = parseToolText(result);

    expect(body.proxy).toEqual({ running: false, pid: null, port: null });
    expect(getSessionManager().getSimulator('DEVICE-1')).toMatchObject({
      deviceId: 'DEVICE-1',
      deviceType: 'iPhone 16',
      state: 'booted',
    });
    expect(getSessionManager().hasConnection('DEVICE-1')).toBe(false);
  });

  it('restarts the device proxy once after a WebKit connect failure', async () => {
    const firstProxy = {
      running: true,
      pid: 101,
      port: 9347,
      waitForTarget: jest.fn().mockResolvedValue(undefined),
    };
    const secondProxy = {
      running: true,
      pid: 202,
      port: 9447,
      waitForTarget: jest.fn().mockResolvedValue(undefined),
    };
    getProxyForDevice.mockResolvedValueOnce(firstProxy).mockResolvedValueOnce(secondProxy);
    connect.mockRejectedValueOnce(new Error('No Safari targets found')).mockResolvedValueOnce(undefined);

    const server = new MCPServer();
    registerDeviceBootTool(server);
    const handler = server.getToolHandler('device_boot');
    expect(handler).toBeDefined();

    const result = await handler!('session-1', { device: 'iPhone 16' });
    const body = parseToolText(result);

    expect(stopProxyForDevice).toHaveBeenCalledWith('DEVICE-1');
    expect(getProxyForDevice).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(body.proxy).toEqual({ running: true, pid: 202, port: 9447 });
    expect(getSessionManager().hasConnection('DEVICE-1')).toBe(true);
  });
});
