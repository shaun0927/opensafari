/**
 * flutter_connect — Connect to a Flutter app's Dart VM Service.
 *
 * Auto-discovers the VM Service URL from simulator logs, or accepts
 * an explicit URL. Required before using other flutter_* tools.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError, StructuredErrorException } from '../errors';
import {
  getCachedVMServiceUrl,
  isValidVMServiceUrl,
  probeVMServiceUrl,
  wsToHttpUrl,
} from '../flutter/vm-service-discovery';
import {
  detectBuildMode,
  capabilitiesFor,
  type FlutterBuildMode,
  type FlutterCapabilities,
} from './flutter-build-mode';

export function registerFlutterConnectTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_connect',
      description:
        'Connect to a Flutter app\'s Dart VM Service for debug inspection. ' +
        'Auto-discovers the observatory URL from simulator logs, or accepts an explicit URL. ' +
        'Required before using flutter_widget_tree, flutter_hot_reload, flutter_logs, etc. ' +
        'Only works with debug/profile builds (release builds disable VM Service).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          vm_service_url: {
            type: 'string',
            description: 'Explicit VM Service URL (e.g. "http://127.0.0.1:50642/abc=/"). If omitted, auto-discovers from logs.',
          },
          bundle_id: {
            type: 'string',
            description: 'Bundle ID of the Flutter app (helps disambiguate if multiple apps running)',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          timeout: {
            type: 'number',
            description: 'Discovery timeout in ms (default: 10000)',
          },
          vm_service_port: {
            type: 'number',
            description: 'Optional deterministic local VM Service port. Requires vm_service_auth_code when the VM service uses an auth token.',
          },
          vm_service_auth_code: {
            type: 'string',
            description: 'Optional VM Service auth code for vm_service_port (e.g. abc=).',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device. Boot a simulator first.');
        }

        const client = getFlutterVMClient(deviceId);
        const attachDiagnostics = await buildAttachDiagnostics({
          explicitUrl: params.vm_service_url as string | undefined,
          port: params.vm_service_port as number | undefined,
          authCode: params.vm_service_auth_code as string | undefined,
          deviceId,
        });

        // Disconnect existing connection if any
        if (client.isConnected()) {
          await client.disconnect();
        }

        const vmServiceUrl =
          (params.vm_service_url as string | undefined) ??
          attachDiagnostics.fixedPortUrl;

        const state = await client.connect({
          deviceId,
          vmServiceUrl,
          bundleId: params.bundle_id as string | undefined,
          timeout: params.timeout as number | undefined,
        });

        // Build-mode + capability disclosure (issue #831): tell the caller
        // up front whether Tier-0 `evaluate` actually works, instead of
        // surfacing a code-113 failure on the first downstream tool.
        const { buildMode, capabilities, evaluateProbed } =
          await computeBuildModeDisclosure(deviceId, client);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'connected',
              vmServiceUrl: redactVmServiceUrl(state.httpUrl),
              wsUrl: redactVmServiceUrl(state.wsUrl),
              deviceId: state.deviceId,
              buildMode,
              vmServiceAvailable: true,
              capabilities,
              evaluateProbed,
              attachDiagnostics: {
                attempts: attachDiagnostics.attempts,
              },
              vm: state.vmInfo ? {
                name: state.vmInfo.name,
                version: state.vmInfo.version,
                pid: state.vmInfo.pid,
                isolates: state.vmInfo.isolates.map((i) => ({ id: i.id, name: i.name })),
              } : null,
              mainIsolateId: state.mainIsolateId,
              dartVersion: state.dartVersion ?? null,
              flutterMajor: state.dartVersion?.major ?? null,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = redactVmServiceUrl(err instanceof Error ? err.message : String(err)) ?? '';
        console.error(`[flutter_connect] ${message}`);
        const attachDiagnostics = buildStaticAttachDiagnostics(params);
        return respondWithStructuredError(ErrorCode.FLUTTER_VM_NOT_CONNECTED, message, {
          attachDiagnostics,
          suggestions: buildAttachTroubleshooting(message, attachDiagnostics.attempts),
        });
      }
    },
  );
}

/**
 * Compute the build-mode + capability disclosure for a freshly connected
 * Flutter VM (issue #831).
 *
 * The load-bearing `evaluate` capability is **probe-backed**, not inferred
 * from the mode label: a no-compiler AOT attach (e.g. `simctl launch` without
 * `flutter run`) has no `ext.flutter.reassemble` and is therefore classified
 * `profile`, yet it rejects `evaluate` with code 113. Trusting the label would
 * report `evaluate: true` falsely. Debug builds skip the probe entirely (JIT
 * always evaluates). Detection/probe failure degrades to `unknown` + no
 * evaluate, and never throws — the connect itself already succeeded.
 */
