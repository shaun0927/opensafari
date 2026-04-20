#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

import { ensureSemanticsActive, isLikelyChromeOnlyTree } from '../src/native';
import { SimulatorManager } from '../src/simulator';
import { buildRawMobileContext } from '../src/tools/raw-mobile-context';

const execFileAsync = promisify(execFile);

interface ErrorJSON {
  error: string;
  code: string;
}

const TOP_LEVEL_HELP = `\
ax-bridge <command> [flags]

Commands:
  dump       Dump accessibility tree for a simulator device
  query      Query app elements by role/label/text/identifier
  inspect    Inspect a single element by path
  press      Issue a press on an element (advanced)
  context    Report current foreground native context

Flags:
  --device <udid|name|booted|any>   Target simulator (required for most commands)
  --max-depth <n>                   Max tree depth (default: 10)
  --role <role>                     (query) Accessibility role filter
  --label <label>                   (query) Accessibility label substring
  --text <text>                     (query) Text substring
  --identifier <id>                 (query) Accessibility identifier exact match
  --path <index/path>               (inspect) Element index path
  --ensure-semantics <auto|off>     Bootstrap Flutter semantics before read (default: auto)
  --bundle-id <bundle>              Target bundle (Flutter apps, VM Service disambiguation)
  --expect-bundle <bundle>          (context) Expected foreground bundle
  --require-match <true|false>      (context) Error when expected bundle is not foreground

Error codes (stdout JSON, exit 1):
  DEVICE_RESOLUTION_FAILED         Requested device not found / not booted
  DEVICE_RESOLUTION_AMBIGUOUS      Multiple booted simulators match
  DEVICE_WINDOW_NOT_FOUND          No AX window matched the requested device
  DEVICE_CONTENT_ROOT_EMPTY        Window resolved but no app-semantics content (#40)
  APP_CONTENT_NOT_EXPOSED          Tree is Simulator chrome only after bootstrap (#41)
  EXPECTED_BUNDLE_MISMATCH         (context) Expected bundle not foreground
  BRIDGE_NOT_FOUND                 ax-bridge-native/ax-bridge.swift missing
  AX_WRAPPER_FAILED                Wrapper-level unexpected error
  BAD_ARGS                         Invalid or missing CLI flags
  UNKNOWN_COMMAND                  Command not recognized
`;

const SUBCOMMAND_FLAGS: Record<string, string> = {
  dump: '--device, --max-depth, --ensure-semantics, --bundle-id',
  query: '--device, --role, --label, --text, --identifier, --ensure-semantics, --bundle-id',
  inspect: '--device, --path, --ensure-semantics, --bundle-id',
  press: '--device, --path, --ensure-semantics, --bundle-id',
  context: '--device, --max-depth, --expect-bundle, --require-match',
};

function printHelp(command?: string): never {
  process.stdout.write(TOP_LEVEL_HELP);
  if (command && SUBCOMMAND_FLAGS[command]) {
    process.stdout.write(`\nRelevant flags for ${command}: ${SUBCOMMAND_FLAGS[command]}\n`);
  }
  process.exit(0);
}

