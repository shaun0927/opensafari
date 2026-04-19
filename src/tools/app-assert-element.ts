/**
 * app_assert_element — CI-friendly assertions on native UI elements.
 *
 * Assert that an element exists, is visible, is enabled, or contains
 * specific text. Returns structured pass/fail results suitable for
 * automated QA pipelines.
 */

import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge, ensureSemanticsActive } from '../native';
import { getSessionManager } from '../session-manager';
import {
  createContextMismatchError,
  ensureTargetAppContext,
  NativeContextMeta,
} from './native-app-context';

type AssertCondition = 'exists' | 'not_exists' | 'visible' | 'enabled' | 'disabled' | 'has_text';

export function registerAppAssertElementTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_assert_element',
      description:
        'Assert a condition on a native app UI element found by accessibility query. ' +
        'Returns structured pass/fail result suitable for CI pipelines. ' +
        'Works with any app including Flutter.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          identifier: {
            type: 'string',
            description: 'Accessibility identifier (exact match)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label (case-insensitive substring)',
          },
          text: {
            type: 'string',
            description: 'Text content in value or label',
          },
          role: {
            type: 'string',
            description: 'Accessibility role (e.g. "AXButton")',
          },
          assert: {
            type: 'string',
            enum: ['exists', 'not_exists', 'visible', 'enabled', 'disabled', 'has_text'],
            description: 'Condition to assert (default: "exists")',
          },
          expected_text: {
            type: 'string',
            description: 'Expected text value (required when assert is "has_text")',
          },
          message: {
            type: 'string',
            description: 'Custom assertion message for CI reports',
          },
          device_id: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          bundle_id: {
            type: 'string',
            description: 'Target app bundle ID. When provided, the tool re-activates the app and rejects mismatched native contexts.',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const identifier = params.identifier as string | undefined;
      const label = params.label as string | undefined;
      const text = params.text as string | undefined;
      const role = params.role as string | undefined;

      if (!identifier && !label && !text && !role) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'At least one query parameter (identifier, label, text, or role) is required',
            }),
          }],
          isError: true,
        };
      }

      try {
        const deviceId =
          (params.device_id as string | undefined) ??
          getSessionManager().getSoleDeviceId();
        if (!deviceId) {
          throw new Error(
            'No device specified and no active device. Boot a simulator first with device_boot.',
          );
        }

        const condition = (params.assert as AssertCondition | undefined) ?? 'exists';
        const expectedText = params.expected_text as string | undefined;
        const message = params.message as string | undefined;
        const bundleId = params.bundle_id as string | undefined;
        const query = { identifier, label, text, role };

        if (condition === 'has_text' && !expectedText) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'expected_text is required when assert is "has_text"',
              }),
            }],
            isError: true,
          };
        }

        const bridge = getAccessibilityBridge();
        let meta: NativeContextMeta = {
          requestedBundleId: bundleId,
          deviceId,
          sourceKind: 'unknown',
          heuristics: ['not-requested'],
          activationAttempted: false,
          activationRetries: 0,
        };
        if (bundleId) {
          const context = await ensureTargetAppContext({
            bridge,
            deviceId,
            bundleId,
            ensureSemanticsActive: () => ensureSemanticsActive(deviceId, { bundleId }),
          });
          meta = context.meta;
          if (meta.sourceKind !== 'target-app') {
            throw createContextMismatchError(meta);
          }
        } else {
          await ensureSemanticsActive(deviceId, { bundleId });
        }
        const result = await bridge.query(query, { deviceId });
        const matches = result.matches;
        const match = matches.length > 0 ? matches[0] : null;

        let passed: boolean;
        let actual: string;

        switch (condition) {
          case 'exists':
            passed = matches.length > 0;
            actual = matches.length > 0 ? `found ${matches.length} element(s)` : 'not found';
            break;
          case 'not_exists':
            passed = matches.length === 0;
            actual = matches.length === 0 ? 'not found (expected)' : `found ${matches.length} element(s)`;
            break;
          case 'visible':
            passed = match !== null && match.visible;
            actual = match ? (match.visible ? 'visible' : 'hidden') : 'not found';
            break;
          case 'enabled':
            passed = match !== null && match.enabled;
            actual = match ? (match.enabled ? 'enabled' : 'disabled') : 'not found';
            break;
          case 'disabled':
            passed = match !== null && !match.enabled;
            actual = match ? (!match.enabled ? 'disabled' : 'enabled') : 'not found';
            break;
          case 'has_text': {
            const elementText = match?.value ?? match?.label ?? '';
            passed = elementText.toLowerCase().includes((expectedText ?? '').toLowerCase());
            actual = elementText || '(empty)';
            break;
          }
          default:
            passed = false;
            actual = `unknown condition: ${condition}`;
        }

        const assertResult = {
          passed,
          condition,
          query,
          actual,
          expected: condition === 'has_text' ? expectedText : condition,
          message: message ?? `Assert ${condition} for element`,
          _meta: { context: meta },
          element: match ? {
            role: match.role,
            label: match.label,
            identifier: match.identifier,
            value: match.value,
            frame: match.frame,
            visible: match.visible,
            enabled: match.enabled,
          } : null,
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(assertResult, null, 2),
          }],
          isError: !passed,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[app_assert_element] ${errorMessage}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMessage }) }],
          isError: true,
        };
      }
    },
  );
}
