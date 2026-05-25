import { MCPServer, getWebKitClient } from '../mcp-server';
import { AuthManager } from '../auth/manager';
import { NativeAuthManager } from '../auth/native-manager';
import { Cookie } from '../types/browser-backend';
import { getSessionManager } from '../session-manager';
import { SimulatorManager } from '../simulator';

export function registerAuthTools(server: MCPServer): void {
  const authManager = new AuthManager();
  const nativeAuth = new NativeAuthManager();

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

  // ── Native (iOS Simulator app) auth ──────────────────────────────────
  // These complement the WebKit/Safari tools above: they capture and
  // restore an app's data container (and optionally the keychain) so
  // Flutter native apps don't have to log in again every test run.

  server.registerTool(
    {
      name: 'auth_save_native',
      description:
        'Capture the iOS Simulator app\'s data container (and optionally the keychain) for later restore. Use this for Flutter / native apps whose login state lives in plist/sqlite/keychain rather than in Safari cookies.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          profile: { type: 'string', description: 'Profile name to save under' },
          bundleId: { type: 'string', description: 'Bundle ID of the target app (e.g. "com.example.myapp")' },
          deviceId: { type: 'string', description: 'Simulator UDID (defaults to the sole booted device)' },
          includeKeychain: {
            type: 'boolean',
            description: 'Also capture the device-wide Keychain DB. Requires temporarily shutting the simulator down.',
          },
        },
        required: ['profile', 'bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const profile = params.profile as string;
        const bundleId = params.bundleId as string;
        const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
        if (!deviceId) {
          return { content: [{ type: 'text' as const, text: 'Error: no booted device found' }], isError: true };
        }
        const includeKeychain = Boolean(params.includeKeychain);
        const saved = await nativeAuth.save(deviceId, bundleId, profile, { includeKeychain });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              saved: true,
              profile: saved.profile,
              bundleId: saved.bundleId,
              deviceUdid: saved.deviceUdid,
              containerArchive: saved.containerArchive,
              keychainCaptured: Boolean(saved.keychainArchive),
              savedAt: saved.savedAt,
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    {
      name: 'auth_restore_native',
      description:
        'Restore a previously captured native app auth profile back into the simulator. Terminates the app, wipes its data container, untars the saved state, and (optionally) re-launches.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          profile: { type: 'string' },
          bundleId: { type: 'string' },
          deviceId: { type: 'string', description: 'Simulator UDID (defaults to the sole booted device)' },
          relaunch: { type: 'boolean', description: 'Launch the app after restore' },
        },
        required: ['profile', 'bundleId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const profile = params.profile as string;
        const bundleId = params.bundleId as string;
        const deviceId = await resolveDeviceId(params.deviceId as string | undefined);
        if (!deviceId) {
          return { content: [{ type: 'text' as const, text: 'Error: no booted device found' }], isError: true };
        }
        const data = await nativeAuth.restore(deviceId, bundleId, profile, {
          relaunch: Boolean(params.relaunch),
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              restored: true,
              profile: data.profile,
              bundleId: data.bundleId,
              deviceUdid: deviceId,
              keychainRestored: Boolean(data.keychainArchive),
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    {
      name: 'auth_list_native',
      description: 'List all saved native iOS app auth profiles',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    async () => {
      try {
        const profiles = await nativeAuth.list();
        return { content: [{ type: 'text' as const, text: JSON.stringify(profiles.map((p) => ({
          profile: p.profile,
          bundleId: p.bundleId,
          deviceUdid: p.deviceUdid,
          savedAt: p.savedAt,
          hasKeychain: Boolean(p.keychainArchive),
        }))) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    {
      name: 'auth_delete_native',
      description: 'Delete a saved native iOS app auth profile',
      inputSchema: {
        type: 'object' as const,
        properties: {
          profile: { type: 'string' },
        },
        required: ['profile'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        await nativeAuth.delete(params.profile as string);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, profile: params.profile }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

/** Pick a simulator UDID: explicit param wins, otherwise fall back to the
 *  sole booted device (single-device flows) or the SessionManager's sole
 *  registered device. Returns null when ambiguous. */
async function resolveDeviceId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const sm = getSessionManager();
  const sole = sm.getSoleDeviceId();
  if (sole) return sole;
  try {
    const booted = await new SimulatorManager().listBooted();
    if (booted.length === 1) return booted[0].udid;
  } catch {
    // simctl unavailable — caller must supply deviceId
  }
  return null;
}
