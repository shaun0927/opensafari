import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuthManager } from '../../src/auth/manager';
import { BrowserBackend, Cookie, NavigateOptions, NavigateResult } from '../../src/types/browser-backend';

const POSIX_MODE_MASK = 0o777;
const isPosix = process.platform !== 'win32';

const fakeCookies: Cookie[] = [
  {
    name: 'session',
    value: 'fake-session-token',
    domain: '.example.com',
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
];

function createFakeBackend(): BrowserBackend {
  return {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    navigate: jest.fn(async (opts: NavigateOptions): Promise<NavigateResult> => ({
      url: opts.url,
      status: 200,
      loadTime: 1,
    })),
    screenshot: async () => Buffer.from('fake-png'),
    evaluate: (jest.fn(async (expression: string): Promise<unknown> => {
      if (expression.includes('localStorage') && !expression.includes('setItem')) {
        return { theme: 'test-dark' };
      }
      if (expression.includes('sessionStorage') && !expression.includes('setItem')) {
        return { nonce: 'fake-nonce' };
      }
      if (expression.includes('location.href')) {
        return 'https://example.com/account';
      }
      return undefined;
    }) as BrowserBackend['evaluate']),
    readPage: async () => 'fake page',
    getCookies: async () => fakeCookies,
    setCookies: jest.fn(async () => {}),
    clearCookies: async () => {},
    click: async () => {},
    type: async () => {},
    scroll: async () => {},
    longPress: async () => {},
    swipe: async () => {},
    press: async () => {},
    dismissKeyboard: async () => {},
    selectOption: async () => {},
    querySelector: async () => null,
    querySelectorAll: async () => [],
    inspect: async () => ({}),
    waitFor: async () => {},
    onConsole: () => {},
    onRequest: () => {},
    onResponse: () => {},
  };
}

describe('AuthManager secure persistence', () => {
  let authDir: string;
  let authManager: AuthManager;

  beforeEach(async () => {
    authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-auth-secure-'));
    authManager = new AuthManager(authDir);
  });

  afterEach(async () => {
    await fs.rm(authDir, { recursive: true, force: true });
  });

  test('save preserves profile schema and restore behavior', async () => {
    const saveClient = createFakeBackend();
    const filePath = await authManager.save('example.com', saveClient);

    const profile = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(Object.keys(profile).sort()).toEqual([
      'cookies',
      'currentUrl',
      'domainGroups',
      'localStorage',
      'savedAt',
      'sessionStorage',
      'site',
    ]);
    expect(profile.site).toBe('example.com');
    expect(profile.currentUrl).toBe('https://example.com/account');
    expect(profile.cookies).toEqual(fakeCookies);
    expect(profile.domainGroups).toEqual([{ domain: 'example.com', cookies: fakeCookies }]);
    expect(profile.localStorage).toEqual({ theme: 'test-dark' });
    expect(profile.sessionStorage).toEqual({ nonce: 'fake-nonce' });

    const restoreClient = createFakeBackend();
    await authManager.restore('example.com', restoreClient);

    expect(restoreClient.setCookies).toHaveBeenCalledWith(fakeCookies);
    expect(restoreClient.navigate).toHaveBeenNthCalledWith(1, {
      url: 'https://example.com',
      waitUntil: 'domcontentloaded',
    });
    expect(restoreClient.navigate).toHaveBeenNthCalledWith(2, {
      url: 'https://example.com/account',
      waitUntil: 'load',
    });
  });

  test('save creates private auth directory and profile file on POSIX', async () => {
    const filePath = await authManager.save('example.com', createFakeBackend());

    if (!isPosix) {
      return;
    }

    const dirMode = (await fs.stat(authDir)).mode & POSIX_MODE_MASK;
    const fileMode = (await fs.stat(filePath)).mode & POSIX_MODE_MASK;

    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  test('save atomically replaces existing profile without temp-file residue', async () => {
    const firstPath = await authManager.save('example.com', createFakeBackend());
    const firstProfile = JSON.parse(await fs.readFile(firstPath, 'utf-8'));

    await authManager.save('example.com', createFakeBackend());

    const files = await fs.readdir(authDir);
    const secondProfile = JSON.parse(await fs.readFile(firstPath, 'utf-8'));

    expect(files).toEqual(['example.com.json']);
    expect(secondProfile.site).toBe(firstProfile.site);
    expect(secondProfile.cookies).toEqual(firstProfile.cookies);
    expect(secondProfile.localStorage).toEqual(firstProfile.localStorage);
    expect(secondProfile.sessionStorage).toEqual(firstProfile.sessionStorage);
  });
});
