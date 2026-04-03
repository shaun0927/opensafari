/**
 * HybridQAEngine — Two-phase QA strategy.
 *
 * Phase A (Fast Scan): Single simulator + viewport emulation + multi-tab
 *   - Opens N tabs for N URLs, applies viewport override per device
 *   - Runs QA detectors on all tabs in parallel
 *   - Collects issues found (~2GB RAM total)
 *
 * Phase B (Deep Verify): Sequential device rotation for flagged items only
 *   - Boots actual device simulators one at a time
 *   - Verifies flagged issues on real device viewports
 *   - Classifies: confirmed vs false-positive (~2GB RAM peak)
 */

import { EventEmitter } from 'events';
import { SimulatorPool } from '../simulator/pool';
import { TabPool } from '../simulator/tab-pool';
import { WebKitClient } from '../webkit/client';
import { BrowserBackend } from '../types/browser-backend';
import { DetectorResult } from '../qa/types';
import { DEVICE_PRESETS } from '../simulator/presets';

// ── Types ──

export interface HybridQAOptions {
  urls: string[];
  devices: string[];
  detectors?: string[];
  deepVerifyThreshold?: 'critical' | 'high' | 'medium' | 'low';
  skipPhaseB?: boolean;
  authProfile?: string;
  /** When true, isolate cookies between tabs to prevent cross-tab auth state leakage (default: false) */
  isolateCookies?: boolean;
}

export interface ViewportConfig {
  preset: string;
  width: number;
  height: number;
  dpr: number;
}

export interface PageScanResult {
  url: string;
  viewport: ViewportConfig;
  detectorResults: DetectorResult[];
  issueCount: number;
  maxSeverity: string;
  emulationConfidence: 'high' | 'medium' | 'low';
}

export interface VerifiedIssue {
  url: string;
  device: string;
  detector: string;
  severity: string;
  confirmedOnDevice: boolean;
  issue: DetectorResult;
}

export interface HybridQAResult {
  id: string;
  status: 'running' | 'phase-a' | 'phase-b' | 'completed' | 'error';
  error?: string;
  phaseA: {
    duration: number;
    scans: PageScanResult[];
    totalIssues: number;
    flaggedForVerification: number;
  };
  phaseB?: {
    duration: number;
    verified: VerifiedIssue[];
    confirmedCount: number;
    falsePositiveCount: number;
  };
  totalDuration: number;
  peakMode: 'tabs-only' | 'tabs+sequential';
}

export interface HybridQAStatus {
  id: string;
  status: 'running' | 'phase-a' | 'phase-b' | 'completed' | 'error';
  error?: string;
  phasesCompleted: number;
  totalIssues: number;
  flaggedForVerification: number;
  confirmedCount: number;
  elapsed: number;
}

// ── Severity Levels (ordered) ──

const SEVERITY_ORDER: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  pass: 1,
  error: 0,
};

function meetsThreshold(severity: string, threshold: string): boolean {
  return (SEVERITY_ORDER[severity] ?? 0) >= (SEVERITY_ORDER[threshold] ?? 0);
}

// ── Default Detectors ──

const DEFAULT_DETECTORS = [
  'auto-zoom', 'touch-targets', 'hover-only', 'input-type',
  'safe-area', 'horizontal-overflow', 'vh100', 'fixed-stacking',
  'scroll-lock', 'pwa-meta',
];

// ── Emulation Confidence Scoring ──

const DETECTOR_CONFIDENCE: Record<string, 'high' | 'medium' | 'low'> = {
  'auto-zoom': 'high',
  'hover-only': 'high',
  'input-type': 'high',
  'pwa-meta': 'high',
  'horizontal-overflow': 'medium',
  'scroll-lock': 'medium',
  'fixed-stacking': 'medium',
  'touch-targets': 'low',
  'safe-area': 'low',
  'vh100': 'low',
  'orientation': 'low',
};

