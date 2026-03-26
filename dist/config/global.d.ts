/**
 * OpenSafari Global Configuration
 * Safari/Simulator equivalent of OpenChrome's Chrome-specific config
 */
export interface OpenSafariConfig {
    defaultDevice: string;
    maxSimulators: number;
    bootTimeout: number;
    idleShutdownTimeout: number;
    webkitDebugPort: number;
    navigationTimeout: number;
    screenshotTimeout: number;
    evaluateTimeout: number;
    authDir: string;
    blockedDomains: string[];
    sanitizeContent: boolean;
    auditLog: boolean;
    healthPort: number;
    maxMemoryPerSimulator: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
export declare function getGlobalConfig(): OpenSafariConfig;
export declare function setGlobalConfig(config: Partial<OpenSafariConfig>): void;
export declare function resetGlobalConfig(): void;
//# sourceMappingURL=global.d.ts.map