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
import { cleanupZombieProcesses, startPeriodicCleanup } from '../src/reliability/zombie-cleanup';
import { setBlockedDomains } from '../src/security/domain-guard';
import { EventLoopMonitor, setGlobalEventLoopMonitor } from '../src/watchdog/event-loop-monitor';
import { SimulatorMonitor } from '../src/watchdog/simulator-monitor';
import { AuthManager } from '../src/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json');

const program = new Command()
  .name('opensafari')
  .description('iOS Safari automation MCP server via Xcode Simulator')
  .version(pkg.version);

// --- serve ---
program
  .command('serve')
  .description('Start OpenSafari MCP server')
  .option('--http [port]', 'Use HTTP transport (default: stdio)')
  .option('--devices <presets>', 'Auto-boot devices (comma-separated)')
  .option('--auth <path>', 'Auth profile to auto-restore')
  .option('--all-tools', 'Expose all tool tiers immediately (equivalent to OPENSAFARI_TOOL_TIER=3)')
  .option('--blocked-domains <domains>', 'Block navigation to these domains')
  .option('--audit-log', 'Enable tool call audit logging')
  .option('--no-zombie-cleanup', 'Disable periodic zombie simulator cleanup')
  .action(async (options) => {
    const server = new MCPServer();
    registerAllTools(server);

    if (options.allTools) {
      server.setTier(3);
    } else if (process.env.OPENSAFARI_TOOL_TIER) {
      const envTier = parseInt(process.env.OPENSAFARI_TOOL_TIER, 10);
      if (envTier === 1 || envTier === 2 || envTier === 3) {
        server.setTier(envTier);
      } else {
        console.error(`[OpenSafari] Warning: OPENSAFARI_TOOL_TIER=${process.env.OPENSAFARI_TOOL_TIER} is invalid (must be 1, 2, or 3). Using default tier.`);
      }
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

    // Periodic zombie cleanup: compare booted simulators against pool
    if (options.zombieCleanup !== false && process.env.OPENSAFARI_DISABLE_ZOMBIE_CLEANUP !== '1') {
      startPeriodicCleanup(() => {
        const ids = new Set<string>();
        for (const sim of pool.getAll()) ids.add(sim.device.udid);
        return ids;
      });
    }

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

// --- audit ---
program
  .command('audit')
  .description('Run QA audit and export results in CI-friendly formats')
  .requiredOption('--url <url>', 'URL to audit')
  .option('--port <port>', 'WebKit debug proxy device port (default: 9322 or $OPENSAFARI_PROXY_PORT)', (v) => parseInt(v, 10))
  .option('--host <host>', 'WebKit debug proxy host', 'localhost')
  .option('--no-spawn-proxy', 'Do not auto-spawn ios_webkit_debug_proxy; assume one is already running')
  .option('--format <format>', 'Output format: markdown, junit, json', 'markdown')
  .option('--output <path>', 'Write report to file instead of stdout')
  .option('--fail-on-high', 'Exit with code 1 if high-severity issues found')
  .option('--min-score <score>', 'Exit with code 1 if score below threshold', parseInt)
  .action(async (options) => {
    const { QAAudit } = await import('../src/qa/audit');
    const { QAHistory } = await import('../src/qa/history');
    const { generateAuditMarkdown } = await import('../src/qa/report-markdown');
    const { generateAuditJUnit } = await import('../src/qa/report-junit');
    const { generateAuditJSON } = await import('../src/qa/report-json');
    const { WebKitClient } = await import('../src/webkit/client');
    const { WebInspectorProxy } = await import('../src/simulator/proxy');

    // Prefer the existing OPENSAFARI_PROXY_PORT env var (also honored by
    // WebInspectorProxy) so audit picks up the same value as `serve` in
    // CI / port-conflict setups.
    const envPortRaw = process.env.OPENSAFARI_PROXY_PORT;
    const envPort = envPortRaw ? parseInt(envPortRaw, 10) : undefined;
    const port: number = options.port ?? (envPort !== undefined && !Number.isNaN(envPort) ? envPort : 9322);
    if (Number.isNaN(port)) {
      console.error(`Error: Invalid port value: ${options.port ?? envPortRaw}`);
      process.exit(1);
    }
    const host: string = options.host;

    // Auto-spawn proxy when targeting localhost unless --no-spawn-proxy is set.
    // For non-localhost hosts the user is bringing their own proxy, so we never spawn.
    const shouldSpawn = options.spawnProxy !== false && host === 'localhost';

    let proxy: InstanceType<typeof WebInspectorProxy> | undefined;
    if (shouldSpawn) {
      proxy = new WebInspectorProxy({ port });
      try {
        await proxy.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: Could not start ios_webkit_debug_proxy on port ${port}. ${msg}`);
        console.error('Hint: ensure a simulator is booted (xcrun simctl boot <device>) and ios-webkit-debug-proxy is installed (brew install ios-webkit-debug-proxy).');
        // start() may have spawned the child and registered a ref before
        // throwing (e.g. waitForReady timeout). Tear it down so we don't
        // leak the proxy process or the ref file into the next run.
        await proxy.stop().catch(() => { /* ignore */ });
        process.exit(1);
      }
    }

    let client: InstanceType<typeof WebKitClient> | undefined;
    try {
      client = new WebKitClient({ host, port });
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: Could not connect to Safari at ${host}:${port}. ${msg}`);
      if (!shouldSpawn) {
        console.error('Hint: ensure ios_webkit_debug_proxy is running on the configured port, or omit --no-spawn-proxy to auto-spawn it.');
      }
      if (proxy) await proxy.stop().catch(() => { /* ignore */ });
      process.exit(1);
    }

    try {
      const audit = new QAAudit(client);
      const report = await audit.runFullAudit(options.url);
      const history = new QAHistory();
      await history.save(report);

      let output: string;
      switch (options.format) {
        case 'junit':
          output = generateAuditJUnit(report);
          break;
        case 'json':
          output = JSON.stringify(generateAuditJSON(report), null, 2);
          break;
        default:
          output = generateAuditMarkdown(report);
      }

      if (options.output) {
        const fs = await import('fs/promises');
        await fs.writeFile(options.output, output, 'utf-8');
        console.error(`Report written to ${options.output}`);
      } else {
        console.log(output);
      }

      const exitCode = history.getExitCode(report, {
        failOnCritical: true,
        failOnHigh: !!options.failOnHigh,
        minScore: options.minScore,
      });

      await client.disconnect();
      if (proxy) await proxy.stop();
      process.exit(exitCode);
    } catch (err) {
      if (client) await client.disconnect().catch(() => { /* ignore */ });
      if (proxy) await proxy.stop().catch(() => { /* ignore */ });
      throw err;
    }
  });

program.parse();
