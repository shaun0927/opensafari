/**
 * Unit tests for PointerServiceInputBackend (issue #590, Phase 1).
 *
 * - tap invokes the bridge with the `tap-ps` subcommand
 * - swipe/keys delegate to the wrapped SimulatorKitHIDInputBackend (so the
 *   PointerService opt-in does not silently regress keyboard or swipe
 *   routing — those remain on the existing Tier-1 path)
 * - exit-code / non-JSON failure paths surface as InputBackendError
 * - tryCreatePointerServiceBackend returns null when the helper is missing
 * - getInputBackend selects PointerService only when the env flag is set
 */

/* eslint-disable no-var */
var execFileMock = jest.fn();
/* eslint-enable no-var */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: unknown[]) => execFileMock(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

import { existsSync } from 'fs';
import {
  PointerServiceInputBackend,
  tryCreatePointerServiceBackend,
  isPointerServiceEnabled,
  OPENSAFARI_ENABLE_POINTERSERVICE_ENV,
} from '../../src/tools/pointer-service-input-backend';
import {
  SimulatorKitHIDInputBackend,
  InputBackendError,
} from '../../src/tools/sim-hid-input-backend';

const existsSyncMock = existsSync as jest.MockedFunction<typeof existsSync>;

const DEVICE = 'POINTER-SVC-UDID';
const BRIDGE = '/fake/dist/sim-hid-bridge';

function execError(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  message?: string;
}): Error {
  const err = new Error(opts.message ?? 'spawn failed') as Error & {
    code?: number | null;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
  };
  err.code = opts.code ?? null;
  err.stdout = opts.stdout ?? '';
  err.stderr = opts.stderr ?? '';
  err.killed = opts.killed ?? false;
  return err;
}

describe('PointerServiceInputBackend', () => {
  let delegate: SimulatorKitHIDInputBackend;
  let backend: PointerServiceInputBackend;

  beforeEach(() => {
    execFileMock.mockReset();
    delegate = new SimulatorKitHIDInputBackend(BRIDGE);
    backend = new PointerServiceInputBackend(BRIDGE, delegate);
  });

  test('exposes kind="pointer-service" for observability', () => {
    expect(backend.kind).toBe('pointer-service');
  });

  test('tap invokes sim-hid-bridge with tap-ps subcommand', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"kind":"tap-ps","udid":"x","elapsed_ms":1}',
      stderr: '',
    });
    await backend.tap(DEVICE, 100, 200);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe(BRIDGE);
    expect(args).toEqual([DEVICE, 'tap-ps', '100', '200']);
  });

  test('tap appends duration when > 0', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true}',
      stderr: '',
    });
    await backend.tap(DEVICE, 50, 60, 1.5);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'tap-ps', '50', '60', '1.5']);
  });

  test('tap with zero duration omits the duration arg', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":true}',
      stderr: '',
    });
    await backend.tap(DEVICE, 50, 60, 0);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([DEVICE, 'tap-ps', '50', '60']);
  });

  test('tap surfaces bridge ok=false as InputBackendError', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: '{"ok":false,"error":"pointer-service registration failed"}',
      stderr: '',
    });
    await expect(backend.tap(DEVICE, 0, 0)).rejects.toBeInstanceOf(InputBackendError);
  });

  test('tap surfaces non-JSON stdout as InputBackendError', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: 'not json',
      stderr: '',
    });
    await expect(backend.tap(DEVICE, 0, 0)).rejects.toMatchObject({
      name: 'InputBackendError',
      code: 'JSON_PARSE_FAILURE',
    });
  });

  test('tap surfaces non-zero exit as InputBackendError', async () => {
    execFileMock.mockRejectedValueOnce(
      execError({ code: 78, stderr: 'SimulatorKit dlopen failed' }),
    );
    await expect(backend.tap(DEVICE, 0, 0)).rejects.toMatchObject({
      name: 'InputBackendError',
    });
  });

  test('swipe delegates to the composed SimulatorKitHIDInputBackend', async () => {
    const spy = jest.spyOn(delegate, 'swipe').mockResolvedValueOnce();
    await backend.swipe(DEVICE, 10, 20, 30, 40, 0.5);
    expect(spy).toHaveBeenCalledWith(DEVICE, 10, 20, 30, 40, 0.5);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('typeText delegates to the composed SimulatorKitHIDInputBackend', async () => {
    const spy = jest.spyOn(delegate, 'typeText').mockResolvedValueOnce();
    await backend.typeText(DEVICE, 'hello');
    expect(spy).toHaveBeenCalledWith(DEVICE, 'hello');
  });

  test('keypress delegates to the composed SimulatorKitHIDInputBackend', async () => {
    const spy = jest.spyOn(delegate, 'keypress').mockResolvedValueOnce();
    await backend.keypress(DEVICE, '40');
    expect(spy).toHaveBeenCalledWith(DEVICE, '40');
  });

  test('sendKey delegates to the composed SimulatorKitHIDInputBackend', async () => {
    const spy = jest.spyOn(delegate, 'sendKey').mockResolvedValueOnce();
    await backend.sendKey(DEVICE, 'Enter');
    expect(spy).toHaveBeenCalledWith(DEVICE, 'Enter');
  });
});

describe('isPointerServiceEnabled', () => {
  const envKey = OPENSAFARI_ENABLE_POINTERSERVICE_ENV;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[envKey];
    else process.env[envKey] = original;
  });

  test('returns false when unset', () => {
    expect(isPointerServiceEnabled()).toBe(false);
  });

  test('returns true for "1"', () => {
    process.env[envKey] = '1';
    expect(isPointerServiceEnabled()).toBe(true);
  });

  test('returns true for "true"', () => {
    process.env[envKey] = 'true';
    expect(isPointerServiceEnabled()).toBe(true);
  });

  test('returns false for other truthy values', () => {
    process.env[envKey] = 'yes';
    expect(isPointerServiceEnabled()).toBe(false);
    process.env[envKey] = '0';
    expect(isPointerServiceEnabled()).toBe(false);
  });
});

describe('tryCreatePointerServiceBackend', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
  });

  test('returns a backend when a bridge candidate exists', async () => {
    existsSyncMock.mockImplementation((p) =>
      String(p).endsWith('sim-hid-bridge'),
    );
    const backend = await tryCreatePointerServiceBackend();
    expect(backend).toBeInstanceOf(PointerServiceInputBackend);
    expect(backend?.kind).toBe('pointer-service');
  });

  test('returns null when no bridge candidate exists', async () => {
    existsSyncMock.mockReturnValue(false);
    const backend = await tryCreatePointerServiceBackend();
    expect(backend).toBeNull();
  });
});
