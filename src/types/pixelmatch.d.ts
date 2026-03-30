declare module 'pixelmatch' {
  /**
   * Compare two images pixel by pixel.
   *
   * @param img1 - First image data (RGBA buffer)
   * @param img2 - Second image data (RGBA buffer)
   * @param output - Output diff image data (RGBA buffer), or null
   * @param width - Image width in pixels
   * @param height - Image height in pixels
   * @param options - Comparison options
   * @returns Number of mismatched pixels
   */
  function pixelmatch(
    img1: Buffer | Uint8Array | Uint8ClampedArray,
    img2: Buffer | Uint8Array | Uint8ClampedArray,
    output: Buffer | Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    options?: {
      threshold?: number;
      includeAA?: boolean;
      alpha?: number;
      aaColor?: [number, number, number];
      diffColor?: [number, number, number];
      diffColorAlt?: [number, number, number];
      diffMask?: boolean;
    },
  ): number;

  export default pixelmatch;
}
