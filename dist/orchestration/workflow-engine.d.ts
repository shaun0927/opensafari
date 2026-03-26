import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
import { AuthManager } from '../auth/manager';
export interface WorkflowInitOptions {
    devices: string[];
    url?: string;
    authProfile?: string;
    taskDescription?: string;
    workerNames?: string[];
}
export interface WorkflowInitResult {
    workflowId: string;
    workers: Array<{
        name: string;
        device: string;
    }>;
    prompts: Array<{
        workerName: string;
        prompt: string;
    }>;
}
export interface WorkerEntry {
    name: string;
    deviceId: string;
    preset: string;
    status: 'pending' | 'active' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    results?: unknown;
    error?: string;
    lastUpdate?: string;
    lastUpdateAt?: number;
}
export interface WorkflowState {
    id: string;
    status: 'running' | 'completed' | 'partial' | 'failed';
    workers: WorkerEntry[];
    startedAt: number;
    completedAt?: number;
    options: WorkflowInitOptions;
}
export interface WorkflowStatus {
    id: string;
    status: string;
    workers: Array<{
        name: string;
        device: string;
        status: string;
        lastUpdate?: string;
        lastUpdateAt?: number;
    }>;
    completedCount: number;
    totalCount: number;
    elapsed: number;
}
export interface WorkflowResults {
    id: string;
    status: string;
    duration: number;
    workers: Array<{
        name: string;
        device: string;
        viewport?: {
            width: number;
            height: number;
        };
        status: string;
        results?: unknown;
        error?: string;
        duration: number;
    }>;
}
export declare class SimulatorWorkflowEngine extends EventEmitter {
    private pool;
    private authManager;
    private workflows;
    private completionLock;
    constructor(pool: SimulatorPool, authManager: AuthManager);
    initWorkflow(options: WorkflowInitOptions): Promise<WorkflowInitResult>;
    updateWorker(workflowId: string, workerName: string, update: string): Promise<void>;
    completeWorker(workflowId: string, workerName: string, results: unknown): Promise<void>;
    failWorker(workflowId: string, workerName: string, error: string): Promise<void>;
    getStatus(workflowId: string): WorkflowStatus;
    collectResults(workflowId: string): WorkflowResults;
    collectPartialResults(workflowId: string): WorkflowResults;
    cleanupWorkflow(workflowId: string): Promise<void>;
    private checkWorkflowCompletion;
    private generateWorkerPrompt;
}
//# sourceMappingURL=workflow-engine.d.ts.map