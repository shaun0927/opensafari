import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  assertStorekitEnabled,
  runStorekit,
  parseStorekitProductIds,
  StorekitDisabledError,
  StorekitUnsupportedError,
} from '../native/simctl-storekit';

export function registerAppStorekitConfigureTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_storekit_configure',
      description:
        'Configure StoreKit / In-App Purchase simulation on an iOS Simulator by loading a .storekit file. ' +
        'Requires Xcode 14+. Disabled when OPENSAFARI_DISABLE_STOREKIT=1.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          configPath: {
            type: 'string',
            description: 'Absolute path to the .storekit configuration file',
          },
          udid: {
            type: 'string',
            description: 'Simulator UDID. Falls back to the sole booted device if omitted.',
          },
        },
        required: ['configPath'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        assertStorekitEnabled();
      } catch (err) {
        if (err instanceof StorekitDisabledError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: err.code, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      const configPath = params.configPath as string;
      if (!configPath) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'MISSING_CONFIG', message: 'configPath is required' }) },
          ],
          isError: true,
        };
      }

      const sm = getSessionManager();
      const udid = (params.udid as string | undefined) ?? sm.getSoleDeviceId();
      if (!udid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message: 'No device specified and no sole booted simulator found. Boot a simulator first.',
              }),
            },
          ],
          isError: true,
        };
      }

      let productIds: string[];
      try {
        productIds = await parseStorekitProductIds(configPath);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'MISSING_FILE', message: (err as Error).message }),
            },
          ],
          isError: true,
        };
      }

      try {
        await runStorekit(['configure', udid, configPath]);
      } catch (err) {
        if (err instanceof StorekitUnsupportedError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: err.code, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'STOREKIT_ERROR', message: (err as Error).message }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              productIds,
              udid,
              configPath,
              _meta: {
                _telemetry: { backend: 'storekit', op: 'configure', udid, configPath },
              },
            }),
          },
        ],
      };
    },
  );
}
