import { captureLogsWindow } from '../../src/observability/capture-logs-window';

interface MockSimctl {
  exec: jest.Mock;
}

function makeSimctl(responses: Array<string | Error>): MockSimctl {
  const exec = jest.fn().mockImplementation(() => {
    const next = responses.shift();
    if (next === undefined) return Promise.resolve('[]');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  return { exec };
}

function controlledClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A fake sleep that advances a clock. */
function makeSleep(clock: { advance: (ms: number) => void }) {
  return (ms: number): Promise<void> => {
    clock.advance(ms);
    return Promise.resolve();
  };
}

function logEntry(timestamp: string, composedMessage: string): Record<string, unknown> {
  return {
    timestamp,
    process: 'Runner',
    messageType: 'info',
    composedMessage,
    traceID: `${timestamp}-${composedMessage}`,
  };
}

describe('captureLogsWindow', () => {
  test('stops on silence once no new matching entry arrives for silenceMs', async () => {
    const clock = controlledClock(1_000_000);
    const preOpenAt = clock.now();
    const first = [logEntry('2026-04-23T00:00:00Z', '[UniversalLink] Resolved /detail/abc')];
    const stillFirst = [...first];
    // First poll → 1 new entry. Second poll → same entry (already seen).
    // Third poll → same entry. After `silenceMs`, stop.
    const simctl = makeSimctl([
      JSON.stringify(first),
      JSON.stringify(stillFirst),
      JSON.stringify(stillFirst),
      JSON.stringify(stillFirst),
    ]);

    const result = await captureLogsWindow(
      'TEST-UDID',
      preOpenAt,
      { prerollMs: 2000, silenceMs: 1000, maxDurationMs: 10_000, pollIntervalMs: 400 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    if ('error' in result) {
      throw new Error('unexpected error: ' + result.error);
    }
    expect(result.stopReason).toBe('silence');
    expect(result.entries).toHaveLength(1);
    expect((result.entries[0] as { composedMessage: string }).composedMessage).toMatch(
      /UniversalLink/,
    );
  });

  test('stops on max_duration when entries keep arriving', async () => {
    const clock = controlledClock(1_000_000);
    const preOpenAt = clock.now();
    // Each poll adds a new entry so silence never triggers.
    let counter = 0;
    const responses: string[] = [];
    for (let i = 0; i < 30; i++) {
      counter++;
      responses.push(
        JSON.stringify([logEntry(`2026-04-23T00:00:0${counter}Z`, `entry-${counter}`)]),
      );
    }
    const simctl = makeSimctl(responses);

    const result = await captureLogsWindow(
      'TEST-UDID',
      preOpenAt,
      { prerollMs: 2000, silenceMs: 10_000, maxDurationMs: 3000, pollIntervalMs: 400 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    if ('error' in result) {
      throw new Error('unexpected error: ' + result.error);
    }
    expect(result.stopReason).toBe('max_duration');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  test('windowStart includes the preroll', async () => {
    const clock = controlledClock(2_000_000);
    const preOpenAt = clock.now();
    const simctl = makeSimctl([JSON.stringify([])]);

    const result = await captureLogsWindow(
      'TEST-UDID',
      preOpenAt,
      { prerollMs: 2500, silenceMs: 100, maxDurationMs: 500, pollIntervalMs: 10 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    if ('error' in result) {
      throw new Error('unexpected error: ' + result.error);
    }
    const windowStartMs = Date.parse(result.windowStart);
    expect(preOpenAt - windowStartMs).toBe(2500);
  });

  test('returns error object when simctl rejects (no throw)', async () => {
    const clock = controlledClock(0);
    const simctl = makeSimctl([new Error('simctl spawn failed: permissions')]);

    const result = await captureLogsWindow(
      'TEST-UDID',
      clock.now(),
      { silenceMs: 100, maxDurationMs: 500, pollIntervalMs: 10 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.stopReason).toBe('error');
      expect(result.error).toMatch(/simctl spawn failed/);
    }
  });

  test('passes --predicate when bundleId / search are provided', async () => {
    const clock = controlledClock(5_000_000);
    const simctl = makeSimctl([JSON.stringify([])]);

    await captureLogsWindow(
      'TEST-UDID',
      clock.now(),
      {
        bundleId: 'com.omofictions.omofictionsApp',
        search: '[UniversalLink]',
        silenceMs: 100,
        maxDurationMs: 500,
        pollIntervalMs: 10,
      },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    expect(simctl.exec).toHaveBeenCalled();
    const firstCallArgs = simctl.exec.mock.calls[0][0] as string[];
    const predicateIdx = firstCallArgs.indexOf('--predicate');
    expect(predicateIdx).toBeGreaterThan(-1);
    const predicate = firstCallArgs[predicateIdx + 1];
    expect(predicate).toContain('process == "com.omofictions.omofictionsApp"');
    expect(predicate).toContain('composedMessage CONTAINS "[UniversalLink]"');
  });

  test('does not trip silence exit when simctl openurl took longer than silenceMs before capture began', async () => {
    // preOpenAt is recorded *before* simctl openurl; the capture helper is
    // invoked only after openurl returns. If openurl takes longer than
    // silenceMs (1500ms default), a naive baseline anchored on preOpenAt
    // would fire the silence exit on the very first poll and miss every
    // post-open log. The baseline must therefore be anchored on capture
    // start — this test freezes that invariant.
    const openurlDelayMs = 3000;
    const preOpenAt = 1_000_000;
    const clock = controlledClock(preOpenAt + openurlDelayMs);
    const entries = [logEntry('2026-04-23T00:00:00Z', '[UniversalLink] Resolved /x')];
    const simctl = makeSimctl([
      JSON.stringify(entries),
      JSON.stringify(entries),
      JSON.stringify(entries),
      JSON.stringify(entries),
    ]);

    const result = await captureLogsWindow(
      'TEST-UDID',
      preOpenAt,
      { prerollMs: 2000, silenceMs: 1500, maxDurationMs: 8000, pollIntervalMs: 400 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    if ('error' in result) {
      throw new Error('unexpected error: ' + result.error);
    }
    // The capture must observe the entry at least once — if silence were
    // anchored on preOpenAt, the first-poll delta (openurlDelayMs = 3000ms)
    // would already exceed silenceMs (1500ms) and return an empty entries
    // array with stopReason "silence" before any new-entry observation.
    expect(result.entries.length).toBeGreaterThan(0);
  });

  test('deduplicates entries across polls using traceID + composedMessage', async () => {
    const clock = controlledClock(0);
    const preOpenAt = clock.now();
    const entry = logEntry('2026-04-23T00:00:00Z', '[UniversalLink] Resolved');
    const simctl = makeSimctl([
      JSON.stringify([entry]),
      JSON.stringify([entry, logEntry('2026-04-23T00:00:01Z', '[Auth] refreshed')]),
      JSON.stringify([entry, logEntry('2026-04-23T00:00:01Z', '[Auth] refreshed')]),
    ]);

    const result = await captureLogsWindow(
      'TEST-UDID',
      preOpenAt,
      { silenceMs: 400, maxDurationMs: 5000, pollIntervalMs: 200, prerollMs: 0 },
      { simctl: simctl as unknown as import('../../src/simulator/simctl').SimctlExecutor, now: clock.now, sleep: makeSleep(clock) },
    );

    if ('error' in result) throw new Error(result.error);
    expect(result.entries).toHaveLength(2);
  });
});
