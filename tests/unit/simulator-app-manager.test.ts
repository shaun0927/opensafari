/**
 * Unit tests for src/simulator/app-manager.ts — #708 step 4.
 *
 * Covers:
 *   - launchApp happy path
 *   - launchApp passes args and env
 *   - launchApp DeviceNotBootedError for shutdown device
 *   - launchApp AppNotInstalledError surfaces
 *   - launchApp AppLaunchError surfaces for other failures
 *   - terminateApp happy path
 *   - terminateApp returns terminated:false when not running
 *   - terminateApp DeviceNotBootedError for shutdown device
 *   - terminateApp AppNotInstalledError surfaces
 *   - activateApp happy path
 *   - activateApp AppNotInstalledError surfaces
 *   - listRunningApps parses UIKitApplication entries
 *   - resetApp happy path (terminate + privacy + uninstall)
 *   - resetApp AppNotInstalledError when uninstall fails with domain not found
 */

import {
  launchApp,
  terminateApp,
  activateApp,
  listRunningApps,
  resetApp,
} from '../../src/simulator/app-manager';
import { AppNotInstalledError, AppLaunchError, DeviceNotBootedError } from '../../src/simulator/errors';
import { SimctlError } from '../../src/simulator/simctl';
import { SimulatorDevice } from '../../src/simulator/types';

// ── helpers ──────────────────────────────────────────────────────────────────

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const BUNDLE_ID = 'com.example.testapp';

function makeDevice(overrides: Partial<SimulatorDevice> = {}): SimulatorDevice {
  return {
    udid: DEVICE_ID,
    name: 'iPhone Test',
    state: 'Booted',
    isAvailable: true,
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    runtimeVersion: '18.0',
    ...overrides,
  };
}

function makeSimctl(execImpl?: (args: string[], options?: unknown) => Promise<string>) {
  const calls: Array<{ args: string[]; options?: unknown }> = [];
  const exec = jest.fn(async (args: string[], options?: unknown) => {
    calls.push({ args, options });
    return execImpl ? execImpl(args, options) : '';
  });
  return { exec, calls };
}

function makeLookup(device: SimulatorDevice | null) {
  return {
    getDevice: jest.fn(async () => device),
  };
}

// ── launchApp ────────────────────────────────────────────────────────────────

describe('app-manager.launchApp', () => {
  it('launches app and returns pid', async () => {
    const simctl = makeSimctl(async () => `${BUNDLE_ID}: 12345\n`);
    const lookup = makeLookup(makeDevice());

    const result = await launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup });

    expect(result).toEqual({ pid: 12345, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
    expect(simctl.exec).toHaveBeenCalledWith(
      ['launch', DEVICE_ID, BUNDLE_ID],
      expect.objectContaining({}),
    );
  });

  it('returns pid -1 when output has no pid match', async () => {
    const simctl = makeSimctl(async () => 'no pid here\n');
    const lookup = makeLookup(makeDevice());

    const result = await launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup });

    expect(result.pid).toBe(-1);
  });

  it('passes launch arguments', async () => {
    const simctl = makeSimctl(async () => `${BUNDLE_ID}: 99\n`);
    const lookup = makeLookup(makeDevice());

    await launchApp(DEVICE_ID, BUNDLE_ID, { args: ['--reset', '--verbose'] }, { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(
      ['launch', DEVICE_ID, BUNDLE_ID, '--reset', '--verbose'],
      expect.objectContaining({}),
    );
  });

  it('passes environment variables via SIMCTL_CHILD_ prefix', async () => {
    const simctl = makeSimctl(async () => `${BUNDLE_ID}: 99\n`);
    const lookup = makeLookup(makeDevice());

    await launchApp(DEVICE_ID, BUNDLE_ID, { env: { DEBUG: '1', FOO: 'bar' } }, { simctl, lookup });

    expect(simctl.exec).toHaveBeenCalledWith(
      ['launch', DEVICE_ID, BUNDLE_ID],
      expect.objectContaining({ env: { SIMCTL_CHILD_DEBUG: '1', SIMCTL_CHILD_FOO: 'bar' } }),
    );
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('throws DeviceNotBootedError when device is null', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(null);

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });

  it('throws AppNotInstalledError when simctl reports domain not found', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: domain not found', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('throws AppNotInstalledError when simctl reports not installed', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: not installed', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('throws AppLaunchError for other SimctlError failures', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: crash', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(AppLaunchError);
  });

  it('throws AppLaunchError for generic errors', async () => {
    const simctl = makeSimctl(async () => {
      throw new Error('unexpected error');
    });
    const lookup = makeLookup(makeDevice());

    await expect(launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup }))
      .rejects.toThrow(AppLaunchError);
  });

  it('AppLaunchError carries bundleId, deviceId, and reason', async () => {
    const simctl = makeSimctl(async () => {
      throw new Error('something went wrong');
    });
    const lookup = makeLookup(makeDevice());

    let caught: AppLaunchError | undefined;
    try {
      await launchApp(DEVICE_ID, BUNDLE_ID, undefined, { simctl, lookup });
    } catch (e) {
      caught = e as AppLaunchError;
    }

    expect(caught).toBeInstanceOf(AppLaunchError);
    expect(caught?.bundleId).toBe(BUNDLE_ID);
    expect(caught?.deviceId).toBe(DEVICE_ID);
    expect(caught?.reason).toContain('something went wrong');
  });
});

