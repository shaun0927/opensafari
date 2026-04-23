/**
 * Unit tests for raw-tap bounds guard (issue #644 WU2).
 */

import type { AXNode } from '../../src/native/ax-types';
import {
  DEFAULT_HOME_INDICATOR_GUARD_PX,
  frameFromAXRoot,
  validateRawTapBounds,
} from '../../src/tools/tap-bounds';

describe('validateRawTapBounds', () => {
  const frame = { width: 393, height: 852 };

  it('accepts coordinates well inside the device frame', () => {
    const result = validateRawTapBounds({ x: 100, y: 200, frame });
    expect(result.ok).toBe(true);
  });

  it('accepts coordinates exactly on the top/left edge', () => {
    const result = validateRawTapBounds({ x: 0, y: 0, frame });
    expect(result.ok).toBe(true);
  });

  it('accepts the right edge but rejects past it', () => {
    expect(validateRawTapBounds({ x: 393, y: 300, frame }).ok).toBe(true);
    const past = validateRawTapBounds({ x: 394, y: 300, frame });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe('x_out_of_bounds');
  });

  it('rejects negative x as out of bounds', () => {
    const result = validateRawTapBounds({ x: -1, y: 100, frame });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('x_out_of_bounds');
      expect(result.detail).toContain('x=-1');
    }
  });

  it('rejects negative y as out of bounds', () => {
    const result = validateRawTapBounds({ x: 100, y: -5, frame });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('y_out_of_bounds');
  });

  it('rejects y past the frame height as out of bounds (not home-indicator)', () => {
    const result = validateRawTapBounds({ x: 100, y: 900, frame });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('y_out_of_bounds');
  });

  it('rejects y inside the bottom home-indicator band', () => {
    const y = frame.height - 5; // inside the default 10 px guard band
    const result = validateRawTapBounds({ x: 100, y, frame });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('home_indicator_band');
      expect(result.detail).toContain('home-indicator');
    }
  });

  it('respects a custom home-indicator guard band', () => {
    const result = validateRawTapBounds({
      x: 100,
      y: frame.height - 20,
      frame,
      homeIndicatorGuardPx: 32,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('home_indicator_band');
  });

  it('lets y right up to the safe bottom pass (home_indicator band excluded)', () => {
    const safeY = frame.height - DEFAULT_HOME_INDICATOR_GUARD_PX;
    const result = validateRawTapBounds({ x: 100, y: safeY, frame });
    expect(result.ok).toBe(true);
  });

  it('treats a zero guard as "no home-indicator band" (still rejects OOB)', () => {
    const result = validateRawTapBounds({
      x: 100,
      y: frame.height,
      frame,
      homeIndicatorGuardPx: 0,
    });
    expect(result.ok).toBe(true);
  });
});

describe('frameFromAXRoot', () => {
  function node(
    frame: { x: number; y: number; width: number; height: number },
    children?: AXNode[],
  ): AXNode {
    return {
      role: 'AXWindow',
      traits: [],
      frame,
      visible: true,
      enabled: true,
      focused: false,
      path: '',
      children,
    };
  }

  it('returns the root frame when it has nonzero size', () => {
    const root = node({ x: 0, y: 0, width: 393, height: 852 });
    expect(frameFromAXRoot(root)).toEqual({ width: 393, height: 852 });
  });

  it('descends into children when the root frame has zero size', () => {
    const root = node({ x: 0, y: 0, width: 0, height: 0 }, [
      node({ x: 0, y: 0, width: 375, height: 812 }),
    ]);
    expect(frameFromAXRoot(root)).toEqual({ width: 375, height: 812 });
  });

  it('returns null when no descendant has a nonzero frame', () => {
    const root = node({ x: 0, y: 0, width: 0, height: 0 });
    expect(frameFromAXRoot(root)).toBeNull();
  });

  it('returns null when the root is null', () => {
    expect(frameFromAXRoot(null)).toBeNull();
  });
});
