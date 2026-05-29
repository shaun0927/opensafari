/**
 * `maybeAttachDebugBundle` — wrap a tool error response so it carries a
 * compact `debug_bundle_collect` artifact when the caller (or the
 * `OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE` env override) opts in.
 *
 * The attachment is *opportunistic*:
 *   - The response must already be an error (`isError === true`).
 *   - The encoded payload must include a known recoverable ErrorCode
 *     (we don't waste a bundle on irrecoverable failures like
 *     `RESOURCE_EXHAUSTED` where no retry will help).
 *   - Either `params.collectDebugBundleOnFailure === true` OR
 *     `process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE` is set to a
 *     truthy value.
 *
 * The bundle is appended to the response's text payload under a new
 * `debugBundle` key, so consumers can branch on its presence without a
 * shape change to the canonical 4-key envelope.
 */

import type { MCPResult } from '../types/mcp';
import { collectDebugBundle, type DebugBundleOptions } from './debug-bundle-collect';
import { ERROR_CATALOG, ErrorCode } from '../errors/codes';

export interface AttachBundleOptions {
  params: Record<string, unknown>;
  deviceId?: string;
  bundleId?: string;
  toolName: string;
}

function envEnabled(): boolean {
  const raw = process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE;
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function isRecoverableCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const entry = ERROR_CATALOG[code as ErrorCode];
  return !!entry && entry.recoverable === true;
}

export async function maybeAttachDebugBundle(
  response: MCPResult,
  options: AttachBundleOptions,
): Promise<MCPResult> {
  // Fast-out: success responses don't get bundles.
  if (!response.isError) return response;

  const optIn =
    options.params.collectDebugBundleOnFailure === true || envEnabled();
  if (!optIn) return response;

  // Parse the payload so we can inspect the ErrorCode before deciding
  // whether the failure is worth a bundle.
  const text =
    response.content && response.content[0] && 'text' in response.content[0]
      ? (response.content[0] as { text: string }).text
      : '';
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON error envelopes don't carry a code we can introspect.
    return response;
  }
  if (!isRecoverableCode(payload.error)) {
    return response;
  }

  // Collect. Bundle is best-effort; failure is silently swallowed so we
  // never make an error response *worse* by failing the attachment.
  let bundle: unknown;
  try {
    const opts: DebugBundleOptions = {
      deviceId: options.deviceId,
      bundleId: options.bundleId,
      // Action-failure attach should default to the lightest viable bundle
      // — agents are inspecting why something failed, not auditing the
      // network state. They can still pass through-tool overrides.
      includeScreenshot: true,
      includeAxTree: true,
      includeLogs: true,
      includeCrashes: true,
      includeFlutterRoute: true,
      includeNetwork: false,
    };
    bundle = await collectDebugBundle(opts);
  } catch (err) {
    bundle = { error: err instanceof Error ? err.message : String(err) };
  }

  const merged = { ...payload, debugBundle: bundle, debugBundleTool: options.toolName };
  return {
    ...response,
    content: [{ type: 'text' as const, text: JSON.stringify(merged) }],
  };
}

/**
 * Decorate an MCP tool handler so every error response it returns is
 * given a chance to attach a `debug_bundle_collect` payload. The
 * decorator never short-circuits success responses, and the bundle
 * collection itself is best-effort.
 */
export function wrapHandlerForBundle(
  toolName: string,
  handler: (sessionId: string, params: Record<string, unknown>) => Promise<MCPResult>,
): (sessionId: string, params: Record<string, unknown>) => Promise<MCPResult> {
  return async (sessionId, params) => {
    const result = await handler(sessionId, params);
    const deviceId =
      (params.device_id as string | undefined) ?? (params.deviceId as string | undefined);
    const bundleId = params.bundleId as string | undefined;
    return maybeAttachDebugBundle(result, { params, deviceId, bundleId, toolName });
  };
}

/**
 * JSON schema fragment that every action tool participating in
 * auto-attach should advertise alongside its existing inputs.
 */
export const COLLECT_DEBUG_BUNDLE_ON_FAILURE_SCHEMA = {
  type: 'boolean' as const,
  description:
    'When true, recoverable error responses include a compact debug_bundle_collect artifact (screenshot, AX summary, recent logs, fresh crashes, flutter route) under `debugBundle`. Can also be forced on globally via OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE=1.',
};
