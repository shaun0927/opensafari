import {
  BootTimeoutError,
  ShutdownTimeoutError,
  DeviceNotFoundError,
  DeviceNotBootedError,
  ScreenshotTimeoutError,
  AppNotInstalledError,
  AppLaunchError,
} from '../../src/simulator/errors';

describe('simulator errors', () => {
  describe('BootTimeoutError', () => {
    it('has correct name and message', () => {
      const err = new BootTimeoutError('udid-1', 'iPhone 17', 30000);
      expect(err).toBeInstanceOf(BootTimeoutError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('BootTimeoutError');
      expect(err.message).toContain('iPhone 17');
      expect(err.message).toContain('udid-1');
      expect(err.message).toContain('30000');
      expect(err.deviceId).toBe('udid-1');
      expect(err.deviceName).toBe('iPhone 17');
      expect(err.timeoutMs).toBe(30000);
    });
  });

  describe('ShutdownTimeoutError', () => {
    it('has correct name and message', () => {
      const err = new ShutdownTimeoutError('udid-2', 15000);
      expect(err).toBeInstanceOf(ShutdownTimeoutError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ShutdownTimeoutError');
      expect(err.message).toContain('udid-2');
      expect(err.message).toContain('15000');
      expect(err.deviceId).toBe('udid-2');
      expect(err.timeoutMs).toBe(15000);
    });
  });

  describe('DeviceNotFoundError', () => {
    it('has correct name and lists available devices', () => {
      const err = new DeviceNotFoundError('iphone-99', ['iPhone 17', 'iPhone SE']);
      expect(err).toBeInstanceOf(DeviceNotFoundError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('DeviceNotFoundError');
      expect(err.message).toContain('iphone-99');
      expect(err.message).toContain('iPhone 17');
      expect(err.requested).toBe('iphone-99');
      expect(err.available).toEqual(['iPhone 17', 'iPhone SE']);
    });

    it('truncates available list beyond 5 items', () => {
      const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const err = new DeviceNotFoundError('x', many);
      expect(err.message).toContain('...');
    });
  });

  describe('DeviceNotBootedError', () => {
    it('has correct name and message', () => {
      const err = new DeviceNotBootedError('udid-3');
      expect(err).toBeInstanceOf(DeviceNotBootedError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('DeviceNotBootedError');
      expect(err.message).toContain('udid-3');
      expect(err.deviceId).toBe('udid-3');
    });
  });

  describe('ScreenshotTimeoutError', () => {
    it('has correct name and message', () => {
      const err = new ScreenshotTimeoutError('udid-4');
      expect(err).toBeInstanceOf(ScreenshotTimeoutError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ScreenshotTimeoutError');
      expect(err.message).toContain('udid-4');
      expect(err.deviceId).toBe('udid-4');
    });
  });

  describe('AppNotInstalledError', () => {
    it('has correct name and message', () => {
      const err = new AppNotInstalledError('com.example.app', 'udid-5');
      expect(err).toBeInstanceOf(AppNotInstalledError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('AppNotInstalledError');
      expect(err.message).toContain('com.example.app');
      expect(err.message).toContain('udid-5');
      expect(err.bundleId).toBe('com.example.app');
      expect(err.deviceId).toBe('udid-5');
    });
  });

  describe('AppLaunchError', () => {
    it('has correct name and message', () => {
      const err = new AppLaunchError('com.example.app', 'udid-6', 'process crashed');
      expect(err).toBeInstanceOf(AppLaunchError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('AppLaunchError');
      expect(err.message).toContain('com.example.app');
      expect(err.message).toContain('udid-6');
      expect(err.message).toContain('process crashed');
      expect(err.bundleId).toBe('com.example.app');
      expect(err.deviceId).toBe('udid-6');
      expect(err.reason).toBe('process crashed');
    });
  });

  describe('re-exports from manager', () => {
    it('exports are identical classes (instanceof preserved)', async () => {
      const { BootTimeoutError: ManagerBoot } = await import('../../src/simulator/manager');
      const err = new BootTimeoutError('u', 'n', 1000);
      expect(err).toBeInstanceOf(ManagerBoot);
    });
  });
});
