import { MCPServer, getWebKitClient } from '../mcp-server';
import { AuthManager } from '../auth/manager';

export function registerAuthTools(server: MCPServer): void {
  const authManager = new AuthManager();

  server.registerTool(
    {
      name: 'auth_save',
      description: 'Save the current Safari session (cookies, localStorage) for a site',
      inputSchema: {
        type: 'object' as const,
        properties: {
          site: { type: 'string', description: 'Site domain to save auth for (e.g. "github.com")' },
        },
        required: ['site'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      try {
        const filePath = await authManager.save(params.site as string, client);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true, site: params.site, filePath }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    {
      name: 'auth_restore',
      description: 'Restore a previously saved auth session (cookies, localStorage) for a site',
      inputSchema: {
        type: 'object' as const,
        properties: {
          site: { type: 'string', description: 'Site domain to restore auth for (e.g. "github.com")' },
        },
        required: ['site'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const client = getWebKitClient();
      if (!client)
        return { content: [{ type: 'text' as const, text: 'Error: Safari not connected' }], isError: true };
      try {
        await authManager.restore(params.site as string, client);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ restored: true, site: params.site }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    {
      name: 'auth_list',
      description: 'List all saved auth profiles',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async () => {
      try {
        const profiles = await authManager.list();
        return { content: [{ type: 'text' as const, text: JSON.stringify(profiles) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
