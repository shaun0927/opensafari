import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BrowserBackend, Cookie } from '../types/browser-backend';

export interface AuthProfile {
  site: string;
  savedAt: string;
  currentUrl: string;
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface ExpiryInfo {
  totalCookies: number;
  expiredCount: number;
  expiringCount: number;
  earliestExpiry: number;
  isExpired: boolean;
  isExpiring: boolean;
}

export class AuthManager {
  private authDir: string;

  constructor(authDir?: string) {
    this.authDir = authDir ?? path.join(os.homedir(), '.opensafari', 'auth');
  }

  async save(site: string, client: BrowserBackend): Promise<string> {
    const cookies = await client.getCookies();

    const localStorage = await client.evaluate<Record<string, string>>(`
      (function() {
        var data = {};
        for (var i = 0; i < window.localStorage.length; i++) {
          var key = window.localStorage.key(i);
          if (key) data[key] = window.localStorage.getItem(key) || '';
        }
        return data;
      })()
    `);

    const sessionStorage = await client.evaluate<Record<string, string>>(`
      (function() {
        var data = {};
        for (var i = 0; i < window.sessionStorage.length; i++) {
          var key = window.sessionStorage.key(i);
          if (key) data[key] = window.sessionStorage.getItem(key) || '';
        }
        return data;
      })()
    `);

    const currentUrl = await client.evaluate<string>('window.location.href');

    const profile: AuthProfile = {
      site,
      savedAt: new Date().toISOString(),
      currentUrl,
      cookies,
      localStorage: localStorage ?? {},
      sessionStorage: sessionStorage ?? {},
    };

    await fs.mkdir(this.authDir, { recursive: true });
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2));

    return filePath;
  }

  async restore(site: string, client: BrowserBackend): Promise<void> {
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8')) as AuthProfile;

    // Navigate to site first (cookies need matching domain)
    await client.navigate({ url: 'https://' + site, waitUntil: 'domcontentloaded' });

    // Inject cookies
    await client.setCookies(data.cookies);

    // Inject localStorage
    if (data.localStorage && Object.keys(data.localStorage).length > 0) {
      await client.evaluate(`
        (function(data) {
          Object.entries(data).forEach(function(entry) {
            window.localStorage.setItem(entry[0], entry[1]);
          });
        })(${JSON.stringify(data.localStorage)})
      `);
    }

    // Reload to apply
    await client.navigate({ url: data.currentUrl ?? 'https://' + site, waitUntil: 'load' });
  }

  async list(): Promise<Array<{ site: string; savedAt: string; cookieCount: number }>> {
    try {
      const files = await fs.readdir(this.authDir);
      const profiles = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fs.readFile(path.join(this.authDir, f), 'utf-8')) as AuthProfile;
          profiles.push({ site: data.site, savedAt: data.savedAt, cookieCount: data.cookies.length });
        } catch {
          // Skip corrupted files
        }
      }
      return profiles;
    } catch {
      return [];
    }
  }

  async delete(site: string): Promise<void> {
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    await fs.unlink(filePath);
  }

  async checkExpiry(site: string): Promise<ExpiryInfo> {
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8')) as AuthProfile;

    const now = Date.now() / 1000;
    const expiring = data.cookies.filter(c => c.expires > 0 && c.expires - now < 300);
    const expired = data.cookies.filter(c => c.expires > 0 && c.expires < now);

    return {
      totalCookies: data.cookies.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      earliestExpiry: data.cookies
        .filter(c => c.expires > 0)
        .reduce((min, c) => Math.min(min, c.expires), Infinity),
      isExpired: expired.length > 0,
      isExpiring: expiring.length > 0,
    };
  }

  async loadProfile(site: string): Promise<AuthProfile> {
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as AuthProfile;
  }

  private sanitizeSite(site: string): string {
    return site.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}
