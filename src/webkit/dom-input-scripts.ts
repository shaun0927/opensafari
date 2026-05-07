/**
 * DOM input script builders for WebKit and native input paths.
 *
 * Each function returns a JavaScript source string suitable for passing to
 * Runtime.evaluate / client.evaluate(). The builders are pure TypeScript
 * functions with no browser globals in module scope.
 *
 * Selector and text values are serialized with JSON.stringify() — never
 * hand-built string interpolation — so user-controlled strings with quotes,
 * backslashes, or Unicode are handled safely.
 */

// ── Tap / click ──────────────────────────────────────────────────────────────

export interface TapScriptOptions {
  x: number;
  y: number;
}

/**
 * Build a synchronous tap script: touchstart → touchend → click.
 * Uses `document.createTouch` / `document.createTouchList` for iOS Safari
 * compatibility — `new Touch()` is not supported in WebKit.
 */
export function buildTapScript(opts: TapScriptOptions): string {
  const { x, y } = opts;
  return `
(function(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return;
  var touch = document.createTouch(window, el, 1, x, y, x, y);
  var touchList = document.createTouchList(touch);
  var emptyList = document.createTouchList();
  el.dispatchEvent(new TouchEvent('touchstart', { touches: touchList, changedTouches: touchList, bubbles: true }));
  el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: touchList, bubbles: true }));
  el.click();
})(${x}, ${y})
`.trim();
}

// ── Long press ───────────────────────────────────────────────────────────────

export interface LongPressScriptOptions {
  x: number;
  y: number;
  /** Duration in milliseconds passed into the JS script. */
  durationMs: number;
}

/**
 * Build an async long-press script: touchstart → wait(durationMs) → touchend.
 * Returns a self-invoking async IIFE that resolves after the hold completes.
 */
export function buildLongPressScript(opts: LongPressScriptOptions): string {
  const { x, y, durationMs } = opts;
  return `
(async function(x, y, duration) {
  var el = document.elementFromPoint(x, y);
  if (!el) return;
  var touch = document.createTouch(window, el, 1, x, y, x, y);
  var touchList = document.createTouchList(touch);
  el.dispatchEvent(new TouchEvent('touchstart', { touches: touchList, changedTouches: touchList, bubbles: true }));
  await new Promise(function(r) { setTimeout(r, duration); });
  var emptyList = document.createTouchList();
  el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: touchList, bubbles: true }));
})(${x}, ${y}, ${durationMs})
`.trim();
}

// ── Swipe ─────────────────────────────────────────────────────────────────────

export interface SwipeScriptOptions {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Number of touchmove steps (default 10 for client.ts path, 20 for WebKitInputBackend). */
  steps: number;
  /** Delay between each step in milliseconds. */
  stepDelayMs: number;
  /**
   * When provided the script also calls window.scrollBy(scrollX, scrollY)
   * before emitting touch events. Used by WebKitInputBackend to supplement
   * native scroll (isTrusted:false JS touch events don't trigger it alone).
   */
  scroll?: { scrollX: number; scrollY: number };
}

/**
 * Build an async swipe script: touchstart → N×touchmove → touchend.
 * Optionally prepends a window.scrollBy() call for native scroll support.
 */
export function buildSwipeScript(opts: SwipeScriptOptions): string {
  const { startX, startY, endX, endY, steps, stepDelayMs, scroll } = opts;
  const scrollLine = scroll
    ? `  window.scrollBy(${scroll.scrollX}, ${scroll.scrollY});\n\n`
    : '';

  return `
(async function(sx, sy, ex, ey, steps, stepDelay) {
${scrollLine}  var el = document.elementFromPoint(sx, sy);
  if (!el) ${scroll ? 'el = document.body || document.documentElement' : 'return'};
  var makeTouch = function(x, y) { return document.createTouch(window, el, 1, x, y, x, y); };
  var startTouch = makeTouch(sx, sy);
  var startList = document.createTouchList(startTouch);
  el.dispatchEvent(new TouchEvent('touchstart', { touches: startList, changedTouches: startList, bubbles: true }));
  for (var i = 1; i <= steps; i++) {
    var x = sx + (ex - sx) * (i / steps);
    var y = sy + (ey - sy) * (i / steps);
    var moveTouch = makeTouch(x, y);
    var moveList = document.createTouchList(moveTouch);
    el.dispatchEvent(new TouchEvent('touchmove', { touches: moveList, changedTouches: moveList, bubbles: true }));
    await new Promise(function(r) { setTimeout(r, stepDelay); });
  }
  var endTouch = makeTouch(ex, ey);
  var endList = document.createTouchList(endTouch);
  var emptyList = document.createTouchList();
  el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: endList, bubbles: true }));
})(${startX}, ${startY}, ${endX}, ${endY}, ${steps}, ${stepDelayMs})
`.trim();
}

