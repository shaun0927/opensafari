import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function registerAppAlertHandleTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_alert_handle',
      description:
        'Accept or dismiss a system alert/dialog on a booted iOS Simulator. ' +
        'Uses keyboard input (Return to accept, Escape to dismiss) with an AppleScript fallback.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['accept', 'dismiss'],
            description: 'Whether to accept or dismiss the alert',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId =
        (params.deviceId as string) ?? sm.getActiveDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message: 'No booted simulator found. Call device_boot first.',
              }),
            },
          ],
          isError: true,
        };
      }

      const action = params.action as string;

      if (action !== 'accept' && action !== 'dismiss') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'INVALID_ACTION',
                message: `Invalid action "${action}". Must be "accept" or "dismiss".`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Primary: use simctl io sendkey to send keyboard input
      // Return/Enter accepts alerts, Escape dismisses them
      const keyName = action === 'accept' ? 'Return' : 'Escape';
      const simctl = manager.getSimctl();

      try {
        await simctl.exec(['io', deviceId, 'sendkey', keyName], { timeout: 10000 });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                handled: true,
                action,
                deviceId,
                method: 'sendkey',
              }),
            },
          ],
        };
      } catch {
        // Fallback: use AppleScript to interact with Simulator window
        try {
          const buttonName = action === 'accept' ? 'Allow' : "Don't Allow";
          await execFileAsync(
            'osascript',
            [
              '-e',
              'tell application "Simulator" to activate',
              '-e',
              'delay 0.3',
              '-e',
              `tell application "System Events" to tell process "Simulator" to click button "${buttonName}" of sheet 1 of window 1`,
            ],
            { timeout: 10000 },
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  handled: true,
                  action,
                  deviceId,
                  method: 'applescript',
                }),
              },
            ],
          };
        } catch (asErr: unknown) {
          const message = asErr instanceof Error ? asErr.message : String(asErr);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'ALERT_HANDLE_FAILED',
                  message: `Failed to ${action} alert: ${message}. No visible alert may be present.`,
                }),
              },
            ],
            isError: true,
          };
        }
      }
    },
  );
}
