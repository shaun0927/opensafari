/**
 * qa_flutter_keyboard_overlap — Detect input fields obscured by the software keyboard.
 *
 * Taps each text input in a Flutter/native app, waits for the keyboard to appear,
 * then checks whether the field remains visible above the keyboard boundary.
 * Handles scrollable forms where the keyboard pushes content up.
 */

import { MCPServer } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';
import { getAccessibilityBridge } from '../native';
import type { AXNode } from '../native';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';

const DEFAULT_KEYBOARD_HEIGHT = 300;
const DEFAULT_SCREEN_HEIGHT = 852; // iPhone 14/15 logical height
const INPUT_ROLES = ['AXTextField', 'AXTextArea'];
const KEYBOARD_APPEAR_DELAY = 800;
const KEYBOARD_DISMISS_DELAY = 500;
const MAX_VIOLATIONS = 20;

/** HID usage code for Escape key — used to dismiss the keyboard. */
const ESCAPE_HID_CODE = '41';

interface OverlapViolation {
  role: string;
  label?: string;
  identifier?: string;
  path: string;
  original_frame: { x: number; y: number; width: number; height: number };
  focused_frame: { x: number; y: number; width: number; height: number };
  overlap_pixels: number;
  scrolled: boolean;
  issue: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findInputFields(node: AXNode): AXNode[] {
  const inputs: AXNode[] = [];
  function walk(n: AXNode): void {
    if (INPUT_ROLES.includes(n.role) && n.visible) {
      inputs.push(n);
    }
    if (n.children) {
      for (const c of n.children) walk(c);
    }
  }
  walk(node);
  return inputs;
}

function findNodeByPath(root: AXNode, targetPath: string): AXNode | undefined {
  if (root.path === targetPath) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }
  return undefined;
}

export function registerQaFlutterKeyboardOverlapTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_flutter_keyboard_overlap',
      description:
        'Verify input fields are not obscured by the software keyboard in Flutter/native apps. ' +
        'Taps each text input, checks if it remains visible above the keyboard, and reports overlap.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          keyboard_height: {
            type: 'number',
            description:
              'Estimated keyboard height in points (default: 300). ' +
              'Adjust for different keyboard types (number pad ~260, email ~300, default ~300).',
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

        const keyboardHeight =
          (params.keyboard_height as number | undefined) ?? DEFAULT_KEYBOARD_HEIGHT;

        const bridge = getAccessibilityBridge();
        const simctl = new SimctlExecutor();

        // Initial tree dump to find all input fields
        const tree = await bridge.dumpTree({ deviceId, maxDepth: 15 });

        // Derive screen height from root element frame
        const screenHeight =
          tree.frame.height > 0 ? tree.frame.height : DEFAULT_SCREEN_HEIGHT;
        const keyboardTop = screenHeight - keyboardHeight;

        const inputFields = findInputFields(tree);
        const violations: OverlapViolation[] = [];

        for (const field of inputFields) {
          const originalFrame = { ...field.frame };
          const centerX = Math.round(field.frame.x + field.frame.width / 2);
          const centerY = Math.round(field.frame.y + field.frame.height / 2);

          // Tap the input to bring up the keyboard
          await simctl.exec(['io', deviceId, 'input', 'tap', String(centerX), String(centerY)]);
          await sleep(KEYBOARD_APPEAR_DELAY);

          // Re-dump tree to get updated frame (form may have scrolled)
          const updatedTree = await bridge.dumpTree({ deviceId, maxDepth: 15 });
          const updatedField = findNodeByPath(updatedTree, field.path);

          if (!updatedField) {
            // Element disappeared after focus — could be a navigation change; skip
            await simctl.exec(['io', deviceId, 'sendkey', ESCAPE_HID_CODE]);
            await sleep(KEYBOARD_DISMISS_DELAY);
            continue;
          }

          const focusedFrame = { ...updatedField.frame };
          const fieldBottom = focusedFrame.y + focusedFrame.height;
          const scrolled = Math.abs(focusedFrame.y - originalFrame.y) > 1;

          if (fieldBottom > keyboardTop) {
            const overlapPixels = Math.round(fieldBottom - keyboardTop);
            violations.push({
              role: field.role,
              label: field.label,
              identifier: field.identifier,
              path: field.path,
              original_frame: originalFrame,
              focused_frame: focusedFrame,
              overlap_pixels: overlapPixels,
              scrolled,
              issue: `Input obscured by keyboard by ${overlapPixels} pixels`,
            });
          }

          // Dismiss keyboard before checking next field
          await simctl.exec(['io', deviceId, 'sendkey', ESCAPE_HID_CODE]);
          await sleep(KEYBOARD_DISMISS_DELAY);
        }

        const passed = violations.length === 0;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  detector: 'qa_flutter_keyboard_overlap',
                  passed,
                  total_inputs: inputFields.length,
                  keyboard_height: keyboardHeight,
                  screen_height: screenHeight,
                  violations_count: violations.length,
                  violations: violations.slice(0, MAX_VIOLATIONS),
                  summary: passed
                    ? `All ${inputFields.length} input fields are visible above the keyboard.`
                    : `${violations.length} of ${inputFields.length} input fields are obscured by keyboard.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: !passed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_flutter_keyboard_overlap] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}
