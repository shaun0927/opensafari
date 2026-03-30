/**
 * Multi-device integration tests -- no simulator required.
 *
 * Tests instantiation and basic API surface of:
 * - SimulatorPool
 * - BatchExecutor
 * - SimulatorWorkflowEngine
 * - CrossViewportCapture
 *
 * All tests use mocked dependencies to avoid requiring a real simulator.
 */

import { SimulatorPool, InsufficientResourcesError } from '../../src/simulator/pool';
import { BatchExecutor } from '../../src/simulator/batch';
import { SimulatorWorkflowEngine } from '../../src/orchestration/workflow-engine';
import { CrossViewportCapture } from '../../src/comparison/cross-viewport';
import { AuthManager } from '../../src/auth';
import * as os from 'os';

describe('Multi-device: SimulatorPool instantiation', () => {
  test('SimulatorPool can be instantiated with default options', () => {
    const pool = new SimulatorPool();
    expect(pool).toBeInstanceOf(SimulatorPool);
    expect(pool.size).toBe(0);
  });

  test('SimulatorPool can be instantiated with custom options', () => {
    const pool = new SimulatorPool({ max: 3, concurrency: 2, webkitBasePort: 9400 });
    expect(pool).toBeInstanceOf(SimulatorPool);
    expect(pool.size).toBe(0);
  });

  test('getAll() returns empty array initially', () => {
    const pool = new SimulatorPool();
    expect(pool.getAll()).toEqual([]);
  });

  test('get() returns null for unknown device', () => {
    const pool = new SimulatorPool();
    expect(pool.get('nonexistent-udid')).toBeNull();
  });

  test('getByPreset() returns null when no devices booted', () => {
    const pool = new SimulatorPool();
    expect(pool.getByPreset('iphone-15-pro')).toBeNull();
  });
});

describe('Multi-device: Resource check', () => {
  test('rejects when requesting absurd number of simulators', async () => {
    // 10000 simulators * 2048 MB each = ~20 TB, guaranteed to exceed any machine
    const pool = new SimulatorPool({ max: 100000 });
    await expect(pool.checkResources(10000)).rejects.toThrow(InsufficientResourcesError);
  });

  test('error message includes RAM and count details', async () => {
    const pool = new SimulatorPool({ max: 100000 });
    try {
      await pool.checkResources(10000);
      throw new Error('Expected checkResources to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientResourcesError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/RAM/);
      expect(msg).toMatch(/10000/);
    }
  });

  test('resolves for single simulator on a dev machine', async () => {
    const pool = new SimulatorPool({ max: 5 });
    const freeMB = Math.floor(os.freemem() / 1024 / 1024);
    if (freeMB >= 2048) {
      await expect(pool.checkResources(1)).resolves.toBeUndefined();
    } else {
      // Low-RAM environment: verify it rejects with a meaningful message
      await expect(pool.checkResources(1)).rejects.toThrow(/RAM/);
    }
  });

  test('InsufficientResourcesError is instanceof Error', () => {
    const err = new InsufficientResourcesError('not enough');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InsufficientResourcesError);
    expect(err.name).toBe('InsufficientResourcesError');
  });
});

describe('Multi-device: BatchExecutor instantiation', () => {
  test('BatchExecutor can be instantiated with a SimulatorPool', () => {
    const pool = new SimulatorPool();
    const batch = new BatchExecutor(pool);
    expect(batch).toBeInstanceOf(BatchExecutor);
  });
});

describe('Multi-device: SimulatorWorkflowEngine instantiation', () => {
  test('SimulatorWorkflowEngine can be instantiated', () => {
    const pool = new SimulatorPool();
    const authManager = new AuthManager();
    const engine = new SimulatorWorkflowEngine(pool, authManager);
    expect(engine).toBeInstanceOf(SimulatorWorkflowEngine);
  });

  test('getStatus throws for unknown workflow', () => {
    const pool = new SimulatorPool();
    const authManager = new AuthManager();
    const engine = new SimulatorWorkflowEngine(pool, authManager);

    expect(() => engine.getStatus('nonexistent')).toThrow(/Workflow not found/);
  });

  test('collectResults throws for unknown workflow', () => {
    const pool = new SimulatorPool();
    const authManager = new AuthManager();
    const engine = new SimulatorWorkflowEngine(pool, authManager);

    expect(() => engine.collectResults('nonexistent')).toThrow(/Workflow not found/);
  });
});

describe('Multi-device: CrossViewportCapture instantiation', () => {
  test('CrossViewportCapture can be instantiated', () => {
    const pool = new SimulatorPool();
    const batch = new BatchExecutor(pool);
    const capture = new CrossViewportCapture(pool, batch);
    expect(capture).toBeInstanceOf(CrossViewportCapture);
  });
});
