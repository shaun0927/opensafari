/**
 * flutter_evaluate — Evaluate an arbitrary Dart expression against a running
 * Flutter app's main isolate (or, in a future PR, a paused stack frame).
 *
 * Motivation (issue #434): today the only way to read a Dart value from
 * an app at runtime is debugPrint + hot reload + flutter_logs — a slow loop.
 * DevTools' Console tab uses the VM Service `evaluate` RPC; exposing the
 * same RPC as an MCP tool collapses that loop to a single call.
 *
 * Primitives (int/double/bool/String/null) return as `valueAsString`.
 * Composite @Instance results expose their 1-depth fields map; deeper
 * traversal is left to follow-up tools (`getObject`).
 *
 * Requires an active flutter_connect session — debug or profile build
 * only (release builds disable VM Service by design; see #442).
 */

import { MCPServer } from '../mcp-server';
import { getFlutterVMClient } from '../flutter';
import { getSessionManager } from '../session-manager';
import { ErrorCode, respondWithStructuredError } from '../errors';

type EvalScope = 'root' | 'frame';

export function registerFlutterEvaluateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'flutter_evaluate',
      description:
        'Evaluate a Dart expression against a running Flutter app via the VM Service. ' +
        'Defaults to evaluating against the main isolate\'s root library. ' +
        'Use scope="frame" with a frame_index to evaluate inside a paused stack frame ' +
        '(requires a breakpoint hit; future feature). ' +
        'Works only on debug / profile builds — run flutter_connect first. ' +
        'SECURITY: this tool executes arbitrary Dart code inside the connected app ' +
        'process, including access to Process, File, Socket, HttpClient, and Isolate.spawn. ' +
        'Never pass user- or model-derived input verbatim; treat it as equivalent to ' +
        'eval() on the developer machine. Every invocation is logged to stderr for audit.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          expression: {
            type: 'string',
            description: 'Dart expression, e.g. "1 + 1" or "DateTime.now().toIso8601String()"',
          },
          scope: {
            type: 'string',
            enum: ['root', 'frame'],
            description: 'Evaluation scope (default: "root"). "frame" requires a paused isolate.',
          },
          frame_index: {
            type: 'number',
            description: 'For scope="frame": 0-based stack frame index from flutter_get_stack.',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['expression'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const rawExpression = params.expression;
        if (typeof rawExpression !== 'string' || rawExpression.trim().length === 0) {
          throw new Error('expression is required (non-empty, non-whitespace string)');
        }
        const expression = rawExpression;

        // Security audit: never log the expression body; the MCP audit log
        // records a redacted argument summary when HTTP high-risk access is enabled.
        console.error(`[flutter_evaluate] audit: evaluating expression (len=${expression.length})`);

        const scope: EvalScope = (params.scope as EvalScope | undefined) ?? 'root';
        if (scope !== 'root' && scope !== 'frame') {
          throw new Error(`scope must be "root" or "frame" (got "${scope}")`);
        }

        let frameIndex: number | undefined;
        if (scope === 'frame') {
          const idx = params.frame_index;
          if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
            throw new Error('scope="frame" requires frame_index (non-negative integer)');
          }
          frameIndex = idx;
        }

        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device. Boot a simulator first.');
        }

        const client = getFlutterVMClient(deviceId);
        if (!client.isConnected()) {
          throw new Error('Not connected to Flutter VM Service. Run flutter_connect first.');
        }

        const raw =
          scope === 'frame'
            ? await client.evaluateInFrame(frameIndex!, expression)
            : await client.evaluate(expression);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ok',
              scope,
              expression,
              frameIndex,
              deviceId,
              result: shapeResult(raw),
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[flutter_evaluate] ${message}`);
        return respondWithStructuredError(ErrorCode.FLUTTER_EVAL_FAILED, message);
      }
    },
  );
}

/**
 * Normalise the VM Service evaluate response into a shape LLMs can read
 * without parsing the full `@Instance` envelope.
 */
export function shapeResult(raw: Record<string, unknown>): Record<string, unknown> {
  const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  const classRef = (raw['class'] as { name?: string } | undefined)?.name;
  const valueAsString = typeof raw.valueAsString === 'string' ? raw.valueAsString : undefined;

  // Error envelope: real VM Service @Error envelopes use type: "@Error"
  // with kind being one of UnhandledException / LanguageError / etc.
  // The `kind === 'Error'` branch below is defensive against older/custom
  // shapes and is intentionally not exercised by the VM today.
  if (type === '@Error' || type === 'Error' || kind === 'Error') {
    return {
      kind: 'Error',
      message: typeof raw.message === 'string' ? raw.message : valueAsString,
      raw,
    };
  }

  // Sentinel (isolate dead, expression not resolvable, etc.)
  if (type === 'Sentinel') {
    return {
      kind: 'Sentinel',
      valueAsString: valueAsString ?? null,
      sentinelKind: typeof raw.kind === 'string' ? raw.kind : null,
    };
  }

  // Null instances: the VM may or may not populate `valueAsString`.
  // Guarantee a consistent shape so callers do not have to treat this
  // specially.
  if (kind === 'Null') {
    return { kind: 'Null', classRef, valueAsString: valueAsString ?? 'null' };
  }

  // Other primitive instances always carry a valueAsString.
  if (valueAsString !== undefined && kind && ['Int', 'Double', 'Bool', 'String'].includes(kind)) {
    return { kind, classRef, valueAsString };
  }

  // Composite @Instance — include 1-depth field names if present.
  const fields = Array.isArray(raw.fields)
    ? (raw.fields as Array<{ decl?: { name?: string }; value?: unknown }>)
        .map((f) => f?.decl?.name)
        .filter((n): n is string => typeof n === 'string')
    : undefined;

  return {
    kind: kind ?? 'Instance',
    classRef,
    valueAsString,
    id: typeof raw.id === 'string' ? raw.id : undefined,
    fields,
    length: typeof raw.length === 'number' ? raw.length : undefined,
  };
}
