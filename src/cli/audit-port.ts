const DEFAULT_AUDIT_PROXY_PORT = 9322;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parsePortValue(raw: string | number): number {
  if (typeof raw === 'number') {
    if (isValidPort(raw)) return raw;
    throw new Error(`Invalid port value: ${String(raw)}`);
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid port value: ${raw}`);
  }

  const parsed = Number(raw);
  if (isValidPort(parsed)) return parsed;
  throw new Error(`Invalid port value: ${raw}`);
}

export function parseAuditProxyPort(raw: string): number {
  return parsePortValue(raw);
}

export function resolveAuditProxyPort(optionPort?: number, envPortRaw?: string): number {
  if (optionPort !== undefined) {
    return parsePortValue(optionPort);
  }
  if (envPortRaw !== undefined && envPortRaw !== '') {
    return parsePortValue(envPortRaw);
  }
  return DEFAULT_AUDIT_PROXY_PORT;
}
