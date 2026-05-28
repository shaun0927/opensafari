import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { probeMobileContext } from './app-context';
import { ErrorCode, respondWithStructuredError } from '../errors';

export function registerAppSwitchAppTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_switch_app',
      description: 'Switch to (foreground) an app on a booted iOS Simulator, optionally opening a URL for handoff flows',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier to switch to (e.g. com.apple.mobilesafari)',
          },
          url: {
            type: 'string',
            description: 'Optional URL to open when switching (for deep-link or handoff flows)',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const sm = getSessionManager();
      const manager = new SimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found. Call device_boot first.');
      }

      const bundleId = params.bundleId as string;
      const url = params.url as string | undefined;

      if (url) {
        // Open URL — the OS routes it to the appropriate app
        await manager.openUrl(deviceId, url);
        const { context, warning } = await probeSwitchContext({
          deviceId,
          bundleId,
          manager,
          action: 'Opened URL for',
        });
        if (context?.expectedBundleMatch === 'mismatch') {
          return respondWithStructuredError(
            ErrorCode.APP_STATE_UNKNOWN,
            `Opened URL for ${bundleId}, but the foreground context is ${context.surface} (${context.expectedBundleMatch}).`,
            { switched: true, bundleId, deviceId, url, context },
          );
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ switched: true, bundleId, deviceId, url, context, warning }),
          }],
        };
      }

      // Launch/foreground the app by bundle ID
      const result = await manager.launchApp(deviceId, bundleId);
      const { context, warning } = await probeSwitchContext({
        deviceId,
        bundleId,
        manager,
        action: 'Switched to',
      });

      if (context?.expectedBundleMatch === 'mismatch') {
        return respondWithStructuredError(
          ErrorCode.APP_STATE_UNKNOWN,
          `Switched to ${bundleId}, but the foreground context is ${context.surface} (${context.expectedBundleMatch}).`,
          { switched: true, bundleId, deviceId, pid: result.pid, context },
        );
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ switched: true, bundleId, deviceId, pid: result.pid, context, warning }),
        }],
      };
    },
  );
}

async function probeSwitchContext(args: {
  deviceId: string;
  bundleId: string;
  manager: SimulatorManager;
  action: string;
}): Promise<{
  context?: Awaited<ReturnType<typeof probeMobileContext>>;
  warning?: string;
}> {
  try {
    const context = await probeMobileContext({
      deviceId: args.deviceId,
      expectedBundle: args.bundleId,
      manager: args.manager,
    });
    const warning =
      context.expectedBundleMatch === 'unknown'
        ? `Foreground context for ${args.bundleId} could not be verified with confidence after ${args.action.toLowerCase()} ${args.bundleId}.`
        : undefined;
    return { context, warning };
  } catch (error) {
    return {
      warning:
        `Foreground context probe failed after ${args.action.toLowerCase()} ${args.bundleId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
