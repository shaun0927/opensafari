/**
 * AuthManager integration tests -- no simulator required.
 * Tests the full save/list/delete lifecycle using a temporary directory
 * and a mock BrowserBackend to avoid needing a real WebKit connection.
 */

import { AuthManager } from '../../src/auth';
import type { AuthProfile } from '../../src/auth';
import type { BrowserBackend } from '../../src/types/browser-backend';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Minimal mock BrowserBackend that returns controlled data
 * for auth save operations.
 */
function createMockClient(): BrowserBackend {
  return {
    getCookies: async () => [
      {
        name: 'session',
        value: 'abc123',
        domain: '.example.com',
        path: '/',
        expires: Date.now() / 1000 + 3600,
        httpOnly: true,
        secure: true,
      },
    ],
    setCookies: async () => {},
    deleteCookies: async () => {},
    evaluate: async <T>(expr: string): Promise<T> => {
      if (expr.includes('localStorage')) {
        return { testKey: 'testValue' } as T;
      }
      if (expr.includes('sessionStorage')) {
        return {} as T;
      }
      if (expr.includes('location.href')) {
        return 'https://example.com/dashboard' as T;
      }
      return {} as T;
    },
    navigate: async () => ({ url: 'https://example.com', status: 200 }),
    screenshot: async () => Buffer.from('fake-screenshot'),
    readPage: async () => 'Example page content',
    querySelector: async () => null,
    querySelectorAll: async () => [],
    click: async () => {},
    type: async () => {},
    scroll: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
  } as unknown as BrowserBackend;
}

describe('AuthManager: save/list/delete lifecycle', () => {
  let tmpDir: string;
  let authManager: AuthManager;
  let mockClient: BrowserBackend;

  const TEST_SITE = 'example.com';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-auth-test-'));
    authManager = new AuthManager(tmpDir);
    mockClient = createMockClient();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('save() creates a file on disk', async () => {
    const filePath = await authManager.save(TEST_SITE, mockClient);
    expect(filePath).toContain('example.com');

    // Verify file exists
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  test('list() returns the saved profile', async () => {
    await authManager.save(TEST_SITE, mockClient);
    const profiles = await authManager.list();

    expect(profiles).toHaveLength(1);
    expect(profiles[0].site).toBe(TEST_SITE);
    expect(profiles[0].cookieCount).toBe(1);
    expect(profiles[0].savedAt).toBeTruthy();
  });

  test('saved profile has correct structure', async () => {
    await authManager.save(TEST_SITE, mockClient);
    const profile = await authManager.loadProfile(TEST_SITE);

    expect(profile).toHaveProperty('site', TEST_SITE);
    expect(profile).toHaveProperty('cookies');
    expect(profile).toHaveProperty('localStorage');
    expect(profile).toHaveProperty('savedAt');
    expect(profile).toHaveProperty('currentUrl');

    expect(Array.isArray(profile.cookies)).toBe(true);
    expect(profile.cookies.length).toBe(1);
    expect(profile.cookies[0].name).toBe('session');
    expect(typeof profile.localStorage).toBe('object');
    expect(profile.currentUrl).toBe('https://example.com/dashboard');
  });

  test('delete() removes the profile', async () => {
    await authManager.save(TEST_SITE, mockClient);

    // Confirm it exists
    const beforeDelete = await authManager.list();
    expect(beforeDelete).toHaveLength(1);

    // Delete it
    await authManager.delete(TEST_SITE);

    // Verify file is gone
    const afterDelete = await authManager.list();
    expect(afterDelete).toHaveLength(0);
  });

  test('list() after delete returns empty array', async () => {
    await authManager.save(TEST_SITE, mockClient);
    await authManager.delete(TEST_SITE);

    const profiles = await authManager.list();
    expect(profiles).toEqual([]);
  });

  test('save multiple profiles and list all', async () => {
    await authManager.save('alpha.com', mockClient);
    await authManager.save('beta.com', mockClient);
    await authManager.save('gamma.com', mockClient);

    const profiles = await authManager.list();
    expect(profiles).toHaveLength(3);

    const sites = profiles.map(p => p.site);
    expect(sites).toContain('alpha.com');
    expect(sites).toContain('beta.com');
    expect(sites).toContain('gamma.com');
  });

  test('checkExpiry detects non-expired cookies', async () => {
    await authManager.save(TEST_SITE, mockClient);
    const expiry = await authManager.checkExpiry(TEST_SITE);

    expect(expiry.totalCookies).toBe(1);
    expect(expiry.isExpired).toBe(false);
    expect(expiry.expiredCount).toBe(0);
  });
});
