import { MCPServer } from '../../src/mcp-server';
import { registerAppPermissionTools } from '../../src/tools/app-permission';
import { getSessionManager } from '../../src/session-manager';
import { SimulatorManager } from '../../src/simulator';

const mockExec = jest.fn().mockResolvedValue('');

jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn().mockImplementation(() => ({
    exec: mockExec,
  })),
}));

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'TEST-UDID-1234' }]),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getActiveDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

const mockedGetSessionManager = getSessionManager as jest.MockedFunction<typeof getSessionManager>;
const MockedSimulatorManager = SimulatorManager as jest.MockedClass<typeof SimulatorManager>;

interface ToolContent {
  type: string;
  text: string;
}

describe('app_permission tools', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppPermissionTools(server);
  });

  beforeEach(() => {
    mockExec.mockClear();
  });

  describe('app_permission_set', () => {
    test('is registered', () => {
      expect(server.getRegisteredTools()).toContain('app_permission_set');
    });

    test('grants camera permission', async () => {
      const handler = server.getToolHandler('app_permission_set')!;
      const result = await handler('test', { permission: 'camera', action: 'grant', bundleId: 'com.example.app' });
      expect(result.isError).toBeUndefined();
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.success).toBe(true);
      expect(text.permission).toBe('camera');
      expect(text.action).toBe('grant');
      expect(mockExec).toHaveBeenCalledWith(['privacy', 'TEST-UDID-1234', 'grant', 'camera', 'com.example.app']);
    });

    test('revokes location permission', async () => {
      const handler = server.getToolHandler('app_permission_set')!;
      const result = await handler('test', { permission: 'location', action: 'revoke', bundleId: 'com.example.app' });
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.action).toBe('revoke');
      expect(mockExec).toHaveBeenCalledWith(['privacy', 'TEST-UDID-1234', 'revoke', 'location', 'com.example.app']);
    });

    test('rejects invalid permission', async () => {
      const handler = server.getToolHandler('app_permission_set')!;
      const result = await handler('test', { permission: 'bluetooth', action: 'grant', bundleId: 'com.example.app' });
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.error).toBe('INVALID_PERMISSION');
    });

    test('rejects invalid action', async () => {
      const handler = server.getToolHandler('app_permission_set')!;
      const result = await handler('test', { permission: 'camera', action: 'delete', bundleId: 'com.example.app' });
      expect(result.isError).toBe(true);
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.error).toBe('INVALID_ACTION');
    });
  });

  describe('app_permission_reset', () => {
    test('is registered', () => {
      expect(server.getRegisteredTools()).toContain('app_permission_reset');
    });

    test('resets specific permission', async () => {
      const handler = server.getToolHandler('app_permission_reset')!;
      const result = await handler('test', { permission: 'camera', bundleId: 'com.example.app' });
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.success).toBe(true);
      expect(text.permission).toBe('camera');
      expect(mockExec).toHaveBeenCalledWith(['privacy', 'TEST-UDID-1234', 'reset', 'camera', 'com.example.app']);
    });

    test('resets all permissions when none specified', async () => {
      const handler = server.getToolHandler('app_permission_reset')!;
      const result = await handler('test', { bundleId: 'com.example.app' });
      const text = JSON.parse((result.content as ToolContent[])[0].text);
      expect(text.success).toBe(true);
      expect(text.permission).toBe('all');
      expect(mockExec).toHaveBeenCalledWith(['privacy', 'TEST-UDID-1234', 'reset', 'all', 'com.example.app']);
    });

    test('returns error when no device booted', async () => {
      mockedGetSessionManager.mockReturnValueOnce({ getActiveDeviceId: () => null } as ReturnType<typeof getSessionManager>);
      MockedSimulatorManager.mockImplementationOnce(() => ({
        listBooted: jest.fn().mockResolvedValue([]),
      }) as unknown as SimulatorManager);

      const handler = server.getToolHandler('app_permission_reset')!;
      const result = await handler('test', { bundleId: 'com.example.app' });
      expect(result.isError).toBe(true);
    });
  });
});
