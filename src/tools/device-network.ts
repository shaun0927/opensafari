import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import {
  AutoBlocker,
  NetworkBlocker,
  NlcBlocker,
  PfctlBlocker,
  PfctlReconcileResult,
  RealHostExec,
  RealTempFileWriter,
} from '../simulator/network-blockers';

export type DeviceNetworkMode = 'online' | 'offline' | 'airplane';
export type DeviceNetworkMechanism = 'pfctl' | 'nlc' | 'auto';
export type DeviceNetworkResolvedMechanism = 'pfctl' | 'nlc' | null;

export interface DeviceNetworkStateEntry {
  mode: DeviceNetworkMode;
  mechanism: DeviceNetworkResolvedMechanism;
  activeSince: string | null;
}

const DEFAULT_STATE: DeviceNetworkStateEntry = {
  mode: 'online',
  mechanism: null,
  activeSince: null,
};

const stateByDevice = new Map<string, DeviceNetworkStateEntry>();

/**
 * Blocker bundle used by the tool layer. The pf/NLC backends are
 * host-wide — they affect the whole machine's network stack — so we
 * keep a single shared instance and reference-count offline devices.
 *
 * The `auto` member is an {@link AutoBlocker} composed from the two
 * concrete backends; when the caller passes `mechanism: "auto"` we
 * route through it so selection (pfctl → nlc fallback) is cached.
 */
export interface HostBlockerBundle {
  pfctl: NetworkBlocker;
  nlc: NetworkBlocker;
  auto: NetworkBlocker;
}

let hostBlocker: HostBlockerBundle | null = null;
/** Reference-tracking: which blocker (if any) currently owns the active host rule. */
let activeHostBlocker: NetworkBlocker | null = null;
/**
 * Set once after the first successful reconciliation attempt so we don't
 * re-probe on every tool call. See {@link reconcileHostBlockers}.
 */
let reconciledOnce = false;

function buildDefaultHostBlocker(): HostBlockerBundle {
  const exec = new RealHostExec();
  const tempFile = new RealTempFileWriter();
  const pfctl = new PfctlBlocker({ exec, tempFile });
  const nlc = new NlcBlocker({ exec });
  const auto = new AutoBlocker({ candidates: [pfctl, nlc] });
  return { pfctl, nlc, auto };
}

function getHostBlocker(): HostBlockerBundle {
  if (!hostBlocker) {
    hostBlocker = buildDefaultHostBlocker();
  }
  return hostBlocker;
}

function selectBlocker(
  bundle: HostBlockerBundle,
  mechanism: DeviceNetworkMechanism,
): NetworkBlocker {
  switch (mechanism) {
    case 'pfctl':
      return bundle.pfctl;
    case 'nlc':
      return bundle.nlc;
    case 'auto':
      return bundle.auto;
  }
}

function resolvedMechanismFor(b: NetworkBlocker): DeviceNetworkResolvedMechanism {
  return b.kind === 'pfctl' || b.kind === 'nlc' ? b.kind : null;
}

function countOfflineDevices(): number {
  let n = 0;
  for (const s of stateByDevice.values()) {
    if (s.mode !== 'online') n += 1;
  }
  return n;
}

/** Test hook: inject a mock blocker bundle. Passing null restores the default. */
export function __setHostBlockerForTests(bundle: HostBlockerBundle | null): void {
  hostBlocker = bundle;
  activeHostBlocker = null;
}

export function __resetDeviceNetworkStateForTests(): void {
  stateByDevice.clear();
  hostBlocker = null;
  activeHostBlocker = null;
  reconciledOnce = false;
}

/**
 * Probe each supported mechanism for leftover state from a previous
 * server run that died before reverting, and flush it. Best-effort:
 * probe failures are logged to stderr and swallowed — reconciliation
 * must never block the server from starting.
 *
 * Called lazily on the first `device_network_set` invocation so tests
 * that never touch this tool don't pay the cost. The one-time gate is
 * {@link reconciledOnce}.
 *
 * Returns the reconcile result so callers (tests, diagnostics) can
 * inspect whether any stale rules were flushed.
 */
export async function reconcileHostBlockers(
  bundle: HostBlockerBundle,
): Promise<{ pfctl: PfctlReconcileResult | null }> {
  let pfctl: PfctlReconcileResult | null = null;
  if (bundle.pfctl instanceof PfctlBlocker) {
    try {
      pfctl = await bundle.pfctl.reconcileStaleAnchor();
      if (pfctl.reconciled) {
        console.error(
          `[device-network] flushed ${pfctl.rulesFound} stale rules from previous run`,
        );
      }
    } catch (err) {
      console.error('[device-network] pfctl reconciliation failed:', err);
    }
  }
  // NLC reconciliation lands in PR 5.
  return { pfctl };
}

