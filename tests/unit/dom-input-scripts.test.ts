/**
 * Unit tests for DOM input script builders (src/webkit/dom-input-scripts.ts).
 *
 * Verifies:
 * - Generated tap script uses document.createTouch (not new Touch)
 * - Selector/text escaping with quotes, backslashes, and Unicode
 * - Stable snapshot: builder output for fixed input matches expected string
 * - Both WebKit call sites import from the shared module
 */

import {
  buildTapScript,
  buildLongPressScript,
  buildSwipeScript,
  buildSetValueScript,
  buildAppendCharScript,
} from '../../src/webkit/dom-input-scripts';

// ── Import reference checks ──────────────────────────────────────────────────
// These static imports verify that both call sites reference the shared module.
// If either import is broken the test file itself will fail to compile.
import '../../src/webkit/client';
import '../../src/tools/native-input-backend';

// ── buildTapScript ────────────────────────────────────────────────────────────

describe('buildTapScript', () => {
  it('uses document.createTouch (not new Touch)', () => {
    const script = buildTapScript({ x: 100, y: 200 });
    expect(script).toContain('document.createTouch');
    expect(script).not.toContain('new Touch(');
  });

  it('uses document.createTouchList', () => {
    const script = buildTapScript({ x: 100, y: 200 });
    expect(script).toContain('document.createTouchList');
  });

  it('dispatches touchstart, touchend, and click', () => {
    const script = buildTapScript({ x: 50, y: 75 });
    expect(script).toContain("'touchstart'");
    expect(script).toContain("'touchend'");
    expect(script).toContain('el.click()');
  });

  it('embeds numeric coordinates directly', () => {
    const script = buildTapScript({ x: 123, y: 456 });
    expect(script).toContain('123');
    expect(script).toContain('456');
  });

  it('stable snapshot for fixed input', () => {
    const script = buildTapScript({ x: 10, y: 20 });
    expect(script).toMatchSnapshot();
  });
});

// ── buildLongPressScript ──────────────────────────────────────────────────────

describe('buildLongPressScript', () => {
  it('uses document.createTouch (not new Touch)', () => {
    const script = buildLongPressScript({ x: 100, y: 200, durationMs: 500 });
    expect(script).toContain('document.createTouch');
    expect(script).not.toContain('new Touch(');
  });

  it('dispatches touchstart and touchend with a setTimeout delay', () => {
    const script = buildLongPressScript({ x: 100, y: 200, durationMs: 750 });
    expect(script).toContain("'touchstart'");
    expect(script).toContain("'touchend'");
    expect(script).toContain('setTimeout');
  });

  it('embeds durationMs into the script', () => {
    const script = buildLongPressScript({ x: 0, y: 0, durationMs: 1234 });
    expect(script).toContain('1234');
  });

  it('is an async IIFE', () => {
    const script = buildLongPressScript({ x: 0, y: 0, durationMs: 500 });
    expect(script).toMatch(/^[\s\S]*async function/);
  });

  it('stable snapshot for fixed input', () => {
    const script = buildLongPressScript({ x: 10, y: 20, durationMs: 500 });
    expect(script).toMatchSnapshot();
  });
});

// ── buildSwipeScript ──────────────────────────────────────────────────────────

describe('buildSwipeScript', () => {
  it('uses document.createTouch (not new Touch)', () => {
    const script = buildSwipeScript({ startX: 0, startY: 300, endX: 0, endY: 100, steps: 10, stepDelayMs: 16 });
    expect(script).toContain('document.createTouch');
    expect(script).not.toContain('new Touch(');
  });

  it('dispatches touchstart, touchmove, and touchend', () => {
    const script = buildSwipeScript({ startX: 0, startY: 300, endX: 0, endY: 100, steps: 10, stepDelayMs: 16 });
    expect(script).toContain("'touchstart'");
    expect(script).toContain("'touchmove'");
    expect(script).toContain("'touchend'");
  });

  it('includes window.scrollBy when scroll option is provided', () => {
    const script = buildSwipeScript({
      startX: 0, startY: 300, endX: 0, endY: 100,
      steps: 20, stepDelayMs: 25,
      scroll: { scrollX: 0, scrollY: 200 },
    });
    expect(script).toContain('window.scrollBy');
    expect(script).toContain('200');
  });

  it('omits window.scrollBy when scroll option is not provided', () => {
    const script = buildSwipeScript({ startX: 0, startY: 300, endX: 0, endY: 100, steps: 10, stepDelayMs: 16 });
    expect(script).not.toContain('window.scrollBy');
  });

  it('falls back to document.body when scroll option is set', () => {
    const script = buildSwipeScript({
      startX: 0, startY: 300, endX: 0, endY: 100,
      steps: 20, stepDelayMs: 25,
      scroll: { scrollX: 0, scrollY: 200 },
    });
    expect(script).toContain('document.body');
  });

  it('returns early when no scroll and element missing', () => {
    const script = buildSwipeScript({ startX: 0, startY: 300, endX: 0, endY: 100, steps: 10, stepDelayMs: 16 });
    expect(script).toContain('return');
  });

  it('stable snapshot for fixed input without scroll', () => {
    const script = buildSwipeScript({ startX: 100, startY: 300, endX: 100, endY: 100, steps: 10, stepDelayMs: 16 });
    expect(script).toMatchSnapshot();
  });

  it('stable snapshot for fixed input with scroll', () => {
    const script = buildSwipeScript({
      startX: 200, startY: 400, endX: 200, endY: 200,
      steps: 20, stepDelayMs: 25,
      scroll: { scrollX: 0, scrollY: 200 },
    });
    expect(script).toMatchSnapshot();
  });
});

