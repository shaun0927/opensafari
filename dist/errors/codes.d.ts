export declare enum ErrorCode {
    SIM_BOOT_FAILED = "SIM_BOOT_FAILED",
    SIM_CRASH = "SIM_CRASH",
    SIM_SHUTDOWN_FAILED = "SIM_SHUTDOWN_FAILED",
    SAFARI_TIMEOUT = "SAFARI_TIMEOUT",
    SAFARI_CRASH = "SAFARI_CRASH",
    AUTH_EXPIRED = "AUTH_EXPIRED",
    RESOURCE_EXHAUSTED = "RESOURCE_EXHAUSTED",
    XCODE_NOT_FOUND = "XCODE_NOT_FOUND",
    WEBKIT_CONNECT_FAILED = "WEBKIT_CONNECT_FAILED",
    WEBKIT_PROTOCOL_ERROR = "WEBKIT_PROTOCOL_ERROR"
}
export interface StructuredError {
    code: ErrorCode;
    message: string;
    recoverable: boolean;
    suggestion: string;
}
export declare const ERROR_CATALOG: Record<ErrorCode, Omit<StructuredError, 'message'>>;
//# sourceMappingURL=codes.d.ts.map