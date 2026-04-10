/**
 * Unit tests for TabManager — the singleton that exposes TabPool instances
 * to the qa_session_* MCP tools.
 */

import { getSessionManager } from '../../src/session-manager';

// Mock TabPool: each instance tracks openTab / closeTab calls
const mockOpenTab = jest.fn();
const mockCloseTab = jest.fn();
const mockCloseAll = jest.fn();
const tabPoolInstances: any[] = [];

jest.mock('../../src/simulator/tab-pool', () => ({
  TabPool: jest.fn().mockImplementation(function (this: any) {
    this.openTab = mockOpenTab;
    this.closeTab = mockCloseTab;
    this.closeAll = mockCloseAll;
    tabPoolInstances.push(this);
  }),
}));

// Stable fake WebKitClient: the TabPool wraps it but we never call through
const fakeClient = {
  getHost: () => 'localhost',
  getPort: () => 9322,
} as any;

import {
  getTabPool,
  openSession,
  closeSession,
  listSessions,
  disposeDevice,
  resetTabManager,
} from '../../src/tools/tab-manager';

const DEVICE_A = 'device-a-udid';
const DEVICE_B = 'device-b-udid';

describe('TabManager', () => {
  beforeEach(() => {
    mockOpenTab.mockReset();
    mockCloseTab.mockReset();
    mockCloseAll.mockReset();
    tabPoolInstances.length = 0;
    resetTabManager();
    // Drain any sessions registered by earlier tests
    const sm = getSessionManager();
    for (const s of sm.listTabSessions()) {
      sm.removeTabSession(s.sessionId);
    }
  });

  describe('getTabPool', () => {
    test('creates a new TabPool on first call per device', () => {
      const pool = getTabPool(DEVICE_A, fakeClient);
      expect(pool).toBeDefined();
      expect(tabPoolInstances).toHaveLength(1);
    });

    test('reuses the same TabPool on subsequent calls for the same device', () => {
      const first = getTabPool(DEVICE_A, fakeClient);
      const second = getTabPool(DEVICE_A, fakeClient);
      expect(first).toBe(second);
      expect(tabPoolInstances).toHaveLength(1);
    });

    test('creates separate pools per device', () => {
      getTabPool(DEVICE_A, fakeClient);
      getTabPool(DEVICE_B, fakeClient);
      expect(tabPoolInstances).toHaveLength(2);
    });
  });

  describe('openSession', () => {
    test('returns session metadata with a fresh UUID', async () => {
      mockOpenTab.mockResolvedValue({ getTargetId: () => 'target-1' });

      const info = await openSession(DEVICE_A, 'https://example.com', fakeClient);

      expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(info.deviceId).toBe(DEVICE_A);
      expect(info.targetId).toBe('target-1');
      expect(info.url).toBe('https://example.com');
      expect(mockOpenTab).toHaveBeenCalledWith('https://example.com');
    });

    test('registers the session with SessionManager', async () => {
      mockOpenTab.mockResolvedValue({ getTargetId: () => 'target-2' });

      const info = await openSession(DEVICE_A, 'https://a.com', fakeClient);

      const found = getSessionManager().getTabSession(info.sessionId);
      expect(found).not.toBeNull();
      expect(found!.targetId).toBe('target-2');
    });

    test('two openSession calls produce distinct sessionIds', async () => {
      mockOpenTab
        .mockResolvedValueOnce({ getTargetId: () => 't1' })
        .mockResolvedValueOnce({ getTargetId: () => 't2' });

      const a = await openSession(DEVICE_A, 'https://a.com', fakeClient);
      const b = await openSession(DEVICE_A, 'https://b.com', fakeClient);

      expect(a.sessionId).not.toBe(b.sessionId);
      expect(getSessionManager().listTabSessions(DEVICE_A)).toHaveLength(2);
    });
  });

  describe('closeSession', () => {
    test('closes the underlying tab and removes the session', async () => {
      mockOpenTab.mockResolvedValue({ getTargetId: () => 'target-3' });
      mockCloseTab.mockResolvedValue(undefined);
      const info = await openSession(DEVICE_A, 'https://x.com', fakeClient);

      const result = await closeSession(info.sessionId);

      expect(result).toBe(true);
      expect(mockCloseTab).toHaveBeenCalledWith('target-3');
      expect(getSessionManager().getTabSession(info.sessionId)).toBeNull();
    });

    test('returns false for an unknown sessionId', async () => {
      const result = await closeSession('no-such-session');
      expect(result).toBe(false);
      expect(mockCloseTab).not.toHaveBeenCalled();
    });

    test('still removes the session from SessionManager if closeTab throws', async () => {
      mockOpenTab.mockResolvedValue({ getTargetId: () => 'target-4' });
      mockCloseTab.mockRejectedValue(new Error('tab already gone'));
      const info = await openSession(DEVICE_A, 'https://y.com', fakeClient);

      const result = await closeSession(info.sessionId);

      expect(result).toBe(true);
      expect(getSessionManager().getTabSession(info.sessionId)).toBeNull();
    });
  });

  describe('listSessions', () => {
    test('returns all sessions when no device filter is provided', async () => {
      mockOpenTab
        .mockResolvedValueOnce({ getTargetId: () => 't-a' })
        .mockResolvedValueOnce({ getTargetId: () => 't-b' });

      await openSession(DEVICE_A, 'https://a.com', fakeClient);
      await openSession(DEVICE_B, 'https://b.com', fakeClient);

      expect(listSessions()).toHaveLength(2);
    });

    test('filters by deviceId', async () => {
      mockOpenTab
        .mockResolvedValueOnce({ getTargetId: () => 't-a' })
        .mockResolvedValueOnce({ getTargetId: () => 't-b' });

      await openSession(DEVICE_A, 'https://a.com', fakeClient);
      await openSession(DEVICE_B, 'https://b.com', fakeClient);

      const aOnly = listSessions(DEVICE_A);
      expect(aOnly).toHaveLength(1);
      expect(aOnly[0].deviceId).toBe(DEVICE_A);
    });
  });

  describe('disposeDevice', () => {
    test('closes all sessions for the device and drops the pool', async () => {
      mockOpenTab
        .mockResolvedValueOnce({ getTargetId: () => 't-1' })
        .mockResolvedValueOnce({ getTargetId: () => 't-2' })
        .mockResolvedValueOnce({ getTargetId: () => 't-3' });
      mockCloseTab.mockResolvedValue(undefined);
      mockCloseAll.mockResolvedValue(undefined);

      await openSession(DEVICE_A, 'https://a.com', fakeClient);
      await openSession(DEVICE_A, 'https://b.com', fakeClient);
      await openSession(DEVICE_B, 'https://b.com', fakeClient);

      await disposeDevice(DEVICE_A);

      expect(listSessions(DEVICE_A)).toHaveLength(0);
      expect(listSessions(DEVICE_B)).toHaveLength(1);
      expect(mockCloseAll).toHaveBeenCalledTimes(1);
    });

    test('is a no-op for a device with no sessions', async () => {
      await expect(disposeDevice('unknown-device')).resolves.toBeUndefined();
      expect(mockCloseTab).not.toHaveBeenCalled();
    });
  });
});
