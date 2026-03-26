export declare class SimctlExecutor {
    exec(args: string[], options?: {
        timeout?: number;
    }): Promise<string>;
    execJson<T>(args: string[]): Promise<T>;
}
export declare class SimctlError extends Error {
    readonly args: string[];
    readonly exitCode?: number | undefined;
    constructor(message: string, args: string[], exitCode?: number | undefined);
}
//# sourceMappingURL=simctl.d.ts.map