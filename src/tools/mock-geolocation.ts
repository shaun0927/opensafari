import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerMockGeolocationTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'mock_geolocation',
      description:
        'Mock geolocation coordinates in Safari. Overrides navigator.geolocation so getCurrentPosition and watchPosition return the specified location.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          latitude: {
            type: 'number',
            description: 'Latitude in decimal degrees (-90 to 90)',
          },
          longitude: {
            type: 'number',
            description: 'Longitude in decimal degrees (-180 to 180)',
          },
          accuracy: {
            type: 'number',
            description: 'Accuracy in meters (default: 10)',
          },
          altitude: {
            type: 'number',
            description: 'Altitude in meters above sea level',
          },
        },
        required: ['latitude', 'longitude'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return {
          content: [{ type: 'text' as const, text: 'Error: Safari not connected' }],
          isError: true,
        };

      const coerceFinite = (raw: unknown): number | undefined => {
        if (raw === undefined || raw === null) return undefined;
        if (typeof raw !== 'number') return Number.NaN;
        return Number.isFinite(raw) ? raw : Number.NaN;
      };

      const latitude = coerceFinite(params.latitude);
      const longitude = coerceFinite(params.longitude);
      const accuracyRaw = coerceFinite(params.accuracy);
      const altitude = coerceFinite(params.altitude);

      if (latitude === undefined || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        return {
          content: [{ type: 'text' as const, text: 'Error: latitude must be a finite number between -90 and 90' }],
          isError: true,
        };
      }
      if (longitude === undefined || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return {
          content: [{ type: 'text' as const, text: 'Error: longitude must be a finite number between -180 and 180' }],
          isError: true,
        };
      }
      if (accuracyRaw !== undefined && !Number.isFinite(accuracyRaw)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: accuracy must be a finite number' }],
          isError: true,
        };
      }
      if (altitude !== undefined && !Number.isFinite(altitude)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: altitude must be a finite number' }],
          isError: true,
        };
      }
      const accuracy = accuracyRaw ?? 10;

      const altitudeJs = altitude !== undefined ? String(altitude) : 'null';
      const altitudeAccuracyJs = altitude !== undefined ? '10' : 'null';

      const script = `(function() {
  var mockPosition = {
    coords: {
      latitude: ${latitude},
      longitude: ${longitude},
      accuracy: ${accuracy},
      altitude: ${altitudeJs},
      altitudeAccuracy: ${altitudeAccuracyJs},
      heading: null,
      speed: null
    },
    timestamp: Date.now()
  };

  var nextWatchId = 1;

  navigator.geolocation.getCurrentPosition = function(success) {
    if (typeof success === 'function') {
      setTimeout(function() {
        success(Object.assign({}, mockPosition, { timestamp: Date.now() }));
      }, 0);
    }
  };

  navigator.geolocation.watchPosition = function(success) {
    var watchId = nextWatchId++;
    if (typeof success === 'function') {
      setTimeout(function() {
        success(Object.assign({}, mockPosition, { timestamp: Date.now() }));
      }, 0);
    }
    return watchId;
  };

  navigator.geolocation.clearWatch = function() {};
})()`;

      await client.evaluate(script);

      try {
        // BrowserBackend doesn't expose send() directly; cast needed for WebKit-specific API
        await (client as any).send('Page.addScriptToEvaluateOnLoad', {
          scriptSource: script,
        });
      } catch {
        // Protocol command not supported
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'mocked',
              latitude,
              longitude,
              accuracy,
              altitude: altitude ?? null,
            }),
          },
        ],
      };
    },
  );
}
