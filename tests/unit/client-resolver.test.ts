/**
 * Unit tests for the shared `resolveClient` helper used by session-aware
 * tool handlers to route between a tab-scoped session and the device-level
 * WebKit client.
 */

// Mock mcp-server so we can control getWebKitClient
const mockGetWebKitClient = jest.fn();
jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: mockGetWebKitClient };
});

// Mock session-manager so we can control getTabSession + active device
const mockGetTabSession = jest.fn();
const mockGetSoleDeviceId = jest.fn();
jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getTabSession: mockGetTabSession,
    getSoleDeviceId: mockGetSoleDeviceId,
  }),
}));

import { resolveClient, sessionNotFoundError, noClientError } from '../../src/tools/client-resolver';

describe('resolveClient', () => {
  const fakeTabClient = { id: 'tab-client' } as any;
  const fakeDeviceClient = { id: 'device-client' } as any;

  beforeEach(() => {
    mockGetWebKitClient.mockReset();
    mockGetTabSession.mockReset();
    mockGetSoleDeviceId.mockReset().mockReturnValue(null);
  });

  test('returns the session client when sessionId matches', () => {
    mockGetTabSession.mockReturnValue({
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      targetId: 't-1',
      url: 'https://example.com',
      createdAt: 1,
      client: fakeTabClient,
    });

    const result = resolveClient({ sessionId: 'sess-1' });

    expect(result.source).toBe('session');
    expect(result.client).toBe(fakeTabClient);
    expect(result.sessionId).toBe('sess-1');
    expect(result.deviceId).toBe('dev-1');
    expect(mockGetWebKitClient).not.toHaveBeenCalled();
  });

  test('returns source=none when sessionId is supplied but unknown', () => {
    mockGetTabSession.mockReturnValue(null);

    const result = resolveClient({ sessionId: 'ghost' });

    expect(result.source).toBe('none');
    expect(result.client).toBeNull();
    expect(result.sessionId).toBe('ghost');
    expect(mockGetWebKitClient).not.toHaveBeenCalled();
  });

  test('falls back to device client when no sessionId is provided', () => {
    mockGetWebKitClient.mockReturnValue(fakeDeviceClient);

    const result = resolveClient({ deviceId: 'dev-2' });

    expect(result.source).toBe('device');
    expect(result.client).toBe(fakeDeviceClient);
    expect(mockGetWebKitClient).toHaveBeenCalledWith('dev-2');
  });

  test('returns source=none when no client is available', () => {
    mockGetWebKitClient.mockReturnValue(null);

    const result = resolveClient({});

    expect(result.source).toBe('none');
    expect(result.client).toBeNull();
  });

  test('ignores empty-string sessionId and uses device fallback', () => {
    mockGetWebKitClient.mockReturnValue(fakeDeviceClient);

    const result = resolveClient({ sessionId: '' });

    expect(result.source).toBe('device');
    expect(mockGetTabSession).not.toHaveBeenCalled();
  });

  test('carries the active device id in the fallback result when one exists', () => {
    mockGetWebKitClient.mockReturnValue(fakeDeviceClient);
    mockGetSoleDeviceId.mockReturnValue('active-dev');

    const result = resolveClient({});

    expect(result.deviceId).toBe('active-dev');
  });
});

describe('sessionNotFoundError', () => {
  test('returns structured SESSION_NOT_FOUND payload', () => {
    const err = sessionNotFoundError('abc');
    expect(err.isError).toBe(true);
    const body = JSON.parse(err.content[0].text);
    expect(body.error).toBe('SESSION_NOT_FOUND');
    expect(body.sessionId).toBe('abc');
    expect(body.message).toContain('qa_session_list');
  });
});

describe('noClientError', () => {
  test('returns structured NO_WEBKIT_CLIENT payload', () => {
    const err = noClientError();
    expect(err.isError).toBe(true);
    const body = JSON.parse(err.content[0].text);
    expect(body.error).toBe('NO_WEBKIT_CLIENT');
    expect(body.message).toContain('device_boot');
  });
});
