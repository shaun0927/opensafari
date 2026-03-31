import { CrossDeviceAssert } from '../../src/orchestration/cross-device-assert';

function createMockSimulator(preset: string, udid: string, evaluateFn: (expr: string) => unknown, screenshotFn?: () => Buffer) {
  return {
    device: { udid },
    client: {
      evaluate: jest.fn(evaluateFn),
      screenshot: jest.fn(screenshotFn ?? (() => Buffer.from('fake-png-data'))),
    },
    preset,
    bootedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function createMockPool(simulators: ReturnType<typeof createMockSimulator>[]) {
  return {
    getAll: () => simulators,
  } as any;
}

describe('CrossDeviceAssert', () => {
  describe('empty pool', () => {
    it('returns appropriate result when no devices are available', async () => {
      const pool = createMockPool([]);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists', selector: '#foo' });

      expect(result.passed).toBe(false);
      expect(result.results).toHaveLength(0);
      expect(result.summary).toBe('0 devices available');
    });
  });

  describe('exists check', () => {
    it('all devices pass when element exists on all', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPad Air', 'udid-2', () => true),
        createMockSimulator('iPhone SE', 'udid-3', () => true),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists', selector: '#nav' });

      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.summary).toBe('3/3 devices passed');
      result.results.forEach(r => expect(r.passed).toBe(true));
    });

    it('reports failed device when element missing on one device', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPad Air', 'udid-2', () => false),
        createMockSimulator('iPhone SE', 'udid-3', () => true),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists', selector: '#nav' });

      expect(result.passed).toBe(false);
      expect(result.summary).toBe('1/3 devices failed: iPad Air');
      expect(result.results.find(r => r.device === 'iPad Air')!.passed).toBe(false);
    });

    it('returns error when selector is missing', async () => {
      const sims = [createMockSimulator('iPhone 15', 'udid-1', () => true)];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists' });

      expect(result.passed).toBe(false);
      expect(result.results[0].error).toBe('selector is required for exists check');
    });
  });

  describe('visible check', () => {
    it('passes when element is visible on all devices', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPhone SE', 'udid-2', () => true),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'visible', selector: '.header' });

      expect(result.passed).toBe(true);
      expect(result.summary).toBe('2/2 devices passed');
    });

    it('fails when element is hidden on one device', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPhone SE', 'udid-2', () => false),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'visible', selector: '.header' });

      expect(result.passed).toBe(false);
      expect(result.results.find(r => r.device === 'iPhone SE')!.passed).toBe(false);
    });

    it('returns error when selector is missing', async () => {
      const sims = [createMockSimulator('iPhone 15', 'udid-1', () => true)];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'visible' });

      expect(result.passed).toBe(false);
      expect(result.results[0].error).toBe('selector is required for visible check');
    });
  });

  describe('text_matches check', () => {
    it('passes when text matches expected on all devices', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => 'Hello World'),
        createMockSimulator('iPad Air', 'udid-2', () => 'Hello World'),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'text_matches',
        selector: 'h1',
        expected: 'Hello World',
      });

      expect(result.passed).toBe(true);
      expect(result.summary).toBe('2/2 devices passed');
    });

    it('fails when text does not match on one device', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => 'Hello World'),
        createMockSimulator('iPad Air', 'udid-2', () => 'Hello Mobile'),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'text_matches',
        selector: 'h1',
        expected: 'Hello World',
      });

      expect(result.passed).toBe(false);
      const failed = result.results.find(r => r.device === 'iPad Air')!;
      expect(failed.passed).toBe(false);
      expect(failed.actual).toBe('Hello Mobile');
    });

    it('returns error when expected is missing', async () => {
      const sims = [createMockSimulator('iPhone 15', 'udid-1', () => 'text')];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'text_matches',
        selector: 'h1',
      });

      expect(result.passed).toBe(false);
      expect(result.results[0].error).toBe('expected is required for text_matches check');
    });
  });

  describe('custom check', () => {
    it('passes when custom expression returns truthy', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPad Air', 'udid-2', () => 42),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'custom',
        assertion: 'window.innerWidth > 300',
      });

      expect(result.passed).toBe(true);
      expect(result.summary).toBe('2/2 devices passed');
    });

    it('fails when custom expression returns falsy', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPhone SE', 'udid-2', () => false),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'custom',
        assertion: 'window.innerWidth > 400',
      });

      expect(result.passed).toBe(false);
      expect(result.summary).toBe('1/2 devices failed: iPhone SE');
    });

    it('returns error when assertion is missing', async () => {
      const sims = [createMockSimulator('iPhone 15', 'udid-1', () => true)];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'custom' });

      expect(result.passed).toBe(false);
      expect(result.results[0].error).toBe('assertion is required for custom check');
    });
  });

  describe('screenshot capture', () => {
    it('includes screenshot when includeScreenshot is true', async () => {
      const pngData = Buffer.from('fake-screenshot-data');
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true, () => pngData),
        createMockSimulator('iPad Air', 'udid-2', () => true, () => pngData),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'exists',
        selector: '#nav',
        includeScreenshot: true,
      });

      expect(result.passed).toBe(true);
      result.results.forEach(r => {
        expect(r.screenshot).toBe(pngData.toString('base64'));
      });
      sims.forEach(sim => {
        expect(sim.client.screenshot).toHaveBeenCalledTimes(1);
      });
    });

    it('does not include screenshot by default', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPad Air', 'udid-2', () => true),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({
        check: 'exists',
        selector: '#nav',
      });

      expect(result.passed).toBe(true);
      result.results.forEach(r => {
        expect(r.screenshot).toBeUndefined();
      });
      sims.forEach(sim => {
        expect(sim.client.screenshot).not.toHaveBeenCalled();
      });
    });

    it('does not fail assertion when screenshot capture fails', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true, () => {
          throw new Error('Screenshot failed');
        }),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await asserter.assertAll({
        check: 'exists',
        selector: '#nav',
        includeScreenshot: true,
      });

      expect(result.passed).toBe(true);
      expect(result.results[0].passed).toBe(true);
      expect(result.results[0].screenshot).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('catches evaluation errors gracefully', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => true),
        createMockSimulator('iPad Air', 'udid-2', () => {
          throw new Error('WebKit connection lost');
        }),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists', selector: '#nav' });

      expect(result.passed).toBe(false);
      expect(result.summary).toBe('1/2 devices failed: iPad Air');
      const failed = result.results.find(r => r.device === 'iPad Air')!;
      expect(failed.passed).toBe(false);
      expect(failed.error).toBe('WebKit connection lost');
    });

    it('catches non-Error throws gracefully', async () => {
      const sims = [
        createMockSimulator('iPhone 15', 'udid-1', () => {
          throw 'string error';
        }),
      ];
      const pool = createMockPool(sims);
      const asserter = new CrossDeviceAssert(pool);
      const result = await asserter.assertAll({ check: 'exists', selector: '#nav' });

      expect(result.passed).toBe(false);
      expect(result.results[0].error).toBe('string error');
    });
  });
});
