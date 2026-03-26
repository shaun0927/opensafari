import { DevicePreset } from './types';

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iphone-se': { name: 'iPhone SE (3rd generation)', w: 375, h: 667, dpr: 2 },
  'iphone-16': { name: 'iPhone 16', w: 393, h: 852, dpr: 3 },
  'iphone-16-pro-max': { name: 'iPhone 16 Pro Max', w: 440, h: 956, dpr: 3 },
  'ipad': { name: 'iPad (10th generation)', w: 820, h: 1180, dpr: 2 },
  'ipad-pro': { name: 'iPad Pro 13-inch (M4)', w: 1032, h: 1376, dpr: 2 },
};

export function resolvePreset(key: string): DevicePreset {
  const preset = DEVICE_PRESETS[key];
  if (!preset) {
    throw new Error(`Unknown device preset: ${key}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
  }
  return preset;
}
