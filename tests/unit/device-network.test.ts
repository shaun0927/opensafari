/**
 * Unit tests for device_network_set / device_network_get (issue #640).
 *
 * PR 3 wires the tool layer to a real pfctl blocker via the bundle DI seam.
 * All host side-effects are stubbed: tests inject a mock blocker bundle so
 * the handler calls `apply`/`revert` on predictable mocks.
 */

let bootedFixture: Array<{ udid: string; state: string }> = [
  { udid: 'booted-device-id', state: 'Booted' },
];

jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    listBooted: jest.fn().mockImplementation(() => Promise.resolve(bootedFixture)),
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => null,
  }),
}));

import { MCPServer } from '../../src/mcp-server';
import {
  AutoBlocker,
  HostExec,
  NetworkBlocker,
  NetworkBlockerStatus,
  NlcBlocker,
  NodeCleanupRegistry,
  PfctlBlocker,
  TempFileWriter,
} from '../../src/simulator/network-blockers';
import {
  HostBlockerBundle,
  __resetDeviceNetworkStateForTests,
  __setHostBlockerForTests,
  reconcileHostBlockers,
  registerDeviceNetworkGetTool,
  registerDeviceNetworkSetTool,
  registerDeviceNetworkTools,
} from '../../src/tools/device-network';