function getEmulationConfidence(detectorResults: DetectorResult[]): 'high' | 'medium' | 'low' {
  const confidenceLevels = detectorResults.map(r => DETECTOR_CONFIDENCE[r.detector] ?? 'medium');
  if (confidenceLevels.includes('low')) return 'low';
  if (confidenceLevels.includes('medium')) return 'medium';
  return 'high';
}

// ── Viewport Emulation ──

export async function applyViewportEmulation(
  client: BrowserBackend,
  viewport: ViewportConfig,
): Promise<void> {
  await client.evaluate(`
    (function() {
      // Override viewport meta tag
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        document.head.appendChild(meta);
      }
      meta.content = 'width=${viewport.width}, initial-scale=1';

      // Override window dimension APIs for accurate detector results
      Object.defineProperty(window, 'innerWidth', { get: function() { return ${viewport.width}; }, configurable: true });
      Object.defineProperty(window, 'innerHeight', { get: function() { return ${viewport.height}; }, configurable: true });
      Object.defineProperty(window, 'devicePixelRatio', { get: function() { return ${viewport.dpr}; }, configurable: true });
      Object.defineProperty(screen, 'width', { get: function() { return ${viewport.width * viewport.dpr}; }, configurable: true });
      Object.defineProperty(screen, 'height', { get: function() { return ${viewport.height * viewport.dpr}; }, configurable: true });

      // Store for detectors
      window.__opensafari_viewport = { width: ${viewport.width}, height: ${viewport.height}, dpr: ${viewport.dpr}, preset: ${JSON.stringify(viewport.preset)} };
    })()
  `);

  // Trigger resize event so responsive JS re-evaluates
  await client.evaluate('window.dispatchEvent(new Event("resize"))');
}

// ── HybridQAEngine ──

export class HybridQAEngine extends EventEmitter {
  private workflows: Map<string, HybridQAResult> = new Map();

  constructor(private pool: SimulatorPool) {
    super();
  }

