/**
 * Resilience integration tests -- no simulator required.
 *
 * Tests start/stop lifecycle of monitoring and cleanup components:
 * - SimulatorCrashWatcher
 * - EventLoopMonitor
 * - SimulatorMonitor
 * - setupGracefulShutdown
 * - cleanupZombieProcesses
 * - startPeriodicCleanup / stopPeriodicCleanup
 */

import { SimulatorCrashWatcher } from '../../src/reliability/crash-watcher';
import { setupGracefulShutdown } from '../../src/reliability/graceful-shutdown';
import {
  cleanupZombieProcesses,
  startPeriodicCleanup,
  stopPeriodicCleanup,
} from '../../src/reliability/zombie-cleanup';
import { EventLoopMonitor } from '../../src/watchdog/event-loop-monitor';
import { SimulatorMonitor } from '../../src/watchdog/simulator-monitor';
import { SimulatorPool } from '../../src/simulator/pool';

describe('Resilience: SimulatorCrashWatcher lifecycle', () => {
  let pool: SimulatorPool;
  let watcher: SimulatorCrashWatcher;

  beforeEach(() => {
    pool = new SimulatorPool({ max: 1 });
    watcher = new SimulatorCrashWatcher(pool);
  });

  afterEach(() => {
    watcher.stop();
  });

  test('can be instantiated', () => {
    expect(watcher).toBeInstanceOf(SimulatorCrashWatcher);
  });

  test('start() does not throw', () => {
    expect(() => watcher.start(60000)).not.toThrow();
  });

  test('stop() after start does not throw', () => {
    watcher.start(60000);
    expect(() => watcher.stop()).not.toThrow();
  });

  test('double start is idempotent', () => {
    watcher.start(60000);
    expect(() => watcher.start(60000)).not.toThrow();
  });

  test('stop() without start is safe', () => {
    expect(() => watcher.stop()).not.toThrow();
  });

  test('addDevice/removeDevice lifecycle', () => {
    const fakeUdid = 'fake-udid-12345';
    expect(() => watcher.addDevice(fakeUdid)).not.toThrow();
    expect(() => watcher.removeDevice(fakeUdid)).not.toThrow();
  });

  test('emits events when listeners are attached', () => {
    const crashHandler = jest.fn();
    watcher.on('crash', crashHandler);
    watcher.emit('crash', { deviceId: 'test-device' });
    expect(crashHandler).toHaveBeenCalledWith({ deviceId: 'test-device' });
  });
});

describe('Resilience: EventLoopMonitor lifecycle', () => {
  let monitor: EventLoopMonitor;

  afterEach(() => {
    monitor?.stop();
  });

  test('can be instantiated with defaults', () => {
    monitor = new EventLoopMonitor();
    expect(monitor).toBeInstanceOf(EventLoopMonitor);
    expect(monitor.isRunning()).toBe(false);
  });

  test('can be instantiated with custom options', () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 500,
      warnThresholdMs: 5000,
      fatalThresholdMs: 30000,
    });
    expect(monitor).toBeInstanceOf(EventLoopMonitor);
  });

  test('start/stop lifecycle', () => {
    monitor = new EventLoopMonitor();
    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  test('double start replaces timer (no leak)', () => {
    monitor = new EventLoopMonitor();
    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    // Second start should stop the first timer and create a new one
    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  test('getStats returns initial values', () => {
    monitor = new EventLoopMonitor();
    const stats = monitor.getStats();
    expect(stats.maxDriftMs).toBe(0);
    expect(stats.warnCount).toBe(0);
    expect(stats.isRunning).toBe(false);
  });

  test('resetStats clears counters', () => {
    monitor = new EventLoopMonitor();
    monitor.resetStats();
    const stats = monitor.getStats();
    expect(stats.maxDriftMs).toBe(0);
    expect(stats.warnCount).toBe(0);
  });

  test('beginHeavyOperation/endHeavyOperation do not throw', () => {
    monitor = new EventLoopMonitor();
    expect(() => monitor.beginHeavyOperation()).not.toThrow();
    expect(() => monitor.endHeavyOperation()).not.toThrow();
  });
});

describe('Resilience: SimulatorMonitor lifecycle', () => {
  let monitor: SimulatorMonitor;

  afterEach(() => {
    monitor?.stop();
  });

  test('can be instantiated with defaults', () => {
    monitor = new SimulatorMonitor();
    expect(monitor).toBeInstanceOf(SimulatorMonitor);
  });

  test('can be instantiated with custom options', () => {
    monitor = new SimulatorMonitor({
      warnMB: 1024,
      killMB: 2048,
      intervalMs: 30000,
    });
    expect(monitor).toBeInstanceOf(SimulatorMonitor);
  });

  test('start/stop lifecycle', () => {
    monitor = new SimulatorMonitor({ intervalMs: 60000 });
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.stop()).not.toThrow();
  });

  test('double start is idempotent', () => {
    monitor = new SimulatorMonitor({ intervalMs: 60000 });
    monitor.start();
    expect(() => monitor.start()).not.toThrow();
    monitor.stop();
  });

  test('stop without start is safe', () => {
    monitor = new SimulatorMonitor();
    expect(() => monitor.stop()).not.toThrow();
  });
});

describe('Resilience: Graceful shutdown', () => {
  test('setupGracefulShutdown registers handlers without throwing', () => {
    const pool = new SimulatorPool({ max: 1 });
    expect(() => setupGracefulShutdown(pool)).not.toThrow();
  });
});

describe('Resilience: Zombie cleanup', () => {
  test('cleanupZombieProcesses() in detection mode returns a number', async () => {
    // Called without knownDeviceIds => detection mode (no killing)
    const count = await cleanupZombieProcesses();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('cleanupZombieProcesses() with empty known set returns a number', async () => {
    const count = await cleanupZombieProcesses(new Set());
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('startPeriodicCleanup / stopPeriodicCleanup lifecycle', () => {
    const getIds = () => new Set<string>();
    expect(() => startPeriodicCleanup(getIds, 60000)).not.toThrow();
    expect(() => stopPeriodicCleanup()).not.toThrow();
  });

  test('stopPeriodicCleanup without start is safe', () => {
    expect(() => stopPeriodicCleanup()).not.toThrow();
  });

  test('double startPeriodicCleanup replaces interval', () => {
    const getIds = () => new Set<string>();
    startPeriodicCleanup(getIds, 60000);
    // Second call should stop first and create new one
    expect(() => startPeriodicCleanup(getIds, 60000)).not.toThrow();
    stopPeriodicCleanup();
  });
});
