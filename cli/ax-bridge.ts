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
