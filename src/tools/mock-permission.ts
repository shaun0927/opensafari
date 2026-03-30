import { MCPServer, getWebKitClient } from '../mcp-server';

const VALID_PERMISSIONS = ['geolocation', 'camera', 'microphone', 'notifications'] as const;
type PermissionName = typeof VALID_PERMISSIONS[number];

const VALID_STATES = ['granted', 'denied', 'prompt'] as const;
type PermissionState = typeof VALID_STATES[number];

export function registerMockPermissionTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'mock_permission',
      description:
        'Mock browser permission states in Safari. Overrides navigator.permissions.query to return the specified state for the given permission. Supports multiple permissions by calling the tool repeatedly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          permission: {
            type: 'string',
            enum: ['geolocation', 'camera', 'microphone', 'notifications'],
            description: 'Permission type to mock',
          },
          state: {
            type: 'string',
            enum: ['granted', 'denied', 'prompt'],
            description: 'Permission state to return',
          },
        },
        required: ['permission', 'state'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return {
          content: [{ type: 'text' as const, text: 'Error: Safari not connected' }],
          isError: true,
        };

      const permission = params.permission as string;
      const state = params.state as string;

      if (!VALID_PERMISSIONS.includes(permission as PermissionName)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: invalid permission "${permission}". Must be one of: ${VALID_PERMISSIONS.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      if (!VALID_STATES.includes(state as PermissionState)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: invalid state "${state}". Must be one of: ${VALID_STATES.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const script = `(function() {
  if (!window.__opensafariPermissionMocks) {
    window.__opensafariPermissionMocks = {};
    var originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(descriptor) {
      var name = descriptor && descriptor.name;
      if (name && window.__opensafariPermissionMocks[name] !== undefined) {
        var mockState = window.__opensafariPermissionMocks[name];
        return Promise.resolve({
          state: mockState,
          name: name,
          onchange: null,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; }
        });
      }
      return originalQuery(descriptor);
    };
  }
  window.__opensafariPermissionMocks[${JSON.stringify(permission)}] = ${JSON.stringify(state)};
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
              permission,
              state,
            }),
          },
        ],
      };
    },
  );
}
