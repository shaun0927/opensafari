/**
 * Unit tests for the diagnose MCP tool (issue #498).
 *
 * All external dependencies (simctl, sim-hid-bridge, session-manager,
 * proxy-manager) are mocked so the tests run offline without Xcode or a
 * booted simulator.
 */

/* eslint-disable no-var */
var execFileMock = jest.fn();
/* eslint-enable no-var */

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execFileMock(...args),
}));

jest.mock('../../src/session-manager');
jest.mock('../../src/simulator/proxy-manager');
jest.mock('../../src/tools/sim-hid-input-backend');

import { MCPServer } from '../../src/mcp-server';
import { registerDiagnoseTool } from '../../src/tools/diagnose';
import { getSessionManager } from '../../src/session-manager';
import { peekProxyForDevice } from '../../src/simulator/proxy-manager';
import { tryCreateSimulatorKitHIDBackend } from '../../src/tools/sim-hid-input-backend';
import type { BrowserBackend } from '../../src/types/browser-backend';

// ── typed mocks ──────────────────────────────────────────────────────────────

const mockGetSessionManager = getSessionManager as jest.MockedFunction<typeof getSessionManager>;
const mockPeekProxyForDevice = peekProxyForDevice as jest.MockedFunction<typeof peekProxyForDevice>;
const mockTryCreateSimHid = tryCreateSimulatorKitHIDBackend as jest.MockedFunction<
  typeof tryCreateSimulatorKitHIDBackend
>;

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFakeClient(connected: boolean): BrowserBackend {
  return {
    isConnected: () => connected,
  } as unknown as BrowserBackend;
}

interface FakeSessionManager {
  getConnection: jest.Mock;
  getSoleDeviceId: jest.Mock;
  getSimulator: jest.Mock;
}

function makeSessionManager(opts: {
  client?: BrowserBackend | null;
  soleDeviceId?: string | null;
  simulator?: { deviceId: string; deviceType: string; state: string } | null;
}): FakeSessionManager {
  return {
    getConnection: jest.fn().mockReturnValue(opts.client ?? null),
    getSoleDeviceId: jest.fn().mockReturnValue(opts.soleDeviceId ?? null),
    getSimulator: jest.fn().mockReturnValue(opts.simulator ?? null),
  };
}

interface FakeProxy {
  running: boolean;
  pid: number | null;
  port: number | null;
}

function makeProxy(running: boolean, pid: number | null, port: number | null): FakeProxy {
  return { running, pid, port };
}

