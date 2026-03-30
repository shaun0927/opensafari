import { THROTTLE_PROFILES, ThrottleProfile, getActiveProfile } from '../../src/tools/network-throttle';

describe('network-throttle', () => {
  describe('THROTTLE_PROFILES', () => {
    it('has all expected profiles', () => {
      const profiles: ThrottleProfile[] = ['slow-3g', 'fast-3g', '4g', 'wifi', 'none'];
      profiles.forEach((p) => {
        expect(THROTTLE_PROFILES[p]).toBeDefined();
      });
    });

    it('slow-3g has highest latency', () => {
      expect(THROTTLE_PROFILES['slow-3g'].latencyMs).toBeGreaterThan(THROTTLE_PROFILES['fast-3g'].latencyMs);
      expect(THROTTLE_PROFILES['fast-3g'].latencyMs).toBeGreaterThan(THROTTLE_PROFILES['4g'].latencyMs);
      expect(THROTTLE_PROFILES['4g'].latencyMs).toBeGreaterThan(THROTTLE_PROFILES['wifi'].latencyMs);
    });

    it('none profile has zero latency', () => {
      expect(THROTTLE_PROFILES['none'].latencyMs).toBe(0);
      expect(THROTTLE_PROFILES['none'].downloadKbps).toBe(0);
      expect(THROTTLE_PROFILES['none'].uploadKbps).toBe(0);
    });

    it('all profiles have positive download > upload (except none)', () => {
      (['slow-3g', 'fast-3g', '4g', 'wifi'] as ThrottleProfile[]).forEach((p) => {
        const config = THROTTLE_PROFILES[p];
        expect(config.downloadKbps).toBeGreaterThan(0);
        expect(config.uploadKbps).toBeGreaterThan(0);
        expect(config.downloadKbps).toBeGreaterThan(config.uploadKbps);
      });
    });

    it('latency values are realistic', () => {
      expect(THROTTLE_PROFILES['slow-3g'].latencyMs).toBe(2000);
      expect(THROTTLE_PROFILES['fast-3g'].latencyMs).toBe(560);
      expect(THROTTLE_PROFILES['4g'].latencyMs).toBe(170);
      expect(THROTTLE_PROFILES['wifi'].latencyMs).toBe(40);
    });
  });

  describe('getActiveProfile', () => {
    it('defaults to none', () => {
      expect(getActiveProfile()).toBe('none');
    });
  });
});
