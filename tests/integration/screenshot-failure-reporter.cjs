/**
 * Custom Jest reporter — captures an iOS Simulator screenshot whenever a test
 * case fails, so live integration runs leave behind a debuggable artifact
 * showing the simulator state at the failure moment.
 *
 * Activation:
 *   - Pass `--reporters=default --reporters=<path>/screenshot-failure-reporter.cjs`
 *     to jest. The `npm run test:integration` script wires this up by default.
 *   - The reporter no-ops when no iOS Simulator device id is resolvable — either
 *     via `OSF_DEVICE_ID` (set explicitly by CI or the dev) or via the local
 *     opt-in `OPENSAFARI_SAVE_FAILURE_SCREENSHOTS=1`, which auto-detects a
 *     booted simulator through `xcrun simctl list devices booted` so the dev
 *     does not have to mirror CI env just to triage a red test locally.
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
    this.forced = process.env.OPENSAFARI_SAVE_FAILURE_SCREENSHOTS === '1';
    // Local opt-in convenience: if the dev asked for failure screenshots but
    // hasn't exported a device id, find the booted simulator ourselves. Keeps
    // `CI=true` / `OSF_DEVICE_ID=…` as the CI path and this flag as the strictly
    // additive local path — neither side effects the other.
    if (!this.deviceId && this.forced) {
      this.deviceId = ScreenshotOnFailureReporter.detectBootedDevice();
    }
    this.captures = 0;
  }

  static detectBootedDevice() {
    try {
      const raw = execFileSync(
        'xcrun',
        ['simctl', 'list', 'devices', 'booted', '-j'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
      );
      const parsed = JSON.parse(raw);
      for (const devices of Object.values(parsed.devices || {})) {
        for (const dev of devices || []) {
          if (dev && dev.udid) return dev.udid;
        }
      }
    } catch {
      // Swallow: absence of xcrun / booted devices means "nothing to do".
    }
    return null;
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
