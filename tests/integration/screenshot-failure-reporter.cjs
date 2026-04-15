/**
 * Custom Jest reporter — captures an iOS Simulator screenshot whenever a test
 * case fails, so live integration runs leave behind a debuggable artifact
 * showing the simulator state at the failure moment.
 *
 * Activation:
 *   - Pass `--reporters=default --reporters=<path>/screenshot-failure-reporter.cjs`
 *     to jest. The `npm run test:integration` script wires this up by default.
 *   - The reporter no-ops when `OSF_DEVICE_ID` is unset (CI without a booted
 *     simulator) or when the booted device cannot be probed.
 *
 * Output:
 *   - Default: `<repo>/test-output/screenshots/<ISO-timestamp>_<sanitised-test-name>.png`
 *   - Override base directory via the `outputDir` reporter option or the
 *     `OSF_SCREENSHOT_DIR` environment variable.
 *
 * Why a custom reporter (not afterEach):
 *   - Reusable across every integration suite without per-file boilerplate.
 *   - Runs even when the test throws synchronously inside `beforeEach` /
 *     `beforeAll`, where afterEach hooks are skipped.
 *   - Stays quiet for skipped / passed cases.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

class ScreenshotOnFailureReporter {
  constructor(globalConfig, options = {}) {
    const cwd = (globalConfig && globalConfig.rootDir) || process.cwd();
    this.outputDir =
      options.outputDir ||
      process.env.OSF_SCREENSHOT_DIR ||
      path.resolve(cwd, 'test-output', 'screenshots');
    this.deviceId = process.env.OSF_DEVICE_ID || null;
    this.captures = 0;
  }

  /**
   * Sanitise an arbitrary jest test name into a filesystem-safe slug.
   * Limits to 120 characters so we do not blow past PATH_MAX even when
   * combined with timestamp + base directory.
   */
  static slugify(name) {
    return String(name)
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unnamed';
  }

  onTestCaseResult(_test, testCaseResult) {
    if (!testCaseResult || testCaseResult.status !== 'failed') return;
    if (!this.deviceId) return;
    const ancestors = (testCaseResult.ancestorTitles || []).join(' › ');
    const fullName = ancestors
      ? `${ancestors} › ${testCaseResult.title}`
      : testCaseResult.title;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(
      this.outputDir,
      `${ts}_${ScreenshotOnFailureReporter.slugify(fullName)}.png`,
    );
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      execFileSync(
        'xcrun',
        ['simctl', 'io', this.deviceId, 'screenshot', target],
        { stdio: 'pipe', timeout: 10_000 },
      );
      this.captures += 1;
      // eslint-disable-next-line no-console
      console.error(`[screenshot-on-failure] saved ${target}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[screenshot-on-failure] capture failed for "${fullName}": ${e.message}`,
      );
    }
  }

  onRunComplete() {
    if (this.captures > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[screenshot-on-failure] wrote ${this.captures} failure screenshot(s) to ${this.outputDir}`,
      );
    }
  }
}

module.exports = ScreenshotOnFailureReporter;
