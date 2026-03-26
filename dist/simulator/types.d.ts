export interface SimulatorDevice {
    udid: string;
    name: string;
    state: 'Booted' | 'Shutdown' | 'Creating' | 'ShuttingDown';
    isAvailable: boolean;
    runtime: string;
    runtimeVersion: string;
}
export interface SimulatorRuntime {
    identifier: string;
    version: string;
    isAvailable: boolean;
    platform: string;
}
export interface DevicePreset {
    name: string;
    w: number;
    h: number;
    dpr: number;
}
//# sourceMappingURL=types.d.ts.map