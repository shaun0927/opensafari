import { SimctlExecutor } from './simctl';
import { SimulatorDevice, SimulatorRuntime } from './types';
import { DEVICE_PRESETS } from './presets';
import { DeviceNotFoundError } from './errors';

interface SimctlListResult {
  devices: Record<string, Array<{
    udid: string;
    name: string;
    state: string;
    isAvailable: boolean;
  }>>;
  runtimes: Array<{
    identifier: string;
    version: string;
    isAvailable: boolean;
    platform: string;
  }>;
}

export async function listDevices(simctl: SimctlExecutor): Promise<SimulatorDevice[]> {
  const result = await simctl.execJson<SimctlListResult>(['list', 'devices']);
  const devices: SimulatorDevice[] = [];

  for (const [runtimeId, deviceList] of Object.entries(result.devices)) {
    const version = runtimeId.match(/iOS-(\d+)-(\d+)/);
    const runtimeVersion = version ? `${version[1]}.${version[2]}` : 'unknown';

    for (const device of deviceList) {
      if (device.isAvailable) {
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state as SimulatorDevice['state'],
          isAvailable: device.isAvailable,
          runtime: runtimeId,
          runtimeVersion,
        });
      }
    }
  }

  return devices;
}

export async function listRuntimes(simctl: SimctlExecutor): Promise<SimulatorRuntime[]> {
  const result = await simctl.execJson<SimctlListResult>(['list', 'runtimes']);
  return result.runtimes.filter(r => r.isAvailable);
}

export async function getDevice(simctl: SimctlExecutor, deviceId: string): Promise<SimulatorDevice | null> {
  const devices = await listDevices(simctl);
  return devices.find(d => d.udid === deviceId) ?? null;
}

/**
 * Resolve a preset key or device name to an actual device.
 * Tries: exact UDID match → preset name match → fuzzy name match
 */
export async function resolveDevice(simctl: SimctlExecutor, presetKey: string): Promise<SimulatorDevice> {
  const devices = await listDevices(simctl);

  // 1. Exact UDID match
  const byUdid = devices.find(d => d.udid === presetKey);
  if (byUdid) return byUdid;

  // 2. Preset name match
  const preset = DEVICE_PRESETS[presetKey];
  if (preset) {
    const exact = devices.find(d => d.name === preset.name);
    if (exact) return exact;
  }

  // 3. Case-insensitive substring match
  const lower = presetKey.toLowerCase();
  const substring = devices.find(d => d.name.toLowerCase().includes(lower));
  if (substring) return substring;

  // 4. Fuzzy: split words, match all keywords
  const keywords = lower.split(/[\s-]+/);
  const fuzzy = devices.find(d => {
    const dLower = d.name.toLowerCase();
    return keywords.every(kw => dLower.includes(kw));
  });
  if (fuzzy) return fuzzy;

  throw new DeviceNotFoundError(presetKey, devices.map(d => d.name));
}
