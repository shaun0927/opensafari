import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  assertStorekitEnabled,
  StorekitDisabledError,
} from '../native/simctl-storekit';

const execFileAsync = promisify(execFile);

export function registerAppStorekitReceiptTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_storekit_receipt',
      description:
        'Retrieve the StoreKit sandbox receipt for an installed app on an iOS Simulator, ' +
        'base64-encoded. Locates the receipt via the app data container. ' +
        'Disabled when OPENSAFARI_DISABLE_STOREKIT=1.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle identifier',
          },
          udid: {
            type: 'string',
            description: 'Simulator UDID. Falls back to the sole booted device if omitted.',
          },
        },
        required: ['bundleId'],
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

      const bundleId = params.bundleId as string;
      if (!bundleId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'MISSING_BUNDLE_ID', message: 'bundleId is required' }),
            },
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

      // Locate the app data container via simctl get_app_container
      let dataContainer: string;
      try {
        const { stdout } = await execFileAsync('xcrun', [
          'simctl',
          'get_app_container',
          udid,
          bundleId,
          'data',
        ]);
        dataContainer = stdout.trim();
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'APP_NOT_INSTALLED',
                message: `Cannot locate data container for ${bundleId} on ${udid}: ${(err as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Try known receipt paths in priority order
      const candidatePaths = [
        path.join(dataContainer, 'StoreKit', 'sandboxReceipt'),
        path.join(dataContainer, 'Documents', 'receipt'),
      ];

      let receiptPath: string | null = null;
      for (const candidate of candidatePaths) {
        try {
          await fs.access(candidate);
          receiptPath = candidate;
          break;
        } catch {
          // not found, try next
        }
      }

      if (!receiptPath) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'NO_RECEIPT',
                message: `No sandbox receipt found for ${bundleId} at expected paths: ${candidatePaths.join(', ')}`,
                bundleId,
                udid,
              }),
            },
          ],
          isError: true,
        };
      }

      let receiptBuffer: Buffer;
      try {
        receiptBuffer = await fs.readFile(receiptPath);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'READ_ERROR',
                message: `Failed to read receipt at ${receiptPath}: ${(err as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }

      const receipt = receiptBuffer.toString('base64');
      const bytes = receiptBuffer.length;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              receipt,
              path: receiptPath,
              bytes,
              bundleId,
              udid,
              _meta: {
                _telemetry: { backend: 'storekit', op: 'receipt', udid, bundleId, bytes },
              },
            }),
          },
        ],
      };
    },
  );
}
