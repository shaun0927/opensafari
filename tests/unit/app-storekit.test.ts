/**
 * Unit tests for StoreKit / IAP automation tools.
 * No real simulator or Xcode required — all subprocess calls are mocked.
 */

import { MCPServer } from '../../src/mcp-server';
import { registerAppStorekitConfigureTool } from '../../src/tools/app-storekit-configure';
import { registerAppStorekitTestSessionTool } from '../../src/tools/app-storekit-test-session';
import { registerAppStorekitReceiptTool } from '../../src/tools/app-storekit-receipt';

// ── child_process mock ────────────────────────────────────────────────────────
const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// ── fs/promises mock ──────────────────────────────────────────────────────────
const mockFsAccess = jest.fn();
const mockFsReadFile = jest.fn();

jest.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockFsReadFile(...args),
  access: (...args: unknown[]) => mockFsAccess(...args),
}));

// ── session-manager mock ──────────────────────────────────────────────────────
const mockGetSoleDeviceId = jest.fn<string | null, []>().mockReturnValue('TEST-UDID-5678');

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ getSoleDeviceId: mockGetSoleDeviceId }),
}));

// ── simctl-storekit mock ──────────────────────────────────────────────────────
// Error classes must be defined inside the factory to avoid hoisting issues.
const mockRunStorekit = jest.fn<Promise<string>, [string[], number?]>();
const mockParseStorekitProductIds = jest.fn<Promise<string[]>, [string]>();
const mockParseTransactionList = jest.fn();
const mockAssertStorekitEnabled = jest.fn();

jest.mock('../../src/native/simctl-storekit', () => {
  class StorekitDisabledError extends Error {
    readonly code = 'STOREKIT_DISABLED';
    constructor() {
      super('StoreKit automation is disabled (OPENSAFARI_DISABLE_STOREKIT=1)');
      this.name = 'StorekitDisabledError';
    }
  }
  class StorekitUnsupportedError extends Error {
    readonly code = 'XCODE_TOO_OLD';
    constructor() {
      super('simctl storekit requires Xcode 14 or later.');
      this.name = 'StorekitUnsupportedError';
    }
  }
  return {
    assertStorekitEnabled: () => mockAssertStorekitEnabled(),
    runStorekit: (...args: unknown[]) => mockRunStorekit(...(args as Parameters<typeof mockRunStorekit>)),
    parseStorekitProductIds: (p: string) => mockParseStorekitProductIds(p),
    parseTransactionList: (r: string) => mockParseTransactionList(r),
    StorekitDisabledError,
    StorekitUnsupportedError,
    STOREKIT_DISABLE_ENV: 'OPENSAFARI_DISABLE_STOREKIT',
  };
});

// Import error classes after mock is set up
import {
  StorekitDisabledError,
  StorekitUnsupportedError,
} from '../../src/native/simctl-storekit';

// ─────────────────────────────────────────────────────────────────────────────

const UDID = 'TEST-UDID-5678';
const CONFIG_PATH = '/tmp/test.storekit';
const BUNDLE_ID = 'com.example.testapp';

// Helper to parse the first content text
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ── app_storekit_configure ────────────────────────────────────────────────────

describe('app_storekit_configure', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppStorekitConfigureTool(server);
  });

  beforeEach(() => {
    mockAssertStorekitEnabled.mockReset().mockReturnValue(undefined);
    mockRunStorekit.mockReset().mockResolvedValue('');
    mockParseStorekitProductIds
      .mockReset()
      .mockResolvedValue(['com.example.product1', 'com.example.product2']);
    mockGetSoleDeviceId.mockReturnValue(UDID);
  });

  test('is registered', () => {
    expect(server.getRegisteredTools()).toContain('app_storekit_configure');
  });

  test('success: parses productIds and returns ok:true', async () => {
    const handler = server.getToolHandler('app_storekit_configure')!;
    const result = await handler('session', { configPath: CONFIG_PATH });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result as { content: Array<{ type: string; text: string }> }) as {
      ok: boolean;
      productIds: string[];
      udid: string;
    };
    expect(body.ok).toBe(true);
    expect(body.productIds).toEqual(['com.example.product1', 'com.example.product2']);
    expect(body.udid).toBe(UDID);
    expect(mockRunStorekit).toHaveBeenCalledWith(['configure', UDID, CONFIG_PATH]);
  });

  test('error: missing file returns MISSING_FILE', async () => {
    mockParseStorekitProductIds.mockRejectedValue(
      new Error('StoreKit config file not found: /tmp/missing.storekit'),
    );

    const handler = server.getToolHandler('app_storekit_configure')!;
    const result = await handler('session', { configPath: '/tmp/missing.storekit' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('MISSING_FILE');
  });

  test('error: STOREKIT_DISABLED when assertStorekitEnabled throws', async () => {
    mockAssertStorekitEnabled.mockImplementation(() => {
      throw new StorekitDisabledError();
    });

    const handler = server.getToolHandler('app_storekit_configure')!;
    const result = await handler('session', { configPath: CONFIG_PATH });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('STOREKIT_DISABLED');
  });

  test('error: XCODE_TOO_OLD when runStorekit throws StorekitUnsupportedError', async () => {
    mockRunStorekit.mockRejectedValue(new StorekitUnsupportedError());

    const handler = server.getToolHandler('app_storekit_configure')!;
    const result = await handler('session', { configPath: CONFIG_PATH });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('XCODE_TOO_OLD');
  });

  test('error: DEVICE_NOT_BOOTED when no device available', async () => {
    mockGetSoleDeviceId.mockReturnValue(null);

    const handler = server.getToolHandler('app_storekit_configure')!;
    const result = await handler('session', { configPath: CONFIG_PATH });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('DEVICE_NOT_BOOTED');
  });

  test('uses explicit udid when provided', async () => {
    const handler = server.getToolHandler('app_storekit_configure')!;
    await handler('session', { configPath: CONFIG_PATH, udid: 'EXPLICIT-UDID' });

    expect(mockRunStorekit).toHaveBeenCalledWith(['configure', 'EXPLICIT-UDID', CONFIG_PATH]);
  });
});

