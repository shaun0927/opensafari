import { MCPServer } from '../mcp-server';
import { getAccessibilityBridge } from '../native/accessibility-bridge';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { classifyMobileContext, type MobileContextProbe } from './mobile-context';

export async function probeMobileContext(params: {
  deviceId: string;
  expectedBundle?: string;
  maxDepth?: number;
}): Promise<MobileContextProbe> {
  const manager = new SimulatorManager();
  const bridge = getAccessibilityBridge();
  const tree = await bridge.dumpTree({
    deviceId: params.deviceId,
    maxDepth: params.maxDepth ?? 6,
  });
  const runningAppsRaw = await manager.listRunningApps(params.deviceId);
  const runningApps = runningAppsRaw.map((app) => ({
    bundleId: app.label,
    pid: app.pid,
  }));
  return classifyMobileContext({
    deviceId: params.deviceId,
    tree,
    runningApps,
    expectedBundle: params.expectedBundle,
  });
}

export function registerAppContextTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_context',
      description:
        'Report the current native mobile context (foreground surface heuristics, running apps, and optional expected-bundle guard) for a booted iOS Simulator.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to the active device if omitted.',
          },
          expectedBundle: {
            type: 'string',
            description:
              'Optional bundle identifier to compare against the current foreground context.',
          },
          requireMatch: {
            type: 'boolean',
            description:
              'When true, return an error if the expected bundle is not matched with verified or heuristic confidence.',
          },
          maxDepth: {
            type: 'number',
            description:
              'Maximum accessibility-tree depth to inspect (default: 6).',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const manager = new SimulatorManager();
        const booted = await manager.listBooted();
        const deviceId =
          (params.deviceId as string | undefined) ??
          getSessionManager().getSoleDeviceId() ??
          booted[0]?.udid;

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

        const expectedBundle = params.expectedBundle as string | undefined;
        const requireMatch = params.requireMatch === true;
        const maxDepth = (params.maxDepth as number | undefined) ?? 6;

        const probe = await probeMobileContext({
          deviceId,
          expectedBundle,
          maxDepth,
        });

        const isMatched =
          probe.expectedBundleMatch === 'matched' &&
          (probe.expectedBundleMatchConfidence === 'verified' ||
            probe.expectedBundleMatchConfidence === 'heuristic');

        if (requireMatch && expectedBundle && !isMatched) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'EXPECTED_BUNDLE_MISMATCH',
                  ...probe,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(probe),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'APP_CONTEXT_FAILED',
                message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
