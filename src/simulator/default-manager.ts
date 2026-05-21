/**
 * Process-singleton SimulatorManager.
 *
 * The state cache inside SimulatorManager (`simctl list devices -j` results,
 * 900 ms TTL) only helps when callers reuse the same instance. Tool entry
 * points were each `new SimulatorManager()`-ing per invocation, which made
 * the cache effectively dead — concurrent tool calls would each fire their
 * own `simctl list devices -j` and serialize on the CLI, spiking CPU and
 * tripping the EventLoop watchdog.
 *
 * `getDefaultSimulatorManager()` returns a shared instance for tools that
 * do not own a manager themselves (the pool still owns its own — that
 * cache is keyed to pool-managed devices). Constructing your own manager
 * is still supported when you genuinely need an isolated cache (tests).
 */

import { SimulatorManager } from './manager';

let singleton: SimulatorManager | null = null;

export function getDefaultSimulatorManager(): SimulatorManager {
  if (!singleton) {
    singleton = new SimulatorManager();
  }
  return singleton;
}

/** Reset the singleton — exported for tests; never call in production. */
export function resetDefaultSimulatorManagerForTests(): void {
  singleton = null;
}
