import { MCPServer, getWebKitClient } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';

export type ThrottleProfile = 'slow-3g' | 'fast-3g' | '4g' | 'wifi' | 'none';

export interface ThrottleConfig {
  latencyMs: number;
}

export const THROTTLE_PROFILES: Record<ThrottleProfile, ThrottleConfig> = {
  'slow-3g': { latencyMs: 2000 },
  'fast-3g': { latencyMs: 560 },
  '4g': { latencyMs: 170 },
  'wifi': { latencyMs: 40 },
  'none': { latencyMs: 0 },
};

let activeProfile: ThrottleProfile = 'none';

export function getActiveProfile(): ThrottleProfile {
  return activeProfile;
}

function buildThrottleScript(config: ThrottleConfig): string {
  if (config.latencyMs === 0) {
    // Remove throttling — restore originals
    return '(function(){if(window.__osOriginalFetchThrottle){window.fetch=window.__osOriginalFetchThrottle;delete window.__osOriginalFetchThrottle}if(window.__osOriginalXHRSendThrottle){XMLHttpRequest.prototype.send=window.__osOriginalXHRSendThrottle;delete window.__osOriginalXHRSendThrottle}delete window.__osThrottleLatency})()';
  }

  const latency = config.latencyMs;
  return '(function(){window.__osThrottleLatency=' + latency + ';if(!window.__osOriginalFetchThrottle){window.__osOriginalFetchThrottle=window.fetch.bind(window)}if(!window.__osOriginalXHRSendThrottle){window.__osOriginalXHRSendThrottle=XMLHttpRequest.prototype.send}window.fetch=function(input,init){var lat=window.__osThrottleLatency||0;return new Promise(function(resolve){setTimeout(function(){resolve(window.__osOriginalFetchThrottle(input,init))},lat)})};XMLHttpRequest.prototype.send=function(){var self=this;var args=arguments;var lat=window.__osThrottleLatency||0;var origSend=window.__osOriginalXHRSendThrottle;setTimeout(function(){origSend.apply(self,args)},lat)}})()';
}

export function registerNetworkThrottleTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'network_throttle',
      description:
        'Simulate network latency conditions. Adds latency to all fetch/XHR requests. ' +
        'Profiles: slow-3g (2s latency), fast-3g (560ms), 4g (170ms), wifi (40ms), none (disable). ' +
        'Note: throttling is lost on page navigation. Re-apply after navigating.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          profile: {
            type: 'string',
            enum: ['slow-3g', 'fast-3g', '4g', 'wifi', 'none'],
            description: 'Network latency profile to simulate',
          },
        },
        required: ['profile'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return respondWithStructuredError(ErrorCode.BACKEND_NOT_CONNECTED, 'Safari not connected');

      const profile = params.profile as ThrottleProfile;
      const config = THROTTLE_PROFILES[profile];
      if (!config) {
        return respondWithStructuredError(ErrorCode.INVALID_INPUT, `Unknown profile "${profile}"`);
      }

      try {
        await client.evaluate(buildThrottleScript(config));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, `Failed to inject throttle script: ${message}`);
      }
      activeProfile = profile;

      if (profile === 'none') {
        return { content: [{ type: 'text' as const, text: 'Network throttling disabled' }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: 'Network throttled to ' + profile + ' (latency: ' + config.latencyMs + 'ms)',
        }],
      };
    },
  );
}
