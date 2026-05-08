/**
 * dom-input-scripts.ts — DOM script builders for WebKit browser input commands.
 *
 * Centralizes the inline JS strings used by click, swipe, type, longPress commands.
 * All scripts use document.createTouch() / document.createTouchList() — never new Touch().
 * All scripts use the prototype-walk value-setter pattern to avoid cross-realm TypeError.
 *
 * (#706 4/5 — extracted from client.ts)
 */

// ========== Click / Tap ==========

/**
 * Build a tap script that dispatches touchstart → touchend → click at (x, y).
 * Uses document.createTouch for iOS Safari compatibility.
 */
export function buildTapScript(x: number, y: number): string {
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
  `;
}

// ========== Long Press ==========

/**
 * Build a long-press script that holds touchstart for `duration` ms then fires touchend.
 */
export function buildLongPressScript(x: number, y: number, duration: number): string {
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
    })(${x}, ${y}, ${duration})
  `;
}

// ========== Swipe ==========

/**
 * Build a swipe script that generates touchstart → N touchmove → touchend.
 */
export function buildSwipeScript(sx: number, sy: number, ex: number, ey: number, steps: number): string {
  return `
    (async function(sx, sy, ex, ey, steps) {
      var el = document.elementFromPoint(sx, sy);
      if (!el) return;
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
        await new Promise(function(r) { setTimeout(r, 16); });
      }
      var endTouch = makeTouch(ex, ey);
      var endList = document.createTouchList(endTouch);
      var emptyList = document.createTouchList();
      el.dispatchEvent(new TouchEvent('touchend', { touches: emptyList, changedTouches: endList, bubbles: true }));
    })(${sx}, ${sy}, ${ex}, ${ey}, ${steps})
  `;
}

// ========== Type / Set Value ==========

/**
 * Build a script that focuses a selector element and sets its value directly,
 * then dispatches input + change events. Uses prototype-walk value setter to
 * avoid cross-realm TypeError with window.HTMLInputElement.prototype.
 */
export function buildSetValueScript(selector: string, text: string): string {
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(text);
  return `
    (function() {
      var el = document.querySelector(${sel});
      if (!el) return;
      var p = Object.getPrototypeOf(el);
      while (p && !Object.getOwnPropertyDescriptor(p, 'value')) {
        p = Object.getPrototypeOf(p);
      }
      var desc = p ? Object.getOwnPropertyDescriptor(p, 'value') : null;
      if (desc && desc.set) {
        desc.set.call(el, ${val});
      } else {
        el.value = ${val};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `;
}

/**
 * Build a script that appends a single character to an input, dispatching
 * keydown / keypress / input / keyup events. Used in character-by-character mode.
 */
export function buildTypeCharScript(selector: string, char: string): string {
  const sel = JSON.stringify(selector);
  const ch = JSON.stringify(char);
  return `
    (function() {
      var el = document.querySelector(${sel});
      if (!el) return;
      var ev = new KeyboardEvent('keydown', { key: ${ch}, bubbles: true });
      el.dispatchEvent(ev);
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ${ch}, bubbles: true }));
      var p = Object.getPrototypeOf(el);
      while (p && !Object.getOwnPropertyDescriptor(p, 'value')) {
        p = Object.getPrototypeOf(p);
      }
      var desc = p ? Object.getOwnPropertyDescriptor(p, 'value') : null;
      if (desc && desc.set) {
        desc.set.call(el, el.value + ${ch});
      } else {
        el.value += ${ch};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ${ch}, bubbles: true }));
    })()
  `;
}

/**
 * Build a script that focuses a selector element.
 * preventScroll prevents iOS Safari from auto-scrolling on focus.
 */
export function buildFocusScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `
    (function() {
      var el = document.querySelector(${sel});
      if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
    })()
  `;
}

// ========== Select ==========

/**
 * Build a script that sets a <select> element's value and dispatches input + change.
 * Uses prototype-walk setter to avoid cross-realm TypeError.
 */
export function buildSelectOptionScript(selector: string, value: string): string {
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(value);
  return `
    (function() {
      var el = document.querySelector(${sel});
      if (!el || el.tagName !== 'SELECT') return;
      var p = Object.getPrototypeOf(el);
      while (p && !Object.getOwnPropertyDescriptor(p, 'value')) {
        p = Object.getPrototypeOf(p);
      }
      var desc = p ? Object.getOwnPropertyDescriptor(p, 'value') : null;
      if (desc && desc.set) {
        desc.set.call(el, ${val});
      } else {
        el.value = ${val};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `;
}
