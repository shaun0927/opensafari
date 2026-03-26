import { SimulatorPool } from '../simulator/pool';
import { BatchExecutor } from '../simulator/batch';
export interface ViewportCapture {
    device: string;
    viewport: {
        w: number;
        h: number;
    };
    breakpoint: string;
    screenshot: string;
    metadata: PageMetadata | null;
    error?: string;
    timing: number;
}
export interface PageMetadata {
    title: string;
    scrollHeight: number;
    scrollWidth: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    hasHorizontalOverflow: boolean;
}
export interface CaptureOptions {
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    settleTime?: number;
    format?: 'png';
}
export declare class CrossViewportCapture {
    private pool;
    private batch;
    constructor(pool: SimulatorPool, batch: BatchExecutor);
    capture(url: string, options?: CaptureOptions): Promise<ViewportCapture[]>;
    private mapBreakpoint;
}
//# sourceMappingURL=cross-viewport.d.ts.map