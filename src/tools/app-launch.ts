import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-utils';

export function registerAppLaunchTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_launch',
      description:
        'Launch a native app by bundle ID on a booted iOS Simulator. Optionally pass launch arguments and environment variables.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier (e.g. com.apple.mobilesafari)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Launch arguments to pass to the app',
          },
          env: {
            type: 'object',
            description: 'Environment variables to set (keys become SIMCTL_CHILD_<KEY>)',
          },
          terminateFirst: {
            type: 'boolean',
            description: 'Terminate existing instance before launch (default: false)',
          },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const bundleId = params.bundleId as string;
        const args = (params.args as string[]) ?? [];
        const env = (params.env as Record<string, string>) ?? {};
        const terminateFirst = (params.terminateFirst as boolean) ?? false;

        const simctl = new SimctlExecutor();

        // Optionally terminate existing instance first
        if (terminateFirst) {
          try {
            await simctl.exec(['terminate', deviceId, bundleId]);
          } catch {
            // Ignore — app may not be running
          }
        }

        // Build environment variables for the child process
        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
          childEnv[`SIMCTL_CHILD_${key}`] = String(value);
        }

        // Run simctl launch — output format: "<bundleId>: <PID>"
        const launchArgs = ['launch', deviceId, bundleId, ...args];
        const stdout = await simctl.exec(launchArgs);

        // Parse PID from stdout
        let pid: number | null = null;
        const pidMatch = stdout.match(/:\s*(\d+)/);
        if (pidMatch) {
          pid = parseInt(pidMatch[1], 10);
        }

        const result = {
          bundleId,
          deviceId,
          pid,
          launchedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_launch] Error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