// ── terminateApp ──────────────────────────────────────────────────────────────

describe('app-manager.terminateApp', () => {
  it('terminates running app and returns terminated:true', async () => {
    const simctl = makeSimctl(async () => '');
    const lookup = makeLookup(makeDevice());

    const result = await terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result).toEqual({ terminated: true, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
    expect(simctl.exec).toHaveBeenCalledWith(['terminate', DEVICE_ID, BUNDLE_ID]);
  });

  it('returns terminated:false when app is not running', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl terminate failed: not running', ['terminate'], 1);
    });
    const lookup = makeLookup(makeDevice());

    const result = await terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result).toEqual({ terminated: false, bundleId: BUNDLE_ID, deviceId: DEVICE_ID });
  });

  it('returns terminated:false for Failed to terminate message', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('Failed to terminate process', ['terminate'], 1);
    });
    const lookup = makeLookup(makeDevice());

    const result = await terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result.terminated).toBe(false);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
    expect(simctl.exec).not.toHaveBeenCalled();
  });

  it('throws AppNotInstalledError when bundle not found (domain not found)', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl terminate failed: domain not found', ['terminate'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('throws AppNotInstalledError when bundle not found (not installed)', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl terminate failed: not installed', ['terminate'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('rethrows non-SimctlError errors', async () => {
    const simctl = makeSimctl(async () => {
      throw new Error('network error');
    });
    const lookup = makeLookup(makeDevice());

    await expect(terminateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow('network error');
  });
});

// ── activateApp ───────────────────────────────────────────────────────────────

describe('app-manager.activateApp', () => {
  it('activates app and returns pid', async () => {
    const simctl = makeSimctl(async () => `${BUNDLE_ID}: 42\n`);
    const lookup = makeLookup(makeDevice());

    const result = await activateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result).toEqual({ activated: true, bundleId: BUNDLE_ID, deviceId: DEVICE_ID, pid: 42 });
    expect(simctl.exec).toHaveBeenCalledWith(['launch', DEVICE_ID, BUNDLE_ID]);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(activateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });

  it('throws AppNotInstalledError when bundle not found (domain not found)', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: domain not found', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(activateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('throws AppNotInstalledError when bundle not found (not installed)', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: not installed', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(activateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('rethrows other SimctlErrors', async () => {
    const simctl = makeSimctl(async () => {
      throw new SimctlError('simctl launch failed: crash', ['launch'], 1);
    });
    const lookup = makeLookup(makeDevice());

    await expect(activateApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(SimctlError);
  });
});

// ── listRunningApps ───────────────────────────────────────────────────────────

describe('app-manager.listRunningApps', () => {
  it('parses UIKitApplication entries from launchctl list', async () => {
    const launchctlOutput = [
      'PID\tSTATUS\tLABEL',
      '101\t0\tUIKitApplication:com.example.app1[0x1]',
      '102\t0\tUIKitApplication:com.example.app2[0x2]',
      '-\t0\tcom.apple.springboard',
    ].join('\n');

    const simctl = makeSimctl(async () => launchctlOutput);
    const lookup = makeLookup(makeDevice());

    const result = await listRunningApps(DEVICE_ID, { simctl, lookup });

    expect(result).toEqual([
      { label: 'com.example.app1', pid: 101 },
      { label: 'com.example.app2', pid: 102 },
    ]);
    expect(simctl.exec).toHaveBeenCalledWith(['spawn', DEVICE_ID, 'launchctl', 'list']);
  });

  it('strips a single trailing bracket group from bundle labels', async () => {
    const launchctlOutput = [
      'PID\tSTATUS\tLABEL',
      '200\t0\tUIKitApplication:com.example.tricky[0x1]',
    ].join('\n');

    const simctl = makeSimctl(async () => launchctlOutput);
    const lookup = makeLookup(makeDevice());

    const result = await listRunningApps(DEVICE_ID, { simctl, lookup });

    expect(result).toEqual([{ label: 'com.example.tricky', pid: 200 }]);
  });

  it('strips all trailing bracket groups (multi-suffix labels)', async () => {
    // launchctl can emit labels with multiple trailing bracket groups, e.g.
    // UIKitApplication:com.example.app[0x1][debug]. We must strip them all so
    // downstream bundle-id comparisons (classifyMobileContext) match cleanly.
    const launchctlOutput = [
      'PID\tSTATUS\tLABEL',
      '300\t0\tUIKitApplication:com.example.app[0x1][debug]',
    ].join('\n');

    const simctl = makeSimctl(async () => launchctlOutput);
    const lookup = makeLookup(makeDevice());

    const result = await listRunningApps(DEVICE_ID, { simctl, lookup });

    expect(result).toEqual([{ label: 'com.example.app', pid: 300 }]);
  });

  it('returns empty array when no UIKitApplication entries', async () => {
    const simctl = makeSimctl(async () => 'PID\tSTATUS\tLABEL\n-\t0\tcom.apple.springboard\n');
    const lookup = makeLookup(makeDevice());

    const result = await listRunningApps(DEVICE_ID, { simctl, lookup });

    expect(result).toEqual([]);
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(listRunningApps(DEVICE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });
});

// ── resetApp ──────────────────────────────────────────────────────────────────

describe('app-manager.resetApp', () => {
  it('runs terminate, privacy reset, and uninstall in order', async () => {
    const calls: string[][] = [];
    const simctl = makeSimctl(async (args) => {
      calls.push(args);
      return '';
    });
    const lookup = makeLookup(makeDevice());

    const result = await resetApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result.reset).toBe(true);
    expect(result.bundleId).toBe(BUNDLE_ID);
    expect(result.deviceId).toBe(DEVICE_ID);
    expect(result.steps).toEqual(['terminated', 'privacy_reset', 'uninstalled']);
    expect(calls[0]).toEqual(['terminate', DEVICE_ID, BUNDLE_ID]);
    expect(calls[1]).toEqual(['privacy', DEVICE_ID, 'reset', 'all', BUNDLE_ID]);
    expect(calls[2]).toEqual(['uninstall', DEVICE_ID, BUNDLE_ID]);
  });

  it('records terminate_skipped when terminate fails', async () => {
    let callCount = 0;
    const simctl = makeSimctl(async (_args) => {
      callCount++;
      if (callCount === 1) throw new Error('not running');
      return '';
    });
    const lookup = makeLookup(makeDevice());

    const result = await resetApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result.steps[0]).toBe('terminate_skipped');
    expect(result.steps[1]).toBe('privacy_reset');
    expect(result.steps[2]).toBe('uninstalled');
  });

  it('throws DeviceNotBootedError for shutdown device', async () => {
    const simctl = makeSimctl();
    const lookup = makeLookup(makeDevice({ state: 'Shutdown' }));

    await expect(resetApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(DeviceNotBootedError);
  });

  it('throws AppNotInstalledError when uninstall reports domain not found', async () => {
    let callCount = 0;
    const simctl = makeSimctl(async (_args) => {
      callCount++;
      // terminate and privacy succeed, uninstall fails with domain not found
      if (callCount === 3) {
        throw new SimctlError('simctl uninstall failed: domain not found', ['uninstall'], 1);
      }
      return '';
    });
    const lookup = makeLookup(makeDevice());

    await expect(resetApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup }))
      .rejects.toThrow(AppNotInstalledError);
  });

  it('records uninstall_failed for non-AppNotInstalled uninstall errors', async () => {
    let callCount = 0;
    const simctl = makeSimctl(async (_args) => {
      callCount++;
      if (callCount === 3) throw new SimctlError('uninstall crashed', ['uninstall'], 1);
      return '';
    });
    const lookup = makeLookup(makeDevice());

    const result = await resetApp(DEVICE_ID, BUNDLE_ID, { simctl, lookup });

    expect(result.steps[2]).toBe('uninstall_failed');
  });
});
