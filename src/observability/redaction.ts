/**
 * Lightweight regex-based redaction for the `debug_bundle_collect` tool.
 *
 * The intent is *not* to be a comprehensive secret scanner. The intent is
 * to keep agent-visible bundles free of the credentials that most often
 * leak through logs and environment snapshots — Bearer tokens in HTTP
 * headers, raw JWTs, and a small allowlist of "looks like a credential"
 * environment-variable names.
 *
 * Each redact() call returns the redacted text and a list of redaction
 * tags (`logs.bearer`, `logs.jwt`, `env.AUTHORIZATION`) that the bundle
 * surfaces in `redactions.applied` so the caller can audit what was
 * scrubbed.
 */

export const REDACTION_POLICY_VERSION = 'default-v1';

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-+/=]+/g;
const AUTHORIZATION_HEADER_PATTERN = /Authorization:\s*\S+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// AWS-style access keys + GitHub PAT prefixes — high-value, low-false-positive.
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;

const SENSITIVE_ENV_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|credential|authorization|cookie|session)/i;

export interface RedactionResult {
  text: string;
  applied: string[];
}

/**
 * Redact a text payload. The returned `applied` list is *unique*, so a
 * file that scrubbed 30 bearer tokens still surfaces as `logs.bearer`
 * once with `count >= 1`.
 */
export function redactText(input: string, tagPrefix = 'text'): RedactionResult {
  const applied = new Set<string>();
  let out = input;

  const apply = (pattern: RegExp, tag: string, replacement: string) => {
    const matched = out.match(pattern);
    if (matched && matched.length > 0) {
      applied.add(`${tagPrefix}.${tag}`);
      out = out.replace(pattern, replacement);
    }
  };

  apply(BEARER_PATTERN, 'bearer', 'Bearer [REDACTED]');
  apply(AUTHORIZATION_HEADER_PATTERN, 'authorization_header', 'Authorization: [REDACTED]');
  apply(JWT_PATTERN, 'jwt', '[REDACTED_JWT]');
  apply(AWS_ACCESS_KEY_PATTERN, 'aws_access_key', '[REDACTED_AWS_KEY]');
  apply(GITHUB_TOKEN_PATTERN, 'github_token', '[REDACTED_GH_TOKEN]');

  return { text: out, applied: Array.from(applied) };
}

/**
 * Redact a string-valued env map. Returns a fresh object — never mutates
 * the input. Keys whose name matches `SENSITIVE_ENV_KEY_PATTERN` are
 * replaced with `'[REDACTED]'`; the original key remains visible so the
 * agent can tell *what* was scrubbed.
 */
export function redactEnvMap(env: Record<string, string>): RedactionResult {
  const applied = new Set<string>();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
      applied.add(`env.${key}`);
      continue;
    }
    const inner = redactText(value, `env.${key}`);
    out[key] = inner.text;
    for (const tag of inner.applied) applied.add(tag);
  }
  return { text: JSON.stringify(out), applied: Array.from(applied) };
}

/**
 * Same shape but applied to a free-form object (e.g. a diagnose report).
 * String leaves are scrubbed in-place; other types are returned as-is.
 */
export function redactObject<T>(value: T, tagPrefix = 'object'): { value: T; applied: string[] } {
  const applied = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = redactText(node, tagPrefix);
      for (const tag of r.applied) applied.add(tag);
      return r.text;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (SENSITIVE_ENV_KEY_PATTERN.test(k) && typeof v === 'string') {
          out[k] = '[REDACTED]';
          applied.add(`${tagPrefix}.${k}`);
          continue;
        }
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value) as T, applied: Array.from(applied) };
}
