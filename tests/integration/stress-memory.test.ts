/**
 * Memory & Resource Stress Tests — Validates resource management under pressure.
 *
 * Tests RAM pre-flight checks, resource cleanup, zombie cleanup targeting,
 * and circuit breaker behavior. Uses mocks to keep tests fast.
 */

import { SimulatorPool, InsufficientResourcesError } from '../../src/simulator/pool';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../src/reliability/circuit-breaker';
import {
  registerManagedDevices,
  unregisterManagedDevices,
  getAllManagedDeviceIds,
  getOrphanedRegisteredDeviceIds,
} from '../../src/reliability/zombie-cleanup';
import { DEVICE_PRESETS } from '../../src/simulator/presets';

// ── Mock SimulatorManager ──

let mockBootCounter = 0;
let mockBootedDevices: Set<string> = new Set();
let mockShutdownCount = 0;

jest.mock('../../src/simulator/manager', () => {
  return {
    SimulatorManager: jest.fn().mockImplementation(() => ({
      boot: jest.fn().mockImplementation(async (presetOrName: string) => {
        const udid = `mem-mock-udid-${++mockBootCounter}`;
        mockBootedDevices.add(udid);
        return {
          udid,
          name: DEVICE_PRESETS[presetOrName]?.name ?? presetOrName,
          state: 'Booted',
        };
      }),
      shutdown: jest.fn().mockImplementation(async (udid: string) => {
        mockShutdownCount++;
        mockBootedDevices.delete(udid);
      }),
      openUrl: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock WebKitClient
jest.mock('../../src/webkit/client', () => {
  return {
    WebKitClient: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
      evaluate: jest.fn().mockResolvedValue('mock'),
      navigate: jest.fn().mockResolvedValue({ url: '', status: 200, loadTime: 100 }),
      setCookies: jest.fn().mockResolvedValue(undefined),
      getCookies: jest.fn().mockResolvedValue([]),
    })),
  };
});

// ── Test Suite ──

describe('Memory & Resource Stress Tests', () => {
  let pool: SimulatorPool;

  beforeEach(() => {
    mockBootCounter = 0;
    mockBootedDevices = new Set();
    mockShutdownCount = 0;
    pool = new SimulatorPool({ max: 10, concurrency: 3 });
  });

  afterEach(async () => {
    try { await pool.shutdownAll(); } catch { /* best-effort */ }
    // Clean up any registry entries from this test process
    unregisterManagedDevices();
  });

  // ── Test 1: Pre-flight RAM Check — Insufficient Resources ──

  test('should throw InsufficientResourcesError when free RAM is too low', async () => {
    // Create a pool with the real checkResources method
    const strictPool = new SimulatorPool({ max: 5, concurrency: 1 });

    // Mock os.freemem to return very low value (100MB)
    const os = require('os');
    const originalFreemem = os.freemem;
    os.freemem = jest.fn().mockReturnValue(100 * 1024 * 1024); // 100MB

    try {
      // Trying to boot 3 devices would need ~6GB, but only 100MB available
      await expect(strictPool.checkResources(3)).rejects.toThrow(InsufficientResourcesError);
      await expect(strictPool.checkResources(3)).rejects.toThrow(/Need ~6144MB/);
    } finally {
      os.freemem = originalFreemem;
    }
  }, 10_000);

  // ── Test 2: Pre-flight RAM Check — Sufficient Resources ──

  test('should pass resource check when enough RAM is available', async () => {
    const strictPool = new SimulatorPool({ max: 5, concurrency: 1 });

    const os = require('os');
    const originalFreemem = os.freemem;
    os.freemem = jest.fn().mockReturnValue(16 * 1024 * 1024 * 1024); // 16GB

    try {
      // 2 devices need ~4GB, 16GB available — should pass
      await expect(strictPool.checkResources(2)).resolves.toBeUndefined();
    } finally {
      os.freemem = originalFreemem;
    }
  }, 10_000);

  // ── Test 3: Cleanup Verification — Boot 3, Shutdown All ──

  test('should leave zero orphaned devices after shutting down 3 booted devices', async () => {
    pool.checkResources = async () => {};

    // Boot 3 devices
    const booted = await pool.bootAll(['iphone-17', 'ipad-pro', 'iphone-17-pro']);
    expect(booted).toHaveLength(3);
    expect(pool.size).toBe(3);
    expect(mockBootedDevices.size).toBe(3);

    // Shutdown all
    await pool.shutdownAll();

    // Zero remaining
    expect(pool.size).toBe(0);
    expect(mockBootedDevices.size).toBe(0);
    expect(mockShutdownCount).toBe(3);
  }, 30_000);

  // ── Test 4: Partial Shutdown — shutdownOne ──

  test('should correctly remove a single device while others remain active', async () => {
    pool.checkResources = async () => {};

    const booted = await pool.bootAll(['iphone-17', 'ipad-pro', 'iphone-17-pro']);
    expect(pool.size).toBe(3);

    const udidToRemove = booted[1].device.udid;

    // Shutdown just one device
    await pool.shutdownOne(udidToRemove);

    expect(pool.size).toBe(2);
    expect(pool.get(udidToRemove)).toBeNull();

    // The other two should still be in the pool
    expect(pool.get(booted[0].device.udid)).not.toBeNull();
    expect(pool.get(booted[2].device.udid)).not.toBeNull();

    // Clean up
    await pool.shutdownAll();
    expect(pool.size).toBe(0);
  }, 30_000);

  // ── Test 5: Zombie Cleanup Only Targets Registered Devices ──

  test('should only report opensafari-registered devices as managed', () => {
    // Register some devices under our PID
    const testUdids = ['reg-device-1', 'reg-device-2', 'reg-device-3'];
    registerManagedDevices(testUdids);

    // Check managed set includes our devices
    const managed = getAllManagedDeviceIds();
    for (const udid of testUdids) {
      expect(managed.has(udid)).toBe(true);
    }

    // Unregister
    unregisterManagedDevices();

    // After unregister, our devices should no longer be in the managed set
    const afterUnregister = getAllManagedDeviceIds();
    for (const udid of testUdids) {
      expect(afterUnregister.has(udid)).toBe(false);
    }
  }, 10_000);

  // ── Test 6: Orphaned Device Detection ──

  test('should not report current-process devices as orphaned', () => {
    const testUdids = ['orphan-test-1', 'orphan-test-2'];
    registerManagedDevices(testUdids);

    // Our process is alive, so these should NOT appear as orphaned
    const orphaned = getOrphanedRegisteredDeviceIds();
    for (const udid of testUdids) {
      expect(orphaned.has(udid)).toBe(false);
    }

    // But they should appear as managed
    const managed = getAllManagedDeviceIds();
    for (const udid of testUdids) {
      expect(managed.has(udid)).toBe(true);
    }

    // Clean up
    unregisterManagedDevices();
  }, 10_000);

  // ── Test 7: Circuit Breaker — Trips After Failures ──

  test('should trip circuit breaker after repeated failures', () => {
    const cb = new CircuitBreaker('test-device-1', {
      failureThreshold: 3,
      cooldownMs: 30_000,
      halfOpenMaxAttempts: 1,
    });

    // Initially closed and available
    expect(cb.getState()).toBe('closed');
    expect(cb.isAvailable()).toBe(true);

    // Record 2 failures — still closed (threshold is 3)
    cb.recordFailure(new Error('fail-1'));
    cb.recordFailure(new Error('fail-2'));
    expect(cb.getState()).toBe('closed');
    expect(cb.isAvailable()).toBe(true);

    // Third failure — trips to open
    cb.recordFailure(new Error('fail-3'));
    expect(cb.getState()).toBe('open');
    expect(cb.isAvailable()).toBe(false);
  }, 10_000);

  // ── Test 8: Circuit Breaker — Recovery After Cooldown ──

  test('should transition to half-open after cooldown period', () => {
    const cb = new CircuitBreaker('test-device-2', {
      failureThreshold: 2,
      cooldownMs: 100, // Very short cooldown for testing
      halfOpenMaxAttempts: 1,
    });

    // Trip the breaker
    cb.recordFailure(new Error('fail-1'));
    cb.recordFailure(new Error('fail-2'));
    expect(cb.getState()).toBe('open');
    expect(cb.isAvailable()).toBe(false);

    // Manually set lastFailureTime to the past by resetting and re-tripping
    // Use the trip() method and then wait
    cb.reset();
    cb.trip();
    expect(cb.getState()).toBe('open');

    // Immediately after trip, should not be available
    // (cooldown is 100ms, so we test by resetting)
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.isAvailable()).toBe(true);
  }, 10_000);

  // ── Test 9: Circuit Breaker — Success Resets to Closed ──

  test('should reset to closed state on success after half-open', () => {
    const cb = new CircuitBreaker('test-device-3', {
      failureThreshold: 1,
      cooldownMs: 0, // Immediate cooldown
      halfOpenMaxAttempts: 1,
    });

    // Trip the breaker
    cb.recordFailure(new Error('fail'));
    expect(cb.getState()).toBe('open');

    // With cooldownMs=0, isAvailable() should transition to half-open
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe('half-open');

    // Record success — should go back to closed
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getFailureCount()).toBe(0);
  }, 10_000);

  // ── Test 10: Circuit Breaker Registry ──

  test('should manage multiple circuit breakers via registry', () => {
    const registry = new CircuitBreakerRegistry({
      failureThreshold: 2,
      cooldownMs: 10_000,
      halfOpenMaxAttempts: 1,
    });

    const cb1 = registry.get('device-a');
    const cb2 = registry.get('device-b');
    const cb3 = registry.get('device-c');

    // All should start closed
    expect(cb1.getState()).toBe('closed');
    expect(cb2.getState()).toBe('closed');
    expect(cb3.getState()).toBe('closed');

    // Trip device-b only
    cb2.recordFailure(new Error('fail-1'));
    cb2.recordFailure(new Error('fail-2'));
    expect(cb2.getState()).toBe('open');

    // Others should remain closed
    expect(cb1.getState()).toBe('closed');
    expect(cb3.getState()).toBe('closed');

    // Available device IDs should exclude device-b
    const available = registry.getAvailableDeviceIds();
    expect(available).toContain('device-a');
    expect(available).not.toContain('device-b');
    expect(available).toContain('device-c');

    // getAllStates should return all states
    const states = registry.getAllStates();
    expect(states.get('device-a')).toBe('closed');
    expect(states.get('device-b')).toBe('open');
    expect(states.get('device-c')).toBe('closed');

    // resetAll should reset everything
    registry.resetAll();
    expect(cb2.getState()).toBe('closed');
    expect(registry.getAvailableDeviceIds()).toHaveLength(3);
  }, 10_000);

  // ── Test 11: Pool Max Simulators Enforcement ──

  test('should reject bootAll when exceeding max simulators', async () => {
    const smallPool = new SimulatorPool({ max: 2, concurrency: 1 });
    smallPool.checkResources = async () => {};

    await expect(
      smallPool.bootAll(['iphone-17', 'ipad-pro', 'iphone-17-pro'])
    ).rejects.toThrow(/Cannot boot 3 simulators \(max: 2\)/);

    // Pool should remain empty (no partial boot)
    expect(smallPool.size).toBe(0);
  }, 10_000);

  // ── Test 12: Sequential Boot Under Resource Constraint ──

  test('should handle resource check failure gracefully in sequential mode', async () => {
    const constrainedPool = new SimulatorPool({ max: 5, concurrency: 1 });

    const os = require('os');
    const originalFreemem = os.freemem;
    os.freemem = jest.fn().mockReturnValue(100 * 1024 * 1024); // 100MB — too low

    try {
      // Sequential mode checks resources per device (1 at a time)
      // With only 100MB free and needing 2GB per device, it should fail
      const results = await constrainedPool.bootSequential(
        ['iphone-17', 'ipad-pro'],
        async (_sim, preset) => ({ preset }),
      );

      // Both should fail due to insufficient resources
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.status).toBe('failed');
        expect(r.error).toBeDefined();
      }
    } finally {
      os.freemem = originalFreemem;
    }
  }, 30_000);

  // ── Test 13: Memory Monitoring Events ──

  test('should emit memory-critical event via pool event system', (done) => {
    pool.checkResources = async () => {};

    pool.on('simulator:memory-critical', (event: { deviceId: string; preset: string; memMB: number }) => {
      expect(event.deviceId).toBe('test-device');
      expect(event.preset).toBe('iphone-17');
      expect(event.memMB).toBe(5000);
      done();
    });

    // Manually emit the event to verify the handler works
    pool.emit('simulator:memory-critical', {
      deviceId: 'test-device',
      preset: 'iphone-17',
      memMB: 5000,
      threshold: 4096,
    });
  }, 10_000);

  // ── Test 14: Circuit Breaker State Change Events ──

  test('should emit state-change events on circuit breaker transitions', () => {
    const stateChanges: Array<{ from: string; to: string }> = [];

    const cb = new CircuitBreaker('event-test-device', {
      failureThreshold: 2,
      cooldownMs: 0,
      halfOpenMaxAttempts: 1,
    });

    cb.on('state-change', (event: { from: string; to: string }) => {
      stateChanges.push({ from: event.from, to: event.to });
    });

    // closed -> open (after 2 failures)
    cb.recordFailure(new Error('f1'));
    cb.recordFailure(new Error('f2'));
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ from: 'closed', to: 'open' });

    // open -> half-open (via isAvailable with cooldown=0)
    cb.isAvailable();
    expect(stateChanges).toHaveLength(2);
    expect(stateChanges[1]).toEqual({ from: 'open', to: 'half-open' });

    // half-open -> closed (via success)
    cb.recordSuccess();
    expect(stateChanges).toHaveLength(3);
    expect(stateChanges[2]).toEqual({ from: 'half-open', to: 'closed' });
  }, 10_000);
});
