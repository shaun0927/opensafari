import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { NativeAuthManager } from '../auth/native-manager';

export function registerAppLaunchTool(server: MCPServer): void {
  const nativeAuth = new NativeAuthManager();

  server.registerTool(
    {
      name: 'app_launch',
      description:
        'Launch an app by bundle identifier on a booted iOS Simulator. Optionally pre-seeds a saved native auth profile (data container + Keychain) before launching so the app starts already logged in.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to launch (e.g. com.apple.mobilesafari)',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional launch arguments passed to the app',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional environment variables set in the launched app',
          },
          authProfile: {
            type: 'string',
            description:
              'Name of a previously saved native auth profile (see auth_save_native) to restore before launching. Restores the data container (and Keychain if the profile included it) so the app starts in its captured signed-in state.',
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'DEVICE_NOT_BOOTED',
              message: 'No booted simulator found. Call device_boot first.',
            }),
          }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const args = params.args as string[] | undefined;
      const env = params.env as Record<string, string> | undefined;
      const authProfile = params.authProfile as string | undefined;

      let authRestored: false | { profile: string; keychain: boolean; warning?: string } = false;
      if (authProfile) {
        // Restore first — the call internally terminates the app before
        // wiping the data container, so by the time `launchApp` runs the
        // process is in a clean post-restore state.
        try {
          const data = await nativeAuth.restore(deviceId, bundleId, authProfile);
          authRestored = {
            profile: data.profile,
            keychain: Boolean(data.keychainArchive),
          };
        } catch (err) {
          // Don't fail the whole launch — surface the auth failure as a
          // warning so the caller can still drive the login flow manually.
          const message = err instanceof Error ? err.message : String(err);
          authRestored = {
            profile: authProfile,
            keychain: false,
            warning: `auth_restore_native failed: ${message}`,
          };
        }
      }

      const result = await manager.launchApp(deviceId, bundleId, { args, env });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...result, authRestored }),
        }],
      };
    },
  );
}
