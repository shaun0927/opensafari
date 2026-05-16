/**
 * Unit tests for ProxyManager — the per-device WebInspectorProxy registry
 * introduced in Phase 2B.1 of issue #408.
 */

// Mock WebInspectorProxy so we can exercise the manager without spawning
// real proxy processes. The mock records the constructor arguments and
// exposes stubs for start/stop.
const mockStart = jest.fn();
const mockStop = jest.fn();
const constructorCalls: Array<{ port: number; [k: string]: unknown }> = [];

jest.mock('../../src/simulator/proxy', () => ({
  WebInspectorProxy: jest.fn().mockImplementation(function (this: any, options: any) {
    constructorCalls.push(options);
    this.port = options.port;
    this.pid = 12345;
    this.running = false;
    this.start = async (_startOptions?: { targetUdid?: string }) => {
      await mockStart(_startOptions);
      this.running = true;
    };
    this.stop = async () => {
      this.running = false;
      mockStop();
    };
  }),
}));

import {
  allocatePort,
  getProxyForDevice,
  peekProxyForDevice,
  stopProxyForDevice,
  stopAll,
  listManagedProxies,
  resetProxyManagerState,
} from '../../src/simulator/proxy-manager';

const UDID_A = 'AAAAAAAA-0000-0000-0000-000000000001';
const UDID_B = 'BBBBBBBB-0000-0000-0000-000000000002';

