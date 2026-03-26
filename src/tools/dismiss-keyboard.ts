import { MCPServer, getWebKitClient } from '../mcp-server';

export function registerDismissKeyboardTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'dismiss_keyboard',
      description: 'Dismiss the on-screen keyboard in Safari on iOS Simulator',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async (_sessionId: string, _params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      await client.dismissKeyboard();
      return { content: [{ type: 'text' as const, text: 'keyboard dismissed' }] };
    },
  );
}
