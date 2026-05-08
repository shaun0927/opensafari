/**
 * app_double_tap regression notes — #693 WU4
 *
 * No macOS-pt → iOS-pt coordinate conversion regression is needed here.
 *
 * Reason: app-double-tap.ts accepts raw `x` / `y` coordinates directly from
 * the MCP caller and forwards them straight to `backend.tap`.  It does NOT
 * query the accessibility tree, does not receive `deviceContentMacOSPt`, and
 * therefore never enters the AX-frame conversion path introduced by #693 WU3.
 * The conversion lives exclusively in app-tap-element.ts (lines 230-248),
 * which is the only tool that reads AX-frame coordinates and needs to normalise
 * them into iOS-pts before dispatch.
 *
 * If app-double-tap is ever extended to accept an accessibility query (e.g.
 * `label`, `identifier`) and derives tap coordinates from AX frames, a
 * regression covering the macOS-pt → iOS-pt conversion path should be added
 * here at that time.
 */

// ── Sanity: tool registers and dispatches two taps ───────────────────────────

jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppDoubleTapTool } from '../../src/tools/app-double-tap';

const mockTap = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    kind: 'simctl' as const,
    tap: mockTap,
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

let handler: (sessionId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

beforeAll(() => {
  const server = {
    registerTool: jest.fn((_schema: unknown, fn: unknown) => {
      handler = fn as typeof handler;
    }),
  } as unknown as MCPServer;
  registerAppDoubleTapTool(server);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('app_double_tap', () => {
  it('dispatches exactly two taps at the same raw coordinates (no AX-frame conversion)', async () => {
    // app_double_tap takes caller-supplied iOS-pt coordinates directly and
    // must dispatch them as-is, without any macOS-pt → iOS-pt scaling.
    const result = await handler('session', { x: 200, y: 400 });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('double_tapped');
    expect(body.x).toBe(200);
    expect(body.y).toBe(400);
    // Two taps, both at the unscaled caller coordinates.
    expect(mockTap).toHaveBeenCalledTimes(2);
    expect(mockTap).toHaveBeenNthCalledWith(1, 'test-device-id', 200, 400);
    expect(mockTap).toHaveBeenNthCalledWith(2, 'test-device-id', 200, 400);
  });
});