describe('ProxyManager', () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockStop.mockReset();
    constructorCalls.length = 0;
    resetProxyManagerState();
    delete process.env.OPENSAFARI_PROXY_PORT_BASE;
    delete process.env.OPENSAFARI_PROXY_PORT_RANGE;
  });

  describe('allocatePort', () => {
    test('same UDID hashes to the same port', () => {
      const p1 = allocatePort(UDID_A);
      resetProxyManagerState();
      const p2 = allocatePort(UDID_A);
      expect(p1).toBe(p2);
    });

    test('different UDIDs get different ports in most cases', () => {
      const p1 = allocatePort(UDID_A);
      const p2 = allocatePort(UDID_B);
      expect(p1).not.toBe(p2);
    });

    test('second allocation for a reserved port falls back linearly', () => {
      // Small range so we can force a collision cheaply
      process.env.OPENSAFARI_PROXY_PORT_BASE = '9500';
      process.env.OPENSAFARI_PROXY_PORT_RANGE = '10';

      const p1 = allocatePort('deviceA');
      const p2 = allocatePort('deviceB');
      const p3 = allocatePort('deviceC');

      // All three fall within the range and are unique
      const ports = [p1, p2, p3];
      const unique = new Set(ports);
      expect(unique.size).toBe(3);
      for (const p of ports) {
        expect(p).toBeGreaterThanOrEqual(9500);
        expect(p).toBeLessThan(9510);
      }
    });

    test('throws when the range is exhausted', () => {
      process.env.OPENSAFARI_PROXY_PORT_BASE = '9600';
      process.env.OPENSAFARI_PROXY_PORT_RANGE = '1';

      // Range of 1 — exactly one slot for the entire host.
      allocatePort('d1');
      expect(() => allocatePort('d2')).toThrow(/no free port/);
    });
  });

  describe('getProxyForDevice', () => {
    test('creates a new proxy on first call', async () => {
      const proxy = await getProxyForDevice(UDID_A);

      expect(proxy).toBeDefined();
      expect(proxy.running).toBe(true);
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].port).toBeGreaterThan(0);
      expect(mockStart).toHaveBeenCalledWith({ targetUdid: UDID_A });
    });

    test('returns the same instance on subsequent calls for the same device', async () => {
      const first = await getProxyForDevice(UDID_A);
      const second = await getProxyForDevice(UDID_A);

      expect(first).toBe(second);
      expect(constructorCalls).toHaveLength(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    test('creates separate proxies per device with different ports', async () => {
      const a = await getProxyForDevice(UDID_A);
      const b = await getProxyForDevice(UDID_B);

      expect(a).not.toBe(b);
      expect(a.port).not.toBe(b.port);
      expect(constructorCalls).toHaveLength(2);
    });


    test('coalesces concurrent starts for the same device', async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      mockStart.mockImplementationOnce(async () => {
        await startGate;
      });

      const firstPromise = getProxyForDevice(UDID_A);
      const secondPromise = getProxyForDevice(UDID_A);

      // Let both calls reach the pending-start path before unblocking start().
      await Promise.resolve();
      releaseStart();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first).toBe(second);
      expect(constructorCalls).toHaveLength(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(listManagedProxies()).toHaveLength(1);
    });

    test('clears failed pending starts so a concurrent retry can create a fresh proxy', async () => {
      mockStart.mockImplementationOnce(async () => {
        throw new Error('proxy spawn failed');
      });

      await expect(Promise.all([
        getProxyForDevice(UDID_A),
        getProxyForDevice(UDID_A),
      ])).rejects.toThrow('proxy spawn failed');

      expect(peekProxyForDevice(UDID_A)).toBeNull();
      const retry = await getProxyForDevice(UDID_A);

      expect(retry).toBeDefined();
      expect(constructorCalls).toHaveLength(2);
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(listManagedProxies()).toHaveLength(1);
    });

    test('releases the reserved port when start() throws', async () => {
      // Force start() to fail for this one call
      mockStart.mockImplementationOnce(() => {
        throw new Error('proxy spawn failed');
      });

      await expect(getProxyForDevice(UDID_A)).rejects.toThrow('proxy spawn failed');

      // The failed proxy should not be tracked
      expect(peekProxyForDevice(UDID_A)).toBeNull();
      // And the port should be free for a retry
      const retry = await getProxyForDevice(UDID_A);
      expect(retry).toBeDefined();
    });
  });

  describe('stopProxyForDevice', () => {

    test('waits for an in-flight start before stopping the target device', async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      mockStart.mockImplementationOnce(async () => {
        await startGate;
      });

      const starting = getProxyForDevice(UDID_A);
      await Promise.resolve();

      const stopping = stopProxyForDevice(UDID_A);
      releaseStart();

      await Promise.all([starting, stopping]);

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(peekProxyForDevice(UDID_A)).toBeNull();
      expect(listManagedProxies()).toHaveLength(0);
    });

    test('stops only the target device proxy', async () => {
      await getProxyForDevice(UDID_A);
      await getProxyForDevice(UDID_B);

      await stopProxyForDevice(UDID_A);

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(peekProxyForDevice(UDID_A)).toBeNull();
      expect(peekProxyForDevice(UDID_B)).not.toBeNull();
    });

    test('is a no-op for a device with no proxy', async () => {
      await stopProxyForDevice('unknown-device');
      expect(mockStop).not.toHaveBeenCalled();
    });

    test('stopping then re-creating allocates a fresh proxy', async () => {
      await getProxyForDevice(UDID_A);
      await stopProxyForDevice(UDID_A);
      const again = await getProxyForDevice(UDID_A);
      expect(again).toBeDefined();
      expect(mockStart).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopAll', () => {

    test('includes in-flight starts when stopping all proxies', async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      mockStart.mockImplementationOnce(async () => {
        await startGate;
      });

      const starting = getProxyForDevice(UDID_A);
      await Promise.resolve();

      const stoppingAll = stopAll();
      releaseStart();

      await Promise.all([starting, stoppingAll]);

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(listManagedProxies()).toHaveLength(0);
    });

    test('stops every managed proxy', async () => {
      await getProxyForDevice(UDID_A);
      await getProxyForDevice(UDID_B);

      await stopAll();

      expect(mockStop).toHaveBeenCalledTimes(2);
      expect(listManagedProxies()).toHaveLength(0);
    });
  });

  describe('listManagedProxies', () => {
    test('returns entries with deviceId and port', async () => {
      await getProxyForDevice(UDID_A);
      await getProxyForDevice(UDID_B);

      const list = listManagedProxies();

      expect(list).toHaveLength(2);
      expect(list.map((l) => l.deviceId).sort()).toEqual([UDID_A, UDID_B].sort());
      for (const entry of list) {
        expect(entry.port).toBeGreaterThan(0);
      }
    });
  });
});
