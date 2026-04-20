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

// Issue #41: unified promotion decision based on the primary native response.
// Replaces the previous double-dump `probeChromeOnly()` helper which suffered
// from depth mismatches and race windows between the query and the follow-up
// probe. When the Swift bridge supplies `chromeOnly` we trust it; older
// bridges (pre-#41) do not emit the field, so we fall back to a best-effort
// TS heuristic against the same primary payload — still single-snapshot,
// still deterministic.
export function resolveChromeOnly(command: string, parsed: Record<string, unknown>): boolean {
  if (typeof parsed.chromeOnly === 'boolean') return parsed.chromeOnly;
  if (command === 'query') {
    // Query response does not include the content tree, so the TS fallback
    // is inconclusive — keep pass-through behavior.
    return false;
  }
  // dump/inspect payloads carry enough tree data for the TS heuristic.
  try {
    return isLikelyChromeOnlyTree(parsed as never);
  } catch {
    return false;
  }
}

export interface PromotionDecision {
  promote: boolean;
  message?: string;
  code?: 'APP_CONTENT_NOT_EXPOSED';
}

/**
 * Decide whether a primary native response should be promoted to a typed
 * APP_CONTENT_NOT_EXPOSED error. Pure function — no I/O, no subprocesses.
 *
 * Rules (Issue #41):
 *   - dump → promote when chromeOnly is true and the response is not already an error.
 *   - query → promote when total is 0 AND chromeOnly is true (legitimate hits beat the flag).
 *   - inspect → promote when found is false AND chromeOnly is true.
 *   - --ensure-semantics off → never promote (caller has explicitly opted out).
 */
export function decidePromotion(args: {
  command: string;
  parsed: Record<string, unknown>;
  deviceId: string | undefined;
  ensureSemanticsOff: boolean;
  bootstrapApplicable: boolean;
}): PromotionDecision {
  const { command, parsed, deviceId, ensureSemanticsOff, bootstrapApplicable } = args;
  if (!bootstrapApplicable || ensureSemanticsOff) return { promote: false };

  const errorCode = typeof parsed.code === 'string' ? parsed.code : undefined;

  if (command === 'dump' && !parsed.error) {
    if (resolveChromeOnly('dump', parsed)) {
      return {
        promote: true,
        code: 'APP_CONTENT_NOT_EXPOSED',
        message: `Resolved simulator ${deviceId} but found only Simulator chrome after semantics bootstrap.`,
      };
    }
  } else if (command === 'query' && !parsed.error) {
    const total = typeof parsed.total === 'number' ? parsed.total : undefined;
    if (total === 0 && resolveChromeOnly('query', parsed)) {
      return {
        promote: true,
        code: 'APP_CONTENT_NOT_EXPOSED',
        message: `Resolved simulator ${deviceId} but query returned zero app matches because only Simulator chrome is exposed after semantics bootstrap.`,
      };
    }
  } else if (command === 'inspect') {
    const found = parsed.found === true
      || (!parsed.error && typeof parsed.path === 'string');
    if (!found && errorCode === 'ELEMENT_NOT_FOUND' && resolveChromeOnly('inspect', parsed)) {
      return {
        promote: true,
        code: 'APP_CONTENT_NOT_EXPOSED',
        message: `Resolved simulator ${deviceId} but inspect could not find the path because only Simulator chrome is exposed after semantics bootstrap.`,
      };
    }
  }

  return { promote: false };
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
  // Issue #41: `--ensure-semantics off` is a caller-explicit opt-out from
  // BOTH the semantics bootstrap AND the chrome-only promotion. If the
  // caller has told us not to ensure semantics, they have also accepted
  // that they may receive a raw chrome-only tree without the typed error.
  const bootstrapApplicable =
    ['dump', 'query', 'inspect', 'press'].includes(command)
    && Boolean(deviceId)
    && deviceId !== 'any'
    && deviceId !== 'booted';
  const ensureSemanticsOff = ensureSemantics === 'off';
  const shouldBootstrap = bootstrapApplicable && !ensureSemanticsOff;

  if (shouldBootstrap) {
    await ensureSemanticsActive(deviceId!, { bundleId, timeout: 5000 });
  }

  let stdout = '';
  let stderr = '';
  let nativeExitCode = 0;
  try {
    const result = await execNative(rawArgs);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
    const code = execError.code;
    nativeExitCode = typeof code === 'number' ? code : 1;
    if (!stdout) {
      if (stderr) process.stderr.write(stderr);
      process.exit(nativeExitCode || 1);
    }
  }

  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  // Issue #41: evaluate promotion on the PRIMARY native response only. No
  // secondary dump is issued — `chromeOnly` is computed server-side by Swift
  // and travels with the payload. This eliminates the depth-mismatch and
  // race-window failure modes of the previous `probeChromeOnly()` helper.
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const decision = decidePromotion({
      command,
      parsed,
      deviceId,
      ensureSemanticsOff,
      bootstrapApplicable,
    });
    if (decision.promote && decision.code && decision.message) {
      outputError(decision.message, decision.code);
    }
  } catch {
    // Non-JSON output is forwarded verbatim below.
  }

  process.stdout.write(stdout);
  if (nativeExitCode !== 0) {
    process.exit(nativeExitCode);
  }
}

// Reminder: stdout is the structured-JSON contract consumed by AccessibilityBridge — do not write non-JSON here.
if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const payload: ErrorJSON = {
      error: `ax-bridge wrapper failed: ${message}`,
      code: 'AX_WRAPPER_FAILED',
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  });
}
