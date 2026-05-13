import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { ActionTraceRecorder, normalizeEvent, sanitizeMetadata } from '../../src/observability/action-trace';

describe('action trace artifacts', () => {
  it('normalizes timing and duration', () => {
    const event = normalizeEvent({
      action: 'tap',
      status: 'passed',
      startedAtMs: 100,
      endedAtMs: 350,
    });
    expect(event.durationMs).toBe(250);
    expect(event.context).toBe('unknown');
  });

  it('redacts secret-like metadata keys recursively', () => {
    expect(sanitizeMetadata({
      authorization: 'Bearer secret',
      nested: { password: 'pw', ok: 'value' },
    })).toEqual({
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', ok: 'value' },
    });
  });

  it('writes bounded JSON trace documents', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opensafari-trace-'));
    const tracePath = path.join(dir, 'trace.json');
    const recorder = new ActionTraceRecorder('run-1');
    recorder.record({
      action: 'navigate',
      status: 'timeout',
      context: 'webkit',
      deviceId: 'device-1',
      startedAtMs: 0,
      endedAtMs: 10,
      timeoutMs: 10,
      error: 'timed out',
      metadata: { token: 'secret', url: 'https://example.com' },
    });

    await recorder.write(tracePath);
    const parsed = JSON.parse(readFileSync(tracePath, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].metadata.token).toBe('[REDACTED]');
  });
});