async function ensureReconciled(bundle: HostBlockerBundle): Promise<void> {
  if (reconciledOnce) return;
  reconciledOnce = true;
  await reconcileHostBlockers(bundle);
}

export function getDeviceNetworkState(deviceId: string): DeviceNetworkStateEntry {
  return stateByDevice.get(deviceId) ?? { ...DEFAULT_STATE };
}

export function setDeviceNetworkState(deviceId: string, entry: DeviceNetworkStateEntry): void {
  stateByDevice.set(deviceId, entry);
}

export type ResolveDeviceIdResult =
  | { ok: true; deviceId: string }
  | {
      ok: false;
      error: 'udid_not_booted' | 'no_booted_device' | 'ambiguous_device';
      requestedUdid?: string;
      bootedUdids?: string[];
    };

/**
 * Resolve a UDID for a device-network call.
 *
 * - Explicit `udid` must correspond to a currently booted simulator. Silently
 *   accepting an arbitrary string caused device_network_set/get to persist
 *   state under the wrong key on typos or already-shutdown devices.
 * - With no explicit `udid`, prefer the session's sole-device binding; then
 *   fall back to `simctl list` only when exactly one simulator is booted.
 *   Silently picking `booted[0]` in a multi-device run would claim success
 *   against an unintended target.
 */
async function resolveDeviceId(explicit: string | undefined): Promise<ResolveDeviceIdResult> {
  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  const bootedUdids = booted.map((b) => b.udid);

  if (explicit) {
    if (bootedUdids.includes(explicit)) {
      return { ok: true, deviceId: explicit };
    }
    return {
      ok: false,
      error: 'udid_not_booted',
      requestedUdid: explicit,
      bootedUdids,
    };
  }

  const sole = getSessionManager().getSoleDeviceId();
  if (sole) {
    // Session-bound UDIDs are authoritative: the caller has an established
    // MCP session tied to this device, so we don't second-guess against
    // listBooted here (race with a just-shutdown device would otherwise lock
    // the caller out mid-session).
    return { ok: true, deviceId: sole };
  }

  if (bootedUdids.length === 0) {
    return { ok: false, error: 'no_booted_device', bootedUdids };
  }
  if (bootedUdids.length === 1) {
    return { ok: true, deviceId: bootedUdids[0] };
  }
  return { ok: false, error: 'ambiguous_device', bootedUdids };
}

