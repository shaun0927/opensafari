/**
 * Single-device integration tests.
 * Requires a real Xcode Simulator to be available.
 * Skipped in CI and when no simulator tooling is found.
 */

import { SimulatorManager } from '../../src/simulator/manager';
import { isSimulatorAvailable, describeWithSimulator } from './helpers/simulator-check';

const DEVICE_NAME = 'iPhone 17 Pro';
const BOOT_TIMEOUT = 90_000;

describeWithSimulator('Single Device: boot / verify / shutdown', () => {
  let manager: SimulatorManager;
  let deviceUdid: string | null = null;
  let available = false;

  beforeAll(async () => {
    available = await isSimulatorAvailable();
    if (!available) return;
    manager = new SimulatorManager();
  }, 10_000);

  afterAll(async () => {
    // Ensure we clean up any booted device
    if (deviceUdid && manager) {
      try {
        await manager.shutdown(deviceUdid);
      } catch {
        // Best-effort cleanup
      }
    }
  }, 60_000);

  test('device_boot boots a simulator device', async () => {
    if (!available) return;

    const device = await manager.boot(DEVICE_NAME, { timeout: BOOT_TIMEOUT });
    deviceUdid = device.udid;

    expect(device.udid).toBeTruthy();
    expect(device.state).toBe('Booted');
    expect(device.name).toContain('iPhone');
  }, BOOT_TIMEOUT + 10_000);

  test('booted device appears in simctl list', async () => {
    if (!available || !deviceUdid) return;

    const booted = await manager.listBooted();
    const found = booted.find(d => d.udid === deviceUdid);
    expect(found).toBeDefined();
    expect(found!.state).toBe('Booted');
  }, 15_000);

  test('device_shutdown removes device from booted list', async () => {
    if (!available || !deviceUdid) return;

    await manager.shutdown(deviceUdid);

    // Verify device is no longer booted
    const booted = await manager.listBooted();
    const found = booted.find(d => d.udid === deviceUdid);
    expect(found).toBeUndefined();

    // Mark as cleaned up so afterAll does not try again
    deviceUdid = null;
  }, 60_000);
});
