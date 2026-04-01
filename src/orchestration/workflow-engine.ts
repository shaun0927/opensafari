import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
import { BatchExecutor } from '../simulator/batch';
import { AuthManager } from '../auth/manager';
import { DEVICE_PRESETS } from '../simulator/presets';
import { WorkflowPersistence } from './workflow-persistence';

export interface WorkflowInitOptions {
  devices: string[];
  url?: string;
  authProfile?: string;
  taskDescription?: string;
  workerNames?: string[];
  mode?: 'concurrent' | 'sequential';
}

export interface WorkflowInitResult {
  workflowId: string;
  workers: Array<{ name: string; device: string }>;
  prompts: Array<{ workerName: string; prompt: string }>;
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
    viewport?: { width: number; height: number };
    status: string;
    results?: unknown;
    error?: string;
    duration: number;
  }>;
}

// Simple promise-based mutex
class PromiseMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

export class SimulatorWorkflowEngine extends EventEmitter {
  private workflows: Map<string, WorkflowState> = new Map();
  private completionLock = new PromiseMutex();
  private persistence = new WorkflowPersistence();

  constructor(
    private pool: SimulatorPool,
    private authManager: AuthManager,
  ) {
    super();
    this.restorePersistedWorkflows();
  }

  private restorePersistedWorkflows(): void {
    try {
      const states = this.persistence.loadAll();
      for (const state of states) {
        if (state.status === 'running') {
          state.status = 'partial';
        }
        this.workflows.set(state.id, state);
      }
    } catch (err) {
      console.error('Failed to restore persisted workflows:', err);
    }
  }

  private persistWorkflow(state: WorkflowState): void {
    try {
      this.persistence.save(state);
    } catch (err) {
      console.error('Failed to persist workflow:', err);
    }
  }

  async initWorkflow(options: WorkflowInitOptions): Promise<WorkflowInitResult> {
    const mode = options.mode ?? 'concurrent';
    const workflowId = `wf-${Date.now()}`;

    if (mode === 'sequential') {
      return this.initSequentialWorkflow(workflowId, options);
    }

    // ── Concurrent mode (default) ──
    const simulators = await this.pool.bootAll(options.devices);

    if (options.authProfile) {
      await this.pool.injectAuth(options.authProfile);
    }

    if (options.url) {
      const batch = new BatchExecutor(this.pool);
      await batch.batchNavigate(options.url);
    }

    const workers: WorkerEntry[] = simulators.map((sim, i) => ({
      name: options.workerNames?.[i] ?? `worker-${sim.preset}`,
      deviceId: sim.device.udid,
      preset: sim.preset,
      status: 'pending' as const,
      startedAt: Date.now(),
    }));

    const state: WorkflowState = {
      id: workflowId,
      status: 'running',
      workers,
      startedAt: Date.now(),
      options,
    };
    this.workflows.set(workflowId, state);
    this.persistWorkflow(state);

    const prompts = workers.map(w => ({
      workerName: w.name,
      prompt: this.generateWorkerPrompt(w, options),
    }));

    return { workflowId, workers: workers.map(w => ({ name: w.name, device: w.preset })), prompts };
  }

  /**
   * Sequential mode: boot one device at a time, run, collect results, shutdown.
   * Peak RAM = ~2GB regardless of device count.
   */
  private async initSequentialWorkflow(
    workflowId: string,
    options: WorkflowInitOptions,
  ): Promise<WorkflowInitResult> {
    const workers: WorkerEntry[] = options.devices.map((preset, i) => ({
      name: options.workerNames?.[i] ?? `worker-${preset}`,
      deviceId: '', // Assigned during sequential execution
      preset,
      status: 'pending' as const,
      startedAt: Date.now(),
    }));

    const state: WorkflowState = {
      id: workflowId,
      status: 'running',
      workers,
      startedAt: Date.now(),
      options,
    };
    this.workflows.set(workflowId, state);
    this.persistWorkflow(state);

    // Run sequentially in background — each device boots, runs, shuts down
    const sequentialResults = await this.pool.bootSequential(
      options.devices,
      async (sim, preset) => {
        const worker = state.workers.find(w => w.preset === preset);
        if (worker) {
          worker.deviceId = sim.device.udid;
          worker.status = 'active';
          this.persistWorkflow(state);
        }

        // Inject auth if configured
        if (options.authProfile) {
          try {
            const authMgr = this.authManager;
            const profile = await authMgr.loadProfile(options.authProfile!);
            if (sim.client.isConnected()) {
              await sim.client.setCookies(profile.cookies);
            }
          } catch (err) {
            console.error(`[Workflow] Auth injection failed for ${preset}: ${err}`);
          }
        }

        // Navigate to URL
        if (options.url && sim.client.isConnected()) {
          try {
            await sim.client.navigate({ url: options.url });
          } catch (err) {
            console.error(`[Workflow] Navigation failed for ${preset}: ${err}`);
          }
        }

        return { device: preset, deviceId: sim.device.udid, ready: true };
      },
    );

    // Update worker statuses from sequential results
    for (const [preset, result] of sequentialResults) {
      const worker = state.workers.find(w => w.preset === preset);
      if (!worker) continue;
      if (result.status === 'completed') {
        worker.status = 'completed';
        worker.results = result.result;
        worker.completedAt = Date.now();
      } else {
        worker.status = 'failed';
        worker.error = result.error;
        worker.completedAt = Date.now();
      }
    }

    this.checkWorkflowCompletion(state);
    this.persistWorkflow(state);

    // Sequential mode: all devices have already run and shut down,
    // so generate completion summaries instead of action prompts.
    const prompts = workers.map(w => ({
      workerName: w.name,
      prompt: `[COMPLETED] ${w.name} on ${w.preset}: ${w.status}. Results available via workflow_collect.`,
    }));

    return { workflowId, workers: workers.map(w => ({ name: w.name, device: w.preset })), prompts };
  }

