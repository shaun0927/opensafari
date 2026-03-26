import { SimulatorPool } from './pool';
import { NavigateResult, ScreenshotOptions } from '../types/browser-backend';
export interface BatchResult<T> {
    device: string;
    deviceId: string;
    viewport: {
        w: number;
        h: number;
    };
    result?: T;
    error?: string;
    timing: number;
}
export declare class BatchExecutor {
    private pool;
    constructor(pool: SimulatorPool);
    private executeOnAll;
    batchNavigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<BatchResult<NavigateResult>[]>;
    batchScreenshot(options?: ScreenshotOptions): Promise<BatchResult<string>[]>;
    batchExecute(expression: string): Promise<BatchResult<unknown>[]>;
}
//# sourceMappingURL=batch.d.ts.map