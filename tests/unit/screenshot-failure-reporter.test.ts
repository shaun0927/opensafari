/**
 * Unit coverage for the integration-suite screenshot-on-failure reporter.
 *
 * The reporter itself is a CommonJS module so we `require` it and treat its
 * default export as `any` — it carries no public TypeScript surface.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const ScreenshotOnFailureReporter = require('../integration/screenshot-failure-reporter.cjs');

interface ReporterStatic {
  new (...args: unknown[]): {
    deviceId: string | null;
    outputDir: string;
    captures: number;
    onTestCaseResult: (
      test: unknown,
      result: { status: string; title?: string; ancestorTitles?: string[] },
    ) => void;
  };
  slugify: (s: string) => string;
}

const Reporter = ScreenshotOnFailureReporter as ReporterStatic;

describe('screenshot-failure-reporter', () => {
  describe('slugify', () => {
    test('replaces unsafe characters with underscores', () => {
      expect(Reporter.slugify('Settings.app › General → About')).toMatch(
        /^Settings_app_General_About$/,
      );
    });

    test('caps length at 120 characters', () => {
      const long = 'x'.repeat(500);
      expect(Reporter.slugify(long).length).toBeLessThanOrEqual(120);
    });

    test('falls back to "unnamed" when the input is empty', () => {
      expect(Reporter.slugify('')).toBe('unnamed');
      expect(Reporter.slugify('!!!')).toBe('unnamed');
    });
  });

  describe('onTestCaseResult', () => {
    test('skips when device id is unset', () => {
      const original = process.env.OSF_DEVICE_ID;
      delete process.env.OSF_DEVICE_ID;
      try {
        const r = new Reporter({ rootDir: process.cwd() });
        // Should not throw and should not capture.
        r.onTestCaseResult(null, {
          status: 'failed',
          title: 'noop',
          ancestorTitles: [],
        });
        expect(r.captures).toBe(0);
      } finally {
        if (original !== undefined) process.env.OSF_DEVICE_ID = original;
      }
    });

    test('skips passed and skipped cases even when device id is set', () => {
      const original = process.env.OSF_DEVICE_ID;
      process.env.OSF_DEVICE_ID = 'fake-uuid';
      try {
        const r = new Reporter({ rootDir: process.cwd() });
        r.onTestCaseResult(null, {
          status: 'passed',
          title: 'pass',
          ancestorTitles: [],
        });
        r.onTestCaseResult(null, {
          status: 'skipped',
          title: 'skip',
          ancestorTitles: [],
        });
        expect(r.captures).toBe(0);
      } finally {
        if (original === undefined) {
          delete process.env.OSF_DEVICE_ID;
        } else {
          process.env.OSF_DEVICE_ID = original;
        }
      }
    });
  });
});
