export { OpenSafariTimeoutError, isTimeoutError } from './timeout';
export { ErrorCode, ERROR_CATALOG } from './codes';
export type { StructuredError } from './codes';
export {
  StructuredErrorException,
  isStructuredErrorException,
  toMcpErrorResponse,
} from './structured-error';
export type { McpToolErrorResponse } from './structured-error';
export { respondWithStructuredError } from './respond';
