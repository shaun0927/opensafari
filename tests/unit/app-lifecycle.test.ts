import { SimulatorManager, AppNotInstalledError, AppLaunchError, DeviceNotBootedError } from '../../src/simulator';
import { SimctlError } from '../../src/simulator/simctl';

// Shared mock functions — every SimctlExecutor instance uses these
const execMock = jest.fn();
const execJsonMock = jest.fn();

jest.mock('../../src/simulator/simctl', () => {
  const actual = jest.requireActual('../../src/simulator/simctl');
  return {
    ...actual,
    SimctlExecutor: jest.fn().mockImplementation(() => ({
      exec: execMock,
      execJson: execJsonMock,
    })),
  };
});

describe('SimulatorManager — App Lifecycle', () => {
  beforeEach(() => {
    execMock.mockReset();
    execJsonMock.mockReset();
  });

  const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
  const BUNDLE_ID = 'com.example.testapp';

  const bootedDeviceList = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: DEVICE_ID, name: 'iPhone 16', state: 'Booted', isAvailable: true },
      ],
    },
    runtimes: [],
  };

  const shutdownDeviceList = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: DEVICE_ID, name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
      ],
    },
    runtimes: [],
  };

  // === launchApp ===

  describe('launchApp', () => {
    it('launches app and returns pid', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue(`${BUNDLE_ID}: 12345\n`);

      const manager = new SimulatorManager();
      const result = await manager.launchApp(DEVICE_ID, BUNDLE_ID);

      expect(result).toEqual({ pid: 12345, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
      expect(execMock).toHaveBeenCalledWith(
        ['launch', DEVICE_ID, BUNDLE_ID],
        expect.objectContaining({}),
      );
    });

    it('passes launch arguments', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue(`${BUNDLE_ID}: 12345\n`);

      const manager = new SimulatorManager();
      await manager.launchApp(DEVICE_ID, BUNDLE_ID, { args: ['--reset', '--verbose'] });

      expect(execMock).toHaveBeenCalledWith(
        ['launch', DEVICE_ID, BUNDLE_ID, '--reset', '--verbose'],
        expect.objectContaining({}),
      );
    });

    it('passes environment variables via SIMCTL_CHILD_ prefix', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue(`${BUNDLE_ID}: 12345\n`);

      const manager = new SimulatorManager();
      await manager.launchApp(DEVICE_ID, BUNDLE_ID, { env: { DEBUG: '1' } });

      expect(execMock).toHaveBeenCalledWith(
        ['launch', DEVICE_ID, BUNDLE_ID],
        expect.objectContaining({ env: { SIMCTL_CHILD_DEBUG: '1' } }),
      );
    });

    it('throws DeviceNotBootedError for shutdown device', async () => {
      execJsonMock.mockResolvedValue(shutdownDeviceList);

      const manager = new SimulatorManager();
      await expect(manager.launchApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(DeviceNotBootedError);
    });

    it('throws AppNotInstalledError when bundle not found', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockRejectedValue(
        new SimctlError('simctl launch failed: domain not found', ['launch'], 1),
      );

      const manager = new SimulatorManager();
      await expect(manager.launchApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(AppNotInstalledError);
    });

    it('throws AppLaunchError for other failures', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockRejectedValue(new Error('unexpected error'));

      const manager = new SimulatorManager();
      await expect(manager.launchApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(AppLaunchError);
    });
  });

  // === terminateApp ===

  describe('terminateApp', () => {
    it('terminates running app', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue('');

      const manager = new SimulatorManager();
      const result = await manager.terminateApp(DEVICE_ID, BUNDLE_ID);

      expect(result).toEqual({ terminated: true, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
      expect(execMock).toHaveBeenCalledWith(['terminate', DEVICE_ID, BUNDLE_ID]);
    });

    it('returns terminated:false when app is not running', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockRejectedValue(
        new SimctlError('simctl terminate failed: not running', ['terminate'], 1),
      );

      const manager = new SimulatorManager();
      const result = await manager.terminateApp(DEVICE_ID, BUNDLE_ID);

      expect(result).toEqual({ terminated: false, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
    });

    it('throws DeviceNotBootedError for shutdown device', async () => {
      execJsonMock.mockResolvedValue(shutdownDeviceList);

      const manager = new SimulatorManager();
      await expect(manager.terminateApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(DeviceNotBootedError);
    });

    it('throws AppNotInstalledError when bundle not found', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockRejectedValue(
        new SimctlError('simctl terminate failed: domain not found', ['terminate'], 1),
      );

      const manager = new SimulatorManager();
      await expect(manager.terminateApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(AppNotInstalledError);
    });
  });
});

describe('App Lifecycle Error Classes', () => {
  it('AppNotInstalledError has correct properties', () => {
    const err = new AppNotInstalledError('com.example.app', 'device-123');
    expect(err.name).toBe('AppNotInstalledError');
    expect(err.bundleId).toBe('com.example.app');
    expect(err.deviceId).toBe('device-123');
    expect(err.message).toContain('com.example.app');
    expect(err.message).toContain('not installed');
  });

  it('AppLaunchError has correct properties', () => {
    const err = new AppLaunchError('com.example.app', 'device-123', 'timeout');
    expect(err.name).toBe('AppLaunchError');
    expect(err.bundleId).toBe('com.example.app');
    expect(err.deviceId).toBe('device-123');
    expect(err.reason).toBe('timeout');
    expect(err.message).toContain('Failed to launch');
  });
});