// JS source fragment that walks the prototype chain to find the native
// `value` property descriptor. Used by both buildSetValueScript and
// buildAppendCharScript.
const PROTO_VALUE_DESC_WALK = `
  var p = Object.getPrototypeOf(el);
  while (p && !Object.getOwnPropertyDescriptor(p, 'value')) {
    p = Object.getPrototypeOf(p);
  }
  var desc = p ? Object.getOwnPropertyDescriptor(p, 'value') : null;
`.trim();

// ── Value setter ─────────────────────────────────────────────────────────────

export interface SetValueScriptOptions {
  /** CSS selector serialized via JSON.stringify before embedding. */
  selector: string;
  /** New value; serialized via JSON.stringify before embedding. */
  value: string;
  /**
   * Which change events to dispatch after setting the value.
   * 'input-change' dispatches both input and change events (fast-type / select path).
   * 'input-only' dispatches only the input event (character-by-character accumulate path).
   */
  dispatchEvents: 'input-change' | 'input-only';
}

/**
 * Build a script that sets an input/select element's value via the prototype
 * chain native setter (avoids cross-realm TypeError with
 * window.HTMLInputElement.prototype) and dispatches DOM events.
 *
 * The selector and value are embedded with JSON.stringify() so user-
 * controlled strings with quotes, backslashes, or Unicode are safe.
 */
export function buildSetValueScript(opts: SetValueScriptOptions): string {
  const { selector, value, dispatchEvents } = opts;
  const selectorJson = JSON.stringify(selector);
  const valueJson = JSON.stringify(value);

  const changeEvent =
    dispatchEvents === 'input-change'
      ? `  el.dispatchEvent(new Event('change', { bubbles: true }));`
      : '';

  return `
(function() {
  var el = document.querySelector(${selectorJson});
  if (!el) return;
  ${PROTO_VALUE_DESC_WALK}
  if (desc && desc.set) {
    desc.set.call(el, ${valueJson});
  } else {
    el.value = ${valueJson};
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
${changeEvent}})()
`.trim();
}

// ── Value appender (character accumulate path) ────────────────────────────────

export interface AppendCharScriptOptions {
  /** CSS selector serialized via JSON.stringify before embedding. */
  selector: string;
  /** Character to append; serialized via JSON.stringify before embedding. */
  char: string;
}

/**
 * Build a script that appends a single character to an input's current value
 * via the prototype-chain native getter+setter. Used by the character-by-
 * character typing path with inter-character delay.
 *
 * The selector and char are embedded with JSON.stringify() so special
 * characters are safe.
 */
export function buildAppendCharScript(opts: AppendCharScriptOptions): string {
  const { selector, char } = opts;
  const selectorJson = JSON.stringify(selector);
  const charJson = JSON.stringify(char);

  return `
(function() {
  var el = document.querySelector(${selectorJson});
  if (!el) return;
  ${PROTO_VALUE_DESC_WALK}
  el.dispatchEvent(new KeyboardEvent('keydown', { key: ${charJson}, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keypress', { key: ${charJson}, bubbles: true }));
  if (desc || ('value' in el)) {
    var val = (desc && desc.get) ? desc.get.call(el) : (el.value || '');
    if (desc && desc.set) {
      desc.set.call(el, val + ${charJson});
    } else {
      el.value = val + ${charJson};
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: ${charJson}, bubbles: true }));
})()
`.trim();
}
