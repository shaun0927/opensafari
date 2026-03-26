/**
 * Event Loop Monitor — detects Node.js event loop blocking.
 * Uses timer drift detection (lightweight, ~0.5% CPU overhead).
 */
import { EventEmitter } from 'events';
export interface EventLoopMonitorOptions {
    /** Check interval in ms. Default: 200 */
    checkIntervalMs?: number;
    /** Warn threshold in ms. Default: 2000 (2s) */
    warnThresholdMs?: number;
    /**
     * Fatal threshold in ms. Default: 0 (disabled).
     * Emits 'fatal' event when threshold exceeded.
     * Callers MUST attach a 'fatal' listener to handle recovery (e.g., process.exit(1)).
     * No automatic process termination — this is intentional for testability.
     */
    fatalThresholdMs?: number;
    /**
     * Fatal threshold in ms during heavy tool operations (screenshot, bulk cookies).
     * Default: 120000 (120s). Heavy ops legitimately block the event loop longer
     * than the normal threshold without indicating a true hang.
     */
    heavyOpFatalThresholdMs?: number;
}
export interface BlockEvent {
    driftMs: number;
    timestamp: number;
}
export declare class EventLoopMonitor extends EventEmitter {
    private timer;
    private readonly checkIntervalMs;
    private readonly warnThresholdMs;
    private readonly fatalThresholdMs;
    private readonly heavyOpThresholdMs;
    private lastCheckAt;
    private maxDriftObserved;
    private warnCount;
    private heavyOpCount;
    constructor(opts?: EventLoopMonitorOptions);
    /**
     * Start monitoring the event loop.
     */
    start(): void;
    /**
     * Stop monitoring.
     */
    stop(): void;
    /**
     * Whether monitoring is active.
     */
    isRunning(): boolean;
    /**
     * Signal the start of a heavy tool operation that may legitimately block the event loop.
     * While active, the monitor uses heavyOpThresholdMs instead of fatalThresholdMs.
     * Uses a reference counter so concurrent heavy tools are handled correctly.
     */
    beginHeavyOperation(): void;
    /**
     * Signal the end of a heavy tool operation, reverting to the normal fatal threshold
     * once all concurrent heavy operations have completed.
     */
    endHeavyOperation(): void;
    /**
     * Get monitoring statistics.
     */
    getStats(): {
        maxDriftMs: number;
        warnCount: number;
        isRunning: boolean;
    };
    /**
     * Reset statistics.
     */
    resetStats(): void;
}
/**
 * Register the global EventLoopMonitor singleton.
 * Called once from src/index.ts after creating the monitor.
 */
export declare function setGlobalEventLoopMonitor(monitor: EventLoopMonitor): void;
/**
 * Retrieve the global EventLoopMonitor singleton.
 * Returns null if the monitor has not been registered yet (e.g., in tests).
 */
export declare function getGlobalEventLoopMonitor(): EventLoopMonitor | null;
//# sourceMappingURL=event-loop-monitor.d.ts.map