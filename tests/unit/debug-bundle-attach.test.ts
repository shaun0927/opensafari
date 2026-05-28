/**
 * #798 PR2 — action-failure auto-attach tests.
 *
 * Pins the gating contract of `maybeAttachDebugBundle` and the
 * `wrapHandlerForBundle` decorator so the 5 wired action tools can
 * rely on consistent behaviour.
 */

import type { MCPResult } from '../../src/types/mcp';

jest.mock('../../src/tools/debug-bundle-collect', () => ({
  collectDebugBundle: jest.fn(async () => ({
    schemaVersion: '1',
    collectedAt: '2026-05-27T00:00:00.000Z',
    device: { udid: 'DEV-1' },
    session: { soleDeviceId: 'DEV-1' },
    diagnose: { memory: {} },
    screenshot: { skipped: true },
    ax: { skipped: true },
    logs: { skipped: true },
    crashes: { skipped: true },
    flutter: { skipped: true },
    network: { skipped: true },
    actionTrace: [],
    redactions: { applied: [], policy: 'default-v1' },
  })),
}));

import { maybeAttachDebugBundle, wrapHandlerForBundle } from '../../src/tools/debug-bundle-attach';

function errorResponse(code: string, extra: Record<string, unknown> = {}): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: code,
          message: 'failure',
          recoverable: true,
          suggestion: 'retry',
          ...extra,
        }),
      },
    ],
    isError: true,
  };
}

describe('maybeAttachDebugBundle (#798 PR2)', () => {
  const originalEnv = process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE;
    else process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE = originalEnv;
  });

  it('returns the response unchanged when isError is false', async () => {
    const success: MCPResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const out = await maybeAttachDebugBundle(success, {
      params: { collectDebugBundleOnFailure: true },
      toolName: 'app_tap_element',
    });
    expect(out).toBe(success);
  });

  it('returns the response unchanged when no opt-in is set', async () => {
    const response = errorResponse('DEVICE_NOT_BOOTED');
    const out = await maybeAttachDebugBundle(response, {
      params: {},
      toolName: 'app_tap_element',
    });
    expect(out).toBe(response);
  });

  it('attaches a bundle when collectDebugBundleOnFailure=true and code is recoverable', async () => {
    const response = errorResponse('DEVICE_NOT_BOOTED');
    const out = await maybeAttachDebugBundle(response, {
      params: { collectDebugBundleOnFailure: true },
      deviceId: 'DEV-1',
      toolName: 'app_tap_element',
    });
    const payload = JSON.parse((out.content?.[0] as { text: string })?.text ?? '{}');
    expect(payload.error).toBe('DEVICE_NOT_BOOTED');
    expect(payload.debugBundle).toBeDefined();
    expect(payload.debugBundle.schemaVersion).toBe('1');
    expect(payload.debugBundleTool).toBe('app_tap_element');
  });

  it('respects the OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE env override', async () => {
    process.env.OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE = '1';
    const response = errorResponse('DEVICE_NOT_BOOTED');
    const out = await maybeAttachDebugBundle(response, {
      params: {},
      deviceId: 'DEV-1',
      toolName: 'app_goto_screen',
    });
    const payload = JSON.parse((out.content?.[0] as { text: string })?.text ?? '{}');
    expect(payload.debugBundle).toBeDefined();
    expect(payload.debugBundleTool).toBe('app_goto_screen');
  });

  it('skips bundle collection for irrecoverable error codes', async () => {
    // RESOURCE_EXHAUSTED is non-recoverable per the catalog — no point
    // bundling for it.
    const response = errorResponse('RESOURCE_EXHAUSTED');
    const out = await maybeAttachDebugBundle(response, {
      params: { collectDebugBundleOnFailure: true },
      deviceId: 'DEV-1',
      toolName: 'app_tap_element',
    });
    const payload = JSON.parse((out.content?.[0] as { text: string })?.text ?? '{}');
    expect(payload.debugBundle).toBeUndefined();
  });

  it('does not crash when the response payload is non-JSON', async () => {
    const weird: MCPResult = {
      content: [{ type: 'text', text: 'plain string failure' }],
      isError: true,
    };
    const out = await maybeAttachDebugBundle(weird, {
      params: { collectDebugBundleOnFailure: true },
      toolName: 'app_tap_element',
    });
    expect(out).toBe(weird);
  });
});

describe('wrapHandlerForBundle (#798 PR2)', () => {
  it('passes through the success response unchanged', async () => {
    const inner = jest.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
    const wrapped = wrapHandlerForBundle('app_tap_element', inner);
    const result = await wrapped('SID', { foo: 'bar' });
    expect(inner).toHaveBeenCalledWith('SID', { foo: 'bar' });
    expect((result.content?.[0] as { text: string })?.text).toBe('{"ok":true}');
    expect(result.isError).toBeUndefined();
  });

  it('attaches a bundle when the inner handler errors and the param is set', async () => {
    const inner = jest.fn(async () => errorResponse('DEVICE_NOT_BOOTED'));
    const wrapped = wrapHandlerForBundle('app_goto_screen', inner);
    const result = await wrapped('SID', {
      collectDebugBundleOnFailure: true,
      device_id: 'DEV-1',
    });
    const payload = JSON.parse((result.content?.[0] as { text: string })?.text ?? '{}');
    expect(payload.debugBundle).toBeDefined();
    expect(payload.debugBundleTool).toBe('app_goto_screen');
  });
});
