/**
 * Generic Flutter service-extension access (issue #441).
 *
 * Two MCP tools that let callers enumerate and invoke any VM Service
 * extension registered by the running app — including third-party ones
 * like riverpod_devtools (`ext.riverpod.*`), Isar, BLoC observer, etc.
 *
 * Keeping this generic (Option B in the issue) avoids shipping a
 * dedicated tool per library. Library-specific wrappers (e.g. a
 * `flutter_riverpod_read` convenience) can be layered on top in a
 * follow-up if a specific ecosystem proves valuable enough.
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError } from '../errors';

async function resolveClient(paramDeviceId: unknown) {
  const deviceId =
    (typeof paramDeviceId === 'string' ? paramDeviceId : undefined) ??
    getSessionManager().getSoleDeviceId();
  if (!deviceId) {
    throw new Error('No device specified and no active device. Boot a simulator first.');
  }
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
  }
  return { deviceId, client };
}

// ── flutter_list_service_extensions ─────────────────────────────────────────

export function registerFlutterListServiceExtensionsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_list_service_extensions',
      description:
        'List all service extensions registered by the running Flutter app ' +
        '(framework ext.flutter.*, dart dev extensions, and third-party ' +
        'extensions such as ext.riverpod.* from the riverpod_devtools package). ' +
        'Pair with flutter_call_service_extension to invoke any of them. ' +
        'Requires an active flutter_connect session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prefix: {
            type: 'string',
            description: 'Optional prefix filter (e.g. "ext.riverpod." to see only Riverpod extensions).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const { deviceId, client } = await resolveClient(params.device_id);
        const isolate = await client.getIsolate();
        const raw = (isolate as Record<string, unknown>).extensionRPCs;
        const all = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];

        const prefix = typeof params.prefix === 'string' ? params.prefix : undefined;
        const filtered = prefix ? all.filter((ext) => ext.startsWith(prefix)) : all;

        // Group by namespace for easier LLM consumption.
        const namespaces: Record<string, string[]> = {};
        for (const ext of filtered) {
          const parts = ext.split('.');
          // "ext.flutter.inspector.show" → "ext.flutter.inspector"
          const ns = parts.slice(0, Math.min(3, parts.length - 1)).join('.') || ext;
          if (!namespaces[ns]) namespaces[ns] = [];
          namespaces[ns].push(ext);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              count: filtered.length,
              total_registered: all.length,
              extensions: filtered.sort(),
              namespaces,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_list_service_extensions] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_VM_NOT_CONNECTED, message);
      }
    },
  );
}

// ── flutter_call_service_extension ──────────────────────────────────────────

export function registerFlutterCallServiceExtensionTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_call_service_extension',
      description:
        'Invoke any VM Service extension registered by the running Flutter app. ' +
        'The isolate id is injected automatically. Use flutter_list_service_extensions ' +
        'first to discover what is available. Example: ' +
        '{ extension: "ext.riverpod.providers", args: {} } returns the Riverpod provider map ' +
        'when the riverpod_devtools package is installed. ' +
        'SECURITY: invoking arbitrary extensions runs code inside the connected app process — ' +
        'treat `extension` and `args` with the same care as flutter_evaluate.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          extension: {
            type: 'string',
            description: 'Fully-qualified service extension name, e.g. "ext.flutter.debugPaint" or "ext.riverpod.providers".',
          },
          args: {
            type: 'object',
            description: 'Arguments to forward to the extension (excluding isolateId, which is injected).',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['extension'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const extension = params.extension;
        if (typeof extension !== 'string' || extension.trim().length === 0) {
          throw new Error('extension is required (non-empty string)');
        }
        if (!extension.startsWith('ext.')) {
          throw new Error(`extension must start with "ext." (got "${extension}")`);
        }

        const args = params.args;
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
          throw new Error('args must be an object or omitted');
        }

        const { deviceId, client } = await resolveClient(params.device_id);

        // Audit: every call is logged so the threat model matches flutter_evaluate.
        console.error(`[flutter_call_service_extension] audit: invoking ${extension} on ${deviceId}`);

        // callServiceExtension auto-prefixes "ext.flutter." for bare names — we
        // want full-name passthrough here, so call callMethod directly with the
        // fully qualified extension and inject isolateId.
        const isolateId = client.getState()?.mainIsolateId;
        if (!isolateId) {
          throw new Error('No main isolate available.');
        }

        // Defensive: strip any caller-supplied `isolateId` before spreading,
        // then add the auto-injected one. This guarantees the tool's promised
        // "isolateId is injected for you" contract — a caller that passes
        // {args: {isolateId: "other"}} cannot silently retarget the RPC.
        const callerArgs = (args as Record<string, unknown> | undefined) ?? {};
        if (Object.prototype.hasOwnProperty.call(callerArgs, 'isolateId')) {
          console.error(`[flutter_call_service_extension] warning: caller-supplied isolateId ignored (auto-injected ${isolateId})`);
        }
        const { isolateId: _ignored, ...safeArgs } = callerArgs;
        void _ignored;
        const result = await client.callMethod(extension, {
          ...safeArgs,
          isolateId,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              deviceId,
              extension,
              result,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_call_service_extension] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message);
      }
    },
  );
}
