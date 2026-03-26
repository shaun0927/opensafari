import { SimctlExecutor } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
export declare class SimulatorManager {
    private simctl;
    listDevices(): Promise<SimulatorDevice[]>;
    listRuntimes(): Promise<SimulatorRuntime[]>;
    listBooted(): Promise<SimulatorDevice[]>;
    getDevice(deviceId: string): Promise<SimulatorDevice | null>;
    /**
     * Resolve a preset key or device name to an actual device.
     * Tries: exact UDID match → preset name match → fuzzy name match
     */
    resolveDevice(presetKey: string): Promise<SimulatorDevice>;
    checkRuntimes(): Promise<{
        installed: SimulatorRuntime[];
        issues: string[];
        suggestions: string[];
    }>;
    boot(presetOrId: string, options?: {
        timeout?: number;
    }): Promise<SimulatorDevice>;
    shutdown(deviceId: string, options?: {
        timeout?: number;
    }): Promise<void>;
    bootPreset(presetKey: string): Promise<SimulatorDevice>;
    openUrl(deviceId: string, url: string): Promise<void>;
    screenshot(deviceId: string, options?: {
        format?: 'png' | 'jpeg';
    }): Promise<Buffer>;
    screenshotBase64(deviceId: string, options?: {
        format?: 'png' | 'jpeg';
    }): Promise<string>;
    getSimctl(): SimctlExecutor;
    setAppearance(deviceId: string, mode: 'light' | 'dark'): Promise<void>;
    getAppearance(deviceId: string): Promise<'light' | 'dark'>;
    toggleAppearance(deviceId: string): Promise<'light' | 'dark'>;
    rotate(deviceId: string): Promise<void>;
    cloneDevice(deviceId: string, cloneName: string): Promise<string>;
    deleteDevice(deviceId: string): Promise<void>;
    overrideStatusBar(deviceId: string): Promise<void>;
}
export declare class BootTimeoutError extends Error {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly timeoutMs: number;
    constructor(deviceId: string, deviceName: string, timeoutMs: number);
}
export declare class ShutdownTimeoutError extends Error {
    readonly deviceId: string;
    readonly timeoutMs: number;
    constructor(deviceId: string, timeoutMs: number);
}
export declare class DeviceNotFoundError extends Error {
    readonly requested: string;
    readonly available: string[];
    constructor(requested: string, available: string[]);
}
export declare class DeviceNotBootedError extends Error {
    readonly deviceId: string;
    constructor(deviceId: string);
}
export declare class ScreenshotTimeoutError extends Error {
    readonly deviceId: string;
    constructor(deviceId: string);
}
//# sourceMappingURL=manager.d.ts.map