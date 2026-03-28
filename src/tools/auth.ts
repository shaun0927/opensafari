import { MCPServer, getWebKitClient } from '../mcp-server';
import { AuthManager } from '../auth/manager';
import { Cookie } from '../types/browser-backend';

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
        const site = params.site as string;
        const cookies = await client.getCookies();
        const domainCookies = cookies.filter((c: Cookie) => {
          const cd = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          return cd === site || site.endsWith('.' + cd);
        });
        if (domainCookies.length === 0) {
          return { content: [{ type: 'text' as const, text: `Error: No cookies found for domain "${site}"` }], isError: true };
        }
        const filePath = await authManager.save(site, client, domainCookies);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true, site, cookieCount: domainCookies.length, filePath }) }] };
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
        const site = params.site as string;
        // Check expiry before restoring
        let expiryWarning: string | undefined;
        try {
          const expiry = await authManager.checkExpiry(site);
          if (expiry.isExpired) {
            expiryWarning = `Warning: ${expiry.expiredCount} of ${expiry.totalCookies} cookies have expired`;
          } else if (expiry.isExpiring) {
            expiryWarning = `Warning: ${expiry.expiringCount} of ${expiry.totalCookies} cookies are expiring soon`;
          }
        } catch {
          // Profile doesn't exist — restore will throw its own error
        }
        await authManager.restore(site, client);
        const result: Record<string, unknown> = { restored: true, site };
        if (expiryWarning) result.warning = expiryWarning;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
