/**
 * Unit tests for src/utils/coordinate-space.ts
 *
 * Verifies macOS-screen-pt → iOS-pt coordinate conversion (#693 WU3).
 */

import { convertMacOSPtToIOSPt } from '../../src/utils/coordinate-space';
import type { Size2D, Point2D } from '../../src/utils/coordinate-space';

// iPhone 17 Pro reference sizes
const IPHONE_17_PRO_MACOS_PT: Size2D = { width: 697, height: 1515 };
const IPHONE_17_PRO_IOS_PT: Size2D = { width: 402, height: 874 };

describe('convertMacOSPtToIOSPt', () => {
  it('scales correctly for iPhone 17 Pro ~1.733× ratio', () => {
    // macOS-pt center from AX frame: (609.875, 1386.73)
    // Expected iOS-pt: x = 609.875 * (402/697) ≈ 351.75
    //                  y = 1386.73 * (874/1515) ≈ 800.00
    const input: Point2D = { x: 609.875, y: 1386.73 };
    const result = convertMacOSPtToIOSPt(input, IPHONE_17_PRO_MACOS_PT, IPHONE_17_PRO_IOS_PT);

    expect(result.x).toBeCloseTo(351.75, 1);
    expect(result.y).toBeCloseTo(800.00, 1);
  });

  it('returns identity when scale is 1.0 (macOS size equals iOS size)', () => {
    const size: Size2D = { width: 390, height: 844 };
    const input: Point2D = { x: 195, y: 422 };
    const result = convertMacOSPtToIOSPt(input, size, size);

    expect(result.x).toBeCloseTo(195, 5);
    expect(result.y).toBeCloseTo(422, 5);
  });

  it('applies asymmetric scale independently on each axis', () => {
    // x scale = 2.0, y scale = 0.5
    const macOS: Size2D = { width: 100, height: 200 };
    const ios: Size2D = { width: 200, height: 100 };
    const input: Point2D = { x: 50, y: 80 };
    const result = convertMacOSPtToIOSPt(input, macOS, ios);

    // x: 50 * (200/100) = 100
    // y: 80 * (100/200) = 40
    expect(result.x).toBeCloseTo(100, 5);
    expect(result.y).toBeCloseTo(40, 5);
  });

  it('returns input unchanged when deviceContentMacOSPt is undefined', () => {
    const input: Point2D = { x: 200, y: 300 };
    const ios: Size2D = { width: 402, height: 874 };
    const result = convertMacOSPtToIOSPt(input, undefined, ios);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when deviceContentMacOSPt is null', () => {
    const input: Point2D = { x: 200, y: 300 };
    const ios: Size2D = { width: 402, height: 874 };
    const result = convertMacOSPtToIOSPt(input, null, ios);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when iosPtSize is undefined', () => {
    const input: Point2D = { x: 200, y: 300 };
    const macOS: Size2D = { width: 697, height: 1515 };
    const result = convertMacOSPtToIOSPt(input, macOS, undefined);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when iosPtSize is null', () => {
    const input: Point2D = { x: 200, y: 300 };
    const macOS: Size2D = { width: 697, height: 1515 };
    const result = convertMacOSPtToIOSPt(input, macOS, null);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when macOSPtSize width is zero (avoids division by zero)', () => {
    const input: Point2D = { x: 200, y: 300 };
    const macOS: Size2D = { width: 0, height: 1515 };
    const ios: Size2D = { width: 402, height: 874 };
    const result = convertMacOSPtToIOSPt(input, macOS, ios);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when macOSPtSize height is zero (avoids division by zero)', () => {
    const input: Point2D = { x: 200, y: 300 };
    const macOS: Size2D = { width: 697, height: 0 };
    const ios: Size2D = { width: 402, height: 874 };
    const result = convertMacOSPtToIOSPt(input, macOS, ios);

    expect(result).toEqual(input);
  });

  it('returns input unchanged when a dimension is NaN', () => {
    const input: Point2D = { x: 200, y: 300 };
    const macOS: Size2D = { width: NaN, height: 1515 };
    const ios: Size2D = { width: 402, height: 874 };
    const result = convertMacOSPtToIOSPt(input, macOS, ios);

    expect(result).toEqual(input);
  });

  it('preserves zero-valued input coordinates (origin tap)', () => {
    const input: Point2D = { x: 0, y: 0 };
    const result = convertMacOSPtToIOSPt(input, IPHONE_17_PRO_MACOS_PT, IPHONE_17_PRO_IOS_PT);

    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});
