import { DevicePreset } from './types';

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iphone-se-1': { name: 'iPhone SE (1st generation)', w: 320, h: 568, dpr: 2 },
  'iphone-se-2': { name: 'iPhone SE (2nd generation)', w: 375, h: 667, dpr: 2 },
  'iphone-se-3': { name: 'iPhone SE (3rd generation)', w: 375, h: 667, dpr: 3 },
  'iphone-17e': { name: 'iPhone 17e', w: 390, h: 844, dpr: 3 },
  'iphone-17': { name: 'iPhone 17', w: 402, h: 874, dpr: 3 },
  'iphone-air': { name: 'iPhone Air', w: 420, h: 912, dpr: 3 },
  'iphone-17-pro': { name: 'iPhone 17 Pro', w: 402, h: 874, dpr: 3 },
  'iphone-17-pro-max': { name: 'iPhone 17 Pro Max', w: 440, h: 956, dpr: 3 },
  'ipad-air': { name: 'iPad Air 13-inch (M4)', w: 1024, h: 1366, dpr: 2 },
  'ipad-pro': { name: 'iPad Pro 13-inch (M5)', w: 1032, h: 1376, dpr: 2 },
};

export function resolvePreset(key: string): DevicePreset {
  const preset = DEVICE_PRESETS[key];
  if (!preset) {
    throw new Error(`Unknown device preset: ${key}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
  }
  return preset;
}
