import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import {
  AutoBlocker,
  NetworkBlocker,
  NlcBlocker,
  PfctlBlocker,
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
}

export function getDeviceNetworkState(deviceId: string): DeviceNetworkStateEntry {
  return stateByDevice.get(deviceId) ?? { ...DEFAULT_STATE };
}

export function setDeviceNetworkState(deviceId: string, entry: DeviceNetworkStateEntry): void {
  stateByDevice.set(deviceId, entry);
}

async function resolveDeviceId(explicit: string | undefined): Promise<string | null> {
  if (explicit) return explicit;
  const sole = getSessionManager().getSoleDeviceId();
  if (sole) return sole;
  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  return booted[0]?.udid ?? null;
}

function jsonResponse(body: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    ...(isError ? { isError: true as const } : {}),
  };
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

      const deviceId = await resolveDeviceId(params.udid as string | undefined);
      if (!deviceId) {
        return jsonResponse({ ok: false, error: 'no_booted_device' }, true);
      }

      const bundle = getHostBlocker();
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
      const deviceId = await resolveDeviceId(params.udid as string | undefined);
      if (!deviceId) {
        return jsonResponse({ ok: false, error: 'no_booted_device' }, true);
      }
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
