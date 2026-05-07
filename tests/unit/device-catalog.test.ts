import { listDevices, getDevice, resolveDevice } from '../../src/simulator/device-catalog';
import { DeviceNotFoundError } from '../../src/simulator/errors';
import { SimctlExecutor } from '../../src/simulator/simctl';

const RUNTIME_KEY = 'com.apple.CoreSimulator.SimRuntime.iOS-18-0';

const DEVICE_A = {
  udid: 'AAAA-1111',
  name: 'iPhone 17',
  state: 'Booted',
  isAvailable: true,
};

const DEVICE_B = {
  udid: 'BBBB-2222',
  name: 'iPhone SE (3rd generation)',
  state: 'Shutdown',
  isAvailable: true,
};

const DEVICE_UNAVAILABLE = {
  udid: 'CCCC-3333',
  name: 'iPhone 15',
  state: 'Shutdown',
  isAvailable: false,
};

function makeSimctlMock(devicesPayload: Record<string, object[]>): SimctlExecutor {
  return {
    execJson: jest.fn().mockResolvedValue({ devices: devicesPayload, runtimes: [] }),
    exec: jest.fn(),
  } as unknown as SimctlExecutor;
}

describe('device-catalog', () => {
  describe('listDevices', () => {
    it('returns available devices with parsed runtimeVersion', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A, DEVICE_B, DEVICE_UNAVAILABLE] });
      const devices = await listDevices(simctl);

      expect(devices).toHaveLength(2);
      expect(devices[0].udid).toBe('AAAA-1111');
      expect(devices[0].runtimeVersion).toBe('18.0');
      expect(devices[0].state).toBe('Booted');
      expect(devices[1].udid).toBe('BBBB-2222');
    });

    it('excludes unavailable devices', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_UNAVAILABLE] });
      const devices = await listDevices(simctl);
      expect(devices).toHaveLength(0);
    });

    it('handles unknown runtime identifier gracefully', async () => {
      const simctl = makeSimctlMock({ 'com.apple.CoreSimulator.SimRuntime.watchOS-10-0': [DEVICE_A] });
      const devices = await listDevices(simctl);
      expect(devices[0].runtimeVersion).toBe('unknown');
    });

    it('flattens devices across multiple runtimes', async () => {
      const simctl = makeSimctlMock({
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [DEVICE_A],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [DEVICE_B],
      });
      const devices = await listDevices(simctl);
      expect(devices).toHaveLength(2);
    });
  });

  describe('getDevice', () => {
    it('returns device when udid matches', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A, DEVICE_B] });
      const device = await getDevice(simctl, 'AAAA-1111');
      expect(device).not.toBeNull();
      expect(device!.udid).toBe('AAAA-1111');
      expect(device!.name).toBe('iPhone 17');
    });

    it('returns null for unknown udid', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A] });
      const device = await getDevice(simctl, 'XXXX-9999');
      expect(device).toBeNull();
    });
  });

  describe('resolveDevice', () => {
    it('resolves by exact udid', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A, DEVICE_B] });
      const device = await resolveDevice(simctl, 'AAAA-1111');
      expect(device.udid).toBe('AAAA-1111');
    });

    it('resolves by preset key (iphone-se-3)', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A, DEVICE_B] });
      // DEVICE_B name matches preset 'iphone-se-3' ("iPhone SE (3rd generation)")
      const device = await resolveDevice(simctl, 'iphone-se-3');
      expect(device.udid).toBe('BBBB-2222');
    });

    it('resolves by case-insensitive substring', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A, DEVICE_B] });
      const device = await resolveDevice(simctl, 'iphone 17');
      expect(device.udid).toBe('AAAA-1111');
    });

    it('throws DeviceNotFoundError for unknown key', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A] });
      await expect(resolveDevice(simctl, 'iphone-99-pro-max')).rejects.toBeInstanceOf(DeviceNotFoundError);
    });

    it('DeviceNotFoundError includes available device names', async () => {
      const simctl = makeSimctlMock({ [RUNTIME_KEY]: [DEVICE_A] });
      let caught: DeviceNotFoundError | null = null;
      try {
        await resolveDevice(simctl, 'iphone-99-pro-max');
      } catch (err) {
        caught = err as DeviceNotFoundError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.available).toContain('iPhone 17');
      expect(caught!.requested).toBe('iphone-99-pro-max');
    });
  });
});
