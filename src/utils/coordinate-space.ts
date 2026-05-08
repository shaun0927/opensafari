/**
 * coordinate-space — helpers for converting AX-frame coordinates between
 * macOS-screen-points and iOS-points.
 *
 * Background (#693 WU3):
 *   ax-bridge-native reports element frames in macOS-screen-points relative to
 *   the device-content-root. sim-hid-bridge and simctl both consume
 *   iOS-points (the logical point space of the device under test, e.g. 402×874
 *   for iPhone 17 Pro). The ratio is ~1.733×, so a tap dispatched at the raw
 *   AX-frame center lands ~73% of the way across the device instead of at the
 *   intended target.
 *
 *   PR #695 (already merged) emits `deviceContentMacOSPt: { width, height }`
 *   on the AX dump root / query result. This module converts coordinates using
 *   that size paired with the known iOS-point size of the device.
 */

/** A 2-D size in a given coordinate space. */
export interface Size2D {
  width: number;
  height: number;
}

/** A 2-D point. */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * Convert a point from macOS-screen-points (AX frame space) to iOS-points
 * (sim-hid / simctl input space).
 *
 * Scale factor per axis = iosPtSize / macOSPtSize.
 *
 * Fallback: when either size argument is falsy, or when either dimension is
 * zero or non-finite, the input point is returned unchanged so callers that
 * lack the necessary metadata transparently preserve the previous behavior.
 */
export function convertMacOSPtToIOSPt(
  point: Point2D,
  macOSPtSize: Size2D | undefined | null,
  iosPtSize: Size2D | undefined | null,
): Point2D {
  if (
    !macOSPtSize ||
    !iosPtSize ||
    !Number.isFinite(macOSPtSize.width) ||
    !Number.isFinite(macOSPtSize.height) ||
    macOSPtSize.width === 0 ||
    macOSPtSize.height === 0 ||
    !Number.isFinite(iosPtSize.width) ||
    !Number.isFinite(iosPtSize.height) ||
    iosPtSize.width === 0 ||
    iosPtSize.height === 0
  ) {
    return point;
  }

  return {
    x: point.x * (iosPtSize.width / macOSPtSize.width),
    y: point.y * (iosPtSize.height / macOSPtSize.height),
  };
}
