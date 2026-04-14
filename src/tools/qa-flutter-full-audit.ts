/**
 * qa_flutter_full_audit — Orchestrator that runs all Flutter QA detectors
 * and produces a unified report with weighted scoring.
 *
 * Checks: touch targets, semantics coverage, dark mode support.
 * Returns aggregated pass/fail with per-detector details and total score.
 */

import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = [
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab',
];

/** Includes AXImage for semantics check (same as qa_flutter_semantics) */
const SEMANTICS_ROLES = [...INTERACTIVE_ROLES, 'AXImage'];

const DEFAULT_MIN_SIZE = 48;
const DEFAULT_MIN_COVERAGE = 80;

const SEVERITY_WEIGHTS: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface DetectorResult {
  detector: string;
  passed: boolean;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  details: Record<string, unknown>;
  error?: string;
}

interface TouchTargetViolation {
  role: string;
  label?: string;
  identifier?: string;
  path: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

interface SemanticsIssue {
  role: string;
  path: string;
  frame: { x: number; y: number; width: number; height: number };
  issue: string;
}

// ── Internal detector functions ────────────────────────────────────────────────

function isInteractive(node: AXNode): boolean {
  return INTERACTIVE_ROLES.some(
    (r) => node.role === r || node.role === r.replace('AX', ''),
  );
}

function isSemanticsRelevant(node: AXNode): boolean {
  return SEMANTICS_ROLES.some(
    (r) => node.role === r || node.role === r.replace('AX', ''),
  );
}

/**
 * Check touch targets against the minimum size requirement.
 * Walks the accessibility tree and flags interactive elements with
 * frame dimensions smaller than minSize.
 */
export function checkTouchTargets(tree: AXNode, minSize: number): DetectorResult {
  const violations: TouchTargetViolation[] = [];
  let totalInteractive = 0;

  function walk(node: AXNode): void {
    if (isInteractive(node) && node.visible) {
      totalInteractive++;
      const { width, height } = node.frame;
      const issues: string[] = [];

      if (width > 0 && width < minSize) {
        issues.push(`width ${Math.round(width)}dp < ${minSize}dp`);
      }
      if (height > 0 && height < minSize) {
        issues.push(`height ${Math.round(height)}dp < ${minSize}dp`);
      }

      if (issues.length > 0) {
        violations.push({
          role: node.role,
          label: node.label,
          identifier: node.identifier,
          path: node.path,
          frame: node.frame,
          issue: issues.join(', '),
        });
      }
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }

  walk(tree);
  const passed = violations.length === 0;

  return {
    detector: 'touch_targets',
    passed,
    severity: 'high',
    summary: passed
      ? `All ${totalInteractive} interactive elements meet ${minSize}dp minimum.`
      : `${violations.length} of ${totalInteractive} interactive elements are smaller than ${minSize}dp.`,
    details: {
      min_size: minSize,
      total_interactive: totalInteractive,
      violations_count: violations.length,
      violations: violations.slice(0, 20),
    },
  };
}

/**
 * Check semantics/accessibility coverage.
 * Counts interactive elements and checks how many have accessibility labels.
 */
export function checkSemantics(tree: AXNode, minCoverage: number): DetectorResult {
  const issues: SemanticsIssue[] = [];
  let totalInteractive = 0;
  let labeled = 0;
  let withIdentifier = 0;

  function walk(node: AXNode): void {
    if (isSemanticsRelevant(node) && node.visible) {
      totalInteractive++;
      const hasLabel = !!(node.label && node.label.trim().length > 0);
      const hasIdentifier = !!(node.identifier && node.identifier.trim().length > 0);

      if (hasLabel) labeled++;
      if (hasIdentifier) withIdentifier++;

      if (!hasLabel && !hasIdentifier) {
        issues.push({
          role: node.role,
          path: node.path,
          frame: node.frame,
          issue: 'Missing both accessibility label and identifier',
        });
      } else if (!hasLabel) {
        issues.push({
          role: node.role,
          path: node.path,
          frame: node.frame,
          issue: 'Missing accessibility label (has identifier only)',
        });
      }
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }

  walk(tree);

  const coverage = totalInteractive > 0
    ? Math.round((labeled / totalInteractive) * 100)
    : 100;
  const identifierCoverage = totalInteractive > 0
    ? Math.round((withIdentifier / totalInteractive) * 100)
    : 100;
  const passed = coverage >= minCoverage;

  return {
    detector: 'semantics',
    passed,
    severity: 'high',
    summary: passed
      ? `Semantics coverage: ${coverage}% (${labeled}/${totalInteractive} elements labeled). Meets ${minCoverage}% threshold.`
      : `Semantics coverage: ${coverage}% (${labeled}/${totalInteractive} elements labeled). Below ${minCoverage}% threshold.`,
    details: {
      coverage_percent: coverage,
      identifier_coverage_percent: identifierCoverage,
      min_coverage: minCoverage,
      total_interactive: totalInteractive,
      labeled,
      with_identifier: withIdentifier,
      issues_count: issues.length,
      issues: issues.slice(0, 20),
    },
  };
}

/**
 * Check dark mode support by comparing screenshots in light vs dark mode.
 * Uses simctl to toggle appearance and compare screenshot file sizes.
 */
export async function checkDarkMode(deviceId: string): Promise<DetectorResult> {
  const simctl = new SimctlExecutor();
  const tmpDir = os.tmpdir();

  // Get current appearance
  let originalAppearance: 'light' | 'dark' = 'light';
  try {
    const currentAppearance = await simctl.exec(['ui', deviceId, 'appearance']);
    if (currentAppearance.trim().toLowerCase().includes('dark')) {
      originalAppearance = 'dark';
    }
  } catch {
    // Default to light if can't determine
  }

  // Set light mode and screenshot
  await simctl.exec(['ui', deviceId, 'appearance', 'light']);
  await sleep(1500);
  const lightPath = path.join(tmpDir, `opensafari-qa-audit-light-${deviceId}.png`);
  await simctl.exec(['io', deviceId, 'screenshot', lightPath]);
  const lightSize = getFileSize(lightPath);

  // Set dark mode and screenshot
  await simctl.exec(['ui', deviceId, 'appearance', 'dark']);
  await sleep(1500);
  const darkPath = path.join(tmpDir, `opensafari-qa-audit-dark-${deviceId}.png`);
  await simctl.exec(['io', deviceId, 'screenshot', darkPath]);
  const darkSize = getFileSize(darkPath);

  // Restore original appearance
  await simctl.exec(['ui', deviceId, 'appearance', originalAppearance]);

  // Clean up temp files
  try { fs.unlinkSync(lightPath); } catch { /* ignore */ }
  try { fs.unlinkSync(darkPath); } catch { /* ignore */ }

  // Compare file sizes as proxy for visual difference
  const sizeDiff = Math.abs(lightSize - darkSize);
  const sizeDiffPercent = lightSize > 0
    ? Math.round((sizeDiff / lightSize) * 100)
    : 0;
  const respondsToDarkMode = sizeDiffPercent > 2;

  return {
    detector: 'dark_mode',
    passed: respondsToDarkMode,
    severity: 'medium',
    summary: respondsToDarkMode
      ? `App responds to dark mode. Screenshot size diff: ${sizeDiffPercent}%.`
      : `App may not respond to dark mode. Screenshot size diff: ${sizeDiffPercent}% (below 2% threshold).`,
    details: {
      responds_to_dark_mode: respondsToDarkMode,
      light_screenshot_size: lightSize,
      dark_screenshot_size: darkSize,
      size_diff_percent: sizeDiffPercent,
      original_appearance: originalAppearance,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Registration ───────────────────────────────────────────────────────────────

export function registerQaFlutterFullAuditTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_full_audit',
      description:
        'Run all Flutter QA detectors and produce a unified report. Checks touch targets, ' +
        'semantics coverage, and dark mode support. Returns aggregated pass/fail with weighted score.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          min_size: {
            type: 'number',
            description: 'Min tap target size for touch check (default: 48)',
          },
          min_coverage: {
            type: 'number',
            description: 'Min semantics coverage percentage (default: 80)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }

        const minSize = (params.min_size as number | undefined) ?? DEFAULT_MIN_SIZE;
        const minCoverage = (params.min_coverage as number | undefined) ?? DEFAULT_MIN_COVERAGE;

        // Run detectors in parallel:
        //   Group 1: tree-based checks (share one tree dump)
        //   Group 2: dark mode check (independent, uses simctl)
        const results = await Promise.allSettled([
          (async (): Promise<DetectorResult[]> => {
            const bridge = getAccessibilityBridge();
            const tree = await bridge.dumpTree({ deviceId, maxDepth: 15 });
            return [
              checkTouchTargets(tree, minSize),
              checkSemantics(tree, minCoverage),
            ];
          })(),
          checkDarkMode(deviceId),
        ]);

        // Flatten results, handling failures gracefully
        const detectorResults: DetectorResult[] = [];

        // Handle tree-based checks (touch_targets + semantics)
        if (results[0].status === 'fulfilled') {
          detectorResults.push(...results[0].value);
        } else {
          // Both tree-based detectors failed
          const errorMsg = results[0].reason instanceof Error
            ? results[0].reason.message
            : String(results[0].reason);
          detectorResults.push({
            detector: 'touch_targets',
            passed: false,
            severity: 'high',
            summary: `Detector failed: ${errorMsg}`,
            details: {},
            error: errorMsg,
          });
          detectorResults.push({
            detector: 'semantics',
            passed: false,
            severity: 'high',
            summary: `Detector failed: ${errorMsg}`,
            details: {},
            error: errorMsg,
          });
        }

        // Handle dark mode check
        if (results[1].status === 'fulfilled') {
          detectorResults.push(results[1].value);
        } else {
          const errorMsg = results[1].reason instanceof Error
            ? results[1].reason.message
            : String(results[1].reason);
          detectorResults.push({
            detector: 'dark_mode',
            passed: false,
            severity: 'medium',
            summary: `Detector failed: ${errorMsg}`,
            details: {},
            error: errorMsg,
          });
        }

        // Calculate weighted score
        let totalWeight = 0;
        let passedWeight = 0;
        let passedCount = 0;
        let errorCount = 0;

        for (const r of detectorResults) {
          const w = SEVERITY_WEIGHTS[r.severity] ?? 1;
          totalWeight += w;
          if (r.passed) {
            passedWeight += w;
            passedCount++;
          }
          if (r.error) errorCount++;
        }

        const score = totalWeight > 0
          ? Math.round((passedWeight / totalWeight) * 100)
          : 0;
        const allPassed = detectorResults.every((r) => r.passed);
        const failedCount = detectorResults.length - passedCount;

        const report = {
          detector: 'qa_flutter_full_audit',
          passed: allPassed,
          score,
          total_detectors: detectorResults.length,
          passed_count: passedCount,
          failed_count: failedCount,
          error_count: errorCount,
          results: detectorResults,
          summary: `Flutter QA Audit: ${score}/100 (${passedCount}/${detectorResults.length} detectors passed)`,
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(report, null, 2),
          }],
          isError: score < 70 || !allPassed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_full_audit] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
