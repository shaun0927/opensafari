import { traceToolHandler } from '../../src/server/tool-trace';
import { ToolHandler } from '../../src/types/mcp';

// Capture console.error calls during tests
function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return fn()
    .then(() => {
      console.error = original;
      return lines;
    })
    .catch((err) => {
      console.error = original;
      throw err;
    });
}

describe('traceToolHandler', () => {
  const successHandler: ToolHandler = async (_sid, _args) => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  });

  const failingHandler: ToolHandler = async (_sid, _args) => {
    throw new Error('boom');
  };

  beforeEach(() => {
    delete process.env.OPENSAFARI_TRACE;
  });

  afterEach(() => {
    delete process.env.OPENSAFARI_TRACE;
  });

  test('emits entry and exit lines on success path', async () => {
    const wrapped = traceToolHandler('my_tool', successHandler);
    const lines = await captureStderr(async () => {
      await wrapped('sess1', { foo: 'bar' });
    });

    const entry = lines.find((l) => l.includes('[mcp] ->') && l.includes('my_tool'));
    const exit = lines.find((l) => l.includes('[mcp] <-') && l.includes('my_tool'));
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(exit).toMatch(/ms=\d+/);
  });

  test('emits entry and error lines on failure path; original error propagates', async () => {
    const wrapped = traceToolHandler('my_tool', failingHandler);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    await expect(wrapped('sess1', {})).rejects.toThrow('boom');
    console.error = original;

    const entry = lines.find((l) => l.includes('[mcp] ->') && l.includes('my_tool'));
    const errLine = lines.find((l) => l.includes('[mcp] !!') && l.includes('my_tool'));
    expect(entry).toBeDefined();
    expect(errLine).toBeDefined();
    expect(errLine).toMatch(/ms=\d+/);
    expect(errLine).toMatch(/err=boom/);
  });

  test('OPENSAFARI_TRACE=1 adds args line on entry', async () => {
    // Re-require the module with OPENSAFARI_TRACE set so the module-level
    // constant picks it up. Jest module isolation is per test file,
    // so we set the env before importing via jest.resetModules.
    jest.resetModules();
    process.env.OPENSAFARI_TRACE = '1';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { traceToolHandler: traceFresh } = require('../../src/server/tool-trace') as typeof import('../../src/server/tool-trace');

    const wrapped = traceFresh('traced_tool', successHandler);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    await wrapped('sess', { key: 'value' });
    console.error = original;

    const argsLine = lines.find((l) => l.includes('[mcp] args') && l.includes('traced_tool'));
    expect(argsLine).toBeDefined();
    expect(argsLine).toMatch(/key=/);
  });

  test('request id is unique per call', async () => {
    const wrapped = traceToolHandler('unique_tool', successHandler);
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const lines = await captureStderr(async () => {
        await wrapped('sess', {});
      });
      const entry = lines.find((l) => l.includes('[mcp] ->') && l.includes('unique_tool'));
      const match = entry?.match(/req=([0-9a-f]{8})/);
      expect(match).toBeTruthy();
      if (match) ids.push(match[1]);
    }

    const unique = new Set(ids);
    // With 5 calls and 8-hex-char ids there is negligible probability of collision
    expect(unique.size).toBe(5);
  });
});
