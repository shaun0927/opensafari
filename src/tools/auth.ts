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
          additionalDomains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional domains to capture cookies for (e.g. SSO/OAuth providers like "auth0.com")',
          },
          captureAll: {
            type: 'boolean',
            description: 'Capture all cookies regardless of domain (recommended for complex SSO/OAuth flows)',
          },
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
        const additionalDomains = params.additionalDomains as string[] | undefined;
        const captureAll = params.captureAll as boolean | undefined;

        const allCookies = await client.getCookies();

        let selectedCookies: Cookie[];
        if (captureAll) {
          selectedCookies = allCookies;
        } else {
          const domains = [site, ...(additionalDomains ?? [])];
          selectedCookies = allCookies.filter((c: Cookie) => {
            const cd = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
            return domains.some(d => cd === d || d.endsWith('.' + cd));
          });
        }

        if (selectedCookies.length === 0) {
          return { content: [{ type: 'text' as const, text: `Error: No cookies found for domain "${site}"` }], isError: true };
        }

        const filePath = await authManager.save(site, client, selectedCookies);
        const cookieDomains = [...new Set(selectedCookies.map(c => {
          const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          return d;
        }))];
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true, site, cookieCount: selectedCookies.length, domains: cookieDomains, filePath }) }] };
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
