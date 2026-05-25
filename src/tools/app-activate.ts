import { MCPServer } from '../mcp-server';
import { getDefaultSimulatorManager, SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { probeMobileContext } from './app-context';

export function registerAppActivateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_activate',
      description: 'Bring an app to the foreground on a booted iOS Simulator. Launches the app if not already running.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to activate',
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
      const manager = getDefaultSimulatorManager();
      const booted = await manager.listBooted();
      const deviceId = (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid;

      if (!deviceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const result = await manager.activateApp(deviceId, bundleId);
      const { context, warning } = await probeActivationContext({
        deviceId,
        bundleId,
        manager,
      });

      if (context?.expectedBundleMatch === 'mismatch') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'EXPECTED_BUNDLE_MISMATCH',
              message:
                `Activated ${bundleId}, but the foreground context is ${context.surface} ` +
                `(${context.expectedBundleMatch}).`,
              ...result,
              context,
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            context,
            warning,
          }),
        }],
      };
    },
  );
}

async function probeActivationContext(args: {
  deviceId: string;
  bundleId: string;
  manager: SimulatorManager;
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
        ? `Foreground context for ${args.bundleId} could not be verified with confidence after activation.`
        : undefined;
    return { context, warning };
  } catch (error) {
    return {
      warning:
        `Foreground context probe failed after activating ${args.bundleId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
