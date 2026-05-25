/**
 * `auth_otp_fetch` — retrieve a one-time password from a developer-side
 * mailbox so OTP-gated logins can be automated end-to-end.
 *
 * Backends supported in this first cut:
 *   mailhog       — GET <baseUrl>/api/v2/messages, scan latest first,
 *                   extract a numeric code matching `codePattern`.
 *   webhook       — GET <baseUrl> and parse the response body. The
 *                   caller's webhook should return JSON `{ code }` or
 *                   any body containing a numeric block that matches
 *                   `codePattern`. Useful for ngrok/inlets sinks that
 *                   re-emit Twilio's webhook payload.
 *   custom        — caller supplies the URL directly and we run the
 *                   same scan against the response body.
 *
 * NOTE: We deliberately do NOT support production Twilio / Auth0 / etc.
 * with API keys — those require secret management and rate-limit
 * coordination that belong in a separate, security-reviewed PR. This
 * tool is for developer/test inboxes only.
 */

import { MCPServer } from '../mcp-server';

const PROVIDERS = ['mailhog', 'webhook', 'custom'] as const;
type Provider = (typeof PROVIDERS)[number];

const DEFAULT_CODE_PATTERN = '\\b\\d{4,8}\\b';

interface FetchResult {
  code: string | null;
  provider: Provider;
  source: 'subject' | 'body' | 'json' | 'none';
  matchedText?: string;
}

async function httpGetJson(url: string, timeoutMs = 5000): Promise<{
  status: number;
  text: string;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function extractCode(haystack: string, codePattern: string): string | null {
  try {
    const re = new RegExp(codePattern);
    const m = haystack.match(re);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function fetchFromMailhog(baseUrl: string, codePattern: string, recipient?: string): Promise<FetchResult> {
  // mailhog v2 API returns { total, items: [ { Content: { Headers: {...}, Body }, Raw: {...} } ] }
  const url = baseUrl.replace(/\/$/, '') + '/api/v2/messages';
  const { status, text } = await httpGetJson(url);
  if (status >= 400) {
    throw new Error(`mailhog responded ${status}`);
  }
  let parsed: { items?: Array<{ Content?: { Headers?: Record<string, string[]>; Body?: string } }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('mailhog: response was not JSON');
  }
  const items = parsed.items ?? [];
  for (const item of items) {
    const headers = item.Content?.Headers ?? {};
    if (recipient) {
      const to = (headers.To ?? []).join(',');
      if (!to.toLowerCase().includes(recipient.toLowerCase())) continue;
    }
    const subject = (headers.Subject ?? []).join(' ');
    const fromSubject = extractCode(subject, codePattern);
    if (fromSubject) {
      return { code: fromSubject, provider: 'mailhog', source: 'subject', matchedText: subject };
    }
    const body = item.Content?.Body ?? '';
    const fromBody = extractCode(body, codePattern);
    if (fromBody) {
      return { code: fromBody, provider: 'mailhog', source: 'body', matchedText: body.slice(0, 120) };
    }
  }
  return { code: null, provider: 'mailhog', source: 'none' };
}

async function fetchFromWebhookOrCustom(
  url: string,
  codePattern: string,
  provider: Provider,
): Promise<FetchResult> {
  const { status, text } = await httpGetJson(url);
  if (status >= 400) {
    throw new Error(`${provider}: responded ${status}`);
  }
  // Try to read JSON `{ code }` first.
  try {
    const parsed = JSON.parse(text) as { code?: string | number };
    if (parsed && (typeof parsed.code === 'string' || typeof parsed.code === 'number')) {
      return { code: String(parsed.code), provider, source: 'json' };
    }
  } catch {
    // Not JSON — fall through to regex scan
  }
  const m = extractCode(text, codePattern);
  return m
    ? { code: m, provider, source: 'body', matchedText: text.slice(0, 120) }
    : { code: null, provider, source: 'none' };
}

export function registerAuthOtpFetchTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'auth_otp_fetch',
      description:
        'Retrieve a one-time password from a developer-side mailbox so OTP-gated logins can be automated end-to-end. Supports mailhog, webhook (returns { code }), and custom URL providers. NOT for production Twilio / Auth0 — those require secret management out of scope here.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          provider: { type: 'string', enum: [...PROVIDERS], description: 'mailhog | webhook | custom' },
          baseUrl: { type: 'string', description: 'Base URL of the mailbox or webhook' },
          recipient: { type: 'string', description: 'Filter by To: header (mailhog only)' },
          codePattern: {
            type: 'string',
            description: `Regex matching the OTP digits (default: ${DEFAULT_CODE_PATTERN}).`,
          },
          timeoutMs: { type: 'number', description: 'HTTP timeout (default 5000)' },
        },
        required: ['provider', 'baseUrl'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const provider = params.provider as Provider | undefined;
      if (!provider || !PROVIDERS.includes(provider)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_PROVIDER', allowed: PROVIDERS }) }],
          isError: true,
        };
      }
      const baseUrl = params.baseUrl as string | undefined;
      if (!baseUrl) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'MISSING_BASE_URL' }) }],
          isError: true,
        };
      }
      const codePattern = (params.codePattern as string | undefined) ?? DEFAULT_CODE_PATTERN;
      const recipient = params.recipient as string | undefined;

      try {
        let result: FetchResult;
        if (provider === 'mailhog') {
          result = await fetchFromMailhog(baseUrl, codePattern, recipient);
        } else {
          result = await fetchFromWebhookOrCustom(baseUrl, codePattern, provider);
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: result.code === null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'OTP_FETCH_FAILED', provider, message }),
          }],
          isError: true,
        };
      }
    },
  );
}

/** Visible for tests. */
export const __forTests = { extractCode };
