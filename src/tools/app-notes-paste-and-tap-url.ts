/**
 * app_notes_paste_and_tap_url — reviewer-equivalent Universal Link tap through Notes.app.
 *
 * The iOS Simulator only exposes `xcrun simctl openurl` as a URL-opening
 * channel, which Apple documentation does not treat as equivalent to a real
 * Universal Link tap. This helper reproduces the "paste a URL into Notes and
 * tap the auto-detected link" flow, which *is* a channel Apple reviewers
 * actually use:
 *
 *   1. Launch Notes (`com.apple.mobilenotes`).
 *   2. Focus the note body by pressing the first text-editor element.
 *   3. Paste the URL via the pasteboard-input backend.
 *   4. Poll the accessibility tree until iOS's Data Detector produces an
 *      `AXLink` referencing the URL (or its host).
 *   5. Press that link. If the app under test is installed and has a valid
 *      `applinks:` association, the Universal Link handler opens it.
 *
 * All steps reuse infrastructure already in-tree (pasteboard-input,
 * AccessibilityBridge, SimulatorManager, SimctlExecutor) so the surface area
 * added here is glue + timing.
 */

import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getAccessibilityBridge } from '../native';
import type { AXQueryResult } from '../native/ax-types';
import { typeViaPasteboard } from './pasteboard-input';
import { resolveDeviceId } from './native-app-utils';

const NOTES_BUNDLE_ID = 'com.apple.mobilenotes';
const DEFAULT_FOCUS_TIMEOUT_MS = 4000;
const DEFAULT_LINK_TAP_TIMEOUT_MS = 4000;
const DEFAULT_SETTLE_MS = 500;
const FOCUS_POLL_MS = 200;
const LINK_POLL_MS = 200;

/** Editor roles tried in order when focusing the note body. */
const EDITOR_ROLES = ['AXTextArea', 'AXTextView', 'AXTextField'] as const;

interface FocusedElement {
  path: string;
  role: string;
  label: string | null;
}

interface DetectedLink {
  path: string;
  label: string;
}

export interface AppNotesPasteAndTapUrlResult {
  url: string;
  deviceId: string;
  notesLaunchedAt: string;
  linkTappedAt: string;
  linkElement: DetectedLink;
  durationMs: number;
}

export function registerAppNotesPasteAndTapUrlTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_notes_paste_and_tap_url',
      description:
        'Reviewer-equivalent Universal Link tap via Notes.app: launches Notes, paste-injects the URL, waits for iOS Data Detector to produce an AXLink, and taps it. Use this instead of app_open_url when Apple-review parity matters (see docs/recipes/universal-link-channels.md).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'Universal Link or HTTPS URL to paste (e.g. https://example.com/detail/abc).',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted).',
          },
          settleMs: {
            type: 'number',
            description: 'Ms to wait after paste before scanning for the detected link. Default: 500.',
          },
          focusTimeoutMs: {
            type: 'number',
            description: 'Max ms to wait for the Notes editor to be AX-queryable. Default: 4000.',
          },
          linkTapTimeoutMs: {
            type: 'number',
            description: 'Max ms to wait for iOS Data Detector to expose an AXLink. Default: 4000.',
          },
          restorePasteboard: {
            type: 'boolean',
            description: 'Restore the simulator pasteboard after paste. Default: true.',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const startedAt = Date.now();
        const url = params.url as string | undefined;
        if (!url || typeof url !== 'string') {
          throw new Error('url parameter is required');
        }
        if (!url.includes('://')) {
          throw new Error(
            'invalid URL — must include a scheme (e.g. https:// or myapp://)',
          );
        }

        const deviceId = resolveDeviceId(params);
        const settleMs = numberParam(params.settleMs, DEFAULT_SETTLE_MS);
        const focusTimeoutMs = numberParam(params.focusTimeoutMs, DEFAULT_FOCUS_TIMEOUT_MS);
        const linkTapTimeoutMs = numberParam(params.linkTapTimeoutMs, DEFAULT_LINK_TAP_TIMEOUT_MS);
        const restorePasteboard = params.restorePasteboard !== false;

        const manager = new SimulatorManager();
        await manager.launchApp(deviceId, NOTES_BUNDLE_ID);
        const notesLaunchedAt = new Date().toISOString();

        const editor = await waitForEditor(deviceId, focusTimeoutMs);
        if (!editor) {
          throw new Error(
            `Notes editor did not appear within ${focusTimeoutMs}ms ` +
              `(tried roles: ${EDITOR_ROLES.join(', ')}).`,
          );
        }

        // Focus the editor so the pasteboard paste lands there.
        const bridge = getAccessibilityBridge();
        await bridge.press(editor.path, deviceId).catch(() => undefined);

        await typeViaPasteboard(deviceId, url, {
          restorePasteboard,
        });

        await sleep(settleMs);

        const link = await waitForDetectedLink(deviceId, url, linkTapTimeoutMs);
        if (!link) {
          throw new Error(
            `Data Detector did not produce a link for "${url}" within ${linkTapTimeoutMs}ms.`,
          );
        }

        const pressResult = await bridge.press(link.path, deviceId);
        if (!pressResult.ok) {
          throw new Error(
            `Failed to press detected link (${pressResult.code}): ${pressResult.message ?? 'unknown'}`,
          );
        }

        const result: AppNotesPasteAndTapUrlResult = {
          url,
          deviceId,
          notesLaunchedAt,
          linkTappedAt: new Date().toISOString(),
          linkElement: { path: link.path, label: link.label },
          durationMs: Date.now() - startedAt,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_notes_paste_and_tap_url] ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

async function waitForEditor(
  deviceId: string,
  timeoutMs: number,
): Promise<FocusedElement | null> {
  const deadline = Date.now() + timeoutMs;
  const bridge = getAccessibilityBridge();
  while (Date.now() < deadline) {
    for (const role of EDITOR_ROLES) {
      try {
        const res: AXQueryResult = await bridge.query({ role }, { deviceId });
        const match = res.matches[0];
        if (match) {
          return { path: match.path, role, label: match.label ?? null };
        }
      } catch {
        /* tree may be mid-transition — retry */
      }
    }
    await sleep(FOCUS_POLL_MS);
  }
  return null;
}

async function waitForDetectedLink(
  deviceId: string,
  url: string,
  timeoutMs: number,
): Promise<DetectedLink | null> {
  const deadline = Date.now() + timeoutMs;
  const bridge = getAccessibilityBridge();
  const lowerUrl = url.toLowerCase();
  const host = safeExtractHost(url);
  while (Date.now() < deadline) {
    try {
      const res: AXQueryResult = await bridge.query(
        { role: 'AXLink' },
        { deviceId, maxResults: 20 },
      );
      for (const match of res.matches) {
        const label = (match.label ?? '').toLowerCase();
        if (label.includes(lowerUrl) || (host && label.includes(host))) {
          return { path: match.path, label: match.label ?? url };
        }
      }
      // Fallback: if exactly one AXLink is present, assume it's the one we pasted.
      if (res.matches.length === 1) {
        const sole = res.matches[0];
        return { path: sole.path, label: sole.label ?? url };
      }
    } catch {
      /* tree may be mid-transition — retry */
    }
    await sleep(LINK_POLL_MS);
  }
  return null;
}

function safeExtractHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function numberParam(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
