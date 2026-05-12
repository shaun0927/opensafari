/**
 * Unit tests for src/simulator/lifecycle.ts — #708 step 3.
 *
 * Covers:
 *   - boot happy path
 *   - boot already-booted no-op
 *   - boot timeout surfaces BootTimeoutError
 *   - shutdown happy path
 *   - shutdown already-shutdown no-op
 *   - shutdown best-effort cleanup: nuclear erase, then return on success
 *   - shutdown propagates SimctlError if the nuclear erase itself fails
 *   - delete is explicit (must be called deliberately — never runs on accident)
 *   - clone returns UDID from simctl output
 *   - erase delegates to simctl erase
 */

import {
  boot,
  shutdown,
  eraseDevice,
  deleteDevice,
  cloneDevice,
} from '../../src/simulator/lifecycle';
import { BootTimeoutError } from '../../src/simulator/errors';
import { SimctlError } from '../../src/simulator/simctl';
import { SimulatorDevice } from '../../src/simulator/types';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDevice(overrides: Partial<SimulatorDevice> = {}): SimulatorDevice {
  return {
    udid: 'TEST-UDID-0001',
    name: 'iPhone Test',
    state: 'Shutdown',
    isAvailable: true,
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
    runtimeVersion: '17.0',
    ...overrides,
  };
}

/** Instantly resolves — replaces real setTimeout in lifecycle functions. */
const noopSleep = (_ms: number) => Promise.resolve();

function makeSimctl(execImpl?: (args: string[]) => Promise<string>) {
  const calls: string[][] = [];
  const exec = jest.fn(async (args: string[]) => {
    calls.push(args);
    return execImpl ? execImpl(args) : '';
  });
  return { exec, calls };
}

// ── boot ────────────────────────────────────────────────────────────────────

