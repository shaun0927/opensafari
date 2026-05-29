/**
 * qa_flutter_dark_mode — Check dark mode rendering for Flutter/native apps.
 *
 * Takes screenshots in both light and dark mode, dumps the accessibility tree
 * in both modes, and reports differences. Returns screenshots as base64 image
 * content alongside structured diff information.
 */

import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

interface DarkModeIssue {
  type:
    | 'element_missing_in_dark'
    | 'element_missing_in_light'
    | 'element_count_mismatch'
    | 'frame_changed'
    | 'text_count_diff'
    | 'no_response_to_dark_mode';
  role?: string;
  label?: string;
  path?: string;
  light_frame?: { x: number; y: number; width: number; height: number };
  dark_frame?: { x: number; y: number; width: number; height: number };
  detail: string;
}

export function registerQaFlutterDarkModeTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_dark_mode',
      description:
        'Check dark mode rendering for a Flutter/native app. Takes screenshots and accessibility ' +
        'tree snapshots in both light and dark mode, returns both screenshots as images, and reports ' +
        'element-level differences (missing elements, frame changes) plus overall responsiveness. ' +
        'Restores the original appearance after check.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          settle_time: {
            type: 'number',
            description: 'Time in ms to wait after appearance change for UI to settle (default: 1500)',
          },
          return_screenshots: {
            type: 'boolean',
            description: 'Return light/dark screenshots as base64 image content (default: true)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const simctl = new SimctlExecutor();
      const tmpDir = os.tmpdir();
      let lightPath: string | null = null;
      let darkPath: string | null = null;
      let originalAppearance: 'light' | 'dark' = 'light';
      let restoredOriginal = false;
      let deviceIdForRestore: string | null = null;

      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error('No device specified and no active device.');
        }
        deviceIdForRestore = deviceId;

        const settleTime = (params.settle_time as number | undefined) ?? 1500;
        const returnScreenshots = (params.return_screenshots as boolean | undefined) ?? true;

        // Detect current appearance so we can restore it after the check.
        try {
          const currentAppearance = await simctl.exec(['ui', deviceId, 'appearance']);
          if (currentAppearance.trim().toLowerCase().includes('dark')) {
            originalAppearance = 'dark';
          }
        } catch {
          // Default to 'light' if unknown.
        }

        const bridge = getAccessibilityBridge();

        // --- Light mode capture ---
        await simctl.exec(['ui', deviceId, 'appearance', 'light']);
        await sleep(settleTime);
        lightPath = path.join(tmpDir, `opensafari-qa-light-${deviceId}.png`);
        await simctl.exec(['io', deviceId, 'screenshot', lightPath]);
        const lightSize = getFileSize(lightPath);
        const lightTree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        // --- Dark mode capture ---
        await simctl.exec(['ui', deviceId, 'appearance', 'dark']);
        await sleep(settleTime);
        darkPath = path.join(tmpDir, `opensafari-qa-dark-${deviceId}.png`);
        await simctl.exec(['io', deviceId, 'screenshot', darkPath]);
        const darkSize = getFileSize(darkPath);
        const darkTree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        // Restore original appearance before further work.
        await simctl.exec(['ui', deviceId, 'appearance', originalAppearance]);
        restoredOriginal = true;

        // --- File size proxy for overall responsiveness ---
        const sizeDiff = Math.abs(lightSize - darkSize);
        const sizeDiffPercent = lightSize > 0
          ? Math.round((sizeDiff / lightSize) * 100)
          : 0;
        const respondsToDarkMode = sizeDiffPercent > 2;

        // --- Element-level tree comparison ---
        const lightElements = indexByPath(lightTree);
        const darkElements = indexByPath(darkTree);

        const issues: DarkModeIssue[] = [];

        // Missing elements in dark mode (present in light, absent in dark)
        for (const [elPath, lightNode] of lightElements) {
          if (!darkElements.has(elPath) && lightNode.visible) {
            issues.push({
              type: 'element_missing_in_dark',
              role: lightNode.role,
              label: lightNode.label,
              path: elPath,
              light_frame: lightNode.frame,
              detail: `Element present in light mode is missing in dark mode — may indicate invisible text or hidden background.`,
            });
          }
        }

        // Elements that appeared only in dark mode (rare, but worth noting).
        for (const [elPath, darkNode] of darkElements) {
          if (!lightElements.has(elPath) && darkNode.visible) {
            issues.push({
              type: 'element_missing_in_light',
              role: darkNode.role,
              label: darkNode.label,
              path: elPath,
              dark_frame: darkNode.frame,
              detail: `Element appears only in dark mode.`,
            });
          }
        }

        // Frames that shifted significantly between modes.
        for (const [elPath, lightNode] of lightElements) {
          const darkNode = darkElements.get(elPath);
          if (!darkNode || !lightNode.visible || !darkNode.visible) continue;
          if (framesDiffer(lightNode.frame, darkNode.frame, 8)) {
            issues.push({
              type: 'frame_changed',
              role: lightNode.role,
              label: lightNode.label,
              path: elPath,
              light_frame: lightNode.frame,
              dark_frame: darkNode.frame,
              detail: `Frame changed between light and dark modes — may indicate layout drift.`,
            });
          }
        }

        // Static text count difference (hint at invisible text).
        const lightTextCount = countRole(lightTree, 'AXStaticText');
        const darkTextCount = countRole(darkTree, 'AXStaticText');
        if (lightTextCount !== darkTextCount) {
          issues.push({
            type: 'text_count_diff',
            detail: `Text element count differs: ${lightTextCount} (light) vs ${darkTextCount} (dark).`,
          });
        }

        // Visible interactive count mismatch.
        const lightInteractive = countInteractive(lightTree);
        const darkInteractive = countInteractive(darkTree);
        if (lightInteractive !== darkInteractive) {
          issues.push({
            type: 'element_count_mismatch',
            detail: `Visible interactive element count differs: ${lightInteractive} (light) vs ${darkInteractive} (dark).`,
          });
        }

        // Overall responsiveness warning.
        if (!respondsToDarkMode) {
          issues.push({
            type: 'no_response_to_dark_mode',
            detail: `Screenshot size diff is ${sizeDiffPercent}% (threshold: >2%). App likely does not adapt to dark mode — text colors and backgrounds may not be switching, which can render content invisible.`,
          });
        }

        // Pass if app responds to dark mode AND no missing-in-dark elements.
        const missingInDarkCount = issues.filter((i) => i.type === 'element_missing_in_dark').length;
        const passed = respondsToDarkMode && missingInDarkCount === 0;

        const resultText = JSON.stringify({
          detector: 'qa_flutter_dark_mode',
          passed,
          responds_to_dark_mode: respondsToDarkMode,
          light_screenshot_size: lightSize,
          dark_screenshot_size: darkSize,
          size_diff_percent: sizeDiffPercent,
          original_appearance: originalAppearance,
          light_element_count: lightElements.size,
          dark_element_count: darkElements.size,
          light_interactive_count: lightInteractive,
          dark_interactive_count: darkInteractive,
          light_text_count: lightTextCount,
          dark_text_count: darkTextCount,
          issues_count: issues.length,
          issues: issues.slice(0, 50),
          summary: passed
            ? `Dark mode OK — app adapts (${sizeDiffPercent}% visual diff), no elements lost.`
            : `Dark mode issues: ${issues.length} finding(s). ${missingInDarkCount} element(s) missing in dark mode.`,
        }, null, 2);

        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text' as const, text: resultText }];

        if (returnScreenshots) {
          try {
            const lightBase64 = fs.readFileSync(lightPath).toString('base64');
            content.push({
              type: 'image' as const,
              data: lightBase64,
              mimeType: 'image/png',
            });
          } catch (err) {
            console.error(`[qa_flutter_dark_mode] failed to read light screenshot: ${err}`);
          }
          try {
            const darkBase64 = fs.readFileSync(darkPath).toString('base64');
            content.push({
              type: 'image' as const,
              data: darkBase64,
              mimeType: 'image/png',
            });
          } catch (err) {
            console.error(`[qa_flutter_dark_mode] failed to read dark screenshot: ${err}`);
          }
        }

        // Clean up temp files after encoding.
        if (lightPath) { try { fs.unlinkSync(lightPath); } catch { /* ignore */ } }
        if (darkPath) { try { fs.unlinkSync(darkPath); } catch { /* ignore */ } }

        return { content, isError: !passed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_dark_mode] ${message}`);

        // Best-effort restore of original appearance on error.
        if (!restoredOriginal && deviceIdForRestore) {
          try {
            await simctl.exec(['ui', deviceIdForRestore, 'appearance', originalAppearance]);
          } catch { /* ignore */ }
        }
        if (lightPath) { try { fs.unlinkSync(lightPath); } catch { /* ignore */ } }
        if (darkPath) { try { fs.unlinkSync(darkPath); } catch { /* ignore */ } }

        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}

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

function indexByPath(root: AXNode): Map<string, AXNode> {
  const map = new Map<string, AXNode>();
  function walk(node: AXNode): void {
    if (node.path !== undefined) map.set(node.path, node);
    if (node.children) {
      for (const c of node.children) walk(c);
    }
  }
  walk(root);
  return map;
}

function countRole(root: AXNode, role: string): number {
  let n = 0;
  function walk(node: AXNode): void {
    if (node.role === role && node.visible) n++;
    if (node.children) for (const c of node.children) walk(c);
  }
  walk(root);
  return n;
}

const INTERACTIVE_ROLES = new Set([
  'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
  'AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXSlider',
  'AXPopUpButton', 'AXMenuItem', 'AXTab',
]);

function countInteractive(root: AXNode): number {
  let n = 0;
  function walk(node: AXNode): void {
    if (INTERACTIVE_ROLES.has(node.role) && node.visible) n++;
    if (node.children) for (const c of node.children) walk(c);
  }
  walk(root);
  return n;
}

function framesDiffer(
  a: { x: number; y: number; width: number; height: number } | undefined,
  b: { x: number; y: number; width: number; height: number } | undefined,
  tolerance: number,
): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.width - b.width) > tolerance ||
    Math.abs(a.height - b.height) > tolerance
  );
}
