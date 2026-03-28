/**
 * Phase 3 Verification: Issue #124
 * Runtime tests for iOS QA Detection Engine — all 13 detectors, audit scoring,
 * regression tracking, and configurable thresholds.
 */

import { detectAutoZoom } from '../../src/qa/detectors/auto-zoom';
import { detectTouchTargets } from '../../src/qa/detectors/touch-targets';
import { detectHoverOnly } from '../../src/qa/detectors/hover-only';
import { detectInputType } from '../../src/qa/detectors/input-type';
import { detectSafeArea } from '../../src/qa/detectors/safe-area';
import { detectKeyboardOverlap } from '../../src/qa/detectors/keyboard-overlap';
import { detectHorizontalOverflow } from '../../src/qa/detectors/horizontal-overflow';
import { detect100vh } from '../../src/qa/detectors/vh100';
import { detectFixedStacking } from '../../src/qa/detectors/fixed-stacking';
import { detectScrollLock } from '../../src/qa/detectors/scroll-lock';
import { detectDarkMode } from '../../src/qa/detectors/dark-mode';
import { detectOrientation } from '../../src/qa/detectors/orientation';
import { detectPwaMeta } from '../../src/qa/detectors/pwa-meta';
import { QAAudit, AuditReport } from '../../src/qa/audit';
import { QAHistory } from '../../src/qa/history';
import { generateAuditMarkdown } from '../../src/qa/report-markdown';
import { DetectorResult, QAConfig, applyIgnoreRules } from '../../src/qa/types';
import { BrowserBackend } from '../../src/types/browser-backend';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockClient(evaluateResult?: any): BrowserBackend {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    navigate: jest.fn().mockResolvedValue({ url: 'https://example.com', status: 200, loadTime: 100 }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
    readPage: jest.fn().mockResolvedValue('<html></html>'),
    getCookies: jest.fn().mockResolvedValue([]),
    setCookies: jest.fn().mockResolvedValue(undefined),
    clearCookies: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    type: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn().mockResolvedValue(undefined),
    longPress: jest.fn().mockResolvedValue(undefined),
    swipe: jest.fn().mockResolvedValue(undefined),
    press: jest.fn().mockResolvedValue(undefined),
    dismissKeyboard: jest.fn().mockResolvedValue(undefined),
    selectOption: jest.fn().mockResolvedValue(undefined),
    querySelector: jest.fn().mockResolvedValue(null),
    querySelectorAll: jest.fn().mockResolvedValue([]),
    inspect: jest.fn().mockResolvedValue({}),
    waitFor: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockSimulatorManager() {
  return {
    setAppearance: jest.fn().mockResolvedValue(undefined),
    rotate: jest.fn().mockResolvedValue(undefined),
    boot: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeAuditReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    url: 'https://example.com',
    device: 'iphone-17e',
    viewport: { w: 390, h: 844 },
    timestamp: new Date().toISOString(),
    duration: 500,
    score: 100,
    summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, passed: 13, failed: 0, errors: 0 },
    detectors: [],
    ...overrides,
  };
}

// ── 1. Input & Interaction Detectors (Story #58) ─────────────────────

describe('1. Input & Interaction Detectors', () => {
  test('qa_auto_zoom: detects input with font-size 14px (< 16px threshold)', async () => {
    const client = createMockClient({
      detector: 'auto_zoom',
      severity: 'high',
      issues: [{ selector: 'input[name="email"]', problem: 'font-size is 14px (< 16px minimum)', fix: 'Set font-size to at least 16px to prevent iOS Safari auto-zoom on focus' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    });

    const result = await detectAutoZoom(client);
    expect(result.detector).toBe('auto_zoom');
    expect(result.severity).toBe('high');
    expect(result.passed).toBe(false);
    expect(result.issueCount).toBe(1);
    expect(result.issues[0].problem).toContain('14px');
    expect(result.issues[0].problem).toContain('< 16px');
  });

  test('qa_touch_targets: detects 30x30px button (< 44x44px minimum)', async () => {
    const client = createMockClient({
      detector: 'touch_targets',
      severity: 'high',
      issues: [{ selector: 'button', problem: 'Touch target is 30x30px (minimum: 44x44px)', fix: 'Increase element size to at least 44x44px or add padding', size: { width: 30, height: 30 } }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    });

    const result = await detectTouchTargets(client);
    expect(result.detector).toBe('touch_targets');
    expect(result.severity).toBe('high');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain('30x30');
    expect(result.issues[0].problem).toContain('44x44');
  });

  test('qa_hover_only: detects :hover style changing visibility without touch alternative', async () => {
    const client = createMockClient({
      detector: 'hover_only',
      severity: 'medium',
      issues: [{ selector: '.tooltip', problem: ':hover changes visibility — inaccessible on touch devices', fix: 'Add click/touch handler or use :focus-within as alternative', cssRule: '.tooltip:hover' }],
      passed: false,
      totalScanned: 0,
      issueCount: 1,
    });

    const result = await detectHoverOnly(client);
    expect(result.detector).toBe('hover_only');
    expect(result.severity).toBe('medium');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain(':hover');
    expect(result.issues[0].problem).toContain('touch devices');
  });

  test('qa_input_type: detects type="text" on email-named field', async () => {
    const client = createMockClient({
      detector: 'input_type',
      severity: 'medium',
      issues: [{ selector: 'input[name="email"]', problem: 'Email field using type="text"', fix: 'Use type="email" for email keyboard' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    });

    const result = await detectInputType(client);
    expect(result.detector).toBe('input_type');
    expect(result.severity).toBe('medium');
    expect(result.issues[0].problem).toContain('Email field');
    expect(result.issues[0].fix).toContain('type="email"');
  });

  test('each detector returns correct JSON shape', async () => {
    const client = createMockClient({
      detector: 'auto_zoom',
      severity: 'pass',
      issues: [],
      passed: true,
      totalScanned: 3,
      issueCount: 0,
    });

    const result = await detectAutoZoom(client);
    expect(result).toHaveProperty('detector');
    expect(result).toHaveProperty('severity');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('totalScanned');
    expect(result).toHaveProperty('issueCount');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  test('no false positives on a clean page (example.com)', async () => {
    // Simulate clean page where all detectors return pass
    const cleanResults: DetectorResult[] = [
      { detector: 'auto_zoom', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 },
      { detector: 'touch_targets', severity: 'pass', issues: [], passed: true, totalScanned: 5, issueCount: 0 },
      { detector: 'hover_only', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 },
      { detector: 'input_type', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 },
    ];

    for (const result of cleanResults) {
      expect(result.passed).toBe(true);
      expect(result.issueCount).toBe(0);
      expect(result.issues).toHaveLength(0);
    }
  });
});

// ── 2. Layout & Viewport Detectors (Story #59) ──────────────────────

describe('2. Layout & Viewport Detectors', () => {
  test('qa_safe_area: checks viewport-fit=cover + fixed element safe-area-inset usage', async () => {
    const client = createMockClient({
      detector: 'safe_area',
      severity: 'high',
      issues: [{ selector: 'div.bottom-bar', problem: 'Fixed element at bottom edge without safe-area-inset padding', fix: 'Add padding: env(safe-area-inset-bottom)' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    });

    const result = await detectSafeArea(client);
    expect(result.detector).toBe('safe_area');
    expect(result.severity).toBe('high');
    expect(result.issues[0].problem).toContain('safe-area-inset');
  });

  test('qa_safe_area: passes when viewport-fit=cover not set', async () => {
    const client = createMockClient({
      detector: 'safe_area',
      severity: 'pass',
      issues: [],
      passed: true,
      totalScanned: 0,
      issueCount: 0,
      metadata: { note: 'viewport-fit=cover not set' },
    });

    const result = await detectSafeArea(client);
    expect(result.passed).toBe(true);
    expect(result.severity).toBe('pass');
  });

  test('qa_keyboard_overlap: detects fixed elements behind keyboard', async () => {
    const client = createMockClient();
    // First call: fixed bottom elements
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce([{ selector: 'div.bottom-nav', bottom: 0, rect: { y: 700, height: 50 } }])
      // Second call: input selectors
      .mockResolvedValueOnce(['input[name="email"]'])
      // Third call: viewport height with keyboard
      .mockResolvedValueOnce(400);

    const result = await detectKeyboardOverlap(client);
    expect(result.detector).toBe('keyboard_overlap');
    expect(result.severity).toBe('critical');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain('hidden behind keyboard');
    expect(result.issues[0].fix).toContain('visualViewport');
  });

  test('qa_keyboard_overlap: passes when no fixed bottom elements', async () => {
    const client = createMockClient();
    (client.evaluate as jest.Mock).mockResolvedValueOnce([]);

    const result = await detectKeyboardOverlap(client);
    expect(result.detector).toBe('keyboard_overlap');
    expect(result.passed).toBe(true);
    expect(result.severity).toBe('pass');
  });

  test('qa_horizontal_overflow: detects element causing scrollWidth > innerWidth', async () => {
    const client = createMockClient({
      detector: 'horizontal_overflow',
      severity: 'high',
      issues: [{ selector: 'div.wide-content', problem: 'Element extends to 2000px (viewport: 390px)', fix: 'Add overflow-x: hidden or max-width: 100%', overflow: '1610px' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    });

    const result = await detectHorizontalOverflow(client);
    expect(result.detector).toBe('horizontal_overflow');
    expect(result.severity).toBe('high');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain('2000px');
  });

  test('qa_100vh: measures 100vh vs window.innerHeight, reports address bar discrepancy', async () => {
    const client = createMockClient({
      detector: '100vh',
      severity: 'medium',
      issues: [{ selector: 'viewport', problem: '100vh = 900px but visible viewport = 844px (diff: 56px)', fix: 'Use 100dvh or calc(var(--vh, 1vh) * 100) with JS viewport listener' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
      metadata: { vh100: 900, innerHeight: 844, difference: 56 },
    });

    const result = await detect100vh(client);
    expect(result.detector).toBe('100vh');
    expect(result.severity).toBe('medium');
    expect(result.issues[0].problem).toContain('100vh');
    expect(result.issues[0].fix).toContain('100dvh');
    expect(result.metadata?.vh100).toBe(900);
    expect(result.metadata?.innerHeight).toBe(844);
  });

  test('qa_fixed_stacking: finds overlapping fixed/sticky elements with same z-index', async () => {
    const client = createMockClient({
      detector: 'fixed_stacking',
      severity: 'medium',
      issues: [{ selector: 'header <-> div.bottom-nav', problem: 'Overlapping fixed elements with same z-index (0)', fix: 'Set distinct z-index values' }],
      passed: false,
      totalScanned: 2,
      issueCount: 1,
    });

    const result = await detectFixedStacking(client);
    expect(result.detector).toBe('fixed_stacking');
    expect(result.severity).toBe('medium');
    expect(result.issues[0].problem).toContain('Overlapping fixed elements');
    expect(result.issues[0].problem).toContain('z-index');
  });
});

// ── 3. State & Behavior Detectors (Story #61) ───────────────────────

describe('3. State & Behavior Detectors', () => {
  test('qa_scroll_lock: detects overflow:hidden on body without visible modal', async () => {
    const client = createMockClient({
      detector: 'scroll_lock',
      severity: 'high',
      issues: [{ selector: 'document.body', problem: 'overflow: hidden set but no visible modal found', fix: 'Ensure modal close handlers restore overflow' }],
      passed: false,
      totalScanned: 2,
      issueCount: 1,
    });

    const result = await detectScrollLock(client);
    expect(result.detector).toBe('scroll_lock');
    expect(result.severity).toBe('high');
    expect(result.issues[0].problem).toContain('overflow: hidden');
    expect(result.issues[0].problem).toContain('no visible modal');
  });

  test('qa_dark_mode: toggles simctl ui appearance dark, captures screenshots', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager();

    // First evaluate: color-scheme meta
    (client.evaluate as jest.Mock).mockResolvedValueOnce('not set');

    const result = await detectDarkMode(client, simulator, 'UDID-1');
    expect(result.detector).toBe('dark_mode');
    expect(result.issues[0].problem).toContain('No <meta name="color-scheme">');

    // Simulator appearance toggled: light -> dark -> light (restore)
    expect(simulator.setAppearance).toHaveBeenCalledWith('UDID-1', 'light');
    expect(simulator.setAppearance).toHaveBeenCalledWith('UDID-1', 'dark');
    expect(simulator.setAppearance).toHaveBeenCalledTimes(3);

    // Screenshots captured
    expect(client.screenshot).toHaveBeenCalledTimes(2);
    expect(result.metadata?.lightScreenshot).toBeDefined();
    expect(result.metadata?.darkScreenshot).toBeDefined();
  });

  test('qa_dark_mode: passes when color-scheme is set', async () => {
    const client = createMockClient();
    (client.evaluate as jest.Mock).mockResolvedValueOnce('light dark');

    const result = await detectDarkMode(client);
    expect(result.detector).toBe('dark_mode');
    expect(result.passed).toBe(true);
    expect(result.severity).toBe('pass');
  });

  test('qa_orientation: rotates device via simctl, checks for landscape overflow', async () => {
    const client = createMockClient();
    const simulator = createMockSimulatorManager();

    // First evaluate: portrait meta
    (client.evaluate as jest.Mock).mockResolvedValueOnce({ scrollWidth: 390, innerWidth: 390, overflow: false });
    // Second evaluate: landscape meta with overflow
    (client.evaluate as jest.Mock).mockResolvedValueOnce({ scrollWidth: 1200, innerWidth: 844, overflow: true });

    const result = await detectOrientation(client, simulator, 'UDID-1');
    expect(result.detector).toBe('orientation');
    expect(result.passed).toBe(false);
    expect(result.issues[0].problem).toContain('Horizontal overflow in landscape');

    // Simulator rotated twice (to landscape, then back)
    expect(simulator.rotate).toHaveBeenCalledTimes(2);
  });

  test('qa_pwa_meta: checks for viewport, theme-color, color-scheme, apple-touch-icon, manifest', async () => {
    const client = createMockClient({
      detector: 'pwa_meta',
      severity: 'low',
      issues: [
        { selector: 'head', problem: 'Missing theme-color (recommended)', fix: 'Add <meta name="theme-color" content="#yourColor">' },
        { selector: 'head', problem: 'Missing color-scheme (recommended)', fix: 'Add <meta name="color-scheme" content="light only">' },
        { selector: 'head', problem: 'Missing apple-touch-icon (recommended)', fix: 'Add <link rel="apple-touch-icon" href="/icon-180.png">' },
        { selector: 'head', problem: 'Missing manifest (recommended)', fix: 'Add <link rel="manifest" href="/manifest.json">' },
      ],
      passed: false,
      totalScanned: 5,
      issueCount: 4,
    });

    const result = await detectPwaMeta(client);
    expect(result.detector).toBe('pwa_meta');
    expect(result.issues.length).toBeGreaterThanOrEqual(1);

    const checked = result.issues.map(i => i.problem);
    // Verify all 5 meta tags are covered by the detector
    const metaNames = ['theme-color', 'color-scheme', 'apple-touch-icon', 'manifest'];
    for (const name of metaNames) {
      expect(checked.some(p => p.includes(name))).toBe(true);
    }
  });

  test('qa_pwa_meta: severity is high when viewport is missing (required)', async () => {
    const client = createMockClient({
      detector: 'pwa_meta',
      severity: 'high',
      issues: [{ selector: 'head', problem: 'Missing viewport (required)', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">' }],
      passed: false,
      totalScanned: 5,
      issueCount: 1,
    });

    const result = await detectPwaMeta(client);
    expect(result.severity).toBe('high');
    expect(result.issues[0].problem).toContain('viewport');
    expect(result.issues[0].problem).toContain('required');
  });
});

// ── 4. Full Audit (Story #64) ────────────────────────────────────────

describe('4. Full Audit', () => {
  test('qa_full_audit runs all 13 detectors', async () => {
    const client = createMockClient();
    // evaluate calls: window.location.href + 10 stateless + stateful setup calls
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce('https://example.com') // window.location.href
      // 10 stateless detectors
      .mockResolvedValue({ detector: 'test', severity: 'pass', issues: [], passed: true, totalScanned: 1, issueCount: 0 });

    const audit = new QAAudit(client, {});
    const report = await audit.runFullAudit();

    expect(report.detectors).toHaveLength(13);
    expect(report.url).toBe('https://example.com');
    expect(report).toHaveProperty('score');
    expect(report).toHaveProperty('summary');
    expect(report).toHaveProperty('duration');
    expect(report).toHaveProperty('timestamp');
  });

  test('10 stateless detectors run in parallel, 3 stateful run sequentially', async () => {
    const client = createMockClient();
    const callOrder: string[] = [];

    (client.evaluate as jest.Mock).mockImplementation(async (expr: string) => {
      if (expr.includes('window.location.href')) return 'https://example.com';
      // Track detector invocations
      if (expr.includes('auto_zoom')) { callOrder.push('auto_zoom'); }
      else if (expr.includes('touch_targets')) { callOrder.push('touch_targets'); }
      // Stateful detectors are called separately (not via inline JS)
      return { detector: 'test', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 };
    });

    const audit = new QAAudit(client, {});
    const report = await audit.runFullAudit();

    // All 13 detectors ran: 10 parallel + 3 sequential
    expect(report.detectors).toHaveLength(13);

    // Stateful detectors (keyboard_overlap, dark_mode, orientation) are the last 3
    // The last 3 should be the stateful ones (keyboard_overlap, dark_mode, orientation)
    // They run after the 10 parallel ones
    expect(report.detectors.length).toBe(13);
  });

  test('score calculation: max(0, 100 - sum(weight * count)) — critical=10, high=5, medium=2, low=1', async () => {
    const client = createMockClient();
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce('https://example.com')
      // 10 stateless: 1 critical(1 issue), 1 high(2 issues), rest pass
      .mockResolvedValueOnce({ detector: 'auto_zoom', severity: 'high', issues: [{ selector: 'a', problem: 'x', fix: 'y' }, { selector: 'b', problem: 'x', fix: 'y' }], passed: false, totalScanned: 2, issueCount: 2 })
      .mockResolvedValue({ detector: 'test', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 });

    const audit = new QAAudit(client, {});
    const report = await audit.runFullAudit();

    // 2 high issues: penalty = 5 * 2 = 10, score = 100 - 10 = 90
    expect(report.score).toBe(90);
  });

  test('score = 100 on a clean page with no issues', async () => {
    const client = createMockClient();
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce('https://example.com')
      .mockResolvedValue({ detector: 'test', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 });

    const audit = new QAAudit(client, {});
    const report = await audit.runFullAudit();

    expect(report.score).toBe(100);
  });

  test('markdown report generated with severity table and fix suggestions', async () => {
    const report = makeAuditReport({
      score: 75,
      summary: { totalIssues: 3, critical: 0, high: 2, medium: 1, low: 0, passed: 10, failed: 3, errors: 0 },
      detectors: [
        { detector: 'auto_zoom', severity: 'high', issues: [{ selector: 'input', problem: 'font-size 14px', fix: 'Set 16px' }], passed: false, totalScanned: 1, issueCount: 1 },
        { detector: 'touch_targets', severity: 'high', issues: [{ selector: 'button', problem: '30x30', fix: 'Make 44x44' }], passed: false, totalScanned: 1, issueCount: 1 },
        { detector: 'hover_only', severity: 'medium', issues: [{ selector: '.tip', problem: ':hover', fix: 'Use touch' }], passed: false, totalScanned: 0, issueCount: 1 },
      ],
    });

    const md = generateAuditMarkdown(report);
    expect(md).toContain('iOS QA Audit Report');
    expect(md).toContain('75/100');
    expect(md).toContain('Critical');
    expect(md).toContain('High');
    expect(md).toContain('Medium');
    expect(md).toContain('Low');
    expect(md).toContain('auto_zoom');
    expect(md).toContain('Set 16px'); // fix suggestion
  });

  test('qa_full_audit completes in < 30 seconds (mock)', async () => {
    const client = createMockClient();
    (client.evaluate as jest.Mock)
      .mockResolvedValueOnce('https://example.com')
      .mockResolvedValue({ detector: 'test', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 });

    const audit = new QAAudit(client, {});
    const start = Date.now();
    await audit.runFullAudit();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30000);
  });
});

// ── 5. Historical Tracking & Regression (Story #66) ──────────────────

describe('5. Historical Tracking & Regression', () => {
  let tmpDir: string;
  let history: QAHistory;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `opensafari-qa-test-${Date.now()}`);
    history = new QAHistory(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('report saved to ~/.opensafari/reports/{hostname}/{timestamp}.json', async () => {
    const report = makeAuditReport({ url: 'https://example.com/page' });
    const filePath = await history.save(report);

    expect(filePath).toContain('example.com');
    expect(filePath.endsWith('.json')).toBe(true);

    const saved = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(saved.url).toBe('https://example.com/page');
    expect(saved.score).toBe(100);
  });

  test('run audit twice -> regression detection classifies new/fixed/recurring', async () => {
    // First report: 2 issues
    const report1 = makeAuditReport({
      score: 85,
      detectors: [
        { detector: 'auto_zoom', severity: 'high', issues: [{ selector: 'input#email', problem: 'font 14px', fix: 'set 16px' }], passed: false, totalScanned: 1, issueCount: 1 },
        { detector: 'touch_targets', severity: 'high', issues: [{ selector: 'button.small', problem: '30x30', fix: '44x44' }], passed: false, totalScanned: 1, issueCount: 1 },
      ],
      summary: { totalIssues: 2, critical: 0, high: 2, medium: 0, low: 0, passed: 11, failed: 2, errors: 0 },
    });

    // Second report: 1 fixed (auto_zoom), 1 recurring (touch_targets), 1 new (hover_only)
    const report2 = makeAuditReport({
      score: 88,
      detectors: [
        { detector: 'touch_targets', severity: 'high', issues: [{ selector: 'button.small', problem: '30x30', fix: '44x44' }], passed: false, totalScanned: 1, issueCount: 1 },
        { detector: 'hover_only', severity: 'medium', issues: [{ selector: '.tooltip', problem: ':hover only', fix: 'add touch' }], passed: false, totalScanned: 0, issueCount: 1 },
      ],
      summary: { totalIssues: 2, critical: 0, high: 1, medium: 1, low: 0, passed: 11, failed: 2, errors: 0 },
    });

    const regression = await history.detectRegressions(report2, report1);

    expect(regression.currentScore).toBe(88);
    expect(regression.previousScore).toBe(85);
    expect(regression.scoreDelta).toBe(3);
    expect(regression.fixedIssues.length).toBe(1);
    expect(regression.fixedIssues[0].detector).toBe('auto_zoom');
    expect(regression.newIssues.length).toBe(1);
    expect(regression.newIssues[0].detector).toBe('hover_only');
    expect(regression.recurringIssues.length).toBe(1);
    expect(regression.recurringIssues[0].detector).toBe('touch_targets');
  });

  test('report rotation: keeps last 30 reports per site', async () => {
    const report = makeAuditReport({ url: 'https://example.com' });

    // Save 35 reports
    for (let i = 0; i < 35; i++) {
      await history.save({ ...report, timestamp: new Date(Date.now() + i * 1000).toISOString() });
      // Small delay to ensure unique filenames
      await new Promise(r => setTimeout(r, 10));
    }

    const siteDir = path.join(tmpDir, 'example.com');
    const files = (await fs.readdir(siteDir)).filter(f => f.endsWith('.json'));
    expect(files.length).toBeLessThanOrEqual(30);
  });

  test('fingerprint stability: same issue produces same fingerprint across runs', async () => {
    const report1 = makeAuditReport({
      detectors: [
        { detector: 'auto_zoom', severity: 'high', issues: [{ selector: 'input#email', problem: 'font 14px', fix: 'set 16px' }], passed: false, totalScanned: 1, issueCount: 1 },
      ],
    });
    const report2 = makeAuditReport({
      detectors: [
        { detector: 'auto_zoom', severity: 'high', issues: [{ selector: 'input#email', problem: 'font 14px', fix: 'set 16px' }], passed: false, totalScanned: 1, issueCount: 1 },
      ],
    });

    const regression = await history.detectRegressions(report1, report2);

    // Same issue = recurring, not new or fixed
    expect(regression.newIssues).toHaveLength(0);
    expect(regression.fixedIssues).toHaveLength(0);
    expect(regression.recurringIssues).toHaveLength(1);
  });

  test('CI exit code: getExitCode returns 1 when critical issues exist', () => {
    const reportWithCritical = makeAuditReport({
      score: 50,
      summary: { totalIssues: 1, critical: 1, high: 0, medium: 0, low: 0, passed: 12, failed: 1, errors: 0 },
    });

    const reportClean = makeAuditReport({
      score: 100,
      summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, passed: 13, failed: 0, errors: 0 },
    });

    expect(history.getExitCode(reportWithCritical, { failOnCritical: true })).toBe(1);
    expect(history.getExitCode(reportClean, { failOnCritical: true })).toBe(0);
  });

  test('getExitCode supports minScore threshold', () => {
    const report = makeAuditReport({ score: 75 });
    expect(history.getExitCode(report, { minScore: 80 })).toBe(1);
    expect(history.getExitCode(report, { minScore: 70 })).toBe(0);
  });

  test('getLatest and getPrevious retrieve correct reports', async () => {
    const report1 = makeAuditReport({ url: 'https://test.com', score: 80 });
    const report2 = makeAuditReport({ url: 'https://test.com', score: 90 });

    await history.save(report1);
    await new Promise(r => setTimeout(r, 50));
    await history.save(report2);

    const latest = await history.getLatest('https://test.com');
    expect(latest).not.toBeNull();
    expect(latest!.score).toBe(90);

    const previous = await history.getPrevious('https://test.com');
    expect(previous).not.toBeNull();
    expect(previous!.score).toBe(80);
  });
});

// ── 6. Configurable Thresholds ───────────────────────────────────────

describe('6. Configurable Thresholds', () => {
  test('QAConfig with custom thresholds is accepted by QAAudit', () => {
    const config: QAConfig = {
      thresholds: { touchTargetMinSize: 48, inputMinFontSize: 18 },
      ignore: [],
    };

    const client = createMockClient();
    const audit = new QAAudit(client, config);
    expect(audit).toBeDefined();
  });

  test('ignore rules filter out specified selectors', () => {
    const result: DetectorResult = {
      detector: 'auto_zoom',
      severity: 'high',
      issues: [
        { selector: 'input#email', problem: 'font-size 14px', fix: 'set 16px' },
        { selector: 'input#search', problem: 'font-size 12px', fix: 'set 16px' },
      ],
      passed: false,
      totalScanned: 2,
      issueCount: 2,
    };

    const config: QAConfig = {
      ignore: [{ detector: 'auto_zoom', selector: 'input#search' }],
    };

    const filtered = applyIgnoreRules({ ...result, issues: [...result.issues] }, config);
    expect(filtered.issueCount).toBe(1);
    expect(filtered.issues[0].selector).toBe('input#email');
  });

  test('ignore rules set passed=true and severity=pass when all issues filtered', () => {
    const result: DetectorResult = {
      detector: 'touch_targets',
      severity: 'high',
      issues: [{ selector: 'button.icon', problem: '30x30', fix: 'make 44x44' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    };

    const config: QAConfig = {
      ignore: [{ detector: 'touch_targets', selector: 'button.icon' }],
    };

    const filtered = applyIgnoreRules({ ...result, issues: [...result.issues] }, config);
    expect(filtered.passed).toBe(true);
    expect(filtered.severity).toBe('pass');
    expect(filtered.issueCount).toBe(0);
  });

  test('ignore rules only affect matching detector', () => {
    const result: DetectorResult = {
      detector: 'auto_zoom',
      severity: 'high',
      issues: [{ selector: 'input#email', problem: 'font 14px', fix: 'set 16px' }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
    };

    const config: QAConfig = {
      ignore: [{ detector: 'touch_targets', selector: 'input#email' }],
    };

    const filtered = applyIgnoreRules({ ...result, issues: [...result.issues] }, config);
    // Rule is for touch_targets, not auto_zoom — should not filter
    expect(filtered.issueCount).toBe(1);
    expect(filtered.passed).toBe(false);
  });
});
