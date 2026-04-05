import { MCPServer } from '../../src/mcp-server';
import { registerAppAssertTool } from '../../src/tools/app-assert';

// Mock the SimctlExecutor
jest.mock('../../src/simulator/simctl', () => {
  return {
    SimctlExecutor: jest.fn().mockImplementation(() => ({
      exec: jest.fn(),
    })),
  };
});

// Mock the SimulatorManager
jest.mock('../../src/simulator', () => {
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([]),
    })),
  };
});

// Mock the session manager
jest.mock('../../src/session-manager', () => {
  return {
    getSessionManager: jest.fn().mockReturnValue({
      getActiveDeviceId: jest.fn().mockReturnValue(null),
    }),
  };
});

import { SimctlExecutor } from '../../src/simulator/simctl';
import { SimulatorManager } from '../../src/simulator';
import { getSessionManager } from '../../src/session-manager';

const MockSimctlExecutor = SimctlExecutor as jest.MockedClass<typeof SimctlExecutor>;
const MockSimulatorManager = SimulatorManager as jest.MockedClass<typeof SimulatorManager>;
const mockGetSessionManager = getSessionManager as jest.MockedFunction<typeof getSessionManager>;

const DEVICE_ID = 'test-device-udid-123';

function setupDeviceId(deviceId: string = DEVICE_ID): void {
  mockGetSessionManager.mockReturnValue({
    getActiveDeviceId: jest.fn().mockReturnValue(deviceId),
  } as any);
}

describe('app_assert tool', () => {
  let server: MCPServer;
  let mockExec: jest.Mock;

  beforeEach(() => {
    server = new MCPServer();
    registerAppAssertTool(server);

    mockExec = jest.fn();
    MockSimctlExecutor.mockImplementation(() => ({
      exec: mockExec,
      execJson: jest.fn(),
    }) as any);

    MockSimulatorManager.mockImplementation(() => ({
      listBooted: jest.fn().mockResolvedValue([{ udid: DEVICE_ID, name: 'iPhone 15', state: 'Booted' }]),
    }) as any);

    setupDeviceId();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('is registered with correct name', () => {
      expect(server.getRegisteredTools()).toContain('app_assert');
    });
  });

  describe('app_running assertion', () => {
    test('returns passed: true when bundleId found in launchctl output', async () => {
      mockExec.mockResolvedValue(
        '123 0 com.example.myapp\n456 0 com.apple.springboard\n',
      );

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.myapp',
        testName: 'app-is-running',
        suiteName: 'my-suite',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(true);
      expect(data.assertion).toBe('app_running');
      expect(data.testName).toBe('app-is-running');
      expect(data.suiteName).toBe('my-suite');
      expect(data.message).toContain('com.example.myapp');
      expect(data.message).toContain('running');
      expect(typeof data.durationMs).toBe('number');
      expect(data.timestamp).toBeTruthy();
    });

    test('returns passed: false when bundleId not in launchctl output', async () => {
      mockExec.mockResolvedValue('456 0 com.apple.springboard\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.myapp',
        testName: 'app-not-running',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('not running');
    });

    test('returns passed: false when bundleId is missing', async () => {
      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('bundleId is required');
    });

    test('returns passed: false when simctl exec fails', async () => {
      mockExec.mockRejectedValue(new Error('simctl error'));

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.myapp',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('simctl error');
    });
  });

  describe('element_exists assertion', () => {
    test('returns passed: true when label found in enumerate output', async () => {
      mockExec.mockResolvedValue(
        '  AXLabel: Login\n  AXValue: Sign In\n  AXRole: AXButton\n',
      );

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'element_exists',
        label: 'Login',
        testName: 'login-button-present',
        suiteName: 'auth-suite',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(true);
      expect(data.assertion).toBe('element_exists');
      expect(data.message).toContain('Login');
      expect(data.message).toContain('found');
    });

    test('returns passed: false when label not found', async () => {
      mockExec.mockResolvedValue('  AXLabel: Home\n  AXRole: AXButton\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'element_exists',
        label: 'Login',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('not found');
    });

    test('returns passed: false when neither label nor identifier provided', async () => {
      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'element_exists',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('label or identifier');
    });

    test('returns passed: false with graceful message when enumerate not available', async () => {
      mockExec.mockRejectedValue(new Error('unknown command: enumerate'));

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'element_exists',
        label: 'Login',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('UI enumeration not available');
    });
  });

  describe('element_visible assertion', () => {
    test('uses same enumerate logic as element_exists', async () => {
      mockExec.mockResolvedValue('  AXLabel: Submit\n  AXRole: AXButton\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'element_visible',
        label: 'Submit',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.assertion).toBe('element_visible');
      expect(data.passed).toBe(true);
    });
  });

  describe('screen_contains_text assertion', () => {
    test('returns passed: true when text found in enumerate output', async () => {
      mockExec.mockResolvedValue('  AXValue: Welcome back\n  AXLabel: greeting\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'screen_contains_text',
        text: 'Welcome back',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(true);
      expect(data.message).toContain('Welcome back');
    });

    test('returns passed: false when text not found', async () => {
      mockExec.mockResolvedValue('  AXValue: Sign In\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'screen_contains_text',
        text: 'Welcome back',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
    });
  });

  describe('text_matches assertion', () => {
    test('returns passed: true when regex pattern matches', async () => {
      mockExec.mockResolvedValue('  AXValue: Order #12345\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'text_matches',
        pattern: 'Order #\\d+',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(true);
      expect(data.details.matchedValue).toBe('Order #12345');
    });

    test('returns passed: false when pattern does not match', async () => {
      mockExec.mockResolvedValue('  AXValue: Hello world\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'text_matches',
        pattern: 'Order #\\d+',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
    });

    test('returns passed: false for invalid regex pattern', async () => {
      mockExec.mockResolvedValue('  AXValue: any\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'text_matches',
        pattern: '[invalid(',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('Invalid regex');
    });

    test('returns passed: false when neither text nor pattern provided', async () => {
      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'text_matches',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('text or pattern');
    });
  });

  describe('default values', () => {
    test('defaults suiteName to opensafari', async () => {
      mockExec.mockResolvedValue('456 0 com.apple.springboard\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.app',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.suiteName).toBe('opensafari');
    });

    test('generates testName when not provided', async () => {
      mockExec.mockResolvedValue('456 0 com.apple.springboard\n');

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.app',
      });

      const data = JSON.parse((result.content as any)[0].text);
      expect(data.testName).toMatch(/^app_running-\d+$/);
    });
  });

  describe('device resolution', () => {
    test('returns error result when no device available', async () => {
      mockGetSessionManager.mockReturnValue({
        getActiveDeviceId: jest.fn().mockReturnValue(null),
      } as any);
      MockSimulatorManager.mockImplementation(() => ({
        listBooted: jest.fn().mockResolvedValue([]),
      }) as any);

      const handler = server.getToolHandler('app_assert')!;
      const result = await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.app',
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.passed).toBe(false);
      expect(data.message).toContain('No booted simulator');
    });

    test('uses provided deviceId over active device', async () => {
      mockExec.mockResolvedValue('123 0 com.example.app\n');

      const handler = server.getToolHandler('app_assert')!;
      await handler('test', {
        assertion: 'app_running',
        bundleId: 'com.example.app',
        deviceId: 'custom-device-id',
      });

      expect(mockExec).toHaveBeenCalledWith(
        ['spawn', 'custom-device-id', 'launchctl', 'list'],
      );
    });
  });
});
