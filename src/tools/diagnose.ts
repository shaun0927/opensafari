/**
 * diagnose — Read-only MCP tool that reports backend availability,
 * proxy status, environment variables, and an overall headless verdict.
 *
 * Issue #498 / #484.
 */

import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { peekProxyForDevice } from '../simulator/proxy-manager';
import { tryCreateSimulatorKitHIDBackend } from './sim-hid-input-backend';
import {
  getInputTelemetryRollup,
  type InputTelemetryRollup,
} from '../metrics/input-telemetry-rollup';
import {
  getMemorySnapshot,
  bytesToMB,
  getRssGrowthPerHour,
  getMemorySoftCapMB,
  isMemoryCapExceeded,
} from '../metrics/memory-tracker';
import { getCacheBudgetNotes } from '../metrics/cache-budget';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── types ─────────────────────────────────────────────────────────────────────

interface BackendStatus {
  available: boolean;
  reason?: string;
  connected?: boolean;
}

interface DiagnoseReport {
  device: {
    udid: string;
    name: string;
    state: string;
    runtime: string;
  } | null;
  backends: {
    simctl: BackendStatus;
    webkit: BackendStatus & { connected?: boolean };
    applescript: BackendStatus;
    simhid: BackendStatus;
  };
  proxy: {
    running: boolean;
    pid: number | null;
    port: number | null;
  };
  environment: {
    OPENSAFARI_ALLOW_FOCUS_INPUT: string;
    OPENSAFARI_HEADLESS_ONLY: string;
    OPENSAFARI_PROXY_PORT: string;
    OPENSAFARI_ALLOW_SWIFT_INTERPRETER: string;
  };
  headless_verdict: {
    safari: boolean;
    native: boolean;
    overall: boolean;
  };
  /**
   * Per-(backendKind, operation) latency rollup (#502). Empty when the
   * accumulator has not seen any input events yet — diagnose itself does
   * not synthesise traffic.
   */
  latency: InputTelemetryRollup[];
  /**
   * Process memory snapshot (#554). `rss_mb` is the current resident set
   * size; `peak_rss_mb` is the maximum RSS observed across every
   * telemetry-emitting input-backend call since process start. Heap fields
   * are taken from `process.memoryUsage()` at diagnose-time so callers
   * always see a fresh V8 heap breakdown regardless of whether the
   * per-op sampler has ticked.
   *
   * `rss_growth_mb_per_hour` is computed from the time-series circular
   * buffer in memory-tracker; `null` until at least 2 entries exist.
   * `soft_cap_mb` mirrors `OPENSAFARI_MEMORY_SOFT_CAP_MB`; `null` when
   * unset. `notes` surfaces actionable warnings (e.g., cap exceeded).
   */
  memory: {
    rss_mb: number;
    peak_rss_mb: number;
    heap_used_mb: number;
    heap_total_mb: number;
    external_mb: number;
    array_buffers_mb: number;
    sample_count: number;
    rss_growth_mb_per_hour: number | null;
    soft_cap_mb: number | null;
    notes: string[];
  };
  /**
   * Quick memory health indicator. `'warn'` when RSS exceeds the configured
   * soft cap; `'ok'` otherwise (including when no cap is configured).
   */
  memory_status: 'ok' | 'warn';
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function probeSimctl(): Promise<BackendStatus> {
  try {
    // Probe with a lightweight subcommand that is always available when simctl works.
    await execFileAsync('xcrun', ['simctl', 'help'], { timeout: 5000 });
    // Now check specifically whether `io input` is available (Xcode ≤16 only).
    // We probe against the `booted` pseudo-device; a missing device is fine —
    // what we care about is whether the subcommand *exists* (exit 117 = removed).
    try {
      await execFileAsync('xcrun', ['simctl', 'io', 'booted', 'input', 'tap', '0', '0'], {
        timeout: 5000,
      });
      return { available: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { status?: number }).status ?? -1;
      if (code === 117) {
        return {
          available: false,
          reason: 'simctl io input removed (Xcode 26+)',
        };
      }
      // Any other error (no booted device, etc.) means the subcommand exists.
      return { available: true };
    }
  } catch {
    return { available: false, reason: 'xcrun simctl not found' };
  }
}

function probeWebKit(deviceId?: string): BackendStatus & { connected?: boolean } {
  const sm = getSessionManager();
  const client = sm.getConnection(deviceId);
  if (!client) {
    return { available: false, reason: 'no WebKit connection registered' };
  }
  const connected = client.isConnected();
  return { available: true, connected };
}

function probeAppleScript(): BackendStatus {
  const val = process.env.OPENSAFARI_ALLOW_FOCUS_INPUT;
  const allowed = val === '1' || val === 'true';
  if (!allowed) {
    return {
      available: false,
      reason: 'OPENSAFARI_ALLOW_FOCUS_INPUT not set (default-deny to prevent focus theft)',
    };
  }
  return { available: true };
}

async function probeSimHid(): Promise<BackendStatus> {
  try {
    const backend = await tryCreateSimulatorKitHIDBackend();
    if (!backend) {
      return { available: false, reason: 'sim-hid-bridge binary not found' };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function readProxyStatus(deviceId?: string): DiagnoseReport['proxy'] {
  // Try per-device proxy first (ProxyManager), then fall back to sole device.
  const sm = getSessionManager();
  const targetId = deviceId ?? sm.getSoleDeviceId() ?? undefined;

  if (targetId) {
    const proxy = peekProxyForDevice(targetId);
    if (proxy) {
      return {
        running: proxy.running,
        pid: proxy.pid,
        port: proxy.port,
      };
    }
  }

  return { running: false, pid: null, port: null };
}

function readEnvironment(): DiagnoseReport['environment'] {
  return {
    OPENSAFARI_ALLOW_FOCUS_INPUT: process.env.OPENSAFARI_ALLOW_FOCUS_INPUT ?? '',
    OPENSAFARI_HEADLESS_ONLY: process.env.OPENSAFARI_HEADLESS_ONLY ?? '',
    OPENSAFARI_PROXY_PORT: process.env.OPENSAFARI_PROXY_PORT ?? '',
    OPENSAFARI_ALLOW_SWIFT_INTERPRETER: process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER ?? '',
  };
}

function readDevice(deviceId?: string): DiagnoseReport['device'] {
  const sm = getSessionManager();
  const targetId = deviceId ?? sm.getSoleDeviceId() ?? undefined;
  if (!targetId) return null;

  const sim = sm.getSimulator(targetId);
  if (!sim) return null;

  return {
    udid: sim.deviceId,
    name: sim.deviceType,
    state: sim.state,
    runtime: '',
  };
}

// ── tool registration ─────────────────────────────────────────────────────────

export function registerDiagnoseTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'diagnose',
      description:
        'Report backend availability, proxy status, environment variables, and headless verdict. ' +
        'Read-only — no side effects.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Target device UDID. Falls back to the active device when omitted.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const deviceId = params.deviceId as string | undefined;

      const [simctlStatus, simhidStatus] = await Promise.all([
        probeSimctl(),
        probeSimHid(),
      ]);

      const webkitStatus = probeWebKit(deviceId);
      const applescriptStatus = probeAppleScript();
      const proxy = readProxyStatus(deviceId);
      const environment = readEnvironment();
      const device = readDevice(deviceId);

      const safariVerdict = webkitStatus.available && (webkitStatus.connected ?? true);
      const nativeVerdict = simctlStatus.available || simhidStatus.available;

      const memorySnapshot = getMemorySnapshot();
      const softCapMB = getMemorySoftCapMB();
      const capExceeded = isMemoryCapExceeded();
      const memoryNotes: string[] = [];
      if (softCapMB !== null && capExceeded) {
        const rssMB = bytesToMB(memorySnapshot.rssBytes);
        memoryNotes.push(`RSS exceeds soft cap (${rssMB} > ${softCapMB} MB)`);
      }
      // Per-cache budget survey (#554) — lists any cache whose current
      // footprint exceeds the budget row in `docs/memory-budget.md`.
      for (const note of getCacheBudgetNotes()) {
        memoryNotes.push(note);
      }

      const report: DiagnoseReport = {
        device,
        backends: {
          simctl: simctlStatus,
          webkit: webkitStatus,
          applescript: applescriptStatus,
          simhid: simhidStatus,
        },
        proxy,
        environment,
        headless_verdict: {
          safari: safariVerdict,
          native: nativeVerdict,
          overall: safariVerdict && nativeVerdict,
        },
        latency: getInputTelemetryRollup(),
        memory: {
          rss_mb: bytesToMB(memorySnapshot.rssBytes),
          peak_rss_mb: bytesToMB(memorySnapshot.peakRssBytes),
          heap_used_mb: bytesToMB(memorySnapshot.heapUsedBytes),
          heap_total_mb: bytesToMB(memorySnapshot.heapTotalBytes),
          external_mb: bytesToMB(memorySnapshot.externalBytes),
          array_buffers_mb: bytesToMB(memorySnapshot.arrayBuffersBytes),
          sample_count: memorySnapshot.sampleCount,
          rss_growth_mb_per_hour: getRssGrowthPerHour(),
          soft_cap_mb: softCapMB,
          notes: memoryNotes,
        },
        memory_status: capExceeded ? 'warn' : 'ok',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
