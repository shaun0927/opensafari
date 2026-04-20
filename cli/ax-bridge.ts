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

// Issue #46: DEVICE_CONTENT_ROOT_EMPTY from the native probe is NOT a hard
// failure for the `context` command. It means the AX root is empty (likely a
// spinner / loading screen / chrome-only transition), which is exactly the
// signal the sim-hid-bridge wrapper needs in order to promote to
// TRANSITIONAL_STATE_TIMEOUT. Coerce it to a synthetic empty AXNode so the
// surface classifier emits `FOREGROUND_CONTEXT_UNAVAILABLE` and the wrapper's
// re-probe rule can run. All other native error codes keep exiting 1 unchanged.
const EMPTY_AX_TREE_WARNING =
  'Native AX probe reported DEVICE_CONTENT_ROOT_EMPTY — foreground AX tree is empty (likely a spinner/loading or chrome-only transition).';

function buildEmptyAXTree(): any {
  return {
    role: '',
    traits: [],
    frame: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    enabled: false,
    focused: false,
    children: [],
    path: '',
  };
}

async function outputContext(flags: Record<string, string>): Promise<never> {
  const deviceId = flags.device;
  if (!deviceId) {
    outputError('The context command requires --device <UDID|device-name|booted>.', 'BAD_ARGS');
  }

  const manager = new SimulatorManager();
  const parsed = await readNativeContextDump(deviceId, flags['max-depth'] ?? '6');
  const emptyTreeCoerced = parsed?.code === 'DEVICE_CONTENT_ROOT_EMPTY';
  if (parsed?.error && !emptyTreeCoerced) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
    process.exit(1);
  }

  const runningAppsDeviceId = await resolveRunningAppsDeviceId(deviceId);
  const runningAppsRaw = await manager.listRunningApps(runningAppsDeviceId);
  const runningApps = runningAppsRaw.map((app) => ({
    bundleId: app.label,
    pid: app.pid,
  }));
  const tree = emptyTreeCoerced ? buildEmptyAXTree() : (parsed as any);
  const result = buildRawMobileContext({
    deviceId,
    tree,
    runningApps,
    expectedBundle: flags['expect-bundle'],
  });
  if (emptyTreeCoerced) {
    result.warnings = [...result.warnings, EMPTY_AX_TREE_WARNING];
  }

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
// Webpack bundles this file as the CLI entry; `require.main === module` does
// not survive that transform, so we detect CLI invocation by inspecting
// `process.argv[1]`. Jest/ts-jest imports run with `argv[1]` pointing at the
// jest worker, so `main()` is only invoked when the ax-bridge binary itself
// is the entry — keeping `decidePromotion` importable by unit tests.
function isCliEntry(): boolean {
  const entry = process.argv[1] ?? '';
  return /(^|\/)ax-bridge(\.js)?$/.test(entry);
}

if (isCliEntry()) {
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
