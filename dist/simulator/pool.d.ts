import { EventEmitter } from 'events';
import { SimulatorManager } from './manager';
import { SimulatorDevice } from './types';
import { WebKitClient } from '../webkit/client';
export interface PooledSimulator {
    device: SimulatorDevice;
    client: WebKitClient;
    preset: string;
    bootedAt: number;
    lastActivity: number;
}
export interface SimulatorPoolOptions {
    max?: number;
    concurrency?: number;
    webkitBasePort?: number;
}
export declare class SimulatorPool extends EventEmitter {
    private pool;
    private manager;
    private maxSimulators;
    private concurrencyLimit;
    private webkitBasePort;
    private devicePorts;
    private nextPort;
    private idleCheckInterval;
    private resourceCheckInterval;
    private idleTimeout;
    private memoryWarnMB;
    private memoryKillMB;
    constructor(options?: SimulatorPoolOptions);
    checkResources(count: number): Promise<void>;
    bootAll(presets: string[]): Promise<PooledSimulator[]>;
    getAll(): PooledSimulator[];
    get(deviceId: string): PooledSimulator | null;
    getByPreset(preset: string): PooledSimulator | null;
    markActivity(deviceId: string): void;
    getManager(): SimulatorManager;
    shutdownAll(): Promise<void>;
    shutdownOne(deviceId: string): Promise<void>;
    startIdleMonitor(): void;
    stopIdleMonitor(): void;
    startResourceMonitor(): void;
    stopResourceMonitor(): void;
    injectAuth(authProfile: string): Promise<void>;
    get size(): number;
    private getPortForDevice;
    private getSimulatorMemory;
}
export declare class InsufficientResourcesError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=pool.d.ts.map