type ToolHandler = (
  s: string,
  p: Record<string, unknown>,
) => Promise<{
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

interface MockBlocker extends NetworkBlocker {
  isAvailable: jest.Mock<Promise<boolean>, []>;
  apply: jest.Mock<Promise<void>, [string]>;
  revert: jest.Mock<Promise<void>, [string]>;
  status: jest.Mock<Promise<NetworkBlockerStatus>, []>;
}

function makeMockBlocker(kind: 'pfctl' | 'nlc'): MockBlocker {
  return {
    kind,
    isAvailable: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    apply: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    revert: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    status: jest
      .fn<Promise<NetworkBlockerStatus>, []>()
      .mockResolvedValue({ active: false, activeSince: null, detail: null }),
  };
}

function makeMockBundle(): {
  bundle: HostBlockerBundle;
  pfctl: MockBlocker;
  nlc: MockBlocker;
  auto: MockBlocker;
} {
  const pfctl = makeMockBlocker('pfctl');
  const nlc = makeMockBlocker('nlc');
  // auto delegates to pfctl for test determinism; its kind is 'pfctl' so
  // `resolvedMechanismFor` surfaces 'pfctl' for auto-routed callers too.
  const auto = makeMockBlocker('pfctl');
  return { bundle: { pfctl, nlc, auto }, pfctl, nlc, auto };
}

beforeEach(() => {
  __resetDeviceNetworkStateForTests();
  bootedFixture = [{ udid: 'booted-device-id', state: 'Booted' }];
});

afterEach(() => {
  __setHostBlockerForTests(null);
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

describe('device_network_set handler — validation', () => {
  let setHandler: ToolHandler;

  beforeEach(() => {
    const server = makeServer();
    const { bundle } = makeMockBundle();
    __setHostBlockerForTests(bundle);
    registerDeviceNetworkTools(server as unknown as MCPServer);
    setHandler = extractHandler(server, 'device_network_set');
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
});

describe('device_network_set handler — online path', () => {
  let setHandler: ToolHandler;
  let getHandler: ToolHandler;
  let pfctl: MockBlocker;

  beforeEach(() => {
    const server = makeServer();
    const { bundle, pfctl: p } = makeMockBundle();
    pfctl = p;
    __setHostBlockerForTests(bundle);
    registerDeviceNetworkTools(server as unknown as MCPServer);
    setHandler = extractHandler(server, 'device_network_set');
    getHandler = extractHandler(server, 'device_network_get');
  });

  it('online when already online is an idempotent no-op (no blocker calls)', async () => {
    const first = await setHandler('s', { mode: 'online' });
    expect(first.isError).toBeUndefined();
    const firstBody = JSON.parse(first.content[0].text);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.mode).toBe('online');
    expect(firstBody.previousMode).toBe('online');
    expect(firstBody.note).toMatch(/already online/);
    expect(pfctl.revert).not.toHaveBeenCalled();

    const second = await setHandler('s', { mode: 'online' });
    const secondBody = JSON.parse(second.content[0].text);
    expect(secondBody.note).toMatch(/already online/);
  });

  it('resolves a booted device when udid is omitted', async () => {
    const result = await setHandler('s', { mode: 'online' });
    const body = JSON.parse(result.content[0].text);
    expect(body.deviceId).toBe('booted-device-id');
  });

  it('honors explicit udid when the device is booted', async () => {
    bootedFixture = [
      { udid: 'booted-device-id', state: 'Booted' },
      { udid: 'explicit-udid', state: 'Booted' },
    ];
    const result = await setHandler('s', { mode: 'online', udid: 'explicit-udid' });
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe('explicit-udid');
  });

  it('rejects explicit udid when it is not currently booted (typo / shutdown guard)', async () => {
    const result = await setHandler('s', { mode: 'online', udid: 'not-booted' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('udid_not_booted');
    expect(body.requestedUdid).toBe('not-booted');
    expect(body.bootedUdids).toEqual(['booted-device-id']);
  });

  it('rejects defaulting to an arbitrary simulator when multiple are booted (ambiguous_device)', async () => {
    bootedFixture = [
      { udid: 'booted-a', state: 'Booted' },
      { udid: 'booted-b', state: 'Booted' },
    ];
    const result = await setHandler('s', { mode: 'online' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('ambiguous_device');
    expect(body.bootedUdids).toEqual(expect.arrayContaining(['booted-a', 'booted-b']));
  });

  it('reports no_booted_device when nothing is booted and no udid is passed', async () => {
    bootedFixture = [];
    const result = await setHandler('s', { mode: 'online' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_booted_device');
  });

  it('device_network_get reports online by default', async () => {
    const result = await getHandler('s', {});
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('online');
    expect(body.mechanism).toBeNull();
    expect(body.activeSince).toBeNull();
  });
});

describe('device_network_set handler — offline path (pfctl wired)', () => {
  let setHandler: ToolHandler;
  let getHandler: ToolHandler;
  let pfctl: MockBlocker;
  let nlc: MockBlocker;
  let auto: MockBlocker;

  beforeEach(() => {
    const server = makeServer();
    const bundle = makeMockBundle();
    pfctl = bundle.pfctl;
    nlc = bundle.nlc;
    auto = bundle.auto;
    __setHostBlockerForTests(bundle.bundle);
    registerDeviceNetworkTools(server as unknown as MCPServer);
    setHandler = extractHandler(server, 'device_network_set');
    getHandler = extractHandler(server, 'device_network_get');
  });

  it('offline calls AutoBlocker.apply and records state with resolved mechanism', async () => {
    const result = await setHandler('s', { mode: 'offline', udid: 'device-a' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('offline');
    expect(body.mechanism).toBe('pfctl');
    expect(body.appliedAt).toEqual(expect.any(String));
    expect(auto.apply).toHaveBeenCalledWith('device-a');
    expect(pfctl.apply).not.toHaveBeenCalled();
    expect(nlc.apply).not.toHaveBeenCalled();

    const getResult = await getHandler('s', { udid: 'device-a' });
    const getBody = JSON.parse(getResult.content[0].text);
    expect(getBody.mode).toBe('offline');
    expect(getBody.mechanism).toBe('pfctl');
  });

  it('airplane routes through the same apply code path as offline', async () => {
    const result = await setHandler('s', { mode: 'airplane', udid: 'device-b' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.mode).toBe('airplane');
    expect(body.mechanism).toBe('pfctl');
    expect(auto.apply).toHaveBeenCalledWith('device-b');
  });

  it('mechanism: "pfctl" routes directly to the pfctl backend', async () => {
    const result = await setHandler('s', {
      mode: 'offline',
      mechanism: 'pfctl',
      udid: 'device-c',
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.mechanism).toBe('pfctl');
    expect(pfctl.apply).toHaveBeenCalledWith('device-c');
    expect(auto.apply).not.toHaveBeenCalled();
  });

  it('propagates blocker apply() failure as an isError response', async () => {
    const err = new Error('sudo pfctl failed');
    err.name = 'PfctlCommandError';
    auto.apply.mockRejectedValueOnce(err);

    const result = await setHandler('s', { mode: 'offline', udid: 'device-d' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('PfctlCommandError');
    expect(body.message).toMatch(/sudo pfctl failed/);

    // state must NOT be recorded when apply fails
    const getResult = await getHandler('s', { udid: 'device-d' });
    const getBody = JSON.parse(getResult.content[0].text);
    expect(getBody.mode).toBe('online');
  });

  it('rejects a mechanism switch when another backend is already active (mechanism_conflict)', async () => {
    await setHandler('s', { mode: 'offline', mechanism: 'pfctl', udid: 'device-a' });
    const conflict = await setHandler('s', { mode: 'offline', mechanism: 'nlc', udid: 'device-b' });
    expect(conflict.isError).toBe(true);
    const body = JSON.parse(conflict.content[0].text);
    expect(body.error).toBe('mechanism_conflict');
    expect(body.activeMechanism).toBe('pfctl');
    expect(body.requestedMechanism).toBe('nlc');
    expect(nlc.apply).not.toHaveBeenCalled();
  });
});

describe('device_network_set handler — reference-counting revert', () => {
  let setHandler: ToolHandler;
  let getHandler: ToolHandler;
  let auto: MockBlocker;

  beforeEach(() => {
    const server = makeServer();
    const bundle = makeMockBundle();
    auto = bundle.auto;
    __setHostBlockerForTests(bundle.bundle);
    registerDeviceNetworkTools(server as unknown as MCPServer);
    setHandler = extractHandler(server, 'device_network_set');
    getHandler = extractHandler(server, 'device_network_get');
  });

  it('does not revert when one of several offline devices returns online', async () => {
    await setHandler('s', { mode: 'offline', udid: 'device-a' });
    await setHandler('s', { mode: 'offline', udid: 'device-b' });
    expect(auto.apply).toHaveBeenCalledTimes(2);
    await setHandler('s', { mode: 'online', udid: 'device-a' });
    expect(auto.revert).not.toHaveBeenCalled();
  });

  it('reverts when the last offline device returns online', async () => {
    await setHandler('s', { mode: 'offline', udid: 'device-a' });
    await setHandler('s', { mode: 'offline', udid: 'device-b' });
    await setHandler('s', { mode: 'online', udid: 'device-a' });
    await setHandler('s', { mode: 'online', udid: 'device-b' });
    expect(auto.revert).toHaveBeenCalledTimes(1);
    expect(auto.revert).toHaveBeenCalledWith('device-b');
  });

  it('rolls back state and surfaces error when revert fails', async () => {
    await setHandler('s', { mode: 'offline', udid: 'device-a' });

    const err = new Error('pfctl revert failed');
    err.name = 'PfctlCommandError';
    auto.revert.mockRejectedValueOnce(err);

    const result = await setHandler('s', { mode: 'online', udid: 'device-a' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('PfctlCommandError');
  });

  it('device_network_get rejects explicit udid that is not booted', async () => {
    const result = await getHandler('s', { udid: 'ghost' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('udid_not_booted');
    expect(body.requestedUdid).toBe('ghost');
  });
});

describe('device_network_set — startup reconciliation (PR 4)', () => {
  function makeBundleWithRealPfctl(): {
    bundle: HostBlockerBundle;
    pfctlExec: jest.Mocked<HostExec>;
    pfctl: PfctlBlocker;
  } {
    const pfctlExec: jest.Mocked<HostExec> = { run: jest.fn().mockResolvedValue('') };
    const tempFile: TempFileWriter = {
      write: jest.fn().mockResolvedValue('/tmp/opensafari-pfctl-x/rules.conf'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const cleanup = new NodeCleanupRegistry();
    cleanup.disableForTests();
    const pfctl = new PfctlBlocker({
      exec: pfctlExec,
      tempFile,
      assumeAvailable: true,
      cleanup,
    });
    const nlc = new NlcBlocker({ exec: pfctlExec, assumeAvailable: false });
    const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
    return { bundle: { pfctl, nlc, auto }, pfctlExec, pfctl };
  }

  it('runs reconciliation exactly once across multiple tool calls', async () => {
    const { bundle, pfctlExec } = makeBundleWithRealPfctl();
    __setHostBlockerForTests(bundle);

    const server = makeServer();
    registerDeviceNetworkTools(server as unknown as MCPServer);
    const setHandler = extractHandler(server, 'device_network_set');

    // First call: reconciliation runs. The empty anchor probe returns '',
    // so no flush is attempted — just a single `pfctl -a <anchor> -sr`
    // sniffing call.
    pfctlExec.run.mockResolvedValueOnce(''); // reconcile probe
    pfctlExec.run.mockResolvedValueOnce(''); // online set: no blocker call
    await setHandler('s', { mode: 'online', udid: 'device-a' });
    const firstCallCount = pfctlExec.run.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // Second call: reconciliation must NOT run again.
    await setHandler('s', { mode: 'online', udid: 'device-a' });
    expect(pfctlExec.run.mock.calls.length).toBe(firstCallCount);
  });

  it('reconcileHostBlockers flushes a stale anchor found on startup', async () => {
    const { bundle, pfctlExec } = makeBundleWithRealPfctl();
    pfctlExec.run
      .mockResolvedValueOnce('block drop out on ! lo0 all\n') // probe
      .mockResolvedValueOnce(''); // flush
    const result = await reconcileHostBlockers(bundle);
    expect(result.pfctl).toMatchObject({ reconciled: true, rulesFound: 1 });
    expect(pfctlExec.run).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.arrayContaining(['-F', 'all']),
      expect.anything(),
    );
  });

  it('reconcileHostBlockers swallows pfctl errors rather than blocking startup', async () => {
    const { bundle, pfctlExec } = makeBundleWithRealPfctl();
    pfctlExec.run
      .mockResolvedValueOnce('block drop out on ! lo0 all\n')
      .mockRejectedValueOnce(
        Object.assign(new Error('pfctl: not root'), { stderr: 'err', code: 1 }),
      );
    // Should resolve (swallowed), not throw, even though the flush failed.
    await expect(reconcileHostBlockers(bundle)).resolves.toBeDefined();
  });
});
