/**
 * MCP tool handler trace wrapper.
 *
 * Wraps any ToolHandler so every invocation emits structured stderr lines:
 *
 *   [mcp] -> {name} req={id}
 *   [mcp] <- {name} req={id} ms={elapsed}          (on success)
 *   [mcp] !! {name} req={id} ms={elapsed} err={msg} (on error)
 *
 * When OPENSAFARI_TRACE=1 is set, an additional debug line is emitted on
 * entry with JSON-serialized args (each value truncated to ~500 chars).
 */

import { ToolHandler } from '../types/mcp';

const TRACE = process.env.OPENSAFARI_TRACE === '1';
const MAX_ARG_CHARS = 500;

/** Generate an 8-character hex request id. */
function newRequestId(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

/** Truncate a JSON-serialized value to MAX_ARG_CHARS characters. */
function truncate(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= MAX_ARG_CHARS) return s;
    return s.slice(0, MAX_ARG_CHARS) + '…';
  } catch {
    return String(value).slice(0, MAX_ARG_CHARS);
  }
}

/**
 * Wrap a ToolHandler with entry/exit trace logging.
 *
 * The wrapper always emits entry and exit lines at error level (so they
 * appear in stderr regardless of log configuration). When OPENSAFARI_TRACE=1
 * is set, a debug line with the full args is also emitted on entry.
 *
 * The original error is re-thrown after logging so MCP error semantics are
 * preserved.
 */
export function traceToolHandler(name: string, handler: ToolHandler): ToolHandler {
  return async function tracedHandler(
    sessionId: string,
    args: Record<string, unknown>,
  ) {
    const id = newRequestId();
    const start = Date.now();

    console.error(`[mcp] -> ${name} req=${id}`);

    if (TRACE) {
      const argsSummary = Object.entries(args)
        .map(([k, v]) => `${k}=${truncate(v)}`)
        .join(' ');
      console.error(`[mcp] args ${name} req=${id} ${argsSummary}`);
    }

    try {
      const result = await handler(sessionId, args);
      const ms = Date.now() - start;
      console.error(`[mcp] <- ${name} req=${id} ms=${ms}`);
      return result;
    } catch (err) {
      const ms = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] !! ${name} req=${id} ms=${ms} err=${message}`);
      throw err;
    }
  };
}