  async start(options: HybridQAOptions): Promise<HybridQAResult> {
    const id = `hqa-${Date.now()}`;
    const threshold = options.deepVerifyThreshold ?? 'medium';
    const detectorNames = options.detectors ?? DEFAULT_DETECTORS;

    const result: HybridQAResult = {
      id,
      status: 'phase-a',
      phaseA: { duration: 0, scans: [], totalIssues: 0, flaggedForVerification: 0 },
      totalDuration: 0,
      peakMode: 'tabs-only',
    };
    this.workflows.set(id, result);
    this.emit('hybrid:started', { id });

    const overallStart = Date.now();

    // ── Phase A: Fast Scan ──
    const phaseAStart = Date.now();
    this.emit('hybrid:phase-a', { id });

    try {
      // Boot one simulator (use largest viewport device or first device)
      const hostPreset = this.selectHostDevice(options.devices);
      const [sim] = await this.pool.bootAll([hostPreset]);

      if (!sim.client.isConnected()) {
        throw new Error('WebKit connection failed for host simulator');
      }

      // Inject auth if configured
      if (options.authProfile) {
        await this.pool.injectAuth(options.authProfile);
      }

      const tabPool = new TabPool(sim.client as WebKitClient, sim.device.udid, {
        isolateCookies: options.isolateCookies,
      });
      const viewports = this.resolveViewports(options.devices);

      // For each URL × viewport combination, run QA detectors
      for (const url of options.urls) {
        for (const viewport of viewports) {
          try {
            // Open tab and apply viewport emulation
            const tab = await tabPool.openTab(url);
            await applyViewportEmulation(tab, viewport);

            // Wait for page to settle
            await new Promise(r => setTimeout(r, 1000));

            // Run detectors
            const detectorResults = await this.runDetectors(tab, detectorNames);
            const issueCount = detectorResults.reduce((sum, r) => sum + r.issueCount, 0);
            const maxSeverity = this.getMaxSeverity(detectorResults);

            const confidence = getEmulationConfidence(detectorResults);
            const scan: PageScanResult = { url, viewport, detectorResults, issueCount, maxSeverity, emulationConfidence: confidence };
            result.phaseA.scans.push(scan);
            result.phaseA.totalIssues += issueCount;

            if ((issueCount > 0 && meetsThreshold(maxSeverity, threshold)) || confidence === 'low') {
              result.phaseA.flaggedForVerification++;
            }

            this.emit('hybrid:scan-complete', { id, url, viewport: viewport.preset, issueCount });
          } catch (err) {
            console.error(`[HybridQA] Phase A scan failed for ${url} @ ${viewport.preset}: ${err}`);
            result.phaseA.scans.push({
              url,
              viewport,
              detectorResults: [{
                detector: 'error',
                severity: 'error',
                issues: [],
                passed: false,
                totalScanned: 0,
                issueCount: 0,
                error: String(err),
              }],
              issueCount: 0,
              maxSeverity: 'error',
              emulationConfidence: 'low',
            });
          }
        }
      }

      // Cleanup Phase A tabs and simulator
      await tabPool.closeAll();
      await this.pool.shutdownAll();

    } catch (err) {
      console.error(`[HybridQA] Phase A failed: ${err}`);
      result.status = 'error';
      result.error = `Phase A failed: ${err}`;
    }

    result.phaseA.duration = Date.now() - phaseAStart;
    this.emit('hybrid:phase-a-complete', { id, duration: result.phaseA.duration, issues: result.phaseA.totalIssues });

    // ── Phase B: Deep Verify (conditional) ──
    if (!options.skipPhaseB && result.phaseA.flaggedForVerification > 0) {
      result.status = 'phase-b';
      result.peakMode = 'tabs+sequential';
      this.emit('hybrid:phase-b', { id });

      const phaseBStart = Date.now();
      const verified: VerifiedIssue[] = [];

      // Collect flagged (url, device) pairs
      const flaggedPairs = result.phaseA.scans
        .filter(s => (s.issueCount > 0 && meetsThreshold(s.maxSeverity, threshold)) || s.emulationConfidence === 'low')
        .map(s => ({ url: s.url, device: s.viewport.preset, issues: s.detectorResults.filter(d => !d.passed) }));

      // Group by device for sequential execution
      const byDevice = new Map<string, typeof flaggedPairs>();
      for (const pair of flaggedPairs) {
        const existing = byDevice.get(pair.device) ?? [];
        existing.push(pair);
        byDevice.set(pair.device, existing);
      }

      // Sequential verification per device
      const devicesToVerify = Array.from(byDevice.keys());

      // If an auth profile was used in Phase A, seed the first Phase B device with it
      if (options.authProfile) {
        const { AuthManager } = await import('../auth/manager');
        const authManager = new AuthManager();
        try {
          const profile = await authManager.loadProfile(options.authProfile);
          this.pool.setTempAuth(id, profile.cookies, profile.localStorage ?? {});
        } catch (err) {
          console.error(`[HybridQA] Failed to seed auth for Phase B: ${err}`);
        }
      }

      try {
        await this.pool.bootSequential(devicesToVerify, async (sim, preset) => {
          // Restore auth state from previous device (if any)
          if (sim.client.isConnected()) {
            await this.pool.restoreTempAuth(id, sim.client);
          }

          const pairs = byDevice.get(preset) ?? [];

          for (const pair of pairs) {
            if (!sim.client.isConnected()) continue;

            try {
              await sim.client.navigate({ url: pair.url });
              await new Promise(r => setTimeout(r, 1000));

              // Re-run only the detectors that found issues
              const detectorsToVerify = pair.issues.map(i => i.detector);
              const verifyResults = await this.runDetectors(sim.client, detectorsToVerify);

              for (const original of pair.issues) {
                const verified_result = verifyResults.find(v => v.detector === original.detector);
                const confirmed = verified_result ? !verified_result.passed : false;

                verified.push({
                  url: pair.url,
                  device: preset,
                  detector: original.detector,
                  severity: original.severity,
                  confirmedOnDevice: confirmed,
                  issue: verified_result ?? original,
                });
              }
            } catch (err) {
              console.error(`[HybridQA] Phase B verify failed for ${pair.url} @ ${preset}: ${err}`);
            }
          }

          // Save auth state for next device in sequence
          if (sim.client.isConnected()) {
            await this.pool.saveTempAuth(id, sim.client);
          }
        });

        result.phaseB = {
          duration: Date.now() - phaseBStart,
          verified,
          confirmedCount: verified.filter(v => v.confirmedOnDevice).length,
          falsePositiveCount: verified.filter(v => !v.confirmedOnDevice).length,
        };

        this.emit('hybrid:phase-b-complete', {
          id,
          duration: result.phaseB.duration,
          confirmed: result.phaseB.confirmedCount,
          falsePositives: result.phaseB.falsePositiveCount,
        });
      } catch (err) {
        result.status = 'error';
        result.error = `Phase B failed: ${(err as Error).message}`;
        console.error(`[HybridQA] Phase B error: ${err}`);
      }

      // Clean up temp auth state now that Phase B is complete
      this.pool.clearTempAuth(id);
    }

    if (result.status !== 'error') {
      result.status = 'completed';
    }
    result.totalDuration = Date.now() - overallStart;
    this.workflows.set(id, result);
    this.emit('hybrid:completed', { id, totalDuration: result.totalDuration });

    return result;
  }