function jsonResponse(body: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function errorResponseForResolveFailure(
  resolution: Extract<ResolveDeviceIdResult, { ok: false }>,
) {
  switch (resolution.error) {
    case 'udid_not_booted':
      return jsonResponse(
        {
          ok: false,
          error: 'udid_not_booted',
          requestedUdid: resolution.requestedUdid,
          bootedUdids: resolution.bootedUdids,
          message:
            'The supplied udid is not currently booted. Pass the UDID of a booted simulator or omit udid to auto-resolve when exactly one is booted.',
        },
        true,
      );
    case 'ambiguous_device':
      return jsonResponse(
        {
          ok: false,
          error: 'ambiguous_device',
          bootedUdids: resolution.bootedUdids,
          message:
            'Multiple simulators are booted; pass an explicit udid so the call cannot act on the wrong device.',
        },
        true,
      );
    case 'no_booted_device':
    default:
      return jsonResponse({ ok: false, error: 'no_booted_device' }, true);
  }
}

function blockerErrorBody(deviceId: string, mode: DeviceNetworkMode, err: unknown) {
  const e = err as { name?: string; message?: string };
  return {
    ok: false,
    error: e.name ?? 'blocker_failed',
    message: e.message ?? String(err),
    deviceId,
    requestedMode: mode,
  };
}
export function registerDeviceNetworkSetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_network_set',
      description:
        'Toggle the iOS Simulator host-level network state so native apps (Flutter, UIKit) see real SocketException / NSURLErrorNotConnectedToInternet. Unlike network_offline (WebKit-only), this targets URLSession and dart:io HttpClient traffic via pfctl or Network Link Conditioner. Requires a one-time setup (passwordless sudoers + /etc/pf.conf anchor) — see docs/tools/device-network.md.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          udid: { type: 'string', description: 'Device UDID. Defaults to the sole booted simulator.' },
          mode: {
            type: 'string',
            enum: ['online', 'offline', 'airplane'],
            description:
              'Target network state. "offline" and "airplane" share a code path; "online" restores connectivity and is idempotent.',
          },
          mechanism: {
            type: 'string',
            enum: ['pfctl', 'nlc', 'auto'],
            description:
              'Blocking mechanism. "auto" selects pfctl when elevated privileges are configured, otherwise falls back to Network Link Conditioner. Default: "auto".',
          },
        },
        required: ['mode'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const mode = params.mode as DeviceNetworkMode | undefined;
      if (mode !== 'online' && mode !== 'offline' && mode !== 'airplane') {
        return jsonResponse(
          { ok: false, error: 'invalid_mode', allowed: ['online', 'offline', 'airplane'] },
          true,
        );
      }
      const mechanismArg = (params.mechanism as DeviceNetworkMechanism | undefined) ?? 'auto';
      if (mechanismArg !== 'pfctl' && mechanismArg !== 'nlc' && mechanismArg !== 'auto') {
        return jsonResponse(
          { ok: false, error: 'invalid_mechanism', allowed: ['pfctl', 'nlc', 'auto'] },
          true,
        );
      }

      const resolution = await resolveDeviceId(params.udid as string | undefined);
      if (!resolution.ok) {
        return errorResponseForResolveFailure(resolution);
      }
      const deviceId = resolution.deviceId;

      const bundle = getHostBlocker();
      // Run startup reconciliation once per process — flushes a stale
      // anchor from a previous server that died before reverting. Safe
      // to call on every handler invocation because of the one-shot gate.
      await ensureReconciled(bundle);
      const current = getDeviceNetworkState(deviceId);

      if (mode === 'online') {
        const wasOffline = current.mode !== 'online';
        const next: DeviceNetworkStateEntry = {
          mode: 'online',
          mechanism: null,
          activeSince: null,
        };
        setDeviceNetworkState(deviceId, next);

        // If this was the last offline device, revert the host-wide rule.
        if (wasOffline && countOfflineDevices() === 0 && activeHostBlocker) {
          try {
            await activeHostBlocker.revert(deviceId);
          } catch (err) {
            // Roll state back so a subsequent retry can re-attempt revert.
            setDeviceNetworkState(deviceId, current);
            return jsonResponse(blockerErrorBody(deviceId, mode, err), true);
          }
          activeHostBlocker = null;
        }

        return jsonResponse({
          ok: true,
          deviceId,
          mode: 'online',
          mechanism: null,
          appliedAt: new Date().toISOString(),
          previousMode: current.mode,
          note:
            current.mode === 'online'
              ? 'already online; no mechanism was active'
              : 'restored to online',
        });
      }

      // offline / airplane
      const requested = selectBlocker(bundle, mechanismArg);

      // Enforce single-mechanism invariant: if a different blocker is already
      // active, reject rather than silently stacking rules on the host.
      if (activeHostBlocker && activeHostBlocker !== requested) {
        return jsonResponse(
          {
            ok: false,
            error: 'mechanism_conflict',
            message:
              'another mechanism is already active on this host; set all devices back to "online" before switching mechanisms',
            activeMechanism: activeHostBlocker.kind,
            requestedMechanism: requested.kind,
            deviceId,
          },
          true,
        );
      }

      try {
        await requested.apply(deviceId);
      } catch (err) {
        return jsonResponse(blockerErrorBody(deviceId, mode, err), true);
      }

      activeHostBlocker = requested;
      const resolved = resolvedMechanismFor(requested);
      const appliedAt = new Date().toISOString();
      const next: DeviceNetworkStateEntry = {
        mode,
        mechanism: resolved,
        activeSince: appliedAt,
      };
      setDeviceNetworkState(deviceId, next);

      return jsonResponse({
        ok: true,
        deviceId,
        mode,
        mechanism: resolved,
        appliedAt,
        previousMode: current.mode,
      });
    },
  );
}

export function registerDeviceNetworkGetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_network_get',
      description:
        'Read the current simulated network state set by device_network_set. Returns {mode, mechanism, activeSince}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          udid: { type: 'string', description: 'Device UDID. Defaults to the sole booted simulator.' },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const resolution = await resolveDeviceId(params.udid as string | undefined);
      if (!resolution.ok) {
        return errorResponseForResolveFailure(resolution);
      }
      const deviceId = resolution.deviceId;
      const state = getDeviceNetworkState(deviceId);
      return jsonResponse({
        ok: true,
        deviceId,
        mode: state.mode,
        mechanism: state.mechanism,
        activeSince: state.activeSince,
      });
    },
  );
}

export function registerDeviceNetworkTools(server: MCPServer): void {
  registerDeviceNetworkSetTool(server);
  registerDeviceNetworkGetTool(server);
}
