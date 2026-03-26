import { EventEmitter } from 'events';
import { BrowserBackend } from './types/browser-backend';
/**
 * Session Manager — Simulator & Safari Connection Tracking
 *
 * Maps booted simulators to WebKit Protocol connections (BrowserBackend instances).
 * Manages active device, workers, and connection lifecycle.
 */
export interface SimulatorInfo {
    deviceId: string;
    deviceType: string;
    state: 'booted' | 'shutdown';
    viewport: {
        width: number;
        height: number;
    };
    bootedAt: number;
    lastActivity: number;
}
export interface WorkerInfo {
    name: string;
    deviceId: string;
    status: 'pending' | 'active' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    results?: unknown;
    error?: string;
}
export declare class SessionManager extends EventEmitter {
    private simulators;
    private connections;
    private workers;
    private activeDeviceId;
    addSimulator(deviceId: string, info: SimulatorInfo): void;
    removeSimulator(deviceId: string): void;
    getSimulator(deviceId: string): SimulatorInfo | null;
    listSimulators(): SimulatorInfo[];
    setConnection(deviceId: string, client: BrowserBackend): void;
    getConnection(deviceId?: string): BrowserBackend | null;
    setActiveDevice(deviceId: string): void;
    getActiveDeviceId(): string | null;
    markActivity(deviceId: string): void;
    createWorker(name: string, deviceId: string): WorkerInfo;
    getWorker(name: string): WorkerInfo | null;
    listWorkers(): WorkerInfo[];
    updateWorkerStatus(name: string, status: WorkerInfo['status'], data?: {
        results?: unknown;
        error?: string;
    }): void;
    removeWorker(name: string): void;
    shutdown(): Promise<void>;
}
export declare function getSessionManager(): SessionManager;
//# sourceMappingURL=session-manager.d.ts.map