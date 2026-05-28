import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';
import { SimctlExecutor } from '../simulator/simctl';
import { ErrorCode, respondWithStructuredError } from '../errors';

const VALID_PERMISSIONS = [
  'location', 'camera', 'microphone', 'photos', 'contacts',
  'calendar', 'reminders', 'notifications', 'health',
] as const;
type AppPermission = typeof VALID_PERMISSIONS[number];

// simctl privacy uses specific service names
const PERMISSION_MAP: Record<AppPermission, string> = {
  location: 'location',
  camera: 'camera',
  microphone: 'microphone',
  photos: 'photos',
  contacts: 'contacts',
  calendar: 'calendar',
  reminders: 'reminders',
  notifications: 'notifications',
  health: 'health',
};

async function resolveDeviceId(params: Record<string, unknown>): Promise<string | null> {
  const sm = getSessionManager();
  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  return (params.deviceId as string) ?? sm.getSoleDeviceId() ?? booted[0]?.udid ?? null;
}

export function registerAppPermissionTools(server: MCPServer): void {
  const simctl = new SimctlExecutor();

  // app_permission_set
  server.registerTool(
    {
      name: 'app_permission_set',
      description: 'Grant or revoke a privacy permission for an app on a booted iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {
          permission: {
            type: 'string',
            enum: [...VALID_PERMISSIONS],
            description: 'Permission type to set',
          },
          action: {
            type: 'string',
            enum: ['grant', 'revoke'],
            description: 'Whether to grant or revoke the permission',
          },
          bundleId: {
            type: 'string',
            description: 'App bundle identifier (e.g. com.example.myapp)',
          },
          deviceId: {
            type: 'string',
            description: 'Device UDID. Falls back to active device if omitted.',
          },
        },
        required: ['permission', 'action', 'bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const deviceId = await resolveDeviceId(params);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found. Call device_boot first.');
      }

      const permission = params.permission as string;
      const action = params.action as string;
      const bundleId = params.bundleId as string;

      if (!VALID_PERMISSIONS.includes(permission as AppPermission)) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Invalid permission "${permission}". Must be one of: ${VALID_PERMISSIONS.join(', ')}`);
      }

      if (action !== 'grant' && action !== 'revoke') {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Invalid action "${action}". Must be "grant" or "revoke".`);
      }

      const simctlPermission = PERMISSION_MAP[permission as AppPermission];
      await simctl.exec(['privacy', deviceId, action, simctlPermission, bundleId]);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, permission, action, bundleId, deviceId }),
        }],
      };
    },
  );

  // app_permission_reset
  server.registerTool(
    {
      name: 'app_permission_reset',
      description: 'Reset privacy permissions for an app on a booted iOS Simulator, restoring the first-run prompt',
      inputSchema: {
        type: 'object' as const,
        properties: {
          permission: {
            type: 'string',
            enum: [...VALID_PERMISSIONS],
            description: 'Permission to reset. Omit to reset all permissions.',
          },
          bundleId: {
            type: 'string',
            description: 'App bundle identifier (e.g. com.example.myapp)',
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
      const deviceId = await resolveDeviceId(params);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found. Call device_boot first.');
      }

      const permission = params.permission as string | undefined;
      const bundleId = params.bundleId as string;

      if (permission && !VALID_PERMISSIONS.includes(permission as AppPermission)) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Invalid permission "${permission}". Must be one of: ${VALID_PERMISSIONS.join(', ')}`);
      }

      const resetTarget = permission ? PERMISSION_MAP[permission as AppPermission] : 'all';
      await simctl.exec(['privacy', deviceId, 'reset', resetTarget, bundleId]);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, permission: permission ?? 'all', bundleId, deviceId }),
        }],
      };
    },
  );
}
