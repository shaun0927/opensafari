import { PNG } from 'pngjs';
import { VisualDiffEngine } from '../../src/comparison/visual-diff';

/** Create a solid-color PNG and return it as base64 */
function createTestPNG(width: number, height: number, color: { r: number; g: number; b: number }): string {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255; // alpha
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

/** Create a PNG with a colored region on a white background */
function createTestPNGWithRegion(
  width: number,
  height: number,
  region: { x: number; y: number; w: number; h: number },
  regionColor: { r: number; g: number; b: number },
): string {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inRegion =
        x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h;

      if (inRegion) {
        png.data[idx] = regionColor.r;
        png.data[idx + 1] = regionColor.g;
        png.data[idx + 2] = regionColor.b;
      } else {
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
      }
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

describe('VisualDiffEngine', () => {
  let engine: VisualDiffEngine;

  beforeEach(() => {
    engine = new VisualDiffEngine();
  });

  describe('compare', () => {
    it('should report identical images as similarity=1 with no diff regions', async () => {
      const image = createTestPNG(100, 100, { r: 128, g: 128, b: 128 });

      const result = await engine.compare(image, image, 'iPhone 15', 'iPhone 15 Pro');

      expect(result.similarity).toBe(1);
      expect(result.diffPercentage).toBe(0);
      expect(result.diffPixelCount).toBe(0);
      expect(result.diffRegions).toHaveLength(0);
      expect(result.totalPixels).toBe(10000);
      expect(result.deviceA).toBe('iPhone 15');
      expect(result.deviceB).toBe('iPhone 15 Pro');
    });

    it('should detect completely different images with low similarity', async () => {
      const red = createTestPNG(100, 100, { r: 255, g: 0, b: 0 });
      const blue = createTestPNG(100, 100, { r: 0, g: 0, b: 255 });

      const result = await engine.compare(red, blue, 'DeviceA', 'DeviceB');

      expect(result.similarity).toBeLessThan(0.1);
      expect(result.diffPercentage).toBeGreaterThan(90);
      expect(result.diffPixelCount).toBeGreaterThan(9000);
    });

    it('should detect partial differences and identify diff regions', async () => {
      const white = createTestPNG(200, 200, { r: 255, g: 255, b: 255 });
      const withRegion = createTestPNGWithRegion(
        200,
        200,
        { x: 50, y: 50, w: 100, h: 100 },
        { r: 255, g: 0, b: 0 },
      );

      const result = await engine.compare(white, withRegion, 'DeviceA', 'DeviceB');

      expect(result.similarity).toBeGreaterThan(0);
      expect(result.similarity).toBeLessThan(1);
      expect(result.diffRegions.length).toBeGreaterThan(0);
      expect(result.diffPercentage).toBeGreaterThan(0);
    });

    it('should normalize different size images to smaller dimensions', async () => {
      const small = createTestPNG(50, 50, { r: 200, g: 200, b: 200 });
      const large = createTestPNG(100, 100, { r: 200, g: 200, b: 200 });

      const result = await engine.compare(small, large, 'Small', 'Large');

      expect(result.normalizedSize.width).toBe(50);
      expect(result.normalizedSize.height).toBe(50);
      // Same color should yield high similarity after resize
      expect(result.similarity).toBeGreaterThan(0.9);
    });

    it('should generate a valid decodable diff image', async () => {
      const white = createTestPNG(80, 80, { r: 255, g: 255, b: 255 });
      const black = createTestPNG(80, 80, { r: 0, g: 0, b: 0 });

      const result = await engine.compare(white, black, 'A', 'B', {
        generateDiffImage: true,
      });

      expect(result.diffImageBase64).toBeDefined();
      // Verify we can decode the diff image
      const buffer = Buffer.from(result.diffImageBase64!, 'base64');
      const decoded = PNG.sync.read(buffer);
      expect(decoded.width).toBe(80);
      expect(decoded.height).toBe(80);
    });

    it('should omit diff image when generateDiffImage is false', async () => {
      const image = createTestPNG(50, 50, { r: 100, g: 100, b: 100 });

      const result = await engine.compare(image, image, 'A', 'B', {
        generateDiffImage: false,
      });

      expect(result.diffImageBase64).toBeUndefined();
    });
  });

  describe('compareAll', () => {
    it('should generate 3 pairs for 3 devices', async () => {
      const img = createTestPNG(40, 40, { r: 100, g: 100, b: 100 });

      const matrix = await engine.compareAll([
        { device: 'iPhone SE', imageBase64: img },
        { device: 'iPhone 15', imageBase64: img },
        { device: 'iPad Air', imageBase64: img },
      ]);

      expect(matrix.devices).toHaveLength(3);
      expect(matrix.results).toHaveLength(3); // C(3,2) = 3
      expect(matrix.flaggedPairs).toHaveLength(0); // all identical
    });

    it('should flag pairs below similarity threshold', async () => {
      const red = createTestPNG(40, 40, { r: 255, g: 0, b: 0 });
      const blue = createTestPNG(40, 40, { r: 0, g: 0, b: 255 });

      const matrix = await engine.compareAll(
        [
          { device: 'DeviceA', imageBase64: red },
          { device: 'DeviceB', imageBase64: blue },
        ],
        { similarityThreshold: 0.95 },
      );

      expect(matrix.flaggedPairs).toHaveLength(1);
      expect(matrix.threshold).toBe(0.95);
    });

    it('should return empty results for single device', async () => {
      const img = createTestPNG(40, 40, { r: 128, g: 128, b: 128 });

      const matrix = await engine.compareAll([{ device: 'Only', imageBase64: img }]);

      expect(matrix.devices).toHaveLength(1);
      expect(matrix.results).toHaveLength(0);
      expect(matrix.flaggedPairs).toHaveLength(0);
    });
  });
});
