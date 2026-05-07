import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { BrowserBackend, Cookie } from '../types/browser-backend';

export interface DomainGroup {
  domain: string;
  cookies: Cookie[];
}

export interface AuthProfile {
  site: string;
  savedAt: string;
  currentUrl: string;
  cookies: Cookie[];           // flat list for backward compat
  domainGroups?: DomainGroup[]; // cookies organized by domain
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
  private static readonly privateDirMode = 0o700;
  private static readonly privateFileMode = 0o600;

  constructor(authDir?: string) {
    this.authDir = authDir ?? path.join(os.homedir(), '.opensafari', 'auth');
  }

  async save(site: string, client: BrowserBackend, filteredCookies?: Cookie[]): Promise<string> {
    const cookies = filteredCookies ?? await client.getCookies();

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
      domainGroups: this.groupCookiesByDomain(cookies),
      localStorage: localStorage ?? {},
      sessionStorage: sessionStorage ?? {},
    };

    await this.ensureAuthDir();
    const filePath = path.join(this.authDir, this.sanitizeSite(site) + '.json');
    await this.atomicWriteProfile(filePath, JSON.stringify(profile, null, 2));

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


    // Inject sessionStorage (must happen before reload)
    if (data.sessionStorage && Object.keys(data.sessionStorage).length > 0) {
      await client.evaluate(`
        (function(data) {
          Object.entries(data).forEach(function(entry) {
            window.sessionStorage.setItem(entry[0], entry[1]);
          });
        })(${JSON.stringify(data.sessionStorage)})
      `);
    }
    // Reload to apply
    await client.navigate({ url: data.currentUrl ?? 'https://' + site, waitUntil: 'load' });
  }

  async list(): Promise<Array<{ site: string; savedAt: string; cookieCount: number; domains: string[] }>> {
    try {
      const files = await fs.readdir(this.authDir);
      const profiles = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fs.readFile(path.join(this.authDir, f), 'utf-8')) as AuthProfile;
          const domains = data.domainGroups
            ? data.domainGroups.map(g => g.domain)
            : [...new Set(data.cookies.map(c => c.domain.startsWith('.') ? c.domain.slice(1) : c.domain))];
          profiles.push({ site: data.site, savedAt: data.savedAt, cookieCount: data.cookies.length, domains });
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
    const expired = data.cookies.filter(c => c.expires > 0 && c.expires < now);
    const expiring = data.cookies.filter(c => c.expires > 0 && c.expires >= now && c.expires - now < 300);

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

  private groupCookiesByDomain(cookies: Cookie[]): DomainGroup[] {
    const groups = new Map<string, Cookie[]>();
    for (const cookie of cookies) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(cookie);
    }
    return Array.from(groups.entries()).map(([domain, cookies]) => ({ domain, cookies }));
  }

  private sanitizeSite(site: string): string {
    return site.replace(/[^a-zA-Z0-9.-]/g, '_');
  }

  private async ensureAuthDir(): Promise<void> {
    await fs.mkdir(this.authDir, { recursive: true, mode: AuthManager.privateDirMode });
    if (this.supportsPosixModes()) {
      await fs.chmod(this.authDir, AuthManager.privateDirMode);
    }
  }

  private async atomicWriteProfile(filePath: string, contents: string): Promise<void> {
    const tempPath = path.join(
      this.authDir,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, 'wx', AuthManager.privateFileMode);
      await handle.writeFile(contents, 'utf-8');
      await handle.close();
      handle = undefined;

      if (this.supportsPosixModes()) {
        await fs.chmod(tempPath, AuthManager.privateFileMode);
      }

      await fs.rename(tempPath, filePath);

      if (this.supportsPosixModes()) {
        await fs.chmod(filePath, AuthManager.privateFileMode);
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }


  private supportsPosixModes(): boolean {
    return process.platform !== 'win32';
  }
}
