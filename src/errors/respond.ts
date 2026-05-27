/**
 * `respondWithStructuredError` — one-line helper for MCP tool handlers.
 *
 * Replaces ad-hoc envelopes like:
 *
 *   return { content: [{ type: 'text', text: JSON.stringify({ error: 'INVALID_X', message }) }], isError: true };
 *
 * with the catalog-backed form:
 *
 *   return respondWithStructuredError(ErrorCode.INVALID_INPUT, message, { extra: 1 });
 *
 * so every tool emits a stable shape that downstream auto-retry layers
 * can introspect via `recoverable` / `suggestion`.
 */

import { ErrorCode } from './codes';
import { StructuredErrorException, type McpToolErrorResponse } from './structured-error';

export function respondWithStructuredError(
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): McpToolErrorResponse {
  return StructuredErrorException.fromCode(code, message).toMcpResponse(extra);
}