// ── app_storekit_test_session ─────────────────────────────────────────────────

describe('app_storekit_test_session', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppStorekitTestSessionTool(server);
  });

  beforeEach(() => {
    mockAssertStorekitEnabled.mockReset().mockReturnValue(undefined);
    mockRunStorekit.mockReset().mockResolvedValue('[]');
    mockParseTransactionList.mockReset().mockReturnValue([
      { id: 'txn-1', state: 'pending', productId: 'com.example.product1' },
    ]);
    mockGetSoleDeviceId.mockReturnValue(UDID);
  });

  test('is registered', () => {
    expect(server.getRegisteredTools()).toContain('app_storekit_test_session');
  });

  test('list: returns transactions', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'list' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { ok: boolean; transactions: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(mockRunStorekit).toHaveBeenCalledWith(['test-session', 'list', UDID]);
  });

  test('approve: requires transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'approve' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('MISSING_TRANSACTION_ID');
  });

  test('decline: requires transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'decline' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('MISSING_TRANSACTION_ID');
  });

  test('refund: requires transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'refund' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('MISSING_TRANSACTION_ID');
  });

  test('approve: succeeds with transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'approve', transactionId: 'txn-123' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { ok: boolean; transactionId: string };
    expect(body.ok).toBe(true);
    expect(body.transactionId).toBe('txn-123');
    expect(mockRunStorekit).toHaveBeenCalledWith(['test-session', 'approve', UDID, 'txn-123']);
  });

  test('decline: succeeds with transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'decline', transactionId: 'txn-456' });

    expect(result.isError).toBeUndefined();
    expect(mockRunStorekit).toHaveBeenCalledWith(['test-session', 'decline', UDID, 'txn-456']);
  });

  test('refund: succeeds with transactionId', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'refund', transactionId: 'txn-789' });

    expect(result.isError).toBeUndefined();
    expect(mockRunStorekit).toHaveBeenCalledWith(['test-session', 'refund', UDID, 'txn-789']);
  });

  test('clear: clears pending transactions', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'clear' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockRunStorekit).toHaveBeenCalledWith(['test-session', 'clear', UDID]);
  });

  test('askToBuy: requires enabled boolean', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'askToBuy' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('MISSING_ENABLED');
  });

  test('askToBuy: enabled=true calls ask-to-buy enable', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'askToBuy', enabled: true });

    expect(result.isError).toBeUndefined();
    expect(mockRunStorekit).toHaveBeenCalledWith([
      'test-session',
      'ask-to-buy',
      UDID,
      'enable',
    ]);
  });

  test('askToBuy: enabled=false calls ask-to-buy disable', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'askToBuy', enabled: false });

    expect(result.isError).toBeUndefined();
    expect(mockRunStorekit).toHaveBeenCalledWith([
      'test-session',
      'ask-to-buy',
      UDID,
      'disable',
    ]);
  });

  test('STOREKIT_DISABLED error when disabled', async () => {
    mockAssertStorekitEnabled.mockImplementation(() => {
      throw new StorekitDisabledError();
    });

    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'list' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('STOREKIT_DISABLED');
  });

  test('DEVICE_NOT_BOOTED when no device available', async () => {
    mockGetSoleDeviceId.mockReturnValue(null);

    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'list' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('DEVICE_NOT_BOOTED');
  });

  test('_meta._telemetry has backend=storekit on list', async () => {
    const handler = server.getToolHandler('app_storekit_test_session')!;
    const result = await handler('session', { action: 'list' });

    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { _meta: { _telemetry: { backend: string } } };
    expect(body._meta._telemetry.backend).toBe('storekit');
  });
});

// ── app_storekit_receipt ──────────────────────────────────────────────────────

