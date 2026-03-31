/**
 * SessionManager Integration Tests
 * Verifies that getWebKitClient/setWebKitClient delegate to SessionManager
 * and that multi-device connection tracking works correctly.
 */

import { getWebKitClient, setWebKitClient } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { BrowserBackend } from '../../src/types/browser-backend';

function createMockClient(id: string): BrowserBackend {
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    isConnected: () => true,
    navigate: jest.fn(),
    screenshot: jest.fn(),
    evaluate: jest.fn(),
    readPage: jest.fn(),
    getCookies: jest.fn(),
    setCookies: jest.fn(),
    clearCookies: jest.fn(),
    click: jest.fn(),
    type: jest.fn(),
    scroll: jest.fn(),
    longPress: jest.fn(),
    swipe: jest.fn(),
    press: jest.fn(),
    dismissKeyboard: jest.fn(),
    selectOption: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(),
    inspect: jest.fn(),
    waitFor: jest.fn(),
    onConsole: jest.fn(),
    onRequest: jest.fn(),
    onResponse: jest.fn(),
    _id: id, // for identification in tests
  } as unknown as BrowserBackend;
}

describe('SessionManager Integration', () => {
  beforeEach(() => {
    // Reset SessionManager state
    const sm = getSessionManager();
    // Clear all simulators and connections
    for (const sim of sm.listSimulators()) {
      sm.removeSimulator(sim.deviceId);
    }
  });

  describe('Legacy setWebKitClient/getWebKitClient', () => {
    it('should store and retrieve client via legacy API', () => {
      const mock = createMockClient('legacy');
      setWebKitClient(mock);
      expect(getWebKitClient()).toBe(mock);
    });

    it('should clear client when set to null', () => {
      const mock = createMockClient('legacy');
      setWebKitClient(mock);
      expect(getWebKitClient()).toBe(mock);
      setWebKitClient(null);
      expect(getWebKitClient()).toBeNull();
    });

    it('should replace client on repeated set', () => {
      const mock1 = createMockClient('first');
      const mock2 = createMockClient('second');
      setWebKitClient(mock1);
      expect(getWebKitClient()).toBe(mock1);
      setWebKitClient(mock2);
      expect(getWebKitClient()).toBe(mock2);
    });
  });

  describe('Multi-device via SessionManager', () => {
    it('should track multiple device connections', () => {
      const sm = getSessionManager();
      const clientA = createMockClient('device-A');
      const clientB = createMockClient('device-B');

      sm.addSimulator('udid-A', {
        deviceId: 'udid-A',
        deviceType: 'iPhone 17',
        state: 'booted',
        viewport: { width: 390, height: 844 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
      sm.setConnection('udid-A', clientA);

      sm.addSimulator('udid-B', {
        deviceId: 'udid-B',
        deviceType: 'iPad Pro',
        state: 'booted',
        viewport: { width: 1024, height: 1366 },
        bootedAt: Date.now(),
        lastActivity: Date.now(),
      });
      sm.setConnection('udid-B', clientB);

      // First registered becomes active
      expect(getWebKitClient()).toBe(clientA);
      // Specific device retrieval
      expect(getWebKitClient('udid-A')).toBe(clientA);
      expect(getWebKitClient('udid-B')).toBe(clientB);
    });

    it('should switch active device', () => {
      const sm = getSessionManager();
      const clientA = createMockClient('device-A');
      const clientB = createMockClient('device-B');

      sm.addSimulator('udid-A', {
        deviceId: 'udid-A', deviceType: 'iPhone 17', state: 'booted',
        viewport: { width: 390, height: 844 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-A', clientA);

      sm.addSimulator('udid-B', {
        deviceId: 'udid-B', deviceType: 'iPad Pro', state: 'booted',
        viewport: { width: 1024, height: 1366 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-B', clientB);

      // Default is first device
      expect(getWebKitClient()).toBe(clientA);

      // Switch active
      sm.setActiveDevice('udid-B');
      expect(getWebKitClient()).toBe(clientB);

      // Specific retrieval still works
      expect(getWebKitClient('udid-A')).toBe(clientA);
    });

    it('should fallback to next device when active is removed', () => {
      const sm = getSessionManager();
      const clientA = createMockClient('device-A');
      const clientB = createMockClient('device-B');

      sm.addSimulator('udid-A', {
        deviceId: 'udid-A', deviceType: 'iPhone 17', state: 'booted',
        viewport: { width: 390, height: 844 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-A', clientA);

      sm.addSimulator('udid-B', {
        deviceId: 'udid-B', deviceType: 'iPad Pro', state: 'booted',
        viewport: { width: 1024, height: 1366 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-B', clientB);

      expect(getWebKitClient()).toBe(clientA);

      // Remove active device → should fallback to udid-B
      sm.removeSimulator('udid-A');
      expect(getWebKitClient()).toBe(clientB);
      expect(sm.getActiveDeviceId()).toBe('udid-B');
    });

    it('should return null when all devices removed', () => {
      const sm = getSessionManager();
      const client = createMockClient('device');

      sm.addSimulator('udid-1', {
        deviceId: 'udid-1', deviceType: 'iPhone', state: 'booted',
        viewport: { width: 390, height: 844 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-1', client);

      sm.removeSimulator('udid-1');
      expect(getWebKitClient()).toBeNull();
      expect(sm.getActiveDeviceId()).toBeNull();
    });
  });

  describe('Connection helpers', () => {
    it('hasConnection returns correct state', () => {
      const sm = getSessionManager();
      const client = createMockClient('test');

      sm.addSimulator('udid-1', {
        deviceId: 'udid-1', deviceType: 'iPhone', state: 'booted',
        viewport: { width: 390, height: 844 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });

      expect(sm.hasConnection('udid-1')).toBe(false);
      sm.setConnection('udid-1', client);
      expect(sm.hasConnection('udid-1')).toBe(true);
      sm.removeConnection('udid-1');
      expect(sm.hasConnection('udid-1')).toBe(false);
    });

    it('listConnections returns all active connections', () => {
      const sm = getSessionManager();
      const clientA = createMockClient('A');
      const clientB = createMockClient('B');

      sm.addSimulator('udid-A', {
        deviceId: 'udid-A', deviceType: 'iPhone', state: 'booted',
        viewport: { width: 390, height: 844 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-A', clientA);

      sm.addSimulator('udid-B', {
        deviceId: 'udid-B', deviceType: 'iPad', state: 'booted',
        viewport: { width: 1024, height: 1366 }, bootedAt: Date.now(), lastActivity: Date.now(),
      });
      sm.setConnection('udid-B', clientB);

      const conns = sm.listConnections();
      expect(conns).toHaveLength(2);
      expect(conns.find(c => c.deviceId === 'udid-A')?.client).toBe(clientA);
      expect(conns.find(c => c.deviceId === 'udid-B')?.client).toBe(clientB);
    });
  });
});
