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

      const latitude = params.latitude as number;
      const longitude = params.longitude as number;
      const accuracy = (params.accuracy as number) ?? 10;
      const altitude = params.altitude as number | undefined;

      if (latitude < -90 || latitude > 90) {
        return {
          content: [{ type: 'text' as const, text: 'Error: latitude must be between -90 and 90' }],
          isError: true,
        };
      }
      if (longitude < -180 || longitude > 180) {
        return {
          content: [{ type: 'text' as const, text: 'Error: longitude must be between -180 and 180' }],
          isError: true,
        };
      }

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

  navigator.geolocation.getCurrentPosition = function(success) {
    if (typeof success === 'function') {
      success(Object.assign({}, mockPosition, { timestamp: Date.now() }));
    }
  };

  navigator.geolocation.watchPosition = function(success) {
    if (typeof success === 'function') {
      success(Object.assign({}, mockPosition, { timestamp: Date.now() }));
    }
    return 1;
  };

  navigator.geolocation.clearWatch = function() {};
})()`;

      await client.evaluate(script);

      try {
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
