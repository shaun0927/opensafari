/**
 * Crash-safe process cleanup registry (issue #640, PR 4).
 *
 * Blockers that mutate host state (pf anchors, NLC profiles) must make a
 * best-effort attempt to revert during process shutdown so SIGINT/SIGTERM
 * and normal exit don't leave stale rules that break the host network.
 *
 * This module owns a single lazily-installed set of process signal
 * handlers. Blockers register async cleanup functions via
 * {@link cleanupRegistry}.`add()`; the registry drains them on:
 *   - SIGINT / SIGTERM (exit with 130 / 143 respectively)
 *   - `beforeExit` (normal event-loop drain)
 *
 * We do not attempt to intercept `uncaughtException`: letting Node's
 * default handler print the trace is more useful for debugging, and
 * `beforeExit` will still fire on the way out.
 *
 * SIGKILL is uncatchable by design — for that case the startup
 * reconciliation path in {@link PfctlBlocker.reconcileStaleAnchor} is
 * the authoritative cleanup mechanism on the next server start.
 *
 * Test guidance: call `cleanupRegistry.disableForTests()` once at
 * module load (e.g. in a setup file) so unit tests don't install real
 * process handlers. Tests that need to drive the registry directly
 * use `NodeCleanupRegistry` from this module.
 */

export type CleanupFn = () => Promise<void>;

export interface CleanupRegistry {
  /**
   * Register an async cleanup function. Returns an `unregister` function
   * that callers MUST call when their resource is released in the normal
   * path (revert succeeded) — otherwise the handler re-runs on shutdown
   * and tries to revert state that is already gone.
   */
  add(fn: CleanupFn): () => void;

  /** Number of currently registered handlers (diagnostics / tests). */
  size(): number;

  /**
   * Test-only: clear all registered handlers without firing them.
   * Use in `beforeEach` to isolate tests.
   */
  clearForTests(): void;

  /**
   * Test-only: suppress process handler installation. MUST be called
   * before any `add()` to have effect. Prevents unit tests from
   * registering real signal handlers on the Node process.
   */
  disableForTests(): void;

  /**
   * Test-only: drain handlers in-band (no process.exit). Returns the
   * number of handlers fired so tests can assert on invocation counts.
   */
  fireForTests(): Promise<number>;
}

export class NodeCleanupRegistry implements CleanupRegistry {
  private handlers: Set<CleanupFn> = new Set();
  private installed = false;
  private disabled: boolean;

  constructor() {
    // Under Jest (`JEST_WORKER_ID` is set per worker) we must not install
    // real process signal handlers — they leak across tests and fire on
    // the Jest runner's own SIGINT/SIGTERM. Tests that want to exercise
    // the fire path construct their own `NodeCleanupRegistry`.
    this.disabled = process.env.JEST_WORKER_ID !== undefined;
  }

  add(fn: CleanupFn): () => void {
    this.handlers.add(fn);
    this.ensureInstalled();
    return () => {
      this.handlers.delete(fn);
    };
  }

  size(): number {
    return this.handlers.size;
  }

  clearForTests(): void {
    this.handlers.clear();
  }

  disableForTests(): void {
    this.disabled = true;
  }

  async fireForTests(): Promise<number> {
    const snapshot = Array.from(this.handlers);
    this.handlers.clear();
    await Promise.allSettled(snapshot.map((h) => h()));
    return snapshot.length;
  }

  private ensureInstalled(): void {
    if (this.installed || this.disabled) return;
    this.installed = true;

    const drain = async (): Promise<void> => {
      const snapshot = Array.from(this.handlers);
      // Clear first so a subsequent signal doesn't re-fire the same handlers.
      this.handlers.clear();
      await Promise.allSettled(
        snapshot.map((h) =>
          h().catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[opensafari] cleanup handler failed:', err);
          }),
        ),
      );
    };

    const exitWith = (code: number): void => {
      drain()
        .catch(() => undefined)
        .finally(() => process.exit(code));
    };

    process.once('SIGINT', () => exitWith(130));
    process.once('SIGTERM', () => exitWith(143));
    process.once('beforeExit', () => {
      void drain();
    });
  }
}

/** Shared cleanup registry for the whole server. */
export const cleanupRegistry: CleanupRegistry = new NodeCleanupRegistry();
