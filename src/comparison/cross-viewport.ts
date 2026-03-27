import { SimulatorPool } from '../simulator/pool';
import { BatchExecutor } from '../simulator/batch';

export interface ViewportCapture {
  device: string;
  viewport: { w: number; h: number };
  breakpoint: string;
  screenshot: string;  // base64
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

export class CrossViewportCapture {
  constructor(
    private pool: SimulatorPool,
    private batch: BatchExecutor,
  ) {}

  async capture(url: string, options?: CaptureOptions): Promise<ViewportCapture[]> {
    // Navigate all devices
    await this.batch.batchNavigate(url, options?.waitUntil ?? 'load');

    // Wait for settle
    if (options?.settleTime) {
      await new Promise(r => setTimeout(r, options.settleTime));
    }

    // Capture screenshots
    const screenshots = await this.batch.batchScreenshot({ format: options?.format ?? 'png' });

    // Gather metadata
    const metadata = await this.batch.batchExecute(`
      (function() {
        return {
          title: document.title,
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
        };
      })()
    `);

    // Combine
    return screenshots.map((shot, i) => ({
      device: shot.device,
      viewport: shot.viewport,
      breakpoint: this.mapBreakpoint(shot.viewport.w),
      screenshot: shot.result ?? '',
      metadata: (metadata[i]?.result as PageMetadata) ?? null,
      error: shot.error ?? metadata[i]?.error,
      timing: shot.timing,
    }));
  }

  private mapBreakpoint(width: number): string {
    if (width < 640) return 'sm';
    if (width < 768) return 'sm';
    if (width < 1024) return 'md';
    if (width < 1280) return 'lg';
    return 'xl';
  }
}
