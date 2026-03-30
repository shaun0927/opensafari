/**
 * Step Synchronization Barrier for coordinated multi-device test scenarios.
 *
 * When multiple simulated devices participate in a shared test flow
 * (e.g. collaborative editing, real-time chat) they need to reach the
 * same logical step before any of them proceeds.  StepBarrier provides
 * that coordination primitive.
 */

export interface BarrierOptions {
  /** Timeout in milliseconds. Default 30 000. */
  timeout?: number;
}

export interface BarrierResult {
  stepName: string;
  allArrived: boolean;
  arrivedDevices: string[];
  missingDevices: string[];
  /** Milliseconds this device waited before the barrier released. */
  waitTime: number;
}

export interface BarrierStatus {
  stepName: string;
  expectedCount: number;
  arrivedCount: number;
  arrivedDevices: string[];
  missingDevices: string[];
}

interface BarrierEntry {
  stepName: string;
  expectedDevices: Set<string>;
  arrivedDevices: Set<string>;
  resolvers: Map<string, (result: BarrierResult) => void>;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class StepBarrier {
  private barriers: Map<string, BarrierEntry> = new Map();

  /**
   * Block until every device in `allDeviceIds` has called `wait()` for
   * the same `stepName`, or until the timeout expires.
   */
  async wait(
    stepName: string,
    deviceId: string,
    allDeviceIds: string[],
    options?: BarrierOptions,
  ): Promise<BarrierResult> {
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    // Lazily create the barrier entry for this step.
    if (!this.barriers.has(stepName)) {
      this.barriers.set(stepName, {
        stepName,
        expectedDevices: new Set(allDeviceIds),
        arrivedDevices: new Set(),
        resolvers: new Map(),
      });
    }

    const entry = this.barriers.get(stepName)!;

    // If this device already arrived, return immediately.
    if (entry.arrivedDevices.has(deviceId)) {
      return this.buildResult(entry, startTime, true);
    }

    // Mark arrival.
    entry.arrivedDevices.add(deviceId);
    console.error(
      `[StepBarrier] Device "${deviceId}" arrived at step "${stepName}" ` +
        `(${entry.arrivedDevices.size}/${entry.expectedDevices.size})`,
    );

    // Check whether all devices have now arrived.
    if (this.allArrived(entry)) {
      this.releaseAll(entry, startTime);
      return this.buildResult(entry, startTime, true);
    }

    // Not everyone is here yet -- wait.
    return new Promise<BarrierResult>((resolve) => {
      entry.resolvers.set(deviceId, resolve);

      // Start timeout only once (first waiter sets it).
      if (entry.timeoutId === undefined) {
        entry.timeoutId = setTimeout(() => {
          this.handleTimeout(entry, startTime);
        }, timeoutMs);
      }
    });
  }

  /**
   * Return the current status of a named barrier, or `null` if none exists.
   */
  getStatus(stepName: string): BarrierStatus | null {
    const entry = this.barriers.get(stepName);
    if (!entry) return null;

    const arrived = Array.from(entry.arrivedDevices);
    const missing = Array.from(entry.expectedDevices).filter(
      (d) => !entry.arrivedDevices.has(d),
    );
    return {
      stepName: entry.stepName,
      expectedCount: entry.expectedDevices.size,
      arrivedCount: entry.arrivedDevices.size,
      arrivedDevices: arrived,
      missingDevices: missing,
    };
  }

  /**
   * Clear (and cancel) a specific barrier.
   */
  clear(stepName: string): void {
    const entry = this.barriers.get(stepName);
    if (entry) {
      if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId);
      const result = this.buildResult(entry, Date.now(), false);
      for (const [, resolve] of entry.resolvers) {
        resolve(result);
      }
      entry.resolvers.clear();
      this.barriers.delete(stepName);
    }
  }

  /**
   * Clear all barriers.
   */
  clearAll(): void {
    for (const entry of this.barriers.values()) {
      if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId);
      const result = this.buildResult(entry, Date.now(), false);
      for (const [, resolve] of entry.resolvers) {
        resolve(result);
      }
      entry.resolvers.clear();
    }
    this.barriers.clear();
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private allArrived(entry: BarrierEntry): boolean {
    for (const d of entry.expectedDevices) {
      if (!entry.arrivedDevices.has(d)) return false;
    }
    return true;
  }

  private releaseAll(entry: BarrierEntry, startTime: number): void {
    if (entry.timeoutId !== undefined) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = undefined;
    }
    const result = this.buildResult(entry, startTime, true);
    for (const [, resolve] of entry.resolvers) {
      resolve(result);
    }
    entry.resolvers.clear();
  }

  private handleTimeout(entry: BarrierEntry, startTime: number): void {
    console.error(
      `[StepBarrier] Timeout for step "${entry.stepName}". ` +
        `Arrived: [${Array.from(entry.arrivedDevices).join(', ')}], ` +
        `Missing: [${Array.from(entry.expectedDevices)
          .filter((d) => !entry.arrivedDevices.has(d))
          .join(', ')}]`,
    );
    const result = this.buildResult(entry, startTime, false);
    for (const [, resolve] of entry.resolvers) {
      resolve(result);
    }
    entry.resolvers.clear();
    entry.timeoutId = undefined;
  }

  private buildResult(
    entry: BarrierEntry,
    startTime: number,
    allArrived: boolean,
  ): BarrierResult {
    const arrived = Array.from(entry.arrivedDevices);
    const missing = Array.from(entry.expectedDevices).filter(
      (d) => !entry.arrivedDevices.has(d),
    );
    return {
      stepName: entry.stepName,
      allArrived,
      arrivedDevices: arrived,
      missingDevices: missing,
      waitTime: Date.now() - startTime,
    };
  }
}
