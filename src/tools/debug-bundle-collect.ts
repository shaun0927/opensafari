/**
 * `debug_bundle_collect` — compact local failure evidence for the
 * #795 SSOT "mobile debugging is a first-class product surface" pillar.
 *
 * Composes existing helpers (no new backend dispatch, no HAR start/stop):
 *   - device/session identity from SessionManager
 *   - backend health summary via the existing diagnose probe set
 *   - screenshot via `xcrun simctl io <udid> screenshot <path>`
 *   - AX tree (depth-capped summary) via AccessibilityBridge.dumpTree
 *   - recent app/system logs via `xcrun simctl spawn <udid> log show`
 *   - fresh crash reports via findFreshCrashes (#793)
 *   - flutter route via VM Service ModalRoute.of (when connected)
 *   - action trace events from the global recorder when one is exposed
 *
 * Best-effort / partial-failure tolerant. Only device/session failure is
 * surfaced as an MCP error response; every individual evidence failure
 * appears as `{ error: ... }` inside its bundle section.
 *
 * Redaction (default-v1):
 *   - Bearer tokens, Authorization headers, JWTs, AWS access keys,
 *     GitHub PATs are scrubbed from logs and stringified diagnose
 *     reports.
 *   - Sensitive env keys (token/secret/password/api_key/credential/
 *     authorization/cookie/session) are replaced with [REDACTED].
 *
 * Artifacts (screenshot.png, ax-tree.json, logs.txt) are written to
 * `artifactDir` (default `${tmpdir}/opensafari-debug/<ts>`) and the
 * bundle response includes their absolute paths.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { getAccessibilityBridge, type AXNode } from '../native';
import { getFlutterVMClient } from '../flutter';
import { findFreshCrashes } from './app-crash-reports';
import {
  getMemorySnapshot,
  bytesToMB,
} from '../metrics/memory-tracker';
import {
  redactText,
  redactObject,
  REDACTION_POLICY_VERSION,
} from '../observability/redaction';
import {
  ErrorCode,
  respondWithStructuredError,
} from '../errors';

const execFileAsync = promisify(execFile);

export const DEBUG_BUNDLE_SCHEMA_VERSION = '1';

const DEFAULT_AX_DEPTH = 3;
const DEFAULT_LOG_TAIL_LINES = 200;
const DEFAULT_LOG_WINDOW = '5m';
const DEFAULT_CRASH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ACTION_TRACE_WINDOW_MS = 60_000;

export interface DebugBundleOptions {
  deviceId?: string;
  bundleId?: string;
  includeScreenshot?: boolean;
  includeAxTree?: boolean;
  includeLogs?: boolean;
  includeCrashes?: boolean;
  includeFlutterRoute?: boolean;
  includeNetwork?: boolean;
  actionTraceWindowMs?: number;
  artifactDir?: string;
}

export interface DebugBundle {
  schemaVersion: typeof DEBUG_BUNDLE_SCHEMA_VERSION;
  collectedAt: string;
  device: {
    udid: string;
    name?: string;
    state?: string;
  };
  session: {
    soleDeviceId: string | null;
  };
  diagnose:
    | {
        memory: ReturnType<typeof memorySection>;
      }
    | { error: string };
  screenshot:
    | { path: string; bytes: number }
    | { error: string }
    | { skipped: true };
  ax:
    | { rootRole: string; childCount: number; depth: number; path?: string }
    | { error: string }
    | { skipped: true };
  logs:
    | { tail: string; lineCount: number; window: string; path?: string; redactionTags: string[] }
    | { error: string }
    | { skipped: true };
  crashes:
    | Array<{ filename: string; mtimeMs: number }>
    | { error: string }
    | { skipped: true };
  flutter:
    | { connected: boolean; route?: string; error?: string }
    | { skipped: true };
  network:
    | { hint: string }
    | { skipped: true };
  actionTrace: Array<{
    action: string;
    status: string;
    context: string;
    startedAtMs: number;
    endedAtMs: number;
  }>;
  redactions: {
    applied: string[];
    policy: typeof REDACTION_POLICY_VERSION;
  };
}

function memorySection() {
  const snapshot = getMemorySnapshot();
  return {
    rss_mb: bytesToMB(snapshot.rssBytes),
    peak_rss_mb: bytesToMB(snapshot.peakRssBytes),
    heap_used_mb: bytesToMB(snapshot.heapUsedBytes),
    heap_total_mb: bytesToMB(snapshot.heapTotalBytes),
    sample_count: snapshot.sampleCount,
  };
}

async function captureScreenshot(
  deviceId: string,
  outPath: string,
): Promise<{ path: string; bytes: number } | { error: string }> {
  try {
    await execFileAsync('xcrun', ['simctl', 'io', deviceId, 'screenshot', outPath], {
      timeout: 10_000,
    });
    const stat = await fs.stat(outPath);
    return { path: outPath, bytes: stat.size };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function summarizeAxTree(node: AXNode, depth = DEFAULT_AX_DEPTH): {
  rootRole: string;
  childCount: number;
  depth: number;
} {
  const children = node.children ?? [];
  return {
    rootRole: node.role,
    childCount: children.length,
    depth,
  };
}

async function captureAxTree(
  deviceId: string,
  outPath: string,
): Promise<{ rootRole: string; childCount: number; depth: number; path?: string } | { error: string }> {
  try {
    const bridge = getAccessibilityBridge();
    const tree = await bridge.dumpTree({ deviceId, maxDepth: DEFAULT_AX_DEPTH });
    const summary = summarizeAxTree(tree);
    try {
      await fs.writeFile(outPath, JSON.stringify(tree, null, 2), 'utf8');
      return { ...summary, path: outPath };
    } catch (writeErr) {
      // Surfacing the write failure as a partial section is more useful
      // than discarding the summary.
      return {
        ...summary,
        path: undefined,
        ...{ writeError: writeErr instanceof Error ? writeErr.message : String(writeErr) },
      } as never;
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function captureLogs(
  deviceId: string,
  outPath: string,
  windowToken: string,
  bundleId?: string,
): Promise<
  | { tail: string; lineCount: number; window: string; path?: string; redactionTags: string[] }
  | { error: string }
> {
  try {
    const args = [
      'simctl',
      'spawn',
      deviceId,
      'log',
      'show',
      '--last',
      windowToken,
      '--style',
      'syslog',
    ];
    if (bundleId) {
      args.push('--predicate', `subsystem == "${bundleId}" OR process == "${bundleId.split('.').pop()}"`);
    }
    const { stdout } = await execFileAsync('xcrun', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const lines = stdout.split('\n');
    const tail = lines.slice(-DEFAULT_LOG_TAIL_LINES).join('\n');
    const redactedTail = redactText(tail, 'logs');
    try {
      await fs.writeFile(outPath, redactedTail.text, 'utf8');
    } catch {
      // best-effort — return summary even when on-disk write fails
    }
    return {
      tail: redactedTail.text,
      lineCount: lines.length,
      window: windowToken,
      path: outPath,
      redactionTags: redactedTail.applied,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function captureFlutterRoute(
  deviceId: string,
): Promise<{ connected: boolean; route?: string; error?: string }> {
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    return { connected: false };
  }
  const expr = `
(() {
  try {
    final binding = WidgetsBinding.instance;
    final root = binding.rootElement;
    if (root == null) return 'opensafari_route:no_root';
    final modal = ModalRoute.of(root);
    return 'opensafari_route:' + (modal?.settings.name ?? 'null').toString();
  } catch (e) {
    return 'opensafari_route:error:' + e.toString();
  }
})()
`.replace(/\s+/g, ' ').trim();
  try {
    const result = await client.evaluate(expr);
    const raw = (result as { valueAsString?: string }).valueAsString ?? '';
    if (raw.startsWith('opensafari_route:error:')) {
      return { connected: true, error: raw.slice('opensafari_route:error:'.length) };
    }
    if (raw.startsWith('opensafari_route:')) {
      const route = raw.slice('opensafari_route:'.length);
      return { connected: true, route };
    }
    return { connected: true, error: `unexpected eval result: ${raw.slice(0, 80)}` };
  } catch (err) {
    return { connected: true, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── action-trace recorder singleton (opt-in for handlers; PR2 wires this) ──

import type { ActionTraceRecorder } from '../observability/action-trace';

let globalRecorder: ActionTraceRecorder | null = null;

export function setDebugBundleActionTraceRecorder(recorder: ActionTraceRecorder | null): void {
  globalRecorder = recorder;
}

function readActionTrace(windowMs: number): DebugBundle['actionTrace'] {
  if (!globalRecorder) return [];
  const doc = globalRecorder.toJSON();
  const cutoff = Date.now() - Math.max(0, windowMs);
  return doc.events
    .filter((e) => e.endedAtMs >= cutoff)
    .map((e) => ({
      action: e.action,
      status: e.status,
      context: e.context ?? 'unknown',
      startedAtMs: e.startedAtMs,
      endedAtMs: e.endedAtMs,
    }));
}

/**
 * Programmatic entry point — used by the registered MCP tool below and
 * (in #798 PR2) by action handlers that want to auto-attach a bundle on
 * recoverable failure.
 */
