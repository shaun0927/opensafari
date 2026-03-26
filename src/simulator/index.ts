export { SimulatorManager, DeviceNotFoundError, BootTimeoutError, ShutdownTimeoutError, DeviceNotBootedError, ScreenshotTimeoutError } from './manager';
export { SimctlExecutor, SimctlError } from './simctl';
export { DEVICE_PRESETS, resolvePreset } from './presets';
export type { SimulatorDevice, SimulatorRuntime, DevicePreset } from './types';
export { checkXcodeInstallation } from './xcode-check';
export type { XcodeCheckResult } from './xcode-check';