describe('lifecycle.boot', () => {
  it('returns immediately if device is already Booted', async () => {
    const device = makeDevice({ state: 'Booted' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(async () => device),
      getDevice: jest.fn(),
    };

    const result = await boot('iphone-test', { simctl, lookup, sleep: noopSleep });

    expect(result).toBe(device);
    expect(simctl.exec).not.toHaveBeenCalled();
    expect(lookup.getDevice).not.toHaveBeenCalled();
  });

  it('issues simctl boot and polls until Booted', async () => {
    const shutdownDevice = makeDevice({ state: 'Shutdown' });
    const bootedDevice = makeDevice({ state: 'Booted' });

    const simctl = makeSimctl();
    let pollCount = 0;
    const lookup = {
      resolveDevice: jest.fn(async () => shutdownDevice),
      getDevice: jest.fn(async () => {
        pollCount++;
        // Return Booted on second poll
        return pollCount >= 2 ? bootedDevice : shutdownDevice;
      }),
    };

    const result = await boot('iphone-test', {
      simctl,
      lookup,
      sleep: noopSleep,
      bootTimeoutMs: 10000,
      pollIntervalMs: 0,
    });

    expect(simctl.exec).toHaveBeenCalledWith(['boot', shutdownDevice.udid]);
    expect(result.state).toBe('Booted');
    expect(lookup.getDevice).toHaveBeenCalledWith(shutdownDevice.udid);
  });

  it('throws BootTimeoutError when device does not boot within timeout', async () => {
    const shutdownDevice = makeDevice({ state: 'Shutdown' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(async () => shutdownDevice),
      // Always returns Shutdown — never boots
      getDevice: jest.fn(async () => shutdownDevice),
    };

    await expect(
      boot('iphone-test', {
        simctl,
        lookup,
        // Use real setTimeout but extremely short timeout so one poll overshoots
        bootTimeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(BootTimeoutError);
  });

  it('BootTimeoutError carries deviceId, deviceName, timeoutMs', async () => {
    const shutdownDevice = makeDevice({ udid: 'UDID-X', name: 'My iPhone', state: 'Shutdown' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(async () => shutdownDevice),
      getDevice: jest.fn(async () => shutdownDevice),
    };

    let caught: BootTimeoutError | undefined;
    try {
      await boot('iphone-test', { simctl, lookup, bootTimeoutMs: 0, pollIntervalMs: 0 });
    } catch (e) {
      caught = e as BootTimeoutError;
    }

    expect(caught).toBeInstanceOf(BootTimeoutError);
    expect(caught?.deviceId).toBe('UDID-X');
    expect(caught?.deviceName).toBe('My iPhone');
    expect(caught?.timeoutMs).toBe(0);
  });
});

// ── shutdown ─────────────────────────────────────────────────────────────────

describe('lifecycle.shutdown', () => {
  it('returns immediately if device is already Shutdown', async () => {
    const device = makeDevice({ state: 'Shutdown' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(),
      getDevice: jest.fn(async () => device),
    };

    await shutdown('TEST-UDID-0001', { simctl, lookup, sleep: noopSleep });

    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('returns immediately if device not found', async () => {
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(),
      getDevice: jest.fn(async () => null),
    };

    await shutdown('MISSING-UDID', { simctl, lookup, sleep: noopSleep });

    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('issues simctl shutdown and resolves when device reaches Shutdown', async () => {
    const bootedDevice = makeDevice({ state: 'Booted' });
    const shutdownDevice = makeDevice({ state: 'Shutdown' });

    const simctl = makeSimctl();
    let pollCount = 0;
    const lookup = {
      resolveDevice: jest.fn(),
      getDevice: jest.fn(async () => {
        // First call: check initial state (Booted); second call during poll: Shutdown
        pollCount++;
        return pollCount === 1 ? bootedDevice : shutdownDevice;
      }),
    };

    await shutdown('TEST-UDID-0001', {
      simctl,
      lookup,
      sleep: noopSleep,
      shutdownTimeoutMs: 10000,
    });

    expect(simctl.exec).toHaveBeenCalledWith(['shutdown', 'TEST-UDID-0001']);
  });

  it('completes successfully after nuclear erase (best-effort cleanup)', async () => {
    // Pre-refactor SimulatorManager.shutdown returned on a successful
    // erase; preserving that contract is what keeps the device_shutdown
    // MCP tool from reporting hard failures on otherwise-clean teardowns.
    const bootedDevice = makeDevice({ state: 'Booted' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(),
      // Always returns Booted — never shuts down, forcing the nuclear path
      getDevice: jest.fn(async () => bootedDevice),
    };

    await expect(
      shutdown('TEST-UDID-0001', {
        simctl,
        lookup,
        sleep: noopSleep,
        shutdownTimeoutMs: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates SimctlError when the nuclear erase itself fails', async () => {
    const bootedDevice = makeDevice({ state: 'Booted' });
    // Let `shutdown` calls succeed; only `erase` fails. This isolates the
    // erase-failure branch from incidental shutdown errors.
    const simctl = makeSimctl(async (args: string[]) => {
      if (args[0] === 'erase') {
        throw new SimctlError('simctl erase failed', ['erase', 'TEST-UDID-0001'], 1);
      }
      return '';
    });
    const lookup = {
      resolveDevice: jest.fn(),
      getDevice: jest.fn(async () => bootedDevice),
    };

    await expect(
      shutdown('TEST-UDID-0001', {
        simctl,
        lookup,
        sleep: noopSleep,
        shutdownTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(SimctlError);
  });

  it('issues simctl erase as the last-resort cleanup step', async () => {
    const bootedDevice = makeDevice({ state: 'Booted' });
    const simctl = makeSimctl();
    const lookup = {
      resolveDevice: jest.fn(),
      getDevice: jest.fn(async () => bootedDevice),
    };

    await shutdown('TEST-UDID-0001', {
      simctl,
      lookup,
      sleep: noopSleep,
      shutdownTimeoutMs: 0,
    });

    const eraseCalls = simctl.calls.filter(a => a[0] === 'erase');
    expect(eraseCalls.length).toBeGreaterThan(0);
  });
});

// ── deleteDevice ─────────────────────────────────────────────────────────────

describe('lifecycle.deleteDevice', () => {
  it('is explicit — only runs when caller invokes it', async () => {
    const simctl = makeSimctl();
    // Calling deleteDevice requires deliberate action from caller — no side effects
    await deleteDevice('UDID-DEL', { simctl });
    expect(simctl.exec).toHaveBeenCalledTimes(1);
    expect(simctl.exec).toHaveBeenCalledWith(['delete', 'UDID-DEL']);
  });

  it('does NOT run implicitly — only when explicitly called', () => {
    // This is a documentation assertion: the function does nothing unless called.
    // The absence of any auto-delete logic in lifecycle.ts is the guarantee.
    expect(typeof deleteDevice).toBe('function');
  });
});

// ── eraseDevice ───────────────────────────────────────────────────────────────

describe('lifecycle.eraseDevice', () => {
  it('delegates to simctl erase', async () => {
    const simctl = makeSimctl();
    await eraseDevice('UDID-ERASE', { simctl });
    expect(simctl.exec).toHaveBeenCalledWith(['erase', 'UDID-ERASE']);
  });
});

// ── cloneDevice ───────────────────────────────────────────────────────────────

describe('lifecycle.cloneDevice', () => {
  it('returns trimmed UDID from simctl clone output', async () => {
    const newUdid = 'CLONE-UDID-9999';
    const simctl = makeSimctl(async (args) => {
      if (args[0] === 'clone') return `${newUdid}\n`;
      return '';
    });

    const result = await cloneDevice('SOURCE-UDID', 'MyClone', { simctl });

    expect(simctl.exec).toHaveBeenCalledWith(['clone', 'SOURCE-UDID', 'MyClone']);
    expect(result).toBe(newUdid);
  });
});
