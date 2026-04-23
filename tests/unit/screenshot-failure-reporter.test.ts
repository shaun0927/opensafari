/**
 * Unit coverage for the integration-suite screenshot-on-failure reporter.
 *
 * The reporter itself is a CommonJS module so we `require` it and treat its
 * default export as `any` — it carries no public TypeScript surface.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const ScreenshotOnFailureReporter = require('../integration/screenshot-failure-reporter.cjs');
const os = require('os');
const path = require('path');

interface ReporterStatic {
  new (...args: unknown[]): {
    deviceId: string | null;
    outputDir: string;
    captures: number;
    forced: boolean;
    onTestCaseResult: (
      test: unknown,
      result: { status: string; title?: string; ancestorTitles?: string[] },
    ) => void;
  };
  slugify: (s: string) => string;
  detectBootedDevice: () => string | null;
}

function withEnv<K extends string>(
  key: K,
  value: string | undefined,
  fn: () => void,
): void {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
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
      withEnv('OSF_DEVICE_ID', 'fake-uuid', () => {
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
      });
    });
  });

  describe('OPENSAFARI_SAVE_FAILURE_SCREENSHOTS opt-in', () => {
    test('force flag triggers booted-device detection when OSF_DEVICE_ID is unset', () => {
      const detect = jest
        .spyOn(Reporter, 'detectBootedDevice')
        .mockReturnValue('auto-detected-uuid');
      withEnv('OSF_DEVICE_ID', undefined, () => {
        withEnv('OPENSAFARI_SAVE_FAILURE_SCREENSHOTS', '1', () => {
          const r = new Reporter({ rootDir: process.cwd() });
          expect(r.forced).toBe(true);
          expect(r.deviceId).toBe('auto-detected-uuid');
          expect(detect).toHaveBeenCalledTimes(1);
        });
      });
      detect.mockRestore();
    });

    test('force flag defers to an explicit OSF_DEVICE_ID when both are set', () => {
      const detect = jest.spyOn(Reporter, 'detectBootedDevice');
      withEnv('OSF_DEVICE_ID', 'explicit-uuid', () => {
        withEnv('OPENSAFARI_SAVE_FAILURE_SCREENSHOTS', '1', () => {
          const r = new Reporter({ rootDir: process.cwd() });
          expect(r.forced).toBe(true);
          expect(r.deviceId).toBe('explicit-uuid');
          expect(detect).not.toHaveBeenCalled();
        });
      });
      detect.mockRestore();
    });

    test('absence of the flag leaves detection dormant', () => {
      const detect = jest.spyOn(Reporter, 'detectBootedDevice');
      withEnv('OSF_DEVICE_ID', undefined, () => {
        withEnv('OPENSAFARI_SAVE_FAILURE_SCREENSHOTS', undefined, () => {
          const r = new Reporter({ rootDir: process.cwd() });
          expect(r.forced).toBe(false);
          expect(r.deviceId).toBeNull();
          expect(detect).not.toHaveBeenCalled();
        });
      });
      detect.mockRestore();
    });

    test('flag without a booted simulator still no-ops on failure', () => {
      const detect = jest
        .spyOn(Reporter, 'detectBootedDevice')
        .mockReturnValue(null);
      withEnv('OSF_DEVICE_ID', undefined, () => {
        withEnv('OPENSAFARI_SAVE_FAILURE_SCREENSHOTS', '1', () => {
          const r = new Reporter({ rootDir: process.cwd() });
          expect(r.deviceId).toBeNull();
          r.onTestCaseResult(null, {
            status: 'failed',
            title: 'red',
            ancestorTitles: [],
          });
          expect(r.captures).toBe(0);
        });
      });
      detect.mockRestore();
    });
  });

  describe('resolveOutputDir', () => {
    const resolveOutputDir: (raw: unknown, cwd: string) => string =
      ScreenshotOnFailureReporter.resolveOutputDir;
    const cwd = process.cwd();
    const defaultDir = path.resolve(cwd, 'test-output', 'screenshots');

    let errorSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    test('accept: absolute path under process.cwd() is returned unchanged', () => {
      const input = path.join(cwd, 'custom-screenshots');
      expect(resolveOutputDir(input, cwd)).toBe(input);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('accept: absolute path under os.tmpdir() is returned unchanged', () => {
      const input = path.join(os.tmpdir(), 'opensafari-test-screenshots');
      expect(resolveOutputDir(input, cwd)).toBe(input);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('accept: relative path is normalized to under cwd and returned', () => {
      const result = resolveOutputDir('custom-screenshots', cwd);
      expect(result).toBe(path.resolve(cwd, 'custom-screenshots'));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('reject: absolute path outside both safe roots returns default with one console.error', () => {
      const result = resolveOutputDir('/etc/opensafari-unexpected', cwd);
      expect(result).toBe(defaultDir);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/^\[screenshot-on-failure\]/);
      expect(errorSpy.mock.calls[0][0]).toContain('/etc/opensafari-unexpected');
      expect(errorSpy.mock.calls[0][0]).toContain('outside safe roots');
    });

    test('reject: .. traversal escaping cwd returns default with one console.error', () => {
      const result = resolveOutputDir('../../etc/foo', cwd);
      expect(result).toBe(defaultDir);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/^\[screenshot-on-failure\]/);
      expect(errorSpy.mock.calls[0][0]).toContain('outside safe roots');
    });

    test('ignore (no diagnostic): empty string returns default silently', () => {
      expect(resolveOutputDir('', cwd)).toBe(defaultDir);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('ignore (no diagnostic): whitespace-only string returns default silently', () => {
      expect(resolveOutputDir('   ', cwd)).toBe(defaultDir);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('ignore (no diagnostic): undefined returns default silently', () => {
      expect(resolveOutputDir(undefined, cwd)).toBe(defaultDir);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('invariant: built-in default resolves inside safe roots', () => {
      const safeRoots = [path.resolve(cwd), os.tmpdir()];
      const safe = safeRoots.some(
        (root) => defaultDir === root || defaultDir.startsWith(root + path.sep),
      );
      expect(safe).toBe(true);
    });

    test('RUNNER_TEMP assertion: os.tmpdir() is a valid safe root for CI macOS runners', () => {
      // On GitHub Actions macOS, RUNNER_TEMP resolves under TMPDIR which
      // os.tmpdir() returns. Verify os.tmpdir() itself passes the guard.
      const input = os.tmpdir();
      expect(resolveOutputDir(input, cwd)).toBe(input);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('constructor resolveOutputDir integration', () => {
    let errorSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    test('env var rejected value falls back to default', () => {
      withEnv('OSF_SCREENSHOT_DIR', '/etc/opensafari-unexpected', () => {
        const r = new Reporter({ rootDir: process.cwd() });
        const defaultDir = path.resolve(process.cwd(), 'test-output', 'screenshots');
        expect(r.outputDir).toBe(defaultDir);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toMatch(/^\[screenshot-on-failure\]/);
      });
    });

    test('options.outputDir rejected value falls back to default and emits diagnostic', () => {
      withEnv('OSF_SCREENSHOT_DIR', undefined, () => {
        const r = new Reporter({ rootDir: process.cwd() }, { outputDir: '/etc/foo' });
        const defaultDir = path.resolve(process.cwd(), 'test-output', 'screenshots');
        expect(r.outputDir).toBe(defaultDir);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toMatch(/^\[screenshot-on-failure\]/);
        expect(errorSpy.mock.calls[0][0]).toContain('/etc/foo');
      });
    });
  });
});
