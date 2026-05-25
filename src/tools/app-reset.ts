import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { NativeAuthManager } from '../auth/native-manager';

export function registerAppResetTool(server: MCPServer): void {
  const nativeAuth = new NativeAuthManager();

  server.registerTool(
    {
      name: 'app_reset',
      description:
        'Reset app state on a booted iOS Simulator. Terminates the app, resets privacy permissions, ' +
        'and uninstalls it to clear all data. The app must be reinstalled after reset. ' +
        'Optionally capture the app\'s native auth snapshot first (see snapshotAuthProfile / includeKeychain) ' +
        'so the caller can restore the logged-in state after the post-reset reinstall.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'The bundle identifier of the app to reset',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
          snapshotAuthProfile: {
            type: 'string',
            description:
              'Profile name to capture the current native auth state into BEFORE the reset. After reinstalling the app, call auth_restore_native with this profile to bring the signed-in state back.',
          },
          includeKeychain: {
            type: 'boolean',
            description:
              'When snapshotAuthProfile is set, also capture the simulator-wide Keychain DB. Requires temporarily shutting the simulator down — leave off for fast captures that only need plist/sqlite/hive stores.',
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
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'DEVICE_NOT_BOOTED', message: 'No booted simulator found. Call device_boot first.' }) }],
          isError: true,
        };
      }

      const bundleId = params.bundleId as string;
      const snapshotAuthProfile = params.snapshotAuthProfile as string | undefined;
      const includeKeychain = Boolean(params.includeKeychain);

      // Capture native auth FIRST so the subsequent uninstall doesn't take
      // it down with the data container. Failure here surfaces as a warning
      // but does NOT block the reset — the caller can always re-login
      // manually if the snapshot didn't work.
      let snapshot: false | { profile: string; keychain: boolean; warning?: string } = false;
      if (snapshotAuthProfile) {
        try {
          const saved = await nativeAuth.save(deviceId, bundleId, snapshotAuthProfile, {
            includeKeychain,
          });
          snapshot = {
            profile: saved.profile,
            keychain: Boolean(saved.keychainArchive),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          snapshot = {
            profile: snapshotAuthProfile,
            keychain: false,
            warning: `auth_save_native failed before reset: ${message}`,
          };
        }
      }

      const result = await manager.resetApp(deviceId, bundleId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...result, authSnapshot: snapshot }),
        }],
      };
    },
  );
}
