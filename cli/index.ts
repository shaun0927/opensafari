#!/usr/bin/env node

import { Command } from 'commander';
import { MCPServer, getWebKitClient } from '../src/mcp-server';
import {
  registerAllTools,
  setWorkflowEngine,
  setCrossViewportCapture,
  setBatchNavigateExecutor,
  setBatchScreenshotExecutor,
  setBatchExecuteExecutor,
} from '../src/tools';
import { DEVICE_PRESETS, checkXcodeInstallation } from '../src/simulator';
import { SimulatorPool } from '../src/simulator/pool';
import { BatchExecutor } from '../src/simulator/batch';
import { SimulatorWorkflowEngine } from '../src/orchestration/workflow-engine';
import { CrossViewportCapture } from '../src/comparison/cross-viewport';
import { setupGracefulShutdown } from '../src/reliability/graceful-shutdown';
import { SimulatorCrashWatcher } from '../src/reliability/crash-watcher';
import { cleanupZombieProcesses } from '../src/reliability/zombie-cleanup';
import { setBlockedDomains } from '../src/security/domain-guard';
import { EventLoopMonitor, setGlobalEventLoopMonitor } from '../src/watchdog/event-loop-monitor';
import { SimulatorMonitor } from '../src/watchdog/simulator-monitor';
import { AuthManager } from '../src/auth';

const program = new Command()
  .name('opensafari')
  .description('iOS Safari automation MCP server via Xcode Simulator')
  .version('0.0.1');

// --- serve ---
program
  .command('serve')
  .description('Start OpenSafari MCP server')
  .option('--http [port]', 'Use HTTP transport (default: stdio)')
  .option('--devices <presets>', 'Auto-boot devices (comma-separated)')
  .option('--auth <path>', 'Auth profile to auto-restore')
  .option('--all-tools', 'Expose all tool tiers immediately')
  .option('--blocked-domains <domains>', 'Block navigation to these domains')
  .option('--audit-log', 'Enable tool call audit logging')
  .action(async (options) => {
    const server = new MCPServer();
    registerAllTools(server);

    if (options.allTools) {
      server.setTier(3);
    }

    // Wire orchestration subsystems
    const pool = new SimulatorPool({ max: 5 });
    const batch = new BatchExecutor(pool);
    const authManager = new AuthManager();
    const engine = new SimulatorWorkflowEngine(pool, authManager);
    const capture = new CrossViewportCapture(pool, batch);

    setWorkflowEngine(engine);
    setCrossViewportCapture(capture);
    setBatchNavigateExecutor(batch);
    setBatchScreenshotExecutor(batch);
    setBatchExecuteExecutor(batch);

    // Wire graceful shutdown
    setupGracefulShutdown(pool);

    // Wire crash watcher
    const crashWatcher = new SimulatorCrashWatcher(pool);
    crashWatcher.on('crash', ({ deviceId }: { deviceId: string }) => {
      console.error(`[OpenSafari] Crash detected on device ${deviceId}`);
    });
    crashWatcher.on('recovered', ({ deviceId }: { deviceId: string }) => {
      console.error(`[OpenSafari] Device ${deviceId} recovered from crash`);
    });
    crashWatcher.on('recovery-failed', ({ deviceId, error }: { deviceId: string; error: string }) => {
      console.error(`[OpenSafari] Device ${deviceId} recovery failed: ${error}`);
    });
    crashWatcher.start();

    // Cleanup zombie processes from previous sessions
    cleanupZombieProcesses().then(count => {
      if (count > 0) console.error(`[OpenSafari] Found ${count} orphaned simulator process(es)`);
    }).catch(() => {});

    // Wire domain guard
    if (options.blockedDomains) {
      setBlockedDomains(options.blockedDomains.split(',').map((d: string) => d.trim()));
      console.error(`[OpenSafari] Domain guard active: ${options.blockedDomains}`);
    }

    // Wire audit logging
    if (options.auditLog) {
      server.enableAuditLog();
      console.error('[OpenSafari] Audit logging enabled');
    }

    // Wire watchdog monitors
    const eventLoopMonitor = new EventLoopMonitor();
    setGlobalEventLoopMonitor(eventLoopMonitor);
    eventLoopMonitor.on('warn', ({ driftMs }: { driftMs: number }) => {
      console.error(`[OpenSafari] Event loop drift warning: ${driftMs}ms`);
    });
    eventLoopMonitor.start();

    const simMonitor = new SimulatorMonitor();
    simMonitor.on('warn', ({ pid, rssMB }: { pid: number; rssMB: number }) => {
      console.error(`[OpenSafari] Simulator memory warning: PID ${pid} using ${rssMB}MB`);
    });
    simMonitor.on('critical', ({ pid, rssMB }: { pid: number; rssMB: number }) => {
      console.error(`[OpenSafari] Simulator memory critical: PID ${pid} using ${rssMB}MB`);
    });
    simMonitor.start();

    const transport = options.http ? 'http' as const : 'stdio' as const;
    const port = typeof options.http === 'string' ? parseInt(options.http, 10) : 3100;

    server.start({ transport, port });
    console.error('[OpenSafari] MCP server running');
  });

