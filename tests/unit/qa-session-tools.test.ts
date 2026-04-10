/**
 * Unit tests for the qa_session_* MCP tools.
 *
 * These tests mock TabManager to isolate the tool handler logic from
 * TabPool / WebKitClient.
 */

// Mock tab-manager first so the imported tool modules pick up the mock
const mockOpenSession = jest.fn();
const mockCloseSession = jest.fn();
const mockListSessions = jest.fn();

jest.mock('../../src/tools/tab-manager', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
  closeSession: (...args: unknown[]) => mockCloseSession(...args),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
}));

// Stub getWebKitClient: return a non-null client by default so tool flow proceeds
const mockGetWebKitClient = jest.fn().mockReturnValue({ isConnected: () => true });
jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: mockGetWebKitClient };
});

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getActiveDeviceId: () => 'ACTIVE-DEVICE',
  }),
}));

import { MCPServer } from '../../src/mcp-server';
import {
  registerQaSessionCreateTool,
  registerQaSessionDestroyTool,
  registerQaSessionListTool,
} from '../../src/tools/qa-session';

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('qa_session_create', () => {
  let server: MCPServer;

  beforeEach(() => {
    mockOpenSession.mockReset();
    mockGetWebKitClient.mockReset().mockReturnValue({ isConnected: () => true });
    server = new MCPServer();
    registerQaSessionCreateTool(server);
  });

  test('registers the tool with the expected name', () => {
    expect(server.getRegisteredTools()).toContain('qa_session_create');
  });

  test('returns session metadata on success', async () => {
    mockOpenSession.mockResolvedValue({
      sessionId: 'session-123',
      deviceId: 'ACTIVE-DEVICE',
      targetId: 'target-abc',
      url: 'https://example.com',
      createdAt: 1700000000000,
      client: {} as any,
    });

    const handler = server.getToolHandler('qa_session_create')!;
    const result = await handler('s', { url: 'https://example.com' });
    const body = parseResult(result);

    expect(body.sessionId).toBe('session-123');
    expect(body.deviceId).toBe('ACTIVE-DEVICE');
    expect(body.targetId).toBe('target-abc');
    expect(body.url).toBe('https://example.com');
    expect(mockOpenSession).toHaveBeenCalledWith(
      'ACTIVE-DEVICE',
      'https://example.com',
      expect.anything(),
    );
  });

  test('rejects empty url', async () => {
    const handler = server.getToolHandler('qa_session_create')!;
    const result = await handler('s', { url: '' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toContain('non-empty string');
  });

  test('returns NO_WEBKIT_CLIENT when no client is available', async () => {
    mockGetWebKitClient.mockReturnValue(null);
    const handler = server.getToolHandler('qa_session_create')!;
    const result = await handler('s', { url: 'https://example.com' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toBe('NO_WEBKIT_CLIENT');
  });

  test('surfaces openSession errors as tool errors', async () => {
    mockOpenSession.mockRejectedValue(new Error('target discovery failed'));
    const handler = server.getToolHandler('qa_session_create')!;
    const result = await handler('s', { url: 'https://example.com' });
    expect((result as any).isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toContain('target discovery failed');
  });
});

describe('qa_session_destroy', () => {
  let server: MCPServer;

  beforeEach(() => {
    mockCloseSession.mockReset();
    server = new MCPServer();
    registerQaSessionDestroyTool(server);
  });

  test('returns destroyed=true when the session existed', async () => {
    mockCloseSession.mockResolvedValue(true);
    const handler = server.getToolHandler('qa_session_destroy')!;
    const result = await handler('s', { sessionId: 'abc' });
    const body = parseResult(result);
    expect(body.sessionId).toBe('abc');
    expect(body.found).toBe(true);
    expect(body.status).toBe('destroyed');
  });

  test('returns found=false for unknown session without error', async () => {
    mockCloseSession.mockResolvedValue(false);
    const handler = server.getToolHandler('qa_session_destroy')!;
    const result = await handler('s', { sessionId: 'missing' });
    expect((result as any).isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.found).toBe(false);
    expect(body.status).toBe('not_found');
  });

  test('rejects empty sessionId', async () => {
    const handler = server.getToolHandler('qa_session_destroy')!;
    const result = await handler('s', { sessionId: '' });
    expect((result as any).isError).toBe(true);
  });
});

describe('qa_session_list', () => {
  let server: MCPServer;

  beforeEach(() => {
    mockListSessions.mockReset();
    server = new MCPServer();
    registerQaSessionListTool(server);
  });

  test('returns active sessions with sanitized fields', async () => {
    mockListSessions.mockReturnValue([
      {
        sessionId: 's1',
        deviceId: 'd1',
        targetId: 't1',
        url: 'https://a.com',
        createdAt: 1,
        client: {} as any,
      },
      {
        sessionId: 's2',
        deviceId: 'd1',
        targetId: 't2',
        url: 'https://b.com',
        createdAt: 2,
        client: {} as any,
      },
    ]);

    const handler = server.getToolHandler('qa_session_list')!;
    const result = await handler('s', {});
    const body = parseResult(result);

    expect(body.count).toBe(2);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).not.toHaveProperty('client');
    expect(body.sessions[0].sessionId).toBe('s1');
    expect(mockListSessions).toHaveBeenCalledWith(undefined);
  });

  test('forwards deviceId filter', async () => {
    mockListSessions.mockReturnValue([]);
    const handler = server.getToolHandler('qa_session_list')!;
    await handler('s', { deviceId: 'my-device' });
    expect(mockListSessions).toHaveBeenCalledWith('my-device');
  });
});
