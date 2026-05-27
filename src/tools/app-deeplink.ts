import { MCPServer } from '../mcp-server';
import { SimctlExecutor } from '../simulator/simctl';
import { resolveDeviceId } from './native-app-helpers';
import { ErrorCode, respondWithStructuredError } from '../errors';
import {
  captureLogsWindow,
  type CaptureLogsOptions,
} from '../observability/capture-logs-window';
import { getFlutterVMClient } from '../flutter';
import { __forTests as flutterRouteUtils } from './flutter-get-route';

export function registerAppDeeplinkTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_deeplink',
      description:
        'Open deep links or universal links in the iOS Simulator. Supports custom URL schemes (myapp://path) and universal links (https://...). Optionally returns unified-log entries around the open event via `captureLogs` (see docs/recipes/universal-link-channels.md).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'Deep link URL (custom scheme or universal link)',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
          captureLogs: {
            type: 'object',
            description:
              'If provided, synchronously captures os_log entries around the deep-link open. Collection stops after `silenceMs` with no new matching entry, or `maxDurationMs` elapses.',
            properties: {
              bundleId: { type: 'string' },
              level: { type: 'string', enum: ['default', 'info', 'debug', 'error', 'fault'] },
              search: { type: 'string' },
              prerollMs: { type: 'number' },
              silenceMs: { type: 'number' },
              maxDurationMs: { type: 'number' },
            },
          },
          expectRoute: {
            type: 'string',
            description:
              'After opening the URL, poll flutter_get_route until the current route name matches this string (substring or exact). Requires an active flutter_connect. Fails the call with EXPECTED_ROUTE_MISMATCH if the route does not appear within expectRouteTimeoutMs.',
          },
          expectRouteTimeoutMs: {
            type: 'number',
            description: 'Timeout (ms) for the expectRoute poll. Default 5000.',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const url = params.url as string;

      if (!url) {
        return respondWithStructuredError(ErrorCode.MISSING_REQUIRED_PARAM, 'url is required');
      }

      // Basic URL validation — must contain a scheme
      if (!url.includes('://')) {
        return respondWithStructuredError(
          ErrorCode.INVALID_URL,
          'invalid URL — must include a scheme (e.g. https:// or myapp://)',
        );
      }

      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return respondWithStructuredError(
          ErrorCode.DEVICE_NOT_BOOTED,
          (err as Error).message,
        );
      }

      try {
        const simctl = new SimctlExecutor();
        const preOpenAt = Date.now();
        await simctl.exec(['openurl', deviceId, url]);

        const result: Record<string, unknown> = {
          url,
          deviceId,
          openedAt: new Date(preOpenAt).toISOString(),
        };

        const captureLogsOpts = params.captureLogs as CaptureLogsOptions | undefined;
        if (captureLogsOpts && typeof captureLogsOpts === 'object') {
          result.logs = await captureLogsWindow(deviceId, preOpenAt, captureLogsOpts, { simctl });
        }

        const expectRoute = params.expectRoute as string | undefined;
        if (expectRoute) {
          const timeoutMs = Math.max(
            500,
            Number(params.expectRouteTimeoutMs) || 5000,
          );
          const verification = await pollForRoute(deviceId, expectRoute, timeoutMs);
          result.expectRoute = verification;
          if (!verification.matched) {
            return respondWithStructuredError(
              ErrorCode.APP_STATE_UNKNOWN,
              'Expected route not reached after deeplink',
              { ...result },
            );
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        return respondWithStructuredError(
          ErrorCode.FLUTTER_EVAL_FAILED,
          `failed to open URL "${url}": ${(err as Error).message}`,
          { url },
        );
      }
    },
  );
}

/**
 * Poll `flutter_get_route` until the current route name matches `expected`
 * (substring) or the timeout fires. Returns a structured result the
 * deeplink handler can merge into its payload. Tolerant of missing
 * Flutter VM service — the caller decides whether that means abort or
 * just skip verification.
 */
async function pollForRoute(
  deviceId: string,
  expected: string,
  timeoutMs: number,
): Promise<{ matched: boolean; lastName: string | null; source: string; elapsedMs: number }> {
  const client = getFlutterVMClient(deviceId);
  if (!client.isConnected()) {
    return {
      matched: false,
      lastName: null,
      source: 'no_flutter',
      elapsedMs: 0,
    };
  }
  const started = Date.now();
  let lastName: string | null = null;
  let lastSource = 'unknown';
  while (Date.now() - started < timeoutMs) {
    try {
      const evalResult = await client.evaluate(flutterRouteUtils.ROUTE_EXPRESSION);
      const raw = (evalResult as { valueAsString?: string }).valueAsString ?? '';
      const route = flutterRouteUtils.parseRoutePayload(raw);
      lastName = route.name;
      lastSource = route.source;
      if (lastName && lastName.includes(expected)) {
        return {
          matched: true,
          lastName,
          source: lastSource,
          elapsedMs: Date.now() - started,
        };
      }
    } catch {
      // ignore single-poll errors — loop will retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    matched: false,
    lastName,
    source: lastSource,
    elapsedMs: Date.now() - started,
  };
}
