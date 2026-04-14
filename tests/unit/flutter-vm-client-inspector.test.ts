/**
 * Unit tests for FlutterVMClient.getRootWidgetSummaryTree fallback logic.
 */

import { FlutterVMClient } from '../../src/flutter/vm-service-client';

describe('FlutterVMClient.getRootWidgetSummaryTree', () => {
  let client: FlutterVMClient;
  let callServiceExtensionSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new FlutterVMClient();
    // Inject a minimal connected state so callServiceExtension doesn't throw NO_ISOLATE
    (client as unknown as Record<string, unknown>)['state'] = { mainIsolateId: 'isolate-1' };
    callServiceExtensionSpy = jest.spyOn(client as unknown as { callServiceExtension: () => unknown }, 'callServiceExtension');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns WithPreviews result when it succeeds (no fallback)', async () => {
    const tree = { type: 'MaterialApp' };
    callServiceExtensionSpy.mockResolvedValue(tree);

    const result = await client.getRootWidgetSummaryTree();

    expect(result).toBe(tree);
    expect(callServiceExtensionSpy).toHaveBeenCalledTimes(1);
    expect(callServiceExtensionSpy).toHaveBeenCalledWith(
      'inspector.getRootWidgetSummaryTreeWithPreviews',
      { objectGroup: 'opensafari-root' },
    );
  });

  it('falls back to non-Previews when WithPreviews throws', async () => {
    const fallbackTree = { type: 'Scaffold' };
    callServiceExtensionSpy
      .mockRejectedValueOnce(new Error('VM Service error: Server error (code: -32000)'))
      .mockResolvedValueOnce(fallbackTree);

    const result = await client.getRootWidgetSummaryTree();

    expect(result).toBe(fallbackTree);
    expect(callServiceExtensionSpy).toHaveBeenCalledTimes(2);
    expect(callServiceExtensionSpy).toHaveBeenNthCalledWith(
      1,
      'inspector.getRootWidgetSummaryTreeWithPreviews',
      { objectGroup: 'opensafari-root' },
    );
    expect(callServiceExtensionSpy).toHaveBeenNthCalledWith(
      2,
      'inspector.getRootWidgetSummaryTree',
      { objectGroup: 'opensafari-root' },
    );
  });

  it('rethrows the original WithPreviews error when both fail', async () => {
    const originalError = new Error('VM Service error: Server error (code: -32000)');
    const fallbackError = new Error('fallback also failed');
    callServiceExtensionSpy
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(fallbackError);

    await expect(client.getRootWidgetSummaryTree()).rejects.toThrow(originalError);
  });

  it('forwards a custom objectGroup to both calls', async () => {
    callServiceExtensionSpy
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ type: 'Text' });

    await client.getRootWidgetSummaryTree({ objectGroup: 'my-group' });

    expect(callServiceExtensionSpy).toHaveBeenNthCalledWith(
      1,
      'inspector.getRootWidgetSummaryTreeWithPreviews',
      { objectGroup: 'my-group' },
    );
    expect(callServiceExtensionSpy).toHaveBeenNthCalledWith(
      2,
      'inspector.getRootWidgetSummaryTree',
      { objectGroup: 'my-group' },
    );
  });
});
