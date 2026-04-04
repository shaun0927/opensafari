import { MCPServer } from '../mcp-server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveDeviceId } from './native-app-helpers';

const execFileAsync = promisify(execFile);

const VALID_ACTIONS = ['accept', 'dismiss'] as const;

/**
 * Build AppleScript that clicks the appropriate button on a Simulator alert dialog.
 * Tries several common button labels in order:
 *   accept  → "Allow", "OK", "Allow While Using App"
 *   dismiss → "Don't Allow", "Cancel", "Don't Allow"
 *
 * Note: Requires macOS Accessibility permissions for the terminal running this process.
 */
export function buildAlertScript(action: string): string {
  const primary = action === 'accept' ? 'Allow' : "Don't Allow";
  const secondary = action === 'accept' ? 'OK' : 'Cancel';
  const tertiary = action === 'accept' ? 'Allow While Using App' : "Don't Allow";

  return `
tell application "Simulator" to activate
delay 0.3
tell application "System Events"
  tell process "Simulator"
    try
      click button "${primary}" of sheet 1 of window 1
    on error
      try
        click button "${secondary}" of sheet 1 of window 1
      on error
        try
          click button "${tertiary}" of sheet 1 of window 1
        on error
          error "No alert button found"
        end try
      end try
    end try
  end tell
end tell
`;
}

export function registerAppHandleAlertTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_handle_alert',
      description:
        'Handle system alert dialogs in the iOS Simulator (e.g. permission prompts). Accepts or dismisses the currently visible alert. Requires macOS Accessibility permissions for the terminal.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['accept', 'dismiss'],
            description: 'Accept or dismiss the alert',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const action = params.action as string;

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const script = buildAlertScript(action);

      try {
        await execFileAsync('osascript', ['-e', script], { timeout: 10000 });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                action,
                deviceId,
                handledAt: new Date().toISOString(),
              }),
            },
          ],
        };
      } catch (err) {
        const message = (err as Error).message || '';

        // If no alert is present, return a helpful message instead of an error
        if (message.includes('No alert button found') || message.includes('sheet 1 of window 1')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  action,
                  deviceId,
                  message: 'No alert dialog is currently visible on the Simulator.',
                  handledAt: new Date().toISOString(),
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: failed to ${action} alert: ${message}. Ensure macOS Accessibility permissions are granted for this terminal.`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
