import { MCPServer } from '../../src/mcp-server';
import { registerAppNotesPasteAndTapUrlTool } from '../../src/tools/app-notes-paste-and-tap-url';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({
    getSoleDeviceId: jest.fn().mockReturnValue('TEST-UDID-1234'),
  }),
}));

const launchAppMock = jest.fn();
jest.mock('../../src/simulator', () => ({
  SimulatorManager: jest.fn().mockImplementation(() => ({
    launchApp: launchAppMock,
  })),
}));

const typeViaPasteboardMock = jest.fn();
jest.mock('../../src/tools/pasteboard-input', () => ({
  typeViaPasteboard: (...args: unknown[]) => typeViaPasteboardMock(...args),
}));

const queryMock = jest.fn();
const pressMock = jest.fn();
jest.mock('../../src/native', () => ({
  getAccessibilityBridge: jest.fn().mockReturnValue({
    query: (...args: unknown[]) => queryMock(...args),
    press: (...args: unknown[]) => pressMock(...args),
  }),
}));

describe('app_notes_paste_and_tap_url', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAppNotesPasteAndTapUrlTool(server);
  });

  beforeEach(() => {
    launchAppMock.mockReset();
    typeViaPasteboardMock.mockReset();
    queryMock.mockReset();
    pressMock.mockReset();
    launchAppMock.mockResolvedValue({ ok: true });
    typeViaPasteboardMock.mockResolvedValue({ backend: 'pasteboard', length: 10 });
    pressMock.mockResolvedValue({ ok: true, code: 'OK', path: '', actions: [], role: null, identifier: null, label: null, message: null, axErrorCode: null });
  });

  test('registers with the expected name', () => {
    expect(server.getRegisteredTools()).toContain('app_notes_paste_and_tap_url');
  });

  test('happy path: launches Notes, paste-injects URL, taps detected link', async () => {
    // First query (editor role=AXTextArea) returns a match; subsequent calls
    // (for AXLink) also return a match.
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({
          matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }],
          total: 1,
        });
      }
      if (query.role === 'AXLink') {
        return Promise.resolve({
          matches: [
            { path: 'link#0', role: 'AXLink', label: 'https://example.com/detail/abc' },
          ],
          total: 1,
        });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 500,
      linkTapTimeoutMs: 500,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.url).toBe('https://example.com/detail/abc');
    expect(parsed.deviceId).toBe('TEST-UDID-1234');
    expect(parsed.linkElement.label).toBe('https://example.com/detail/abc');
    expect(parsed.linkElement.path).toBe('link#0');

    expect(launchAppMock).toHaveBeenCalledWith('TEST-UDID-1234', 'com.apple.mobilenotes');
    expect(typeViaPasteboardMock).toHaveBeenCalledWith(
      'TEST-UDID-1234',
      'https://example.com/detail/abc',
      expect.objectContaining({ restorePasteboard: true }),
    );
    // First press focuses editor; second presses link.
    expect(pressMock).toHaveBeenCalledTimes(2);
    expect(pressMock).toHaveBeenNthCalledWith(1, 'editor#0', 'TEST-UDID-1234');
    expect(pressMock).toHaveBeenNthCalledWith(2, 'link#0', 'TEST-UDID-1234');
  });

  test('matches link by URL host when label only shows the host', async () => {
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({ matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }], total: 1 });
      }
      if (query.role === 'AXLink') {
        return Promise.resolve({
          matches: [
            { path: 'link#0', role: 'AXLink', label: 'Detail · Example.com' },
            { path: 'link#1', role: 'AXLink', label: 'example.com' },
          ],
          total: 2,
        });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 500,
      linkTapTimeoutMs: 500,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    // No label contains the full URL literal, so the first AXLink whose
    // label contains the host wins.
    expect(parsed.linkElement.path).toBe('link#0');
  });

  test('prefers exact URL match over a host-only match earlier in the list', async () => {
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({ matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }], total: 1 });
      }
      if (query.role === 'AXLink') {
        return Promise.resolve({
          matches: [
            // Pre-existing host-only link on the same domain — would win under
            // first-match semantics and tap the wrong route.
            { path: 'link#stale', role: 'AXLink', label: 'https://example.com' },
            // The link we actually pasted appears later in the tree.
            { path: 'link#target', role: 'AXLink', label: 'https://example.com/detail/abc' },
          ],
          total: 2,
        });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 500,
      linkTapTimeoutMs: 500,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.linkElement.path).toBe('link#target');
    expect(pressMock).toHaveBeenNthCalledWith(2, 'link#target', 'TEST-UDID-1234');
  });

  test('does not tap a sole unrelated AXLink as a fallback', async () => {
    // Notes is launched into prior state: a pre-existing, completely unrelated
    // AXLink is already on screen. The tool must treat this as "no match" and
    // surface an error rather than tapping the wrong link.
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({ matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }], total: 1 });
      }
      if (query.role === 'AXLink') {
        return Promise.resolve({
          matches: [{ path: 'link#stale', role: 'AXLink', label: 'https://unrelated.test/stuff' }],
          total: 1,
        });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 500,
      linkTapTimeoutMs: 200,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe('APP_STATE_UNKNOWN');
    expect(parsed.message).toMatch(/Data Detector did not produce a link/);
    // The press for the detected link must never fire on a fallback candidate.
    expect(pressMock).not.toHaveBeenCalledWith('link#stale', 'TEST-UDID-1234');
  });

  test('returns isError when url is missing', async () => {
    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {});
    expect(result.isError).toBe(true);
  });

  test('returns isError when url has no scheme', async () => {
    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', { url: 'example.com/no-scheme' });
    expect(result.isError).toBe(true);
  });

  test('returns isError when Notes editor never appears', async () => {
    queryMock.mockResolvedValue({ matches: [], total: 0 });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 200,
      linkTapTimeoutMs: 200,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe('APP_STATE_UNKNOWN');
    expect(parsed.message).toMatch(/Notes editor did not appear/);
    expect(typeViaPasteboardMock).not.toHaveBeenCalled();
  });

  test('returns isError when Data Detector never produces a link', async () => {
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({ matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }], total: 1 });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 500,
      linkTapTimeoutMs: 200,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe('APP_STATE_UNKNOWN');
    expect(parsed.message).toMatch(/Data Detector did not produce a link/);
  });

  test('returns isError when Notes launch fails', async () => {
    launchAppMock.mockRejectedValueOnce(new Error('simctl launch failed: no such bundle'));

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', { url: 'https://example.com/x' });
    expect(result.isError).toBe(true);
  });

  test('returns isError when pressing the detected link fails', async () => {
    queryMock.mockImplementation((query: { role: string }) => {
      if (query.role === 'AXTextArea') {
        return Promise.resolve({ matches: [{ path: 'editor#0', role: 'AXTextArea', label: null }], total: 1 });
      }
      if (query.role === 'AXLink') {
        return Promise.resolve({
          matches: [{ path: 'link#0', role: 'AXLink', label: 'https://example.com/detail/abc' }],
          total: 1,
        });
      }
      return Promise.resolve({ matches: [], total: 0 });
    });
    pressMock.mockImplementation((path: string) => {
      if (path === 'link#0') {
        return Promise.resolve({ ok: false, code: 'PRESS_NOT_ACTIONABLE', path, actions: [], role: 'AXLink', identifier: null, label: null, message: 'link does not advertise AXPress', axErrorCode: null });
      }
      return Promise.resolve({ ok: true, code: 'OK', path, actions: [], role: null, identifier: null, label: null, message: null, axErrorCode: null });
    });

    const handler = server.getToolHandler('app_notes_paste_and_tap_url')!;
    const result = await handler('test-session', {
      url: 'https://example.com/detail/abc',
      settleMs: 0,
      focusTimeoutMs: 200,
      linkTapTimeoutMs: 200,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as unknown as Array<{ text: string }>)[0].text);
    expect(parsed.error).toBe('APP_STATE_UNKNOWN');
    expect(parsed.message).toMatch(/Failed to press detected link/);
  });
});