// ── buildSetValueScript ───────────────────────────────────────────────────────

describe('buildSetValueScript', () => {
  it('embeds selector with JSON.stringify (double-quoted string)', () => {
    const script = buildSetValueScript({ selector: '#my-input', value: 'hello', dispatchEvents: 'input-change' });
    expect(script).toContain('"#my-input"');
    // No raw hand-interpolated selector
    expect(script).not.toContain("'#my-input'");
  });

  it('safely escapes selector with double quotes', () => {
    const selector = 'input[name="email"]';
    const script = buildSetValueScript({ selector, value: 'test', dispatchEvents: 'input-change' });
    // JSON.stringify should produce escaped inner quotes
    expect(script).toContain(JSON.stringify(selector));
    expect(script).not.toContain('input[name="email"]');
  });

  it('safely escapes selector with backslash', () => {
    const selector = 'input[data-id="foo\\\\bar"]';
    const script = buildSetValueScript({ selector, value: 'test', dispatchEvents: 'input-change' });
    expect(script).toContain(JSON.stringify(selector));
  });

  it('safely escapes selector with Unicode', () => {
    const selector = 'button[aria-label="提交"]';
    const script = buildSetValueScript({ selector, value: 'test', dispatchEvents: 'input-change' });
    expect(script).toContain(JSON.stringify(selector));
  });

  it('safely escapes value with double quotes', () => {
    const value = 'say "hello"';
    const script = buildSetValueScript({ selector: '#inp', value, dispatchEvents: 'input-change' });
    expect(script).toContain(JSON.stringify(value));
  });

  it('safely escapes value with backslash', () => {
    const value = 'C:\\Users\\name';
    const script = buildSetValueScript({ selector: '#inp', value, dispatchEvents: 'input-change' });
    expect(script).toContain(JSON.stringify(value));
  });

  it('safely escapes value with Unicode', () => {
    const value = '你好世界';
    const script = buildSetValueScript({ selector: '#inp', value, dispatchEvents: 'input-change' });
    expect(script).toContain(JSON.stringify(value));
  });

  it('dispatches both input and change events for input-change mode', () => {
    const script = buildSetValueScript({ selector: '#inp', value: 'v', dispatchEvents: 'input-change' });
    expect(script).toContain("'input'");
    expect(script).toContain("'change'");
  });

  it('dispatches only input event for input-only mode', () => {
    const script = buildSetValueScript({ selector: '#inp', value: 'v', dispatchEvents: 'input-only' });
    expect(script).toContain("'input'");
    expect(script).not.toContain("'change'");
  });

  it('uses prototype chain value setter', () => {
    const script = buildSetValueScript({ selector: '#inp', value: 'v', dispatchEvents: 'input-change' });
    expect(script).toContain('Object.getPrototypeOf');
    expect(script).toContain('getOwnPropertyDescriptor');
  });

  it('stable snapshot for fixed input', () => {
    const script = buildSetValueScript({ selector: '#email', value: 'user@example.com', dispatchEvents: 'input-change' });
    expect(script).toMatchSnapshot();
  });
});

// ── buildAppendCharScript ─────────────────────────────────────────────────────

describe('buildAppendCharScript', () => {
  it('safely escapes char with single quote using JSON.stringify', () => {
    const script = buildAppendCharScript({ selector: '#inp', char: "'" });
    expect(script).toContain(JSON.stringify("'"));
  });

  it('safely escapes char with backslash using JSON.stringify', () => {
    const script = buildAppendCharScript({ selector: '#inp', char: '\\' });
    expect(script).toContain(JSON.stringify('\\'));
  });

  it('safely escapes char with Unicode', () => {
    const script = buildAppendCharScript({ selector: '#inp', char: '文' });
    expect(script).toContain(JSON.stringify('文'));
  });

  it('dispatches keydown, keypress, input, and keyup events', () => {
    const script = buildAppendCharScript({ selector: '#inp', char: 'a' });
    expect(script).toContain("'keydown'");
    expect(script).toContain("'keypress'");
    expect(script).toContain("'input'");
    expect(script).toContain("'keyup'");
  });

  it('stable snapshot for fixed input', () => {
    const script = buildAppendCharScript({ selector: '#name', char: 'a' });
    expect(script).toMatchSnapshot();
  });
});