  getStatus(id: string): HybridQAStatus | null {
    const w = this.workflows.get(id);
    if (!w) return null;
    return {
      id: w.id,
      status: w.status,
      error: w.error,
      phasesCompleted: w.phaseB ? 2 : w.phaseA.scans.length > 0 ? 1 : 0,
      totalIssues: w.phaseA.totalIssues,
      flaggedForVerification: w.phaseA.flaggedForVerification,
      confirmedCount: w.phaseB?.confirmedCount ?? 0,
      elapsed: w.totalDuration,
    };
  }

  getResults(id: string): HybridQAResult | null {
    return this.workflows.get(id) ?? null;
  }

  // ── Private Helpers ──

  private selectHostDevice(devices: string[]): string {
    // Pick the largest viewport device as host (best for viewport emulation)
    let best = devices[0];
    let bestArea = 0;
    for (const d of devices) {
      const preset = DEVICE_PRESETS[d];
      if (preset) {
        const area = preset.w * preset.h;
        if (area > bestArea) {
          bestArea = area;
          best = d;
        }
      }
    }
    return best;
  }

  private resolveViewports(devices: string[]): ViewportConfig[] {
    return devices.map(d => {
      const preset = DEVICE_PRESETS[d];
      return {
        preset: d,
        width: preset?.w ?? 390,
        height: preset?.h ?? 844,
        dpr: preset?.dpr ?? 3,
      };
    });
  }

  private getMaxSeverity(results: DetectorResult[]): string {
    let max = 'pass';
    for (const r of results) {
      if ((SEVERITY_ORDER[r.severity] ?? 0) > (SEVERITY_ORDER[max] ?? 0)) {
        max = r.severity;
      }
    }
    return max;
  }

  private async runDetectors(
    client: BrowserBackend,
    detectorNames: string[],
  ): Promise<DetectorResult[]> {
    const results: DetectorResult[] = [];

    for (const name of detectorNames) {
      try {
        const mod = await import(`../qa/detectors/${name}.js`);
        // Find the detector function (detect* pattern)
        const fnName = Object.keys(mod).find(k => k.startsWith('detect'));
        if (!fnName) continue;
        const result = await mod[fnName](client);
        results.push(result);
      } catch (err) {
        results.push({
          detector: name,
          severity: 'error',
          issues: [],
          passed: false,
          totalScanned: 0,
          issueCount: 0,
          error: `Failed to run ${name}: ${err}`,
        });
      }
    }

    return results;
  }
}
