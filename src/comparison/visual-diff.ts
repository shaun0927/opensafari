import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualDiffOptions {
  /** pixelmatch color threshold (0-1, default 0.1) */
  threshold?: number;
  /** include anti-aliased pixels (default false) */
  includeAA?: boolean;
  /** generate overlay image (default true) */
  generateDiffImage?: boolean;
  /** minimum similarity to pass (default 0.95) */
  similarityThreshold?: number;
}

export interface VisualDiffResult {
  /** 0-1 (1 = identical) */
  similarity: number;
  /** percentage of pixels that differ */
  diffPercentage: number;
  diffPixelCount: number;
  totalPixels: number;
  diffRegions: BoundingBox[];
  /** PNG overlay highlighting differences (base64) */
  diffImageBase64?: string;
  deviceA: string;
  deviceB: string;
  normalizedSize: { width: number; height: number };
}

export interface PairwiseComparisonMatrix {
  devices: string[];
  results: VisualDiffResult[];
  /** pairs below similarity threshold */
  flaggedPairs: VisualDiffResult[];
  threshold: number;
}

/** Decode a base64-encoded PNG into a PNG object */
function decodePNG(base64: string): PNG {
  const buffer = Buffer.from(base64, 'base64');
  return PNG.sync.read(buffer);
}

/** Encode a PNG object to a base64 string */
function encodePNG(png: PNG): string {
  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

/** Nearest-neighbor resize of a PNG to target dimensions */
function resizeImage(src: PNG, targetWidth: number, targetHeight: number): PNG {
  if (src.width === targetWidth && src.height === targetHeight) {
    return src;
  }

  const dest = new PNG({ width: targetWidth, height: targetHeight });

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.floor((x * src.width) / targetWidth);
      const srcY = Math.floor((y * src.height) / targetHeight);
      const srcIdx = (srcY * src.width + srcX) * 4;
      const destIdx = (y * targetWidth + x) * 4;

      dest.data[destIdx] = src.data[srcIdx];
      dest.data[destIdx + 1] = src.data[srcIdx + 1];
      dest.data[destIdx + 2] = src.data[srcIdx + 2];
      dest.data[destIdx + 3] = src.data[srcIdx + 3];
    }
  }

  return dest;
}

/** Grid-based connected-component analysis for detecting diff regions */
function detectDiffRegions(
  diffData: Uint8Array,
  width: number,
  height: number,
  cellSize: number = 32,
): BoundingBox[] {
  const gridW = Math.ceil(width / cellSize);
  const gridH = Math.ceil(height / cellSize);
  const grid: boolean[][] = Array.from({ length: gridH }, () =>
    Array.from({ length: gridW }, () => false),
  );

  // Mark grid cells that contain diff pixels (non-black pixels in the diff image)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = diffData[idx];
      const g = diffData[idx + 1];
      const b = diffData[idx + 2];

      if (r > 0 || g > 0 || b > 0) {
        const gx = Math.floor(x / cellSize);
        const gy = Math.floor(y / cellSize);
        grid[gy][gx] = true;
      }
    }
  }

  // Connected-component labeling using flood fill
  const visited: boolean[][] = Array.from({ length: gridH }, () =>
    Array.from({ length: gridW }, () => false),
  );
  const regions: BoundingBox[] = [];

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (grid[gy][gx] && !visited[gy][gx]) {
        // Flood fill to find connected component
        let minX = gx;
        let minY = gy;
        let maxX = gx;
        let maxY = gy;

        const stack: [number, number][] = [[gx, gy]];
        visited[gy][gx] = true;

        while (stack.length > 0) {
          const [cx, cy] = stack.pop()!;
          minX = Math.min(minX, cx);
          minY = Math.min(minY, cy);
          maxX = Math.max(maxX, cx);
          maxY = Math.max(maxY, cy);

          // Check 4-connected neighbors
          const neighbors: [number, number][] = [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1],
          ];

          for (const [nx, ny] of neighbors) {
            if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH && grid[ny][nx] && !visited[ny][nx]) {
              visited[ny][nx] = true;
              stack.push([nx, ny]);
            }
          }
        }

        regions.push({
          x: minX * cellSize,
          y: minY * cellSize,
          width: (maxX - minX + 1) * cellSize,
          height: (maxY - minY + 1) * cellSize,
        });
      }
    }
  }

  return regions;
}