// This CLI is a standalone process consumed by the internal AccessibilityBridge via execFile,
// which parses stdout as JSON. stdout is the contract for structured success AND error payloads here.
// DO NOT import outputError into the MCP server process — it would corrupt JSON-RPC on stdout.
function outputError(message: string, code: string): never {
  process.stdout.write(`${JSON.stringify({ error: message, code }, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const command = argv[0] ?? 'dump';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return { command, flags };
}

function resolveNativeBridge(): { cmd: string; prefixArgs: string[] } {
  const nativeBinary = path.resolve(__dirname, 'ax-bridge-native');
  if (fs.existsSync(nativeBinary)) {
    return { cmd: nativeBinary, prefixArgs: [] };
  }

  const swiftSource = path.resolve(__dirname, 'ax-bridge.swift');
  if (fs.existsSync(swiftSource)) {
    return { cmd: 'swift', prefixArgs: [swiftSource] };
  }

  outputError('Could not locate ax-bridge-native or ax-bridge.swift in dist/.', 'BRIDGE_NOT_FOUND');
}

async function execNative(rawArgs: string[]): Promise<{ stdout: string; stderr: string }> {
  const native = resolveNativeBridge();
  return execFileAsync(native.cmd, [...native.prefixArgs, ...rawArgs], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });
}

async function probeChromeOnly(deviceId: string): Promise<boolean> {
  try {
    const { stdout } = await execNative(['dump', '--device', deviceId, '--max-depth', '6']);
    const parsed = JSON.parse(stdout);
    if (parsed?.error) return false;
    return isLikelyChromeOnlyTree(parsed);
  } catch {
    return false;
  }
}

async function outputContext(flags: Record<string, string>): Promise<never> {
  const deviceId = flags.device;
  if (!deviceId) {
    outputError('The context command requires --device <UDID|device-name|booted>.', 'BAD_ARGS');
  }

  const manager = new SimulatorManager();
  const parsed = await readNativeContextDump(deviceId, flags['max-depth'] ?? '6');
  if (parsed?.error) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
    process.exit(1);
  }

  const runningAppsDeviceId = await resolveRunningAppsDeviceId(deviceId);
  const runningAppsRaw = await manager.listRunningApps(runningAppsDeviceId);
  const runningApps = runningAppsRaw.map((app) => ({
    bundleId: app.label,
    pid: app.pid,
  }));
  const result = buildRawMobileContext({
    deviceId,
    tree: parsed as any,
    runningApps,
    expectedBundle: flags['expect-bundle'],
  });

  if (flags['require-match'] === 'true' && flags['expect-bundle'] && result.expectedBundleMatched === false) {
    process.stdout.write(`${JSON.stringify({
      error: `Expected bundle ${flags['expect-bundle']} is not frontmost.`,
      code: 'EXPECTED_BUNDLE_MISMATCH',
      ...result,
    }, null, 2)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

async function resolveRunningAppsDeviceId(requested: string): Promise<string> {
  const devices = await listSimctlDevices();
  if (looksLikeUDID(requested)) {
    const exact = devices.find((device) => device.udid.toLowerCase() === requested.toLowerCase());
    return exact?.udid ?? requested;
  }

  const booted = devices.filter((device) => device.state === 'Booted');

  if (requested === 'any') {
    return booted[0]?.udid ?? requested;
  }
  if (requested === 'booted') {
    return booted[0]?.udid ?? requested;
  }

  const exact = booted.find((device) => device.name === requested);
  return exact?.udid ?? requested;
}

async function listSimctlDevices(): Promise<Array<{
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}>> {
  const { stdout } = await execFileAsync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], {
    timeout: 10_000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
  };
  const devices = Object.values(parsed.devices)
    .flat()
    .filter((device) => device.isAvailable !== false);
  return devices;
}

function looksLikeUDID(value: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
}

async function readNativeContextDump(deviceId: string, maxDepth: string): Promise<Record<string, unknown>> {
  try {
    const bridgeOutput = await execNative(['dump', '--device', deviceId, '--max-depth', maxDepth]);
    return JSON.parse(bridgeOutput.stdout);
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    if (execError.stderr) process.stderr.write(execError.stderr);
    if (execError.stdout) {
      try {
        return JSON.parse(execError.stdout);
      } catch {
        // fall through to generic wrapper error below
      }
    }
    return {
      error: `ax-bridge wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
      code: 'AX_WRAPPER_FAILED',
    };
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // --help / -h must be intercepted before argument validation so missing
  // required flags never suppress help output.
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    const KNOWN = new Set(['dump', 'query', 'inspect', 'press', 'context']);
    const first = rawArgs[0];
    printHelp(first && KNOWN.has(first) ? first : undefined);
  }

  const { command, flags } = parseArgs(rawArgs);
  if (command === 'context') {
    await outputContext(flags);
  }
  const deviceId = flags.device;
  const bundleId = flags['bundle-id'] ?? process.env.OPENSAFARI_AX_BUNDLE_ID;
  const ensureSemantics = flags['ensure-semantics'] ?? 'auto';
  const shouldBootstrap =
    ['dump', 'query', 'inspect', 'press'].includes(command)
    && Boolean(deviceId)
    && deviceId !== 'any'
    && deviceId !== 'booted'
    && ensureSemantics !== 'off';

  if (shouldBootstrap) {
    await ensureSemanticsActive(deviceId!, { bundleId, timeout: 5000 });
  }

  let stdout = '';
  let stderr = '';
  try {
    const result = await execNative(rawArgs);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    if (execError.stdout) process.stdout.write(execError.stdout);
    if (execError.stderr) process.stderr.write(execError.stderr);
    process.exit(1);
  }

  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  try {
    const parsed = JSON.parse(stdout);
    if (!parsed?.error && shouldBootstrap) {
      if (command === 'dump' && isLikelyChromeOnlyTree(parsed)) {
        outputError(
          `Resolved simulator ${deviceId} but found only Simulator chrome after semantics bootstrap.`,
          'APP_CONTENT_NOT_EXPOSED',
        );
      }

      if (command === 'query' && parsed.total === 0) {
        const chromeOnly = await probeChromeOnly(deviceId!);
        if (chromeOnly) {
          outputError(
            `Resolved simulator ${deviceId} but query returned zero app matches because only Simulator chrome is exposed after semantics bootstrap.`,
            'APP_CONTENT_NOT_EXPOSED',
          );
        }
      }
    }
  } catch {
    // Non-JSON output should be forwarded verbatim below.
  }

  process.stdout.write(stdout);
}

// Reminder: stdout is the structured-JSON contract consumed by AccessibilityBridge — do not write non-JSON here.
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const payload: ErrorJSON = {
    error: `ax-bridge wrapper failed: ${message}`,
    code: 'AX_WRAPPER_FAILED',
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
