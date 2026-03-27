/**
 * OpenSafari Global Configuration
 * Safari/Simulator equivalent of OpenChrome's Chrome-specific config
 */

export interface OpenSafariConfig {
  // Simulator
  defaultDevice: string;
  maxSimulators: number;
  bootTimeout: number;
  idleShutdownTimeout: number;

  // Safari/WebKit
  webkitDebugPort: number;
  navigationTimeout: number;
  screenshotTimeout: number;
  evaluateTimeout: number;

  // Auth
  authDir: string;

  // Security
  blockedDomains: string[];
  sanitizeContent: boolean;
  auditLog: boolean;

  // Watchdog
  healthPort: number;
  maxMemoryPerSimulator: number;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const defaultConfig: OpenSafariConfig = {
  defaultDevice: 'iphone-17-pro',
  maxSimulators: 3,
  bootTimeout: 15000,
  idleShutdownTimeout: 300000,
  webkitDebugPort: 9322,
  navigationTimeout: 30000,
  screenshotTimeout: 10000,
  evaluateTimeout: 15000,
  authDir: '~/.opensafari/auth/',
  blockedDomains: [],
  sanitizeContent: true,
  auditLog: false,
  healthPort: 9090,
  maxMemoryPerSimulator: 600,
  logLevel: 'info',
};

let globalConfig: OpenSafariConfig = { ...defaultConfig };

export function getGlobalConfig(): OpenSafariConfig {
  return globalConfig;
}

export function setGlobalConfig(config: Partial<OpenSafariConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export function resetGlobalConfig(): void {
  globalConfig = { ...defaultConfig };
}
