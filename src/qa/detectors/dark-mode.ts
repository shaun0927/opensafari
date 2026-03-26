import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';
import { SimulatorManager } from '../../simulator/manager';

export async function detectDarkMode(client: BrowserBackend, simulator?: SimulatorManager, deviceId?: string): Promise<DetectorResult> {
  const colorScheme = await client.evaluate<string>(`
    (document.querySelector('meta[name="color-scheme"]') || {}).content || 'not set'
  `);

  const issues: Array<{ selector: string; problem: string; fix: string }> = [];

  if (colorScheme === 'not set') {
    issues.push({
      selector: 'head',
      problem: 'No <meta name="color-scheme"> tag — browser may apply forced dark mode',
      fix: 'Add <meta name="color-scheme" content="light only"> or implement proper dark mode',
    });
  }

  // Toggle dark mode if simulator available
  let lightScreenshot: string | undefined;
  let darkScreenshot: string | undefined;

  if (simulator && deviceId) {
    try {
      await simulator.setAppearance(deviceId, 'light');
      await new Promise(r => setTimeout(r, 500));
      const lightBuf = await client.screenshot();
      lightScreenshot = lightBuf.toString('base64');

      await simulator.setAppearance(deviceId, 'dark');
      await new Promise(r => setTimeout(r, 500));
      const darkBuf = await client.screenshot();
      darkScreenshot = darkBuf.toString('base64');

      await simulator.setAppearance(deviceId, 'light');
    } catch {
      // Simulator not available
    }
  }

  return {
    detector: 'dark_mode',
    severity: issues.length > 0 ? 'medium' : 'pass',
    issues,
    passed: issues.length === 0,
    totalScanned: 1,
    issueCount: issues.length,
    metadata: {
      colorScheme,
      ...(lightScreenshot ? { lightScreenshot, darkScreenshot, note: 'Compare screenshots visually' } : {}),
    },
  };
}
