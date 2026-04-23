import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

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

export function __resetDeviceNetworkStateForTests(): void {
  stateByDevice.clear();
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

export function registerDeviceNetworkSetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_network_set',
      description:
        'Toggle the iOS Simulator host-level network state so native apps (Flutter, UIKit) see real SocketException / NSURLErrorNotConnectedToInternet. Unlike network_offline (which is WebKit-only), this is intended to affect URLSession and dart:io HttpClient traffic. Scaffold only in this build — requesting offline/airplane returns NotImplemented until the pfctl/NLC backend lands.',
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

      const current = getDeviceNetworkState(deviceId);

      if (mode === 'online') {
        const next: DeviceNetworkStateEntry = {
          mode: 'online',
          mechanism: null,
          activeSince: null,
        };
        setDeviceNetworkState(deviceId, next);
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
              : 'restored to online (scaffold: no real rule was installed)',
        });
      }

      return jsonResponse(
        {
          ok: false,
          error: 'not_implemented',
          deviceId,
          requestedMode: mode,
          requestedMechanism: mechanismArg,
          message:
            'device_network_set scaffold is registered, but no blocking backend is wired yet. Tracking in issue #640 — PR 2 adds the mechanism abstraction, PR 3 wires pfctl, PR 4 wires NLC.',
        },
        true,
      );
    },
  );
}

export function registerDeviceNetworkGetTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'device_network_get',
      description:
        'Read the current simulated network state set by device_network_set. Returns {mode, mechanism, activeSince}. Scaffold build — always reports "online" until a backend is wired.',
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