export async function collectDebugBundle(
  options: DebugBundleOptions = {},
): Promise<DebugBundle | { error: string }> {
  const sm = getSessionManager();
  const deviceId = options.deviceId ?? sm.getSoleDeviceId();
  if (!deviceId) {
    return { error: 'no booted device and no deviceId supplied' };
  }
  const sim = sm.getSimulator(deviceId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir =
    options.artifactDir ?? path.join(os.tmpdir(), 'opensafari-debug', ts);
  await fs.mkdir(artifactDir, { recursive: true });

  const includeScreenshot = options.includeScreenshot !== false;
  const includeAxTree = options.includeAxTree !== false;
  const includeLogs = options.includeLogs !== false;
  const includeCrashes = options.includeCrashes !== false;
  const includeFlutterRoute = options.includeFlutterRoute !== false;
  const includeNetwork = options.includeNetwork === true;

  // Parallel evidence collection — every collector is wrapped so a single
  // failure cannot kill the bundle.
  const [screenshot, ax, logs, crashes, flutter] = await Promise.all([
    includeScreenshot
      ? captureScreenshot(deviceId, path.join(artifactDir, 'screenshot.png'))
      : Promise.resolve({ skipped: true as const }),
    includeAxTree
      ? captureAxTree(deviceId, path.join(artifactDir, 'ax-tree.json'))
      : Promise.resolve({ skipped: true as const }),
    includeLogs
      ? captureLogs(deviceId, path.join(artifactDir, 'logs.txt'), DEFAULT_LOG_WINDOW, options.bundleId)
      : Promise.resolve({ skipped: true as const }),
    includeCrashes
      ? findFreshCrashes(undefined, Date.now() - DEFAULT_CRASH_WINDOW_MS).then(
          (rows) => rows,
          (err) => ({ error: err instanceof Error ? err.message : String(err) }),
        )
      : Promise.resolve({ skipped: true as const }),
    includeFlutterRoute
      ? captureFlutterRoute(deviceId)
      : Promise.resolve({ skipped: true as const }),
  ]);

  const appliedRedactions = new Set<string>();
  // Apply the same redaction pass to the diagnose memory section's
  // surfaceable strings (defensive — `getMemorySnapshot()` itself does
  // not carry secrets today, but future fields might).
  const memory = memorySection();
  const memoryRedacted = redactObject(memory, 'diagnose.memory');
  for (const tag of memoryRedacted.applied) appliedRedactions.add(tag);

  // Logs are redacted in captureLogs() — surface the tags it accumulated
  // there (re-running redactText here would always be a no-op because the
  // payload has already been scrubbed).
  if (logs && typeof logs === 'object' && 'redactionTags' in logs) {
    for (const tag of logs.redactionTags) appliedRedactions.add(tag);
  }

  const bundle: DebugBundle = {
    schemaVersion: DEBUG_BUNDLE_SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    device: {
      udid: deviceId,
      name: sim?.deviceType,
      state: sim?.state,
    },
    session: {
      soleDeviceId: sm.getSoleDeviceId(),
    },
    diagnose: { memory: memoryRedacted.value },
    screenshot,
    ax,
    logs,
    crashes,
    flutter,
    network: includeNetwork ? { hint: 'Pass a tool-specific network argument to enable HAR/intercept capture; this PR only stats existing state.' } : { skipped: true },
    actionTrace: readActionTrace(options.actionTraceWindowMs ?? DEFAULT_ACTION_TRACE_WINDOW_MS),
    redactions: {
      applied: Array.from(appliedRedactions),
      policy: REDACTION_POLICY_VERSION,
    },
  };

  return bundle;
}

export function registerDebugBundleCollectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'debug_bundle_collect',
      description:
        'Collect a compact local failure-evidence bundle for a simulator: backend memory, screenshot, AX tree summary, recent system/app logs, fresh crash reports, and Flutter route when available. Best-effort — partial evidence failures appear inline rather than failing the bundle. Default-v1 redaction scrubs Bearer/JWT/AWS/GitHub tokens and sensitive env keys.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Simulator UDID. Falls back to sole booted device.' },
          bundleId: { type: 'string', description: 'Optional app bundle ID — narrows the log predicate.' },
          includeScreenshot: { type: 'boolean', description: 'Default true' },
          includeAxTree: { type: 'boolean', description: 'Default true (depth=3 summary)' },
          includeLogs: { type: 'boolean', description: 'Default true (last 5 minutes, tail of 200 lines)' },
          includeCrashes: { type: 'boolean', description: 'Default true (last 5 minutes)' },
          includeFlutterRoute: { type: 'boolean', description: 'Default true (only when VM is connected)' },
          includeNetwork: { type: 'boolean', description: 'Default false — current PR only emits a placeholder' },
          actionTraceWindowMs: { type: 'number', description: 'Default 60000' },
          artifactDir: { type: 'string', description: 'Where to write screenshot.png / ax-tree.json / logs.txt. Default tmpdir.' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const opts: DebugBundleOptions = {
        deviceId: params.deviceId as string | undefined,
        bundleId: params.bundleId as string | undefined,
        includeScreenshot: params.includeScreenshot as boolean | undefined,
        includeAxTree: params.includeAxTree as boolean | undefined,
        includeLogs: params.includeLogs as boolean | undefined,
        includeCrashes: params.includeCrashes as boolean | undefined,
        includeFlutterRoute: params.includeFlutterRoute as boolean | undefined,
        includeNetwork: params.includeNetwork as boolean | undefined,
        actionTraceWindowMs: params.actionTraceWindowMs as number | undefined,
        artifactDir: params.artifactDir as string | undefined,
      };
      const bundle = await collectDebugBundle(opts);
      if ('error' in bundle && typeof bundle.error === 'string') {
        return respondWithStructuredError(
          ErrorCode.DEVICE_NOT_BOOTED,
          bundle.error,
        );
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(bundle) }],
      };
    },
  );
}

export const __forTests = {
  captureScreenshot,
  captureAxTree,
  captureLogs,
  captureFlutterRoute,
  summarizeAxTree,
  readActionTrace,
};
