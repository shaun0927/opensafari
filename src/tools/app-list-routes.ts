/**
 * `app_list_routes` — enumerate the URL schemes (and, where possible,
 * universal-link associated domains) declared by an installed iOS app.
 *
 * Mechanism
 * ---------
 *   1. Resolve the app bundle dir via `xcrun simctl get_app_container
 *      <udid> <bundleId> app`.
 *   2. Read `Info.plist` from disk and parse `CFBundleURLTypes` /
 *      `CFBundleURLSchemes` arrays, plus the `LSApplicationQueriesSchemes`
 *      block (which lists deeplink schemes the app intends to OPEN, not
 *      ones it handles — surfaced for completeness).
 *   3. Optionally call `flutter_get_route` to report the current route
 *      so callers can see "deeplink X took us to route Y" without an
 *      extra round trip.
 *
 * The parser handles both XML and binary plist outputs by shelling out
 * to `plutil -convert xml1 -o - <path>` first; binary plists fail
 * silently in pure-JS parsing otherwise.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';
import { ErrorCode, respondWithStructuredError } from '../errors';

const execFileAsync = promisify(execFile);

interface UrlType {
  name?: string;
  role?: string;
  schemes: string[];
}

interface AppRoutesResult {
  bundleId: string;
  deviceId: string;
  appBundlePath: string;
  urlTypes: UrlType[];
  queriesSchemes: string[];
}

async function resolveDeviceId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const sole = getSessionManager().getSoleDeviceId();
  if (sole) return sole;
  try {
    const booted = await new SimulatorManager().listBooted();
    if (booted.length === 1) return booted[0].udid;
  } catch {
    // simctl unavailable
  }
  return null;
}

export async function readAppRoutes(
  deviceId: string,
  bundleId: string,
  runner: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = async (cmd, args) => {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 4 * 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  },
): Promise<AppRoutesResult> {
  const { stdout: containerStdout } = await runner('xcrun', [
    'simctl',
    'get_app_container',
    deviceId,
    bundleId,
    'app',
  ]);
  const appBundlePath = containerStdout.trim();
  if (!appBundlePath) {
    throw new Error(`Could not resolve app bundle path for ${bundleId} on ${deviceId}`);
  }

  // Convert plist to XML so we can parse without a binary-plist library.
  const { stdout: plistXml } = await runner('plutil', [
    '-convert',
    'xml1',
    '-o',
    '-',
    `${appBundlePath}/Info.plist`,
  ]);

  return {
    bundleId,
    deviceId,
    appBundlePath,
    ...parseInfoPlist(plistXml),
  };
}

/** Visible for tests — parses just the URL-related Info.plist subset.
 *
 * Note on regex limitations: a plain non-greedy `<array>([\s\S]*?)</array>`
 * pattern can't match the outer `CFBundleURLTypes` array because the
 * inner per-entry `CFBundleURLSchemes` is itself an `<array>`, and the
 * non-greedy quantifier stops at the FIRST `</array>` — the inner one.
 * We instead bracket-count to find the matching close tag, which keeps
 * the parser robust against arbitrary nesting without pulling in a full
 * XML library. */
export function parseInfoPlist(xml: string): { urlTypes: UrlType[]; queriesSchemes: string[] } {
  const urlTypes: UrlType[] = [];

  const urlTypesBlock = extractArrayBlock(xml, 'CFBundleURLTypes');
  if (urlTypesBlock) {
    for (const dict of extractTopLevelDicts(urlTypesBlock)) {
      const name = extractStringKey(dict, 'CFBundleURLName');
      const role = extractStringKey(dict, 'CFBundleTypeRole');
      const schemes = extractStringArrayKey(dict, 'CFBundleURLSchemes');
      urlTypes.push({
        name: name ?? undefined,
        role: role ?? undefined,
        schemes,
      });
    }
  }

  const queriesSchemes = extractStringArrayKey(xml, 'LSApplicationQueriesSchemes');

  return { urlTypes, queriesSchemes };
}

/** Find `<key>{key}</key>\s*<array>...</array>` and return the inner array
 *  body with nesting correctly handled. */
function extractArrayBlock(xml: string, key: string): string | null {
  const keyIdx = xml.indexOf(`<key>${key}</key>`);
  if (keyIdx < 0) return null;
  const arrayStart = xml.indexOf('<array>', keyIdx);
  if (arrayStart < 0) return null;
  // Walk forward counting <array> openers vs </array> closers.
  let depth = 1;
  let i = arrayStart + '<array>'.length;
  while (i < xml.length && depth > 0) {
    const nextOpen = xml.indexOf('<array>', i);
    const nextClose = xml.indexOf('</array>', i);
    if (nextClose < 0) return null;
    // Treat an empty self-closing <array/> as both open + close in one token.
    const selfClose = xml.indexOf('<array/>', i);
    if (selfClose >= 0 && (nextOpen < 0 || selfClose < nextOpen) && (nextClose < 0 || selfClose < nextClose)) {
      i = selfClose + '<array/>'.length;
      continue;
    }
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + '<array>'.length;
    } else {
      depth -= 1;
      if (depth === 0) {
        return xml.slice(arrayStart + '<array>'.length, nextClose);
      }
      i = nextClose + '</array>'.length;
    }
  }
  return null;
}

/** Pull every top-level `<dict>...</dict>` (or `<dict/>`) span out of the
 *  array body, ignoring dicts inside nested arrays/dicts. */
function extractTopLevelDicts(block: string): string[] {
  const dicts: string[] = [];
  let i = 0;
  while (i < block.length) {
    const start = block.indexOf('<dict>', i);
    if (start < 0) break;
    let depth = 1;
    let j = start + '<dict>'.length;
    while (j < block.length && depth > 0) {
      const nextOpen = block.indexOf('<dict>', j);
      const nextClose = block.indexOf('</dict>', j);
      if (nextClose < 0) return dicts;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        j = nextOpen + '<dict>'.length;
      } else {
        depth -= 1;
        if (depth === 0) {
          dicts.push(block.slice(start + '<dict>'.length, nextClose));
          i = nextClose + '</dict>'.length;
          break;
        }
        j = nextClose + '</dict>'.length;
      }
    }
    if (depth > 0) break;
  }
  return dicts;
}

function extractStringKey(scope: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = scope.match(re);
  return m ? m[1] : null;
}

function extractStringArrayKey(scope: string, key: string): string[] {
  const block = extractArrayBlock(scope, key);
  if (block === null) return [];
  const strings: string[] = [];
  const strRe = /<string>([^<]*)<\/string>/g;
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(block)) !== null) {
    strings.push(sm[1]);
  }
  return strings;
}

export function registerAppListRoutesTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_list_routes',
      description:
        'List the URL schemes the installed app advertises in its Info.plist (CFBundleURLTypes), plus LSApplicationQueriesSchemes. Useful for discovering valid deep-link entry points without trial-and-error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bundleId: { type: 'string', description: 'Target app bundle identifier' },
          deviceId: { type: 'string', description: 'Simulator UDID (defaults to sole booted)' },
        },
        required: ['bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const bundleId = params.bundleId as string;
      const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      if (!deviceId) {
        return respondWithStructuredError(ErrorCode.DEVICE_NOT_BOOTED, 'No booted simulator found. Call device_boot first.');
      }
      try {
        const result = await readAppRoutes(deviceId, bundleId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}
