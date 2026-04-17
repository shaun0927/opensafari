/**
 * Unit tests for discoverVMServiceUrl (vm-service-discovery.ts)
 *
 * Covers:
 *  - Env override short-circuits without spawning simctl
 *  - Both probes share the same deadline (total elapsed < deadline + slack)
 *  - Null return + stderr error when no URL found within budget
 *  - Predicate probe success skips broad fallback
 *  - OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS env var is parsed and clamped
 */

import { promisify } from 'util';

// ── Mock setup ────────────────────────────────────────────────────────────────
// execFile has util.promisify.custom which makes promisify() resolve to
// { stdout, stderr }. We replicate that so execFileAsync in the module under
// test also resolves to { stdout, stderr } when the mock is active.

type ExecFileImpl = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

// The active implementation — tests swap this out via setExecFileImpl().
let _execFileImpl: ExecFileImpl = () =>
  Promise.resolve({ stdout: '', stderr: '' });

function setExecFileImpl(impl: ExecFileImpl) {
  _execFileImpl = impl;
}

// Track how many times execFile was called.
let _execFileCallCount = 0;
function resetCallCount() {
  _execFileCallCount = 0;
}
function getCallCount() {
  return _execFileCallCount;
}

// The promisify.custom function — called by promisify(execFile) in the module.
const customPromisified: ExecFileImpl = (cmd, args, opts) => {
  _execFileCallCount++;
  return _execFileImpl(cmd, args, opts);
};

// The stub execFile function exposed to child_process importers.
const execFileStub = jest.fn();
// Attach promisify.custom so promisify(execFileStub) returns the custom impl.
(execFileStub as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

jest.mock('child_process', () => ({
  execFile: execFileStub,
}));

// Import after mock hoisting so the module under test uses our stub.
import { discoverVMServiceUrl } from '../../src/flutter/vm-service-discovery';

// ─────────────────────────────────────────────────────────────────────────────

const VALID_VM_URL = 'http://127.0.0.1:50642/abc=/';
const DEVICE_ID = 'test-device-udid';

beforeEach(() => {
  resetCallCount();
  setExecFileImpl(() => Promise.resolve({ stdout: '', stderr: '' }));
  delete process.env.OPENSAFARI_VM_SERVICE_URL;
  delete process.env.OPENSAFARI_VM_SERVICE_WS_URL;
  delete process.env.OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS;
  delete process.env.OPENSAFARI_VM_DISCOVERY_LOG_WINDOW;
});

// ── Env override tests ────────────────────────────────────────────────────────

describe('env override short-circuits', () => {
  it('returns HTTP URL from OPENSAFARI_VM_SERVICE_URL without calling execFile', async () => {
    process.env.OPENSAFARI_VM_SERVICE_URL = VALID_VM_URL;

    const result = await discoverVMServiceUrl(DEVICE_ID);

    expect(result).toBe(VALID_VM_URL);
    expect(getCallCount()).toBe(0);
  });

  it('returns HTTP URL converted from OPENSAFARI_VM_SERVICE_WS_URL without calling execFile', async () => {
    process.env.OPENSAFARI_VM_SERVICE_WS_URL = 'ws://127.0.0.1:50642/abc=/ws';

    const result = await discoverVMServiceUrl(DEVICE_ID);

    expect(result).toBe(VALID_VM_URL);
    expect(getCallCount()).toBe(0);
  });

  it('ignores invalid OPENSAFARI_VM_SERVICE_URL and falls through to probes', async () => {
    process.env.OPENSAFARI_VM_SERVICE_URL = 'not-a-valid-url';

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await discoverVMServiceUrl(DEVICE_ID);
    errorSpy.mockRestore();

    expect(result).toBeNull();
    expect(getCallCount()).toBeGreaterThan(0);
  });
});

// ── Shared deadline tests ─────────────────────────────────────────────────────

describe('shared deadline enforcement', () => {
  it('total elapsed is within deadline + 500 ms slack when probes return quickly', async () => {
    setExecFileImpl(() =>
      new Promise(resolve => setTimeout(() => resolve({ stdout: '', stderr: '' }), 10)),
    );

    const deadlineMs = 1000;
    const start = Date.now();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await discoverVMServiceUrl(DEVICE_ID, { timeout: deadlineMs });
    errorSpy.mockRestore();
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // 2 probes × ~10 ms each ≈ 20 ms total — well within deadline + 500 ms slack
    expect(elapsed).toBeLessThan(deadlineMs + 500);
  });

  it('exits the probe loop within the total deadline', async () => {
    // Each probe takes ~10 ms (real setTimeout). With a 600 ms total budget
    // the loop must exit within budget + slack. Asserts wall-time bounding
    // even after the original two-probe cap was removed.
    setExecFileImpl(() =>
      new Promise(resolve => setTimeout(() => resolve({ stdout: '', stderr: '' }), 10)),
    );

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const start = Date.now();
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 600 });
    errorSpy.mockRestore();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(600 + 500);
    // Multiple probes should have fit into the 600 ms budget.
    expect(getCallCount()).toBeGreaterThanOrEqual(1);
  });
});

// ── Log window override tests ─────────────────────────────────────────────────

