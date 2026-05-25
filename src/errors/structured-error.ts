/**
 * `StructuredErrorException` — Throwable carrier for the structured-error
 * metadata defined in `codes.ts`.
 *
 * Before this class, callers either threw plain `Error` (losing the
 * `code` / `recoverable` / `suggestion` fields the catalog already
 * defined) or returned ad-hoc `{ error, message }` payloads that no
 * downstream auto-retry layer could introspect. With
 * `StructuredErrorException`:
 *
 *   throw StructuredErrorException.fromCode(ErrorCode.WEBKIT_CONNECT_FAILED,
 *     `Could not reach ${host}:${port}`);
 *
 * yields an Error whose `.code`, `.recoverable`, and `.suggestion`
 * surface through `instanceof` and `toMcpResponse()` produces a stable
 * MCP tool response shape ready to return from a handler.
 */

import { ErrorCode, ERROR_CATALOG, type StructuredError } from './codes';

export interface McpToolErrorResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

export class StructuredErrorException extends Error implements StructuredError {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly suggestion: string;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = 'StructuredErrorException';
    this.code = structured.code;
    this.recoverable = structured.recoverable;
    this.suggestion = structured.suggestion;
    // Preserve V8 stack traces.
    if (typeof (Error as unknown as { captureStackTrace?: (target: object, ctor?: unknown) => void }).captureStackTrace === 'function') {
      (Error as unknown as { captureStackTrace: (target: object, ctor: unknown) => void })
        .captureStackTrace(this, StructuredErrorException);
    }
  }

  /** Build a StructuredErrorException from one of the catalog codes,
   *  layering a free-form message on top of the catalog's suggestion. */
  static fromCode(code: ErrorCode, message: string): StructuredErrorException {
    const entry = ERROR_CATALOG[code];
    return new StructuredErrorException({
      code: entry.code,
      message,
      recoverable: entry.recoverable,
      suggestion: entry.suggestion,
    });
  }

  /** Stringify into an MCP tool error response. Pass extra payload fields
   *  through `extra` to keep tool-specific diagnostics attached. */
  toMcpResponse(extra?: Record<string, unknown>): McpToolErrorResponse {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: this.code,
          message: this.message,
          recoverable: this.recoverable,
          suggestion: this.suggestion,
          ...(extra ?? {}),
        }),
      }],
      isError: true,
    };
  }

  /** Plain-object form for logging / telemetry. */
  toJSON(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      suggestion: this.suggestion,
    };
  }
}

/** Type-guard wrappers so call sites can branch on structured errors
 *  without an `instanceof` import dance. */
export function isStructuredErrorException(err: unknown): err is StructuredErrorException {
  return err instanceof StructuredErrorException;
}

/** Convert any thrown value into a typed MCP error response. Unknown
 *  errors fall back to `APP_STATE_UNKNOWN` (recoverable=true) so the
 *  caller still sees a useful suggestion. */
export function toMcpErrorResponse(
  err: unknown,
  fallbackCode: ErrorCode = ErrorCode.APP_STATE_UNKNOWN,
  extra?: Record<string, unknown>,
): McpToolErrorResponse {
  if (isStructuredErrorException(err)) {
    return err.toMcpResponse(extra);
  }
  const message = err instanceof Error ? err.message : String(err);
  return StructuredErrorException.fromCode(fallbackCode, message).toMcpResponse(extra);
}
