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
export declare class AuthManager {
    private authDir;
    constructor(authDir?: string);
    save(site: string, client: BrowserBackend): Promise<string>;
    restore(site: string, client: BrowserBackend): Promise<void>;
    list(): Promise<Array<{
        site: string;
        savedAt: string;
        cookieCount: number;
    }>>;
    delete(site: string): Promise<void>;
    checkExpiry(site: string): Promise<ExpiryInfo>;
    loadProfile(site: string): Promise<AuthProfile>;
    private sanitizeSite;
}
//# sourceMappingURL=manager.d.ts.map