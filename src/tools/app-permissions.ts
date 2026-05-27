import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-helpers';
import { ErrorCode, respondWithStructuredError } from '../errors';

/** Map user-facing permission names to simctl privacy service names */
const PERMISSION_MAP: Record<string, string> = {
  photos: 'photos',
  camera: 'camera',
  microphone: 'microphone',
  location: 'location',
  'location-always': 'location-always',
  contacts: 'contacts',
  calendar: 'calendar',
  reminders: 'reminders',
  siri: 'siri',
  speech: 'speech-recognition',
  motion: 'motion',
  health: 'health',
  homekit: 'homekit',
  'media-library': 'media-library',
  all: 'all',
};

export const VALID_PERMISSIONS = Object.keys(PERMISSION_MAP);
const VALID_ACTIONS = ['grant', 'revoke', 'reset'] as const;

export function registerAppPermissionsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_permissions',
      description:
        'Manage iOS privacy permissions for apps in Simulator. Grant, revoke, or reset permissions like camera, photos, location, etc.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['grant', 'revoke', 'reset'],
            description: 'Permission action',
          },
          permission: {
            type: 'string',
            description:
              'Permission type: photos, camera, microphone, location, contacts, calendar, reminders, siri, speech, motion, health, homekit, media-library, all',
          },
          bundleId: {
            type: 'string',
            description: 'Target app bundle identifier',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['action', 'permission', 'bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const action = params.action as string;
      const permission = params.permission as string;
      const bundleId = params.bundleId as string;

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
      }

      const service = PERMISSION_MAP[permission];
      if (!service) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Invalid permission "${permission}". Must be one of: ${VALID_PERMISSIONS.join(', ')}`);
      }

      if (!bundleId) {
        return respondWithStructuredError(ErrorCode.MISSING_REQUIRED_PARAM, 'bundleId is required');
      }

      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, (err as Error).message);
      }

      try {
        const simctl = new SimctlExecutor();
        await simctl.exec(['privacy', deviceId, action, service, bundleId]);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ action, permission, bundleId, deviceId, success: true }),
            },
          ],
        };
      } catch (err) {
        return respondWithStructuredError(
          action === 'reset' ? ErrorCode.PERMISSION_RESET_DENIED : ErrorCode.APP_STATE_UNKNOWN,
          `Failed to ${action} ${permission} for ${bundleId}: ${(err as Error).message}`,
        );
      }
    },
  );
}