describe('app_storekit_receipt', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppStorekitReceiptTool(server);
  });

  beforeEach(() => {
    mockAssertStorekitEnabled.mockReset().mockReturnValue(undefined);
    mockExecFile.mockReset();
    mockFsAccess.mockReset();
    mockFsReadFile.mockReset();
    mockGetSoleDeviceId.mockReturnValue(UDID);
  });

  test('is registered', () => {
    expect(server.getRegisteredTools()).toContain('app_storekit_receipt');
  });

  test('success: returns base64 receipt', async () => {
    const receiptContent = Buffer.from('fake-receipt-data');

    // Mock execFile for get_app_container (callback style)
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        callback: (err: null, result: { stdout: string }) => void,
      ) => {
        callback(null, { stdout: '/tmp/sim/data/container\n' });
      },
    );
    // sandboxReceipt exists
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(receiptContent);

    const handler = server.getToolHandler('app_storekit_receipt')!;
    const result = await handler('session', { bundleId: BUNDLE_ID });

    expect(result.isError).toBeUndefined();
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as {
      receipt: string;
      bytes: number;
      path: string;
      bundleId: string;
      _meta: { _telemetry: { backend: string } };
    };
    expect(body.receipt).toBe(receiptContent.toString('base64'));
    expect(body.bytes).toBe(receiptContent.length);
    expect(body.bundleId).toBe(BUNDLE_ID);
    expect(body._meta._telemetry.backend).toBe('storekit');
  });

  test('error: NO_RECEIPT when receipt files not found', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        callback: (err: null, result: { stdout: string }) => void,
      ) => {
        callback(null, { stdout: '/tmp/sim/data/container\n' });
      },
    );
    // Neither path exists
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));

    const handler = server.getToolHandler('app_storekit_receipt')!;
    const result = await handler('session', { bundleId: BUNDLE_ID });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('NO_RECEIPT');
  });

  test('error: APP_NOT_INSTALLED when get_app_container fails', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: Error) => void) => {
        callback(new Error('No such bundle'));
      },
    );

    const handler = server.getToolHandler('app_storekit_receipt')!;
    const result = await handler('session', { bundleId: 'com.example.notinstalled' });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('APP_NOT_INSTALLED');
  });

  test('error: STOREKIT_DISABLED when assertStorekitEnabled throws', async () => {
    mockAssertStorekitEnabled.mockImplementation(() => {
      throw new StorekitDisabledError();
    });

    const handler = server.getToolHandler('app_storekit_receipt')!;
    const result = await handler('session', { bundleId: BUNDLE_ID });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('STOREKIT_DISABLED');
  });

  test('error: DEVICE_NOT_BOOTED when no device available', async () => {
    mockGetSoleDeviceId.mockReturnValue(null);

    const handler = server.getToolHandler('app_storekit_receipt')!;
    const result = await handler('session', { bundleId: BUNDLE_ID });

    expect(result.isError).toBe(true);
    const body = parseResult(
      result as { content: Array<{ type: string; text: string }> },
    ) as { error: string };
    expect(body.error).toBe('DEVICE_NOT_BOOTED');
  });
});

// ── simctl-storekit helpers (real implementation) ─────────────────────────────

describe('simctl-storekit helpers (real module)', () => {
  describe('parseTransactionList', () => {
    const { parseTransactionList } = jest.requireActual<
      typeof import('../../src/native/simctl-storekit')
    >('../../src/native/simctl-storekit');

    it('returns empty array for empty string', () => {
      expect(parseTransactionList('')).toEqual([]);
    });

    it('parses array JSON', () => {
      const data = [{ id: 'txn-1', state: 'pending', productId: 'com.example.p1' }];
      expect(parseTransactionList(JSON.stringify(data))).toEqual(data);
    });

    it('parses object with transactions key', () => {
      const data = {
        transactions: [{ id: 'txn-2', state: 'approved', productId: 'com.example.p2' }],
      };
      expect(parseTransactionList(JSON.stringify(data))).toEqual(data.transactions);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parseTransactionList('not json')).toEqual([]);
    });
  });

  describe('assertStorekitEnabled', () => {
    const { assertStorekitEnabled, StorekitDisabledError: RealStorekitDisabledError } =
      jest.requireActual<typeof import('../../src/native/simctl-storekit')>(
        '../../src/native/simctl-storekit',
      );

    const realEnvKey = 'OPENSAFARI_DISABLE_STOREKIT';

    afterEach(() => {
      delete process.env[realEnvKey];
    });

    it('does not throw when env var is unset', () => {
      delete process.env[realEnvKey];
      expect(() => assertStorekitEnabled()).not.toThrow();
    });

    it('throws StorekitDisabledError when OPENSAFARI_DISABLE_STOREKIT=1', () => {
      process.env[realEnvKey] = '1';
      expect(() => assertStorekitEnabled()).toThrow(RealStorekitDisabledError);
    });

    it('throws StorekitDisabledError when OPENSAFARI_DISABLE_STOREKIT=true', () => {
      process.env[realEnvKey] = 'true';
      expect(() => assertStorekitEnabled()).toThrow(RealStorekitDisabledError);
    });
  });
});