/** Call the diagnose tool handler via the registered MCP server. */
async function runDiagnose(
  server: MCPServer,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const handler = server.getToolHandler('diagnose');
  if (!handler) throw new Error('diagnose tool not registered');
  const result = await handler('test-session', params);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

// ── simctl stub helpers ──────────────────────────────────────────────────────

/** Make execFileMock succeed for xcrun simctl help and fail with code 117 for io input. */
function stubSimctlUnavailable117(): void {
  execFileMock.mockImplementation(
    (cmd: string, args: string[]) => {
      if (args[0] === 'simctl' && args[1] === 'help') return Promise.resolve({ stdout: '', stderr: '' });
      // io input tap → exit 117 (Xcode 26+ removal)
      const err = Object.assign(new Error('exit 117'), { status: 117 });
      return Promise.reject(err);
    },
  );
}

/** Make execFileMock succeed for both xcrun calls (simctl available + io input works). */
function stubSimctlAvailable(): void {
  execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
}

/** Make xcrun simctl itself fail (not installed). */
function stubSimctlNotFound(): void {
  execFileMock.mockRejectedValue(new Error('xcrun not found'));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('diagnose tool', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
    registerDiagnoseTool(server);
    jest.resetAllMocks();
    // Default: no env vars
    delete process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
    delete process.env.OPENSAFARI_HEADLESS_ONLY;
    delete process.env.OPENSAFARI_PROXY_PORT;
    delete process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER;
  });

  // ── Test: all backends available ─────────────────────────────────────────

  it('reports all backends available when everything is set up', async () => {
    const client = makeFakeClient(true);
    mockGetSessionManager.mockReturnValue(makeSessionManager({ client, soleDeviceId: 'DEV-1' }) as never);
    mockPeekProxyForDevice.mockReturnValue(makeProxy(true, 12345, 9322) as never);
    mockTryCreateSimHid.mockResolvedValue({} as never); // non-null = found

    stubSimctlAvailable();

    process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';

    const report = await runDiagnose(server);

    const backends = report.backends as Record<string, Record<string, unknown>>;
    expect(backends.simctl.available).toBe(true);
    expect(backends.webkit.available).toBe(true);
    expect(backends.webkit.connected).toBe(true);
    expect(backends.applescript.available).toBe(true);
    expect(backends.simhid.available).toBe(true);

    const verdict = report.headless_verdict as Record<string, boolean>;
    expect(verdict.safari).toBe(true);
    expect(verdict.native).toBe(true);
    expect(verdict.overall).toBe(true);

    const proxy = report.proxy as Record<string, unknown>;
    expect(proxy.running).toBe(true);
    expect(proxy.pid).toBe(12345);
    expect(proxy.port).toBe(9322);
  });

  // ── Test: no backends → overall false ───────────────────────────────────

  it('reports overall=false when no backends are available', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({ client: null }) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);

    stubSimctlNotFound();

    const report = await runDiagnose(server);

    const backends = report.backends as Record<string, Record<string, unknown>>;
    expect(backends.simctl.available).toBe(false);
    expect(backends.webkit.available).toBe(false);
    expect(backends.simhid.available).toBe(false);

    const verdict = report.headless_verdict as Record<string, boolean>;
    expect(verdict.safari).toBe(false);
    expect(verdict.native).toBe(false);
    expect(verdict.overall).toBe(false);
  });

  // ── Test: only webkit → safari true, native false, overall false ─────────

  it('safari=true native=false overall=false when only webkit is available', async () => {
    const client = makeFakeClient(true);
    mockGetSessionManager.mockReturnValue(makeSessionManager({ client, soleDeviceId: 'DEV-1' }) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);

    stubSimctlUnavailable117();

    const report = await runDiagnose(server);

    const verdict = report.headless_verdict as Record<string, boolean>;
    expect(verdict.safari).toBe(true);
    expect(verdict.native).toBe(false);
    expect(verdict.overall).toBe(false);
  });

  // ── Test: env vars reflected correctly ───────────────────────────────────

  it('reflects environment variables in the report', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({}) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlNotFound();

    process.env.OPENSAFARI_ALLOW_FOCUS_INPUT = '1';
    process.env.OPENSAFARI_HEADLESS_ONLY = 'true';
    process.env.OPENSAFARI_PROXY_PORT = '9500';
    process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER = '1';

    const report = await runDiagnose(server);
    const env = report.environment as Record<string, string>;

    expect(env.OPENSAFARI_ALLOW_FOCUS_INPUT).toBe('1');
    expect(env.OPENSAFARI_HEADLESS_ONLY).toBe('true');
    expect(env.OPENSAFARI_PROXY_PORT).toBe('9500');
    expect(env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER).toBe('1');
  });

  // ── Test: proxy status reflected correctly ───────────────────────────────

  it('reflects proxy status when a proxy exists for the device', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({ soleDeviceId: 'DEV-42' }) as never);
    mockPeekProxyForDevice.mockReturnValue(makeProxy(true, 99999, 9422) as never);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlNotFound();

    const report = await runDiagnose(server);
    const proxy = report.proxy as Record<string, unknown>;

    expect(proxy.running).toBe(true);
    expect(proxy.pid).toBe(99999);
    expect(proxy.port).toBe(9422);
  });

  // ── Test: proxy absent ───────────────────────────────────────────────────

  it('reports proxy not running when no proxy is found', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({ soleDeviceId: null }) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlNotFound();

    const report = await runDiagnose(server);
    const proxy = report.proxy as Record<string, unknown>;

    expect(proxy.running).toBe(false);
    expect(proxy.pid).toBeNull();
    expect(proxy.port).toBeNull();
  });

  // ── Test: applescript gated on env var ───────────────────────────────────

  it('reports applescript unavailable when OPENSAFARI_ALLOW_FOCUS_INPUT is unset', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({}) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlNotFound();

    // Env var intentionally NOT set

    const report = await runDiagnose(server);
    const backends = report.backends as Record<string, Record<string, unknown>>;
    expect(backends.applescript.available).toBe(false);
    expect(typeof backends.applescript.reason).toBe('string');
  });

  // ── Test: webkit disconnected → safari false ─────────────────────────────

  it('safari=false when webkit client exists but isConnected returns false', async () => {
    const client = makeFakeClient(false);
    mockGetSessionManager.mockReturnValue(makeSessionManager({ client }) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlNotFound();

    const report = await runDiagnose(server);
    const verdict = report.headless_verdict as Record<string, boolean>;
    expect(verdict.safari).toBe(false);
  });

  // ── Test: simctl available via io input ──────────────────────────────────

  it('simctl available when io input does not exit 117', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({}) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlAvailable();

    const report = await runDiagnose(server);
    const backends = report.backends as Record<string, Record<string, unknown>>;
    expect(backends.simctl.available).toBe(true);
  });

  // ── Test: simctl unavailable on Xcode 26+ (exit 117) ────────────────────

  it('simctl.available=false with reason when exit code is 117', async () => {
    mockGetSessionManager.mockReturnValue(makeSessionManager({}) as never);
    mockPeekProxyForDevice.mockReturnValue(null);
    mockTryCreateSimHid.mockResolvedValue(null);
    stubSimctlUnavailable117();

    const report = await runDiagnose(server);
    const backends = report.backends as Record<string, Record<string, unknown>>;
    expect(backends.simctl.available).toBe(false);
    expect(backends.simctl.reason).toMatch(/Xcode 26/);
  });
});
