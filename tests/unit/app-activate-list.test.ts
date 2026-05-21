import { SimulatorManager, AppNotInstalledError, DeviceNotBootedError } from '../../src/simulator';
import { SimctlError } from '../../src/simulator/simctl';

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

describe('SimulatorManager — App Activate & List Running', () => {
  beforeEach(() => {
    execMock.mockReset();
    execJsonMock.mockReset();
  });

  const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
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

  describe('activateApp', () => {
    it('activates an app successfully', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue(`${BUNDLE_ID}: 45678\n`);

      const manager = new SimulatorManager();
      const result = await manager.activateApp(DEVICE_ID, BUNDLE_ID);

      // PR6 adds the `alreadyRunning` flag — false on the fallback launch path
      // (the launchctl probe in this test is mocked to return a non-UIKitApplication string).
      expect(result).toEqual({
        activated: true,
        alreadyRunning: false,
        bundleId: BUNDLE_ID,
        deviceId: DEVICE_ID,
        pid: 45678,
      });
      expect(execMock).toHaveBeenCalledWith(['launch', DEVICE_ID, BUNDLE_ID]);
    });

    it('throws DeviceNotBootedError for shutdown device', async () => {
      execJsonMock.mockResolvedValue(shutdownDeviceList);

      const manager = new SimulatorManager();
      await expect(manager.activateApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(DeviceNotBootedError);
    });

    it('throws AppNotInstalledError when bundle not found', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockRejectedValue(
        new SimctlError('simctl launch failed: domain not found', ['launch'], 1),
      );

      const manager = new SimulatorManager();
      await expect(manager.activateApp(DEVICE_ID, BUNDLE_ID))
        .rejects.toThrow(AppNotInstalledError);
    });
  });

  describe('listRunningApps', () => {
    const launchctlOutput = [
      'PID\tStatus\tLabel',
      '123\t0\tUIKitApplication:com.example.testapp[1234]',
      '456\t0\tUIKitApplication:com.apple.mobilesafari[5678]',
      '-\t0\tcom.apple.backboardd',
      '789\t0\tcom.apple.SpringBoard',
      '',
    ].join('\n');

    it('returns running UIKit apps with pid and bundle id', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue(launchctlOutput);

      const manager = new SimulatorManager();
      const apps = await manager.listRunningApps(DEVICE_ID);

      expect(apps).toEqual([
        { label: 'com.example.testapp', pid: 123 },
        { label: 'com.apple.mobilesafari', pid: 456 },
      ]);
      expect(execMock).toHaveBeenCalledWith(['spawn', DEVICE_ID, 'launchctl', 'list']);
    });

    it('returns empty array when no UIKit apps running', async () => {
      execJsonMock.mockResolvedValue(bootedDeviceList);
      execMock.mockResolvedValue('PID\tStatus\tLabel\n-\t0\tcom.apple.backboardd\n');

      const manager = new SimulatorManager();
      const apps = await manager.listRunningApps(DEVICE_ID);

      expect(apps).toEqual([]);
    });

    it('throws DeviceNotBootedError for shutdown device', async () => {
      execJsonMock.mockResolvedValue(shutdownDeviceList);

      const manager = new SimulatorManager();
      await expect(manager.listRunningApps(DEVICE_ID))
        .rejects.toThrow(DeviceNotBootedError);
    });
  });
});
