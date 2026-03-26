import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
export declare class SimulatorCrashWatcher extends EventEmitter {
    private pool;
    private authProfile?;
    private interval;
    private knownStates;
    constructor(pool: SimulatorPool, authProfile?: string | undefined);
    start(checkIntervalMs?: number): void;
    stop(): void;
    private check;
    private recover;
    addDevice(deviceId: string): void;
    removeDevice(deviceId: string): void;
}
//# sourceMappingURL=crash-watcher.d.ts.map