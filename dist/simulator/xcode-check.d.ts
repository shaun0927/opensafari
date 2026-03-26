export interface XcodeCheckResult {
    installed: boolean;
    version?: string;
    simulatorAvailable: boolean;
    iosRuntimes: string[];
    issues: string[];
    suggestions: string[];
}
export declare function checkXcodeInstallation(): Promise<XcodeCheckResult>;
//# sourceMappingURL=xcode-check.d.ts.map