  async updateWorker(workflowId: string, workerName: string, update: string): Promise<void> {
    const state = this.workflows.get(workflowId);
    if (!state) throw new Error(`Workflow not found: ${workflowId}`);
    const worker = state.workers.find(w => w.name === workerName);
    if (!worker) throw new Error(`Worker not found: ${workerName}`);

    worker.status = 'active';
    worker.lastUpdate = update;
    worker.lastUpdateAt = Date.now();
    this.persistWorkflow(state);
  }

  async completeWorker(workflowId: string, workerName: string, results: unknown): Promise<void> {
    await this.completionLock.acquire();
    try {
      const state = this.workflows.get(workflowId);
      if (!state) throw new Error(`Workflow not found: ${workflowId}`);
      const worker = state.workers.find(w => w.name === workerName);
      if (!worker) throw new Error(`Worker not found: ${workerName}`);

      worker.status = 'completed';
      worker.results = results;
      worker.completedAt = Date.now();

      this.checkWorkflowCompletion(state);
      this.persistWorkflow(state);
    } finally {
      this.completionLock.release();
    }
  }

  async failWorker(workflowId: string, workerName: string, error: string): Promise<void> {
    await this.completionLock.acquire();
    try {
      const state = this.workflows.get(workflowId);
      if (!state) throw new Error(`Workflow not found: ${workflowId}`);
      const worker = state.workers.find(w => w.name === workerName);
      if (!worker) throw new Error(`Worker not found: ${workerName}`);

      worker.status = 'failed';
      worker.error = error;
      worker.completedAt = Date.now();

      this.checkWorkflowCompletion(state);
      this.persistWorkflow(state);
    } finally {
      this.completionLock.release();
    }
  }

  getStatus(workflowId: string): WorkflowStatus {
    const state = this.workflows.get(workflowId);
    if (!state) throw new Error(`Workflow not found: ${workflowId}`);

    return {
      id: workflowId,
      status: state.status,
      workers: state.workers.map(w => ({
        name: w.name,
        device: w.preset,
        status: w.status,
        lastUpdate: w.lastUpdate,
        lastUpdateAt: w.lastUpdateAt,
      })),
      completedCount: state.workers.filter(w => w.status === 'completed' || w.status === 'failed').length,
      totalCount: state.workers.length,
      elapsed: Date.now() - state.startedAt,
    };
  }

  collectResults(workflowId: string): WorkflowResults {
    const state = this.workflows.get(workflowId);
    if (!state) throw new Error(`Workflow not found: ${workflowId}`);

    return {
      id: workflowId,
      status: state.status,
      duration: (state.completedAt ?? Date.now()) - state.startedAt,
      workers: state.workers.map(w => {
        const preset = DEVICE_PRESETS[w.preset];
        return {
          name: w.name,
          device: w.preset,
          viewport: preset ? { width: preset.w, height: preset.h } : undefined,
          status: w.status,
          results: w.results,
          error: w.error,
          duration: (w.completedAt ?? Date.now()) - w.startedAt,
        };
      }),
    };
  }

  collectPartialResults(workflowId: string): WorkflowResults {
    // Same as collectResults but only includes completed/failed workers
    const full = this.collectResults(workflowId);
    full.workers = full.workers.filter(w => w.status === 'completed' || w.status === 'failed');
    return full;
  }

  async cleanupWorkflow(workflowId: string): Promise<void> {
    this.persistence.remove(workflowId);
    this.workflows.delete(workflowId);
    await this.pool.shutdownAll();
  }

  private checkWorkflowCompletion(state: WorkflowState): void {
    const allDone = state.workers.every(w => w.status === 'completed' || w.status === 'failed');
    if (allDone) {
      const hasFailed = state.workers.some(w => w.status === 'failed');
      state.status = hasFailed ? 'partial' : 'completed';
      state.completedAt = Date.now();
      this.emit('workflow:completed', { id: state.id, status: state.status });
    }
  }

  private generateWorkerPrompt(worker: WorkerEntry, options: WorkflowInitOptions): string {
    const preset = DEVICE_PRESETS[worker.preset];
    return [
      `You are worker "${worker.name}" testing on ${worker.preset}.`,
      preset ? `Device: ${preset.name} (${preset.w}x${preset.h})` : `Device: ${worker.preset}`,
      `URL: ${options.url ?? 'Not set'}`,
      `Task: ${options.taskDescription ?? 'General QA'}`,
      '',
      'Use these tools with your assigned device:',
      '- navigate, screenshot, click, type, query_dom, javascript, read_page',
      '- Report findings via worker_update',
      '- When done, call worker_complete with your results',
    ].join('\n');
  }
}
