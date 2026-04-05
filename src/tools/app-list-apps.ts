import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-utils';

interface AppInfo {
  bundleId: string;
  name: string;
  version: string;
  path: string;
}

/**
 * Parse plist XML output from `simctl listapps` into an array of AppInfo.
 * The output is an array of dictionaries in Apple plist format.
 */
function parsePlistApps(plistXml: string): AppInfo[] {
  const apps: AppInfo[] = [];

  // Split into individual dict blocks (each <dict>...</dict> is one app)
  const dictBlocks = plistXml.match(/<dict>[\s\S]*?<\/dict>/g) ?? [];

  for (const block of dictBlocks) {
    const bundleId = extractPlistValue(block, 'CFBundleIdentifier');
    if (!bundleId) continue; // Skip entries without a bundle ID

    const name =
      extractPlistValue(block, 'CFBundleDisplayName') ||
      extractPlistValue(block, 'CFBundleName') ||
      bundleId;
    const version =
      extractPlistValue(block, 'CFBundleShortVersionString') ||
      extractPlistValue(block, 'CFBundleVersion') ||
      'unknown';
    const appPath =
      extractPlistValue(block, 'Path') ||
      extractPlistValue(block, 'BundlePath') ||
      '';

    apps.push({ bundleId, name, version, path: appPath });
  }

  return apps;
}

/**
 * Extract a string value following a <key> tag in plist XML.
 */
function extractPlistValue(block: string, key: string): string | null {
  const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const match = block.match(regex);
  return match ? match[1] : null;
}

export function registerAppListAppsTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_list_apps',
      description:
        'List all installed apps on an iOS Simulator. Returns bundle IDs, names, versions, and paths.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: [],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const simctl = new SimctlExecutor();

        // simctl listapps outputs plist XML
        const output = await simctl.exec(['listapps', deviceId]);
        const apps = parsePlistApps(output);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ deviceId, count: apps.length, apps }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[app_list_apps] Error: ${message}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
