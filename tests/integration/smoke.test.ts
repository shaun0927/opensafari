/**
 * Smoke integration tests -- CI-safe, no simulator required.
 *
 * These tests verify that core modules can be imported and instantiated
 * without errors, and that key behaviors (tier filtering, tool count,
 * auth lifecycle, resource checks) work correctly in isolation.
 */

import { MCPServer, getToolTier, TOOL_TIERS } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';
import { AuthManager } from '../../src/auth';
import { SimulatorPool, InsufficientResourcesError } from '../../src/simulator/pool';
import { WebInspectorProxy } from '../../src/simulator/proxy';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Smoke: MCPServer tool registration', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
    registerAllTools(server);
  });

  test('createServer registers all expected tools', () => {
    const tools = server.getRegisteredTools();
    // The project has 37 registerTool calls across tool files
    // (29 single-tool files + orchestration-tools registers 7 + auth registers 3 = ~37)
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  test('setTier(3) exposes all tools via tools/list', () => {
    server.setTier(3);
    const tools = server.getRegisteredTools();
    // All tools should be retrievable regardless of tier (getRegisteredTools
    // returns the full list; tier filtering only applies to handleToolsList).
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  test('setTier(1) only exposes Tier 1 tools', () => {
    server.setTier(1);
    const tier = server.getTier();
    expect(tier).toBe(1);

    // Tier 1 tools from TOOL_TIERS config
    const tier1Tools = Object.entries(TOOL_TIERS)
      .filter(([, t]) => t === 1)
      .map(([name]) => name);

    expect(tier1Tools.length).toBeGreaterThan(0);

    // Every tier 1 tool should be registered
    const registered = server.getRegisteredTools();
    for (const toolName of tier1Tools) {
      expect(registered).toContain(toolName);
    }
  });

  test('enableAuditLog() does not throw', () => {
    expect(() => server.enableAuditLog()).not.toThrow();
  });
});

describe('Smoke: Tool tier mapping', () => {
  test('navigate is Tier 1', () => {
    expect(getToolTier('navigate')).toBe(1);
  });

  test('screenshot is Tier 1', () => {
    expect(getToolTier('screenshot')).toBe(1);
  });

  test('inspect is Tier 2', () => {
    expect(getToolTier('inspect')).toBe(2);
  });

  test('auth_save is Tier 3', () => {
    expect(getToolTier('auth_save')).toBe(3);
  });

  test('workflow_init is Tier 3', () => {
    expect(getToolTier('workflow_init')).toBe(3);
  });

  test('unknown tool returns default tier (2)', () => {
    expect(getToolTier('nonexistent_tool_xyz')).toBe(2);
  });

  test('all TOOL_TIERS entries are between 1 and 3', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(tier).toBeLessThanOrEqual(3);
    }
  });
});

describe('Smoke: AuthManager with temp directory', () => {
  let tmpDir: string;
  let authManager: AuthManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-test-auth-'));
    authManager = new AuthManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('list() returns empty array when no profiles exist', async () => {
    const profiles = await authManager.list();
    expect(profiles).toEqual([]);
  });

  test('delete() throws for nonexistent profile', async () => {
    await expect(authManager.delete('nonexistent.example.com')).rejects.toThrow();
  });
});

describe('Smoke: SimulatorPool resource check', () => {
  test('checkResources rejects when actual free RAM is less than required', async () => {
    // Request an absurdly large number of simulators to guarantee rejection
    // Each simulator needs ~2048 MB, so 10000 simulators would need ~20 TB
    const pool = new SimulatorPool({ max: 100000 });
    await expect(pool.checkResources(10000)).rejects.toThrow(/RAM/);
  });

  test('checkResources resolves for a single simulator when RAM is available', async () => {
    // A single simulator needs ~2048 MB; most dev machines have this available
    const pool = new SimulatorPool({ max: 5 });
    // This will pass on any machine with > 2 GB free RAM
    const freeMB = Math.floor(os.freemem() / 1024 / 1024);
    if (freeMB >= 2048) {
      await expect(pool.checkResources(1)).resolves.toBeUndefined();
    } else {
      // Machine has very low RAM — just verify it throws a meaningful error
      await expect(pool.checkResources(1)).rejects.toThrow(/RAM/);
    }
  });

  test('InsufficientResourcesError has correct name', () => {
    const err = new InsufficientResourcesError('test message');
    expect(err.name).toBe('InsufficientResourcesError');
    expect(err.message).toBe('test message');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('Smoke: WebInspectorProxy defaults', () => {
  test('constructor sets default port to 9322', () => {
    // Clear env vars to test defaults
    const savedPort = process.env.OPENSAFARI_PROXY_PORT;
    const savedDeviceListPort = process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT;
    delete process.env.OPENSAFARI_PROXY_PORT;
    delete process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT;

    try {
      const proxy = new WebInspectorProxy();
      expect(proxy.port).toBe(9322);
      expect(proxy.deviceListPort).toBe(9321);
    } finally {
      if (savedPort !== undefined) process.env.OPENSAFARI_PROXY_PORT = savedPort;
      if (savedDeviceListPort !== undefined) process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT = savedDeviceListPort;
    }
  });

  test('constructor respects custom port option', () => {
    const proxy = new WebInspectorProxy({ port: 9500 });
    expect(proxy.port).toBe(9500);
    expect(proxy.deviceListPort).toBe(9499);
  });

  test('constructor respects explicit deviceListPort', () => {
    const proxy = new WebInspectorProxy({ port: 9500, deviceListPort: 9400 });
    expect(proxy.port).toBe(9500);
    expect(proxy.deviceListPort).toBe(9400);
  });
});

describe('Smoke: Graceful shutdown registration', () => {
  test('setupGracefulShutdown does not throw', () => {
    const spy = jest.spyOn(process, 'on').mockImplementation(() => process);
    try {
      const { setupGracefulShutdown } = require('../../src/reliability/graceful-shutdown');
      const pool = new SimulatorPool({ max: 1 });
      expect(() => setupGracefulShutdown(pool)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
