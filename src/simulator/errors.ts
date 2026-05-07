export class BootTimeoutError extends Error {
  constructor(
    public readonly deviceId: string,
    public readonly deviceName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Simulator boot timeout: "${deviceName}" (${deviceId}) did not boot within ${timeoutMs}ms`);
    this.name = 'BootTimeoutError';
  }
}

export class ShutdownTimeoutError extends Error {
  constructor(
    public readonly deviceId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Simulator shutdown timeout: ${deviceId} did not shutdown within ${timeoutMs}ms`);
    this.name = 'ShutdownTimeoutError';
  }
}

export class DeviceNotFoundError extends Error {
  constructor(
    public readonly requested: string,
    public readonly available: string[],
  ) {
    super(`Device not found: "${requested}". Available: ${available.slice(0, 5).join(', ')}${available.length > 5 ? '...' : ''}`);
    this.name = 'DeviceNotFoundError';
  }
}

export class DeviceNotBootedError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Device ${deviceId} is not booted. Call boot() first.`);
    this.name = 'DeviceNotBootedError';
  }
}

export class ScreenshotTimeoutError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Screenshot capture timed out for device ${deviceId}`);
    this.name = 'ScreenshotTimeoutError';
  }
}

export class AppNotInstalledError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly deviceId: string,
  ) {
    super(`App "${bundleId}" is not installed on device ${deviceId}`);
    this.name = 'AppNotInstalledError';
  }
}

export class AppLaunchError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly deviceId: string,
    public readonly reason: string,
  ) {
    super(`Failed to launch "${bundleId}" on device ${deviceId}: ${reason}`);
    this.name = 'AppLaunchError';
  }
}
