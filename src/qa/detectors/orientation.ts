import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';
import { SimulatorManager } from '../../simulator/manager';

export async function detectOrientation(client: BrowserBackend, simulator?: SimulatorManager, deviceId?: string): Promise<DetectorResult> {
  const portraitMeta = await client.evaluate<{ scrollWidth: number; innerWidth: number; overflow: boolean }>(`({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth
  })`);

  const issues: Array<{ selector: string; problem: string; fix: string }> = [];

  // Try rotation
  if (simulator && deviceId) {
    try {
      await simulator.rotate(deviceId);
      await new Promise(r => setTimeout(r, 1000));

      const landscapeMeta = await client.evaluate<{ scrollWidth: number; innerWidth: number; overflow: boolean }>(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth
      })`);

      if (landscapeMeta.overflow) {
        issues.push({
          selector: 'document.documentElement',
          problem: `Horizontal overflow in landscape (scrollWidth: ${landscapeMeta.scrollWidth}px, viewport: ${landscapeMeta.innerWidth}px)`,
          fix: 'Ensure responsive layout handles landscape orientation',
        });
      }

      await simulator.rotate(deviceId); // rotate back
    } catch {
      // Rotation not available
    }
  }

  return {
    detector: 'orientation',
    severity: issues.length > 0 ? 'medium' : 'pass',
    issues,
    passed: issues.length === 0,
    totalScanned: 1,
    issueCount: issues.length,
    metadata: { portrait: portraitMeta },
  };
}
