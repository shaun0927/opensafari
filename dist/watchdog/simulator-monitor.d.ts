import { EventEmitter } from 'events';
export declare class SimulatorMonitor extends EventEmitter {
    private interval;
    private warnMB;
    private killMB;
    private checkIntervalMs;
    constructor(options?: {
        warnMB?: number;
        killMB?: number;
        intervalMs?: number;
    });
    start(): void;
    stop(): void;
    private check;
}
//# sourceMappingURL=simulator-monitor.d.ts.map