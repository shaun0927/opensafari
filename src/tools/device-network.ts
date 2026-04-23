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

      const deviceId = await resolveDeviceId(params.udid as string | undefined);
      if (!deviceId) {
        return jsonResponse({ ok: false, error: 'no_booted_device' }, true);
      }

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
