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
  let rotationTested = false;
  let rotationMethod = 'none';

  if (simulator && deviceId) {
    try {
      const result = await simulator.rotate(deviceId, 'left');
      if (result.success) {
        rotationTested = true;
        rotationMethod = result.method;
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

        // Rotate back
        await simulator.rotate(deviceId, 'right');
      }
    } catch {
      // Rotation not available
    }
  }

  // If rotation was not tested, report as warning instead of pass
  if (!rotationTested && simulator && deviceId) {
    return {
      detector: 'orientation',
      severity: 'warning',
      issues: [{
        selector: 'document.documentElement',
        problem: 'Device rotation unavailable — orientation not tested',
        fix: 'Run on a machine with Xcode Simulator GUI or use simctl io setorientation',
      }],
      passed: false,
      totalScanned: 1,
      issueCount: 1,
      metadata: { portrait: portraitMeta, rotationMethod: 'none', rotationTested: false },
    };
  }

  return {
    detector: 'orientation',
    severity: issues.length > 0 ? 'medium' : 'pass',
    issues,
    passed: issues.length === 0,
    totalScanned: 1,
    issueCount: issues.length,
    metadata: { portrait: portraitMeta, rotationMethod, rotationTested },
  };
}