// --- auth ---
const auth = program.command('auth').description('Manage login persistence profiles');

auth.command('save')
  .argument('<site>', 'Site domain')
  .action(async (site: string) => {
    const client = getWebKitClient();
    if (!client) {
      console.error('Error: No active Safari connection. Run "opensafari serve" first.');
      process.exit(1);
    }
    const manager = new AuthManager();
    const filePath = await manager.save(site, client);
    console.log(`Auth saved: ${filePath}`);
  });

auth.command('list')
  .action(async () => {
    const manager = new AuthManager();
    const profiles = await manager.list();
    if (profiles.length === 0) {
      console.log('No auth profiles saved.');
      return;
    }
    console.log('Saved auth profiles:\n');
    for (const p of profiles) {
      console.log(`  ${p.site.padEnd(30)} ${p.cookieCount} cookies  (saved: ${p.savedAt})`);
    }
  });

auth.command('delete')
  .argument('<site>', 'Site domain to delete')
  .action(async (site: string) => {
    const manager = new AuthManager();
    await manager.delete(site);
    console.log(`Auth deleted: ${site}`);
  });

// --- doctor ---
program
  .command('doctor')
  .description('Verify installation and diagnose issues')
  .action(async () => {
    console.log('OpenSafari Doctor\n');

    const result = await checkXcodeInstallation();

    const checks = [
      { name: 'macOS', ok: process.platform === 'darwin' },
      { name: 'Xcode', ok: result.installed, detail: result.version ? `v${result.version}` : undefined },
      { name: 'Simulator', ok: result.simulatorAvailable },
      { name: 'iOS Runtimes', ok: result.iosRuntimes.length > 0, detail: result.iosRuntimes.join(', ') },
      { name: 'Node.js >= 18', ok: parseInt(process.version.slice(1)) >= 18, detail: process.version },
      { name: 'WebInspector Socket', ok: !!result.webInspectorSocket, detail: result.webInspectorSocket },
      { name: 'Proxy Reachable', ok: result.proxyReachable },
      ...(result.proxyReachable ? [{ name: 'Device Port', ok: result.devicePortReachable, detail: result.devicePort ? `port ${result.devicePort}` : undefined }] : []),
    ];

    for (const check of checks) {
      const icon = check.ok ? '✓' : '✗';
      const detail = check.detail ? ` (${check.detail})` : '';
      console.log(`  ${icon} ${check.name}${detail}`);
    }

    if (result.issues.length > 0) {
      console.log('\nIssues:');
      for (const issue of result.issues) {
        console.log(`  ! ${issue}`);
      }
    }

    if (result.suggestions.length > 0) {
      console.log('\nSuggestions:');
      for (const suggestion of result.suggestions) {
        console.log(`  → ${suggestion}`);
      }
    }

    const allOk = checks.every(c => c.ok);
    process.exit(allOk ? 0 : 1);
  });

// --- devices ---
program
  .command('devices')
  .description('List available device presets')
  .action(() => {
    console.log('Available Device Presets:\n');
    for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
      console.log(`  ${key.padEnd(22)} ${preset.name.padEnd(35)} ${preset.w}×${preset.h} @${preset.dpr}x`);
    }
  });

program.parse();
