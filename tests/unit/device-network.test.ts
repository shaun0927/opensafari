/**
 * Unit tests for device_network_set / device_network_get (issue #640, PR 1 scaffold).
 *
 * The scaffold intentionally returns `not_implemented` for offline/airplane so that
 * CI surfaces the missing backend; online + get must still behave correctly.
 */

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockResolvedValue([{ udid: 'booted-device-id', state: 'Booted' }]),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => null,
  }),
}));

import { MCPServer } from '../../src/mcp-server';
import {
  registerDeviceNetworkSetTool,
  registerDeviceNetworkGetTool,
  registerDeviceNetworkTools,
  __resetDeviceNetworkStateForTests,
} from '../../src/tools/device-network';

type ToolHandler = (s: string, p: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeServer() {
  return { registerTool: jest.fn() };
}

function extractHandler(server: { registerTool: jest.Mock }, name: string): ToolHandler {
  const call = server.registerTool.mock.calls.find(([def]) => def.name === name);
  if (!call) throw new Error(`Tool ${name} was not registered`);
  return call[1] as ToolHandler;
}

beforeEach(() => {
  __resetDeviceNetworkStateForTests();
});

describe('device_network registration', () => {
  it('registerDeviceNetworkTools registers both tools', () => {
    const server = makeServer();
    registerDeviceNetworkTools(server as unknown as MCPServer);
    const names = server.registerTool.mock.calls.map(([def]) => def.name);
    expect(names).toEqual(expect.arrayContaining(['device_network_set', 'device_network_get']));
  });

  it('device_network_set schema requires mode and accepts known modes/mechanisms', () => {
    const server = makeServer();
    registerDeviceNetworkSetTool(server as unknown as MCPServer);
    const [def] = server.registerTool.mock.calls[0];
    expect(def.name).toBe('device_network_set');
    expect(def.inputSchema.required).toEqual(['mode']);
    expect(def.inputSchema.properties.mode.enum).toEqual(['online', 'offline', 'airplane']);
    expect(def.inputSchema.properties.mechanism.enum).toEqual(['pfctl', 'nlc', 'auto']);
    expect(def.inputSchema.properties.udid.type).toBe('string');
  });

  it('device_network_get schema has no required fields', () => {
    const server = makeServer();
    registerDeviceNetworkGetTool(server as unknown as MCPServer);
    const [def] = server.registerTool.mock.calls[0];
    expect(def.name).toBe('device_network_get');
    expect(def.inputSchema.required).toEqual([]);
  });
});

describe('device_network_set handler (scaffold)', () => {
  let setHandler: ToolHandler;
  let getHandler: ToolHandler;

  beforeEach(() => {
    const server = makeServer();
    registerDeviceNetworkTools(server as unknown as MCPServer);
    setHandler = extractHandler(server, 'device_network_set');
    getHandler = extractHandler(server, 'device_network_get');
  });

  it('rejects invalid mode', async () => {
    const result = await setHandler('s', { mode: 'bogus' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('invalid_mode');
    expect(body.allowed).toEqual(['online', 'offline', 'airplane']);
  });

  it('rejects invalid mechanism', async () => {
    const result = await setHandler('s', { mode: 'online', mechanism: 'tc' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('invalid_mechanism');
  });

  it('returns not_implemented for offline (scaffold build)', async () => {
    const result = await setHandler('s', { mode: 'offline' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_implemented');
    expect(body.requestedMode).toBe('offline');
    expect(body.requestedMechanism).toBe('auto');
    expect(body.message).toMatch(/#640/);
  });

  it('returns not_implemented for airplane (scaffold build)', async () => {
    const result = await setHandler('s', { mode: 'airplane', mechanism: 'pfctl' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_implemented');
    expect(body.requestedMode).toBe('airplane');
    expect(body.requestedMechanism).toBe('pfctl');
  });

  it('accepts online as an idempotent no-op and records state', async () => {
    const first = await setHandler('s', { mode: 'online' });
    expect(first.isError).toBeUndefined();
    const firstBody = JSON.parse(first.content[0].text);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.mode).toBe('online');
    expect(firstBody.mechanism).toBeNull();
    expect(firstBody.previousMode).toBe('online');

    const second = await setHandler('s', { mode: 'online' });
    const secondBody = JSON.parse(second.content[0].text);
    expect(secondBody.ok).toBe(true);
    expect(secondBody.note).toMatch(/already online/);
  });

  it('resolves a booted device when udid is omitted', async () => {
    const result = await setHandler('s', { mode: 'online' });
    const body = JSON.parse(result.content[0].text);
    expect(body.deviceId).toBe('booted-device-id');
  });

  it('honors explicit udid over booted lookup', async () => {
    const result = await setHandler('s', { mode: 'online', udid: 'explicit-udid' });
    const body = JSON.parse(result.content[0].text);
    expect(body.deviceId).toBe('explicit-udid');
  });

  it('device_network_get reports online by default', async () => {
    const result = await getHandler('s', {});
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('online');
    expect(body.mechanism).toBeNull();
    expect(body.activeSince).toBeNull();
  });

  it('device_network_get reports state set by device_network_set(online)', async () => {
    await setHandler('s', { mode: 'online', udid: 'device-a' });
    const result = await getHandler('s', { udid: 'device-a' });
    const body = JSON.parse(result.content[0].text);
    expect(body.mode).toBe('online');
    expect(body.deviceId).toBe('device-a');
  });
});