export class VisualDiffEngine {
  /**
   * Compare two base64-encoded PNG images pixel by pixel.
   */
  async compare(
    imageABase64: string,
    imageBBase64: string,
    deviceA: string,
    deviceB: string,
    options?: VisualDiffOptions,
  ): Promise<VisualDiffResult> {
    const threshold = options?.threshold ?? 0.1;
    const includeAA = options?.includeAA ?? false;
    const generateDiffImage = options?.generateDiffImage ?? true;

    // Decode PNGs
    let pngA = decodePNG(imageABase64);
    let pngB = decodePNG(imageBBase64);

    // Normalize to same dimensions (use Math.min of each dimension)
    const normalizedWidth = Math.min(pngA.width, pngB.width);
    const normalizedHeight = Math.min(pngA.height, pngB.height);

    pngA = resizeImage(pngA, normalizedWidth, normalizedHeight);
    pngB = resizeImage(pngB, normalizedWidth, normalizedHeight);

    const totalPixels = normalizedWidth * normalizedHeight;

    // Create diff output image
    const diffOutput = new PNG({ width: normalizedWidth, height: normalizedHeight });

    // Run pixelmatch
    const diffPixelCount = pixelmatch(
      pngA.data,
      pngB.data,
      diffOutput.data,
      normalizedWidth,
      normalizedHeight,
      {
        threshold,
        includeAA,
      },
    );

    const diffPercentage = totalPixels > 0 ? (diffPixelCount / totalPixels) * 100 : 0;
    const similarity = totalPixels > 0 ? 1 - diffPixelCount / totalPixels : 1;

    // Detect diff regions (skip if no diff pixels)
    const diffRegions = diffPixelCount > 0
      ? detectDiffRegions(
          new Uint8Array(diffOutput.data.buffer, diffOutput.data.byteOffset, diffOutput.data.length),
          normalizedWidth,
          normalizedHeight,
        )
      : [];

    // Generate diff image if requested
    let diffImageBase64: string | undefined;
    if (generateDiffImage) {
      diffImageBase64 = encodePNG(diffOutput);
    }

    return {
      similarity,
      diffPercentage,
      diffPixelCount,
      totalPixels,
      diffRegions,
      diffImageBase64,
      deviceA,
      deviceB,
      normalizedSize: { width: normalizedWidth, height: normalizedHeight },
    };
  }

  /**
   * Compare all pairs of screenshots and return a pairwise comparison matrix.
   */
  async compareAll(
    screenshots: Array<{ device: string; imageBase64: string }>,
    options?: VisualDiffOptions,
  ): Promise<PairwiseComparisonMatrix> {
    const similarityThreshold = options?.similarityThreshold ?? 0.95;
    const devices = screenshots.map(s => s.device);
    const results: VisualDiffResult[] = [];

    // Generate all unique pairs (i < j)
    for (let i = 0; i < screenshots.length; i++) {
      for (let j = i + 1; j < screenshots.length; j++) {
        const result = await this.compare(
          screenshots[i].imageBase64,
          screenshots[j].imageBase64,
          screenshots[i].device,
          screenshots[j].device,
          options,
        );
        results.push(result);
      }
    }

    // Flag pairs below threshold
    const flaggedPairs = results.filter(r => r.similarity < similarityThreshold);

    return {
      devices,
      results,
      flaggedPairs,
      threshold: similarityThreshold,
    };
  }
}