describe('log scan window', () => {
  it('uses default window of 10m when env var is unset', async () => {
    let capturedLogWindow: string | undefined;
    setExecFileImpl((_cmd, args) => {
      const idx = args.indexOf('--last');
      if (idx >= 0) capturedLogWindow = args[idx + 1] as string;
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 600 });
    errorSpy.mockRestore();

    expect(capturedLogWindow).toBe('10m');
  });

  it('honors OPENSAFARI_VM_DISCOVERY_LOG_WINDOW env override', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_LOG_WINDOW = '30m';

    let capturedLogWindow: string | undefined;
    setExecFileImpl((_cmd, args) => {
      const idx = args.indexOf('--last');
      if (idx >= 0) capturedLogWindow = args[idx + 1] as string;
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 600 });
    errorSpy.mockRestore();

    expect(capturedLogWindow).toBe('30m');
  });

  it('honors options.logWindow over env var', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_LOG_WINDOW = '30m';

    let capturedLogWindow: string | undefined;
    setExecFileImpl((_cmd, args) => {
      const idx = args.indexOf('--last');
      if (idx >= 0) capturedLogWindow = args[idx + 1] as string;
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 600, logWindow: '2h' });
    errorSpy.mockRestore();

    expect(capturedLogWindow).toBe('2h');
  });

  it('falls back to default window when env value is malformed', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_LOG_WINDOW = 'not-a-window';

    let capturedLogWindow: string | undefined;
    setExecFileImpl((_cmd, args) => {
      const idx = args.indexOf('--last');
      if (idx >= 0) capturedLogWindow = args[idx + 1] as string;
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 600 });
    errorSpy.mockRestore();

    expect(capturedLogWindow).toBe('10m');
  });
});

// ── Large-timeout-override schedules additional retry iterations ──────────────

describe('large timeout override extends probe iterations beyond 2', () => {
  it('schedules more than two probes when total budget exceeds PROBE_TIMEOUT_MS × 2', async () => {
    // Each probe completes in 10 ms (real setTimeout) returning empty stdout.
    // With a 4 s budget the loop should iterate well past the original
    // two-probe cap — proving the override actually widens discovery.
    setExecFileImpl(() =>
      new Promise(resolve => setTimeout(() => resolve({ stdout: '', stderr: '' }), 10)),
    );

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 4000 });
    errorSpy.mockRestore();

    expect(getCallCount()).toBeGreaterThan(2);
  });

  it('alternates predicate and broad probes across iterations', async () => {
    const probeKinds: Array<'predicate' | 'broad'> = [];
    setExecFileImpl((_cmd, args) => {
      const isPredicate = Array.isArray(args) && args.includes('--predicate');
      probeKinds.push(isPredicate ? 'predicate' : 'broad');
      return new Promise(resolve =>
        setTimeout(() => resolve({ stdout: '', stderr: '' }), 10),
      );
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 4000 });
    errorSpy.mockRestore();

    expect(probeKinds.length).toBeGreaterThan(2);
    expect(probeKinds[0]).toBe('predicate');
    expect(probeKinds[1]).toBe('broad');
    expect(probeKinds[2]).toBe('predicate');
  });
});

// ── Null return + stderr logging ──────────────────────────────────────────────

describe('null return and stderr logging on budget exhaustion', () => {
  it('returns null and emits exactly one console.error line when no URL found', async () => {
    setExecFileImpl(() =>
      Promise.resolve({ stdout: 'some log with no URL', stderr: '' }),
    );

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await discoverVMServiceUrl(DEVICE_ID, { timeout: 600 });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('No VM Service URL found within budget');
    expect(msg).toContain('elapsed:');
    expect(msg).toContain('deadline:');
    expect(msg).toContain(DEVICE_ID);

    errorSpy.mockRestore();
  });
});

// ── Predicate probe success skips broad fallback ──────────────────────────────

describe('predicate probe success skips broad fallback', () => {
  it('does not invoke broad fallback when predicate probe finds the URL', async () => {
    setExecFileImpl((_cmd, args) => {
      const isPredicateProbe = Array.isArray(args) && args.includes('--predicate');
      if (isPredicateProbe) {
        return Promise.resolve({
          stdout: `Observatory listening on ${VALID_VM_URL}`,
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const result = await discoverVMServiceUrl(DEVICE_ID);

    expect(result).toBe(VALID_VM_URL);
    expect(getCallCount()).toBe(1); // only the predicate probe was invoked
  });
});

// ── OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS env var ────────────────────────────────

describe('OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS env var', () => {
  it('parses a valid ms value and uses it as the deadline', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS = '800';

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await discoverVMServiceUrl(DEVICE_ID);

    expect(result).toBeNull();
    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('deadline: 800 ms');

    errorSpy.mockRestore();
  });

  it('clamps sub-minimum values to 500 ms minimum', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS = '10'; // below MIN_DISCOVERY_TIMEOUT_MS (500)

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID);

    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('deadline: 500 ms');

    errorSpy.mockRestore();
  });

  it('ignores non-numeric env value and falls back to 5000 ms default', async () => {
    process.env.OPENSAFARI_VM_DISCOVERY_TIMEOUT_MS = 'not-a-number';

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID);

    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('deadline: 5000 ms');

    errorSpy.mockRestore();
  });
});

// ── options.timeout override ──────────────────────────────────────────────────

describe('options.timeout override', () => {
  it('uses options.timeout when provided', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 1200 });

    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('deadline: 1200 ms');

    errorSpy.mockRestore();
  });

  it('clamps options.timeout below minimum to 500 ms', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await discoverVMServiceUrl(DEVICE_ID, { timeout: 50 });

    const msg: string = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('deadline: 500 ms');

    errorSpy.mockRestore();
  });
});
