/**
 * Edge case integration tests -- no simulator required.
 *
 * Tests error handling and boundary conditions:
 * - WebKitClient connection to unreachable host
 * - SimulatorPool with max:0
 * - AuthManager restore of nonexistent profile
 * - Tool tier for unknown tool
 * - SimulatorPool idle/resource monitor start/stop
 */

import { WebKitClient } from '../../src/webkit/client';
import { SimulatorPool } from '../../src/simulator/pool';
import { AuthManager } from '../../src/auth';
import { getToolTier } from '../../src/config/tool-tiers';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Edge cases: WebKitClient connection errors', () => {
  test('connect to localhost on unused port rejects', async () => {
    const client = new WebKitClient({
      host: 'localhost',
      port: 19998, // unlikely to be in use
      connectTimeout: 5000,
    });

    await expect(client.connect()).rejects.toThrow();
  }, 15_000);

  test('connect to 127.0.0.1 on unused port rejects', async () => {
    const client = new WebKitClient({
      host: '127.0.0.1',
      port: 19997,
      connectTimeout: 5000,
    });

    await expect(client.connect()).rejects.toThrow();
  }, 15_000);
});

describe('Edge cases: SimulatorPool with max:0', () => {
  test('bootAll with presets exceeding max rejects', async () => {
    const pool = new SimulatorPool({ max: 0 });

    await expect(pool.bootAll(['iphone-15-pro'])).rejects.toThrow(
      /Cannot boot 1 simulators/
    );
  });
});

describe('Edge cases: AuthManager restore nonexistent profile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-edge-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('loadProfile for nonexistent site throws ENOENT', async () => {
    const authManager = new AuthManager(tmpDir);
    await expect(authManager.loadProfile('nonexistent.example.com')).rejects.toThrow();
  });

  test('restore for nonexistent site throws', async () => {
    const authManager = new AuthManager(tmpDir);
    // Create a minimal mock client
    const mockClient = {
      navigate: async () => ({ url: '', status: 200 }),
      setCookies: async () => {},
      evaluate: async () => {},
    } as any;

    await expect(
      authManager.restore('nonexistent.example.com', mockClient)
    ).rejects.toThrow();
  });

  test('checkExpiry for nonexistent site throws', async () => {
    const authManager = new AuthManager(tmpDir);
    await expect(authManager.checkExpiry('nonexistent.example.com')).rejects.toThrow();
  });

  test('delete for nonexistent site throws', async () => {
    const authManager = new AuthManager(tmpDir);
    await expect(authManager.delete('nonexistent.example.com')).rejects.toThrow();
  });
});

describe('Edge cases: Tool tier defaults', () => {
  test('unknown tool returns default tier 2', () => {
    expect(getToolTier('completely_unknown_tool')).toBe(2);
  });

  test('empty string tool returns default tier 2', () => {
    expect(getToolTier('')).toBe(2);
  });

  test('known tools return expected tiers', () => {
    expect(getToolTier('navigate')).toBe(1);
    expect(getToolTier('inspect')).toBe(2);
    expect(getToolTier('auth_save')).toBe(3);
  });
});

describe('Edge cases: SimulatorPool monitor lifecycle', () => {
  let pool: SimulatorPool;

  beforeEach(() => {
    pool = new SimulatorPool({ max: 5 });
  });

  afterEach(() => {
    pool.stopIdleMonitor();
    pool.stopResourceMonitor();
  });

  test('startIdleMonitor / stopIdleMonitor lifecycle', () => {
    expect(() => pool.startIdleMonitor()).not.toThrow();
    expect(() => pool.stopIdleMonitor()).not.toThrow();
  });

  test('startResourceMonitor / stopResourceMonitor lifecycle', () => {
    expect(() => pool.startResourceMonitor()).not.toThrow();
    expect(() => pool.stopResourceMonitor()).not.toThrow();
  });

  test('double startIdleMonitor is idempotent', () => {
    pool.startIdleMonitor();
    expect(() => pool.startIdleMonitor()).not.toThrow();
    pool.stopIdleMonitor();
  });

  test('stopIdleMonitor without start is safe', () => {
    expect(() => pool.stopIdleMonitor()).not.toThrow();
  });

  test('shutdownAll on empty pool resolves', async () => {
    await expect(pool.shutdownAll()).resolves.toBeUndefined();
  });

  test('shutdownOne on unknown device resolves', async () => {
    await expect(pool.shutdownOne('nonexistent-udid')).resolves.toBeUndefined();
  });
});
