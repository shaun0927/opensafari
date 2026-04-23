/**
 * Raw-tap coordinate bounds guard.
 *
 * iOS Simulator taps that land outside the device frame — or inside the
 * bottom home-indicator band — are routinely reinterpreted as home-gesture
 * swipes, which silently drop the foreground app and expose SpringBoard
 * (see issue #644). Validating coordinates before dispatching the tap lets
 * `app_tap` return a structured `out_of_bounds` side effect instead of
 * executing a destructive no-op.
 *
 * The guard is additive over the existing `sanitizeTapTarget` in
 * `app-tap-element.ts` (which only clamps negative values); this module is
 * focused on the raw coordinate path that `app_tap` uses.
 */

import type { AXNode } from '../native/ax-types';

/**
 * Bottom gutter treated as the home-indicator swipe zone. Empirically the
 * iOS home-indicator hit area extends ~20 pt on modern devices, so taps in
 * the bottom 10 pt are almost always misrouted as home-gesture swipes.
 */
export const DEFAULT_HOME_INDICATOR_GUARD_PX = 10;

export interface DeviceFrame {
  width: number;
  height: number;
}

export interface ValidateRawTapParams {
  x: number;
  y: number;
  frame: DeviceFrame;
  /** Override the default home-indicator guard band (px). */
  homeIndicatorGuardPx?: number;
}

export type BoundsRejectionReason =
  | 'x_out_of_bounds'
  | 'y_out_of_bounds'
  | 'home_indicator_band';

export type ValidateRawTapResult =
  | { ok: true }
  | {
      ok: false;
      reason: BoundsRejectionReason;
      detail: string;
    };

/**
 * Check whether a raw coordinate tap would land inside the actionable
 * portion of the device frame. Coordinates must already be finite
 * (callers should reject NaN / Infinity before calling this).
 *
 * Returns `{ ok: true }` when the tap is safe to dispatch. Otherwise
 * returns a structured rejection with a short human-readable detail so
 * the caller can surface it as `sideEffect: "out_of_bounds"`.
 */
export function validateRawTapBounds(
  params: ValidateRawTapParams,
): ValidateRawTapResult {
  const {
    x,
    y,
    frame,
    homeIndicatorGuardPx = DEFAULT_HOME_INDICATOR_GUARD_PX,
  } = params;

  if (x < 0 || x > frame.width) {
    return {
      ok: false,
      reason: 'x_out_of_bounds',
      detail: `x=${x} is outside the device frame width ${frame.width}`,
    };
  }

  const guard = Math.max(0, homeIndicatorGuardPx);
  const safeBottom = frame.height - guard;

  if (y < 0 || y > frame.height) {
    return {
      ok: false,
      reason: 'y_out_of_bounds',
      detail: `y=${y} is outside the device frame height ${frame.height}`,
    };
  }

  if (y > safeBottom) {
    return {
      ok: false,
      reason: 'home_indicator_band',
      detail:
        `y=${y} falls inside the bottom ${guard}px home-indicator guard ` +
        `band (safe max y=${safeBottom}); the tap would likely be ` +
        `reinterpreted as a home-gesture swipe.`,
    };
  }

  return { ok: true };
}

/**
 * Derive the device frame from the root AX node. The Simulator AX root
 * reports the window content frame in simulator-normalized coordinates;
 * we take the first non-zero frame so nested chrome wrappers (rare) do
 * not throw off the bounds check.
 */
export function frameFromAXRoot(root: AXNode | null): DeviceFrame | null {
  if (!root) return null;
  const seed = root.frame;
  if (seed && seed.width > 0 && seed.height > 0) {
    return { width: seed.width, height: seed.height };
  }
  for (const child of root.children ?? []) {
    const childFrame = frameFromAXRoot(child);
    if (childFrame) return childFrame;
  }
  return null;
}
