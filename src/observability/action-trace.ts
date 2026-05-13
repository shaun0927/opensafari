import { promises as fs } from 'fs';
import * as path from 'path';

export type ActionTraceStatus = 'passed' | 'failed' | 'timeout' | 'skipped';
export type ActionTraceContext = 'webkit' | 'native' | 'flutter' | 'simulator' | 'orchestration' | 'unknown';

export interface ActionTraceArtifact {
  kind: 'screenshot' | 'console' | 'network' | 'crash' | 'log' | 'other';
  path: string;
}

export interface ActionTraceEventInput {
  action: string;
  status: ActionTraceStatus;
  context?: ActionTraceContext;
  deviceId?: string;
  startedAtMs: number;
  endedAtMs: number;
  timeoutMs?: number;
  retryCount?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  artifacts?: ActionTraceArtifact[];
}

export interface ActionTraceEvent extends ActionTraceEventInput {
  durationMs: number;
}

export interface ActionTraceDocument {
  version: 1;
  runId: string;
  createdAt: string;
  events: ActionTraceEvent[];
}

const MAX_STRING_LENGTH = 500;
const MAX_METADATA_KEYS = 30;
const SECRET_KEY_PATTERN = /(authorization|cookie|password|secret|token|credential|api[-_]?key)/i;

export class ActionTraceRecorder {
  private readonly events: ActionTraceEvent[] = [];
  private readonly createdAt = new Date().toISOString();

  constructor(private readonly runId: string) {}

  record(input: ActionTraceEventInput): void {
    this.events.push(normalizeEvent(input));
  }

  toJSON(): ActionTraceDocument {
    return {
      version: 1,
      runId: this.runId,
      createdAt: this.createdAt,
      events: [...this.events],
    };
  }

  async write(filePath: string): Promise<void> {
    await writeActionTrace(filePath, this.toJSON());
  }
}

export async function writeActionTrace(
  filePath: string,
  document: ActionTraceDocument,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(document, null, 2) + '\n', 'utf8');
}

export function normalizeEvent(input: ActionTraceEventInput): ActionTraceEvent {
  const startedAtMs = finiteOrZero(input.startedAtMs);
  const endedAtMs = Math.max(startedAtMs, finiteOrZero(input.endedAtMs));
  return {
    action: truncate(input.action || 'unknown'),
    status: input.status,
    context: input.context ?? 'unknown',
    ...(input.deviceId ? { deviceId: truncate(input.deviceId) } : {}),
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: Math.max(0, input.timeoutMs) } : {}),
    ...(typeof input.retryCount === 'number' ? { retryCount: Math.max(0, Math.floor(input.retryCount)) } : {}),
    ...(input.error ? { error: truncate(input.error) } : {}),
    ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts.slice(0, 20).map(sanitizeArtifact) } : {}),
  };
}

export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).slice(0, MAX_METADATA_KEYS)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeValue(metadata[key]);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return String(value);
}

function sanitizeArtifact(artifact: ActionTraceArtifact): ActionTraceArtifact {
  return {
    kind: artifact.kind,
    path: truncate(artifact.path),
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…`
    : value;
}
