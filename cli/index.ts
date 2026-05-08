#!/usr/bin/env node

import { Command } from 'commander';

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
  .option('--http-host <host>', 'HTTP bind host (default: 127.0.0.1)')
  .option('--http-token <token>', 'Bearer token required for HTTP /mcp requests')
  .option('--http-allow-origin <origins>', 'Allowed browser origins for HTTP /mcp CORS (comma-separated)')
  .option('--http-insecure-local', 'Disable HTTP /mcp token auth for explicit local-only insecure use')
  .option('--http-enable-high-risk-tools', 'Allow high-risk code execution and credential movement tools over HTTP')
  .option('--devices <presets>', 'Auto-boot devices (comma-separated)')
  .option('--auth <path>', 'Auth profile to auto-restore')
  .option('--all-tools', 'Expose all tool tiers immediately (equivalent to OPENSAFARI_TOOL_TIER=3)')
  .option('--blocked-domains <domains>', 'Block navigation to these domains')
  .option('--audit-log', 'Enable tool call audit logging')
  .option('--no-zombie-cleanup', 'Disable periodic zombie simulator cleanup')
  .action(async (options) => {
    // Lazy-load all heavy serve-only dependencies so they are excluded from
    // --help / auth / doctor startup paths. Dynamic import errors surface with
    // module context so they are diagnosable.
    const [
      { MCPServer },
      {
        registerAllTools,
        setWorkflowEngine,
        setCrossViewportCapture,
        setBatchNavigateExecutor,
        setBatchScreenshotExecutor,
        setBatchExecuteExecutor,
      },
      { SimulatorPool },
      { BatchExecutor },
      { AuthManager },
      { SimulatorWorkflowEngine },
      { CrossViewportCapture },
      { setupGracefulShutdown },
      { SimulatorCrashWatcher },
      { cleanupZombieProcesses, startPeriodicCleanup },
      { setBlockedDomains },
      { EventLoopMonitor, setGlobalEventLoopMonitor },
      { SimulatorMonitor },
    ] = await Promise.all([
      import('../src/mcp-server'),
      import('../src/tools'),
      import('../src/simulator/pool'),
      import('../src/simulator/batch'),
      import('../src/auth'),
      import('../src/orchestration/workflow-engine'),
      import('../src/comparison/cross-viewport'),
      import('../src/reliability/graceful-shutdown'),
      import('../src/reliability/crash-watcher'),
      import('../src/reliability/zombie-cleanup'),
      import('../src/security/domain-guard'),
      import('../src/watchdog/event-loop-monitor'),
      import('../src/watchdog/simulator-monitor'),
    ]).catch((err: unknown) => {
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      console.error(`[OpenSafari] Failed to load serve dependencies${code ? ` (${code})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

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
    const allowedOrigins = typeof options.httpAllowOrigin === 'string'
      ? options.httpAllowOrigin.split(',').map((origin: string) => origin.trim()).filter(Boolean)
      : undefined;

    await server.start({
      transport,
      port,
      host: options.httpHost,
      authToken: options.httpToken,
      httpInsecure: options.httpInsecureLocal,
      allowedOrigins,
      httpHighRiskTools: options.httpEnableHighRiskTools,
    });
    console.error('[OpenSafari] MCP server running');
  });

// --- auth ---
const auth = program.command('auth').description('Manage login persistence profiles');

auth.command('save')
  .argument('<site>', 'Site domain')
  .action(async (site: string) => {
    let mcpServerMod: typeof import('../src/mcp-server');
    let authMod: typeof import('../src/auth');
    try {
      [mcpServerMod, authMod] = await Promise.all([
        import('../src/mcp-server'),
        import('../src/auth'),
      ]);
    } catch (err) {
      console.error(`[OpenSafari] Failed to load auth save dependencies (../src/mcp-server, ../src/auth): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { getWebKitClient } = mcpServerMod;
    const { AuthManager } = authMod;

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
    let authMod: typeof import('../src/auth');
    try {
      authMod = await import('../src/auth');
    } catch (err) {
      console.error(`[OpenSafari] Failed to load auth module (../src/auth): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { AuthManager } = authMod;
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
    let authMod: typeof import('../src/auth');
    try {
      authMod = await import('../src/auth');
    } catch (err) {
      console.error(`[OpenSafari] Failed to load auth module (../src/auth): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { AuthManager } = authMod;
    const manager = new AuthManager();
    await manager.delete(site);
    console.log(`Auth deleted: ${site}`);
  });

// --- doctor ---
program
  .command('doctor')
  .description('Verify installation and diagnose issues')
  .action(async () => {
    let simulatorMod: typeof import('../src/simulator');
    try {
      simulatorMod = await import('../src/simulator');
    } catch (err) {
      console.error(`[OpenSafari] Failed to load simulator module (../src/simulator): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { checkXcodeInstallation } = simulatorMod;

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
  .action(async () => {
    let simulatorMod: typeof import('../src/simulator');
    try {
      simulatorMod = await import('../src/simulator');
    } catch (err) {
      console.error(`[OpenSafari] Failed to load simulator module (../src/simulator): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const { DEVICE_PRESETS } = simulatorMod;
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
  .option('--format <format>', 'Output format: markdown, junit, json', 'markdown')
  .option('--output <path>', 'Write report to file instead of stdout')
  .option('--fail-on-high', 'Exit with code 1 if high-severity issues found')
  .option('--min-score <score>', 'Exit with code 1 if score below threshold', parseInt)
  .action(async (options) => {
    const [
      { QAAudit },
      { QAHistory },
      { generateAuditMarkdown },
      { generateAuditJUnit },
      { generateAuditJSON },
      { WebKitClient },
    ] = await Promise.all([
      import('../src/qa/audit'),
      import('../src/qa/history'),
      import('../src/qa/report-markdown'),
      import('../src/qa/report-junit'),
      import('../src/qa/report-json'),
      import('../src/webkit/client'),
    ]).catch((err: unknown) => {
      console.error(`[OpenSafari] Failed to load audit dependencies (../src/qa/*, ../src/webkit/client): ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

    let client: InstanceType<typeof WebKitClient> | undefined;
    try {
      client = new WebKitClient({ host: 'localhost', port: 9322 });
      await client.connect();
    } catch {
      console.error('Error: Could not connect to Safari. Ensure a simulator is booted and ios-webkit-debug-proxy is running.');
      process.exit(1);
    }

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
    process.exit(exitCode);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