export async function computeBuildModeDisclosure(
  deviceId: string,
  client: { probeEvaluateCompile(): Promise<{ available: boolean }> },
): Promise<{
  buildMode: FlutterBuildMode;
  capabilities: FlutterCapabilities;
  evaluateProbed: boolean;
}> {
  let buildMode: FlutterBuildMode = 'unknown';
  let capabilities: FlutterCapabilities = capabilitiesFor('unknown');
  let evaluateProbed = false;
  try {
    const probe = await detectBuildMode(deviceId);
    buildMode = probe.mode;
    if (buildMode === 'debug') {
      // JIT always evaluates — no probe needed.
      capabilities = capabilitiesFor('debug');
    } else {
      const evalProbe = await client.probeEvaluateCompile();
      evaluateProbed = true;
      capabilities = { ...capabilitiesFor(buildMode), evaluate: evalProbe.available };
    }
  } catch (err) {
    console.error(
      `[flutter_connect] build-mode disclosure skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    buildMode = 'unknown';
    capabilities = { ...capabilitiesFor('unknown'), evaluate: false };
    evaluateProbed = false;
  }
  return { buildMode, capabilities, evaluateProbed };
}

export interface AttachAttempt {
  source: 'explicit_url' | 'env_http_url' | 'env_ws_url' | 'cache' | 'fixed_port' | 'log_scan';
  url?: string;
  valid?: boolean;
  reachable?: boolean;
  selected?: boolean;
  reason?: string;
}

export async function buildAttachDiagnostics(args: {
  explicitUrl?: string;
  port?: number;
  authCode?: string;
  deviceId: string;
}): Promise<{ attempts: AttachAttempt[]; fixedPortUrl?: string; cachedUrl?: string }> {
  const attempts: AttachAttempt[] = [];

  if (args.explicitUrl) {
    attempts.push({
      source: 'explicit_url',
      url: redactVmServiceUrl(args.explicitUrl),
      valid: isValidVMServiceUrl(args.explicitUrl),
      selected: true,
    });
  }

  const envHttp = process.env.OPENSAFARI_VM_SERVICE_URL;
  if (envHttp) {
    attempts.push({
      source: 'env_http_url',
      url: redactVmServiceUrl(envHttp),
      valid: isValidVMServiceUrl(envHttp),
      selected: !args.explicitUrl,
    });
  }

  const envWs = process.env.OPENSAFARI_VM_SERVICE_WS_URL;
  if (envWs) {
    const normalized = wsToHttpUrl(envWs);
    attempts.push({
      source: 'env_ws_url',
      url: redactVmServiceUrl(normalized),
      valid: isValidVMServiceUrl(normalized),
      selected: !args.explicitUrl && !envHttp,
    });
  }

  const cached = getCachedVMServiceUrl(args.deviceId);
  if (cached) {
    attempts.push({
      source: 'cache',
      url: redactVmServiceUrl(cached),
      valid: isValidVMServiceUrl(cached),
      reachable: await probeVMServiceUrl(cached).catch(() => false),
      selected: !args.explicitUrl && !envHttp && !envWs,
    });
  }

  let fixedPortUrl: string | undefined;
  if (Number.isFinite(args.port)) {
    const token = args.authCode ? `${args.authCode.replace(/\/$/, '')}/` : '';
    fixedPortUrl = `http://127.0.0.1:${Math.floor(args.port as number)}/${token}`;
    attempts.push({
      source: 'fixed_port',
      url: redactVmServiceUrl(fixedPortUrl),
      valid: isValidVMServiceUrl(fixedPortUrl),
      reachable: await probeVMServiceUrl(fixedPortUrl).catch(() => false),
      selected: !args.explicitUrl && !envHttp && !envWs && !cached,
      reason: args.authCode
        ? 'Fixed port with caller-supplied auth code.'
        : 'Fixed port without auth code; valid only when VM Service auth codes are disabled.',
    });
  }

  attempts.push({
    source: 'log_scan',
    selected: !args.explicitUrl && !envHttp && !envWs && !cached && !fixedPortUrl,
    reason: 'Fallback simulator log scan.',
  });

  return { attempts, fixedPortUrl, cachedUrl: cached };
}

export function buildStaticAttachDiagnostics(params: Record<string, unknown>): { attempts: AttachAttempt[] } {
  const explicit = params.vm_service_url as string | undefined;
  const port = params.vm_service_port as number | undefined;
  const attempts: AttachAttempt[] = [];
  if (explicit) {
    attempts.push({ source: 'explicit_url', url: redactVmServiceUrl(explicit), valid: isValidVMServiceUrl(explicit), selected: true });
  }
  if (process.env.OPENSAFARI_VM_SERVICE_URL) {
    attempts.push({ source: 'env_http_url', url: redactVmServiceUrl(process.env.OPENSAFARI_VM_SERVICE_URL), valid: isValidVMServiceUrl(process.env.OPENSAFARI_VM_SERVICE_URL) });
  }
  if (process.env.OPENSAFARI_VM_SERVICE_WS_URL) {
    const normalized = wsToHttpUrl(process.env.OPENSAFARI_VM_SERVICE_WS_URL);
    attempts.push({ source: 'env_ws_url', url: redactVmServiceUrl(normalized), valid: isValidVMServiceUrl(normalized) });
  }
  if (Number.isFinite(port)) {
    const authCode = params.vm_service_auth_code as string | undefined;
    const token = authCode ? `${authCode.replace(/\/$/, '')}/` : '';
    const url = `http://127.0.0.1:${Math.floor(port as number)}/${token}`;
    attempts.push({ source: 'fixed_port', url: redactVmServiceUrl(url), valid: isValidVMServiceUrl(url) });
  }
  attempts.push({ source: 'log_scan', reason: 'Fallback simulator log scan.' });
  return { attempts };
}

export function redactVmServiceUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(
    /((?:ws|http)s?:\/\/127\.0\.0\.1:\d+\/)([^/?#]+)(\/(?:ws)?\/?)?/,
    (_match, prefix: string, token: string, suffix: string | undefined) => {
      if (!token) return `${prefix}${suffix ?? ''}`;
      return `${prefix}<redacted>${suffix ?? '/'}`;
    },
  );
}


export function buildAttachTroubleshooting(message: string, attempts: AttachAttempt[]): string[] {
  const suggestions: string[] = [];
  if (/invalid/i.test(message) || attempts.some((a) => a.valid === false)) {
    suggestions.push('Check the VM Service URL shape: use http://127.0.0.1:<port>/<auth-code>/ or ws://127.0.0.1:<port>/<auth-code>/ws.');
  }
  if (attempts.some((a) => a.source === 'cache' && a.reachable === false)) {
    suggestions.push('Cached VM Service URL is stale; reconnect with vm_service_url or restart the debug/profile Flutter app.');
  }
  if (attempts.some((a) => a.source === 'fixed_port' && a.reachable === false)) {
    suggestions.push('Fixed VM Service port is not reachable; verify the external flutter run/profile command uses the same host port and auth-code settings.');
  }
  if (!attempts.some((a) => a.source === 'explicit_url' || a.source === 'fixed_port' || a.source.startsWith('env_'))) {
    suggestions.push('For deterministic QA, launch Flutter externally with a fixed VM Service port and pass vm_service_port plus vm_service_auth_code, or pass vm_service_url directly.');
  }
  if (/release/i.test(message)) {
    suggestions.push('Flutter release builds disable VM Service; use debug or profile builds for flutter_* inspection tools.');
  }
  suggestions.push('OpenSafari does not own flutter run; keep app launch external and use flutter_connect only to attach.');
  return [...new Set(suggestions)];
}
