import { DEVICE_PRESETS, resolvePreset } from '../../src/simulator/presets';

describe('Device Presets', () => {
  it('defines exactly 10 presets', () => {
    expect(Object.keys(DEVICE_PRESETS)).toHaveLength(10);
  });

  it('all presets have lastVerified metadata with valid ISO date', () => {
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const [, preset] of Object.entries(DEVICE_PRESETS)) {
      expect(preset.lastVerified).toBeDefined();
      expect(preset.lastVerified).toMatch(isoDateRegex);
      // Verify it's a parseable date
      const date = new Date(preset.lastVerified!);
      expect(date.getTime()).not.toBeNaN();
    }
  });

  it('all presets have verifiedXcodeVersion metadata', () => {
    for (const [, preset] of Object.entries(DEVICE_PRESETS)) {
      expect(preset.verifiedXcodeVersion).toBeDefined();
      expect(preset.verifiedXcodeVersion!.length).toBeGreaterThan(0);
    }
  });

  it('all presets have valid dimension values', () => {
    for (const [, preset] of Object.entries(DEVICE_PRESETS)) {
      expect(preset.w).toBeGreaterThan(0);
      expect(preset.h).toBeGreaterThan(0);
      expect(preset.dpr).toBeGreaterThanOrEqual(1);
      expect(preset.dpr).toBeLessThanOrEqual(4);
      // Height should be greater than width (portrait orientation)
      expect(preset.h).toBeGreaterThan(preset.w);
    }
  });

  it('resolvePreset returns correct preset', () => {
    const preset = resolvePreset('iphone-17-pro');
    expect(preset.name).toBe('iPhone 17 Pro');
    expect(preset.w).toBe(402);
    expect(preset.h).toBe(874);
    expect(preset.dpr).toBe(3);
  });

  it('resolvePreset throws for unknown key', () => {
    expect(() => resolvePreset('nonexistent')).toThrow('Unknown device preset: nonexistent');
  });

  it('iPhone SE 3rd gen has DPR 2 (not 3)', () => {
    const preset = DEVICE_PRESETS['iphone-se-3'];
    expect(preset.dpr).toBe(2);
  });

  describe('preset metadata completeness', () => {
    const presetEntries = Object.entries(DEVICE_PRESETS);

    it.each(presetEntries)('%s has lastVerified', (key, preset) => {
      expect(preset.lastVerified).toBeDefined();
    });

    it.each(presetEntries)('%s has verifiedXcodeVersion', (key, preset) => {
      expect(preset.verifiedXcodeVersion).toBeDefined();
    });
  });
});
