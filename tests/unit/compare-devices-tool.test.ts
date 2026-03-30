import { PNG } from 'pngjs';

/**
 * Tests for the compare_devices MCP tool.
 *
 * We test tool registration, error handling, and the comparison logic
 * by mocking the MCPServer, capturer, and batch executor.
 */

/** Create a solid-color PNG and return it as base64 */
function createTestPNG(width: number, height: number, color: { r: number; g: number; b: number }): string {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return buffer.toString('base64');
}

// Mock MCPServer that captures tool registrations
class MockMCPServer {
  tools: Map<string, { meta: any; handler: (sessionId: string, params: Record<string, unknown>) => Promise<any> }> = new Map();

  registerTool(meta: any, handler: any): void {
    this.tools.set(meta.name, { meta, handler });
  }

  getTool(name: string) {
    return this.tools.get(name);
  }
}

describe('compare_devices tool', () => {
  let server: MockMCPServer;

  beforeEach(() => {
    // Reset module state between tests by re-requiring
    jest.resetModules();
    server = new MockMCPServer();
  });

  it('should register with the correct name and schema', async () => {
    const { registerCompareDevicesTool } = await import('../../src/tools/compare-devices');
    registerCompareDevicesTool(server as any);

    const tool = server.getTool('compare_devices');
    expect(tool).toBeDefined();
    expect(tool!.meta.name).toBe('compare_devices');
    expect(tool!.meta.inputSchema.required).toContain('url');
    expect(tool!.meta.inputSchema.properties.url).toBeDefined();
    expect(tool!.meta.inputSchema.properties.devices).toBeDefined();
    expect(tool!.meta.inputSchema.properties.threshold).toBeDefined();
    expect(tool!.meta.inputSchema.properties.includeDOM).toBeDefined();
  });

  it('should return error when capturer is not initialized', async () => {
    const { registerCompareDevicesTool } = await import('../../src/tools/compare-devices');
    registerCompareDevicesTool(server as any);

    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not initialized');
  });

  it('should return error when no captures are returned', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    setCompareDevicesCapture({
      capture: async () => [],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No captures');
  });

  it('should return error when fewer than 2 devices are available', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    const testImage = createTestPNG(50, 50, { r: 128, g: 128, b: 128 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: testImage },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 2');
  });

  it('should return error when requested devices do not match any booted', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    const testImage = createTestPNG(50, 50, { r: 128, g: 128, b: 128 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: testImage },
        { device: 'iPad Air', viewport: { w: 820, h: 1180 }, screenshot: testImage },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      devices: ['Pixel 5', 'Galaxy S21'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('None of the requested devices');
  });

  it('should perform visual comparison and return results for identical images', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    const testImage = createTestPNG(50, 50, { r: 128, g: 128, b: 128 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: testImage },
        { device: 'iPhone 15 Pro', viewport: { w: 393, h: 852 }, screenshot: testImage },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      includeDOM: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    const text = result.content[0].text;
    expect(text).toContain('Cross-Device Comparison Report');
    expect(text).toContain('iPhone 15');
    expect(text).toContain('100.0%');
    expect(text).toContain('PASS');
  });

  it('should flag pairs below threshold for different images', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    const red = createTestPNG(50, 50, { r: 255, g: 0, b: 0 });
    const blue = createTestPNG(50, 50, { r: 0, g: 0, b: 255 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone SE', viewport: { w: 375, h: 667 }, screenshot: red },
        { device: 'iPad Air', viewport: { w: 820, h: 1180 }, screenshot: blue },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      threshold: 0.95,
      includeDOM: false,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('FAIL');
    expect(text).toContain('Flagged Pairs');
    // Should include diff overlay image for flagged pair
    const imageContent = result.content.find((c: any) => c.type === 'image');
    expect(imageContent).toBeDefined();
    expect(imageContent.mimeType).toBe('image/png');
  });

  it('should include DOM comparison when includeDOM is true and batch executor is set', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture, setCompareDevicesBatchExecutor } = await import('../../src/tools/compare-devices');

    const testImage = createTestPNG(50, 50, { r: 128, g: 128, b: 128 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: testImage },
        { device: 'iPad Air', viewport: { w: 820, h: 1180 }, screenshot: testImage },
      ],
    });

    setCompareDevicesBatchExecutor({
      batchExecute: async () => [
        {
          device: 'iPhone 15',
          deviceId: 'uuid-1',
          viewport: { w: 390, h: 844 },
          result: {
            viewport: { w: 390, h: 844 },
            elements: [
              { tag: 'h1', selector: 'h1', rect: { x: 0, y: 0, width: 390, height: 40 }, visible: true, childCount: 0 },
              { tag: 'button', selector: 'button', rect: { x: 10, y: 100, width: 200, height: 44 }, visible: true, childCount: 0 },
            ],
          },
          timing: 100,
        },
        {
          device: 'iPad Air',
          deviceId: 'uuid-2',
          viewport: { w: 820, h: 1180 },
          result: {
            viewport: { w: 820, h: 1180 },
            elements: [
              { tag: 'h1', selector: 'h1', rect: { x: 0, y: 0, width: 820, height: 40 }, visible: true, childCount: 0 },
              { tag: 'button', selector: 'button', rect: { x: 10, y: 100, width: 400, height: 44 }, visible: true, childCount: 0 },
            ],
          },
          timing: 120,
        },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      includeDOM: true,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('DOM Structural Comparison');
    expect(text).toContain('iPhone 15');
    expect(text).toContain('iPad Air');
  });

  it('should gracefully handle DOM diff failures', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture, setCompareDevicesBatchExecutor } = await import('../../src/tools/compare-devices');

    const testImage = createTestPNG(50, 50, { r: 128, g: 128, b: 128 });
    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: testImage },
        { device: 'iPad Air', viewport: { w: 820, h: 1180 }, screenshot: testImage },
      ],
    });

    setCompareDevicesBatchExecutor({
      batchExecute: async () => { throw new Error('DOM snapshot failed'); },
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      includeDOM: true,
    });

    // Should still succeed with visual diff results
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('Visual Comparison Results');
    // Should NOT contain DOM section since it failed
    expect(text).not.toContain('DOM Structural Comparison');
  });

  it('should filter captures by device name when devices param is provided', async () => {
    const { registerCompareDevicesTool, setCompareDevicesCapture } = await import('../../src/tools/compare-devices');

    const red = createTestPNG(50, 50, { r: 255, g: 0, b: 0 });
    const green = createTestPNG(50, 50, { r: 0, g: 255, b: 0 });
    const blue = createTestPNG(50, 50, { r: 0, g: 0, b: 255 });

    setCompareDevicesCapture({
      capture: async () => [
        { device: 'iPhone SE', viewport: { w: 375, h: 667 }, screenshot: red },
        { device: 'iPhone 15', viewport: { w: 390, h: 844 }, screenshot: green },
        { device: 'iPad Air', viewport: { w: 820, h: 1180 }, screenshot: blue },
      ],
    });

    registerCompareDevicesTool(server as any);
    const tool = server.getTool('compare_devices')!;
    const result = await tool.handler('test-session', {
      url: 'https://example.com',
      devices: ['iPhone SE', 'iPhone 15'],
      includeDOM: false,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('iPhone SE');
    expect(text).toContain('iPhone 15');
    // Should have exactly 1 pair (2 devices => C(2,2) = 1)
    expect(text).toContain('Total pairs:** 1');
  });
});
