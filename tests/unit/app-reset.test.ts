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

describe('SimulatorManager — App Reset', () => {
  beforeEach(() => {
    execMock.mockReset();
    execJsonMock.mockReset();
  });

  const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
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

  it('resets app: terminate, privacy reset, uninstall', async () => {
    execJsonMock.mockResolvedValue(bootedDeviceList);
    execMock.mockResolvedValue('');

    const manager = new SimulatorManager();
    const result = await manager.resetApp(DEVICE_ID, BUNDLE_ID);

    expect(result.reset).toBe(true);
    expect(result.bundleId).toBe(BUNDLE_ID);
    expect(result.deviceId).toBe(DEVICE_ID);
    expect(result.steps).toEqual(['terminated', 'privacy_reset', 'uninstalled']);

    expect(execMock).toHaveBeenCalledWith(['terminate', DEVICE_ID, BUNDLE_ID]);
    expect(execMock).toHaveBeenCalledWith(['privacy', DEVICE_ID, 'reset', 'all', BUNDLE_ID]);
    expect(execMock).toHaveBeenCalledWith(['uninstall', DEVICE_ID, BUNDLE_ID]);
  });

  it('skips terminate if app is not running', async () => {
    execJsonMock.mockResolvedValue(bootedDeviceList);
    execMock
      .mockRejectedValueOnce(new SimctlError('not running', ['terminate'], 1))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const manager = new SimulatorManager();
    const result = await manager.resetApp(DEVICE_ID, BUNDLE_ID);

    expect(result.steps).toEqual(['terminate_skipped', 'privacy_reset', 'uninstalled']);
  });

  it('skips privacy reset if command fails', async () => {
    execJsonMock.mockResolvedValue(bootedDeviceList);
    execMock
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('privacy not supported'))
      .mockResolvedValueOnce('');

    const manager = new SimulatorManager();
    const result = await manager.resetApp(DEVICE_ID, BUNDLE_ID);

    expect(result.steps).toEqual(['terminated', 'privacy_reset_skipped', 'uninstalled']);
  });

  it('throws AppNotInstalledError if uninstall finds no app', async () => {
    execJsonMock.mockResolvedValue(bootedDeviceList);
    execMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(
        new SimctlError('domain not found', ['uninstall'], 1),
      );

    const manager = new SimulatorManager();
    await expect(manager.resetApp(DEVICE_ID, BUNDLE_ID))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    execJsonMock.mockResolvedValue(shutdownDeviceList);

    const manager = new SimulatorManager();
    await expect(manager.resetApp(DEVICE_ID, BUNDLE_ID))
      .rejects.toThrow(DeviceNotBootedError);
  });
});
