/**
 * Unit tests for Dart version parsing and version-aware inspector branching
 * introduced in issue #436 ("Flutter version branch is covered for at least
 * two supported majors").
 */

import {
  FlutterVMClient,
  parseDartVersion,
} from '../../src/flutter/vm-service-client';

describe('parseDartVersion', () => {
  it('parses a Flutter 3.x VM version string with suffix metadata', () => {
    expect(parseDartVersion('3.11.3 (stable) (Thu ...) on "ios_arm64"')).toEqual({
      major: 3,
      minor: 11,
      patch: 3,
    });
  });

  it('parses a bare semver string (Flutter 2.x)', () => {
    expect(parseDartVersion('2.19.0')).toEqual({ major: 2, minor: 19, patch: 0 });
  });

  it('returns null for unparsable strings', () => {
    expect(parseDartVersion('garbage')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(parseDartVersion('')).toBeNull();
    expect(parseDartVersion(undefined)).toBeNull();
    expect(parseDartVersion(null)).toBeNull();
  });
});

describe('FlutterVMClient.getRootWidgetSummaryTree — version branching', () => {
  let client: FlutterVMClient;
  let callServiceExtensionSpy: jest.SpyInstance;

  function injectState(dartVersion: { major: number; minor: number; patch: number } | null | undefined): void {
    (client as unknown as Record<string, unknown>)['state'] = {
      mainIsolateId: 'isolate-1',
      dartVersion,
    };
  }

  beforeEach(() => {
    client = new FlutterVMClient();
    callServiceExtensionSpy = jest.spyOn(
      client as unknown as { callServiceExtension: () => unknown },
      'callServiceExtension',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Flutter 3.x session: calls WithPreviews first', async () => {
    injectState({ major: 3, minor: 11, patch: 3 });
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

  it('Flutter 3.x with -32000 error: falls back to getRootWidgetSummaryTree', async () => {
    injectState({ major: 3, minor: 0, patch: 0 });
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

  it('Flutter 2.x session: skips WithPreviews, calls getRootWidgetSummaryTree directly', async () => {
    injectState({ major: 2, minor: 19, patch: 0 });
    const tree = { type: 'MaterialApp' };
    callServiceExtensionSpy.mockResolvedValue(tree);

    const result = await client.getRootWidgetSummaryTree();

    expect(result).toBe(tree);
    expect(callServiceExtensionSpy).toHaveBeenCalledTimes(1);
    expect(callServiceExtensionSpy).toHaveBeenCalledWith(
      'inspector.getRootWidgetSummaryTree',
      { objectGroup: 'opensafari-root' },
    );
  });

  it('Flutter 2.x session: propagates errors without trying WithPreviews', async () => {
    injectState({ major: 2, minor: 10, patch: 5 });
    const err = new Error('VM Service error: method not found (code: -32601)');
    callServiceExtensionSpy.mockRejectedValue(err);

    await expect(client.getRootWidgetSummaryTree()).rejects.toThrow(err);
    expect(callServiceExtensionSpy).toHaveBeenCalledTimes(1);
    expect(callServiceExtensionSpy).toHaveBeenCalledWith(
      'inspector.getRootWidgetSummaryTree',
      { objectGroup: 'opensafari-root' },
    );
  });

  it('Unknown version: preserves historical WithPreviews-first behaviour', async () => {
    injectState(null);
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
});

describe('FlutterVMClient version accessors', () => {
  it('getDartVersion / getFlutterMajor return null when state is absent', () => {
    const client = new FlutterVMClient();
    expect(client.getDartVersion()).toBeUndefined();
    expect(client.getFlutterMajor()).toBeNull();
  });

  it('getDartVersion / getFlutterMajor reflect the captured version', () => {
    const client = new FlutterVMClient();
    (client as unknown as Record<string, unknown>)['state'] = {
      mainIsolateId: 'isolate-1',
      dartVersion: { major: 3, minor: 11, patch: 3 },
    };
    expect(client.getDartVersion()).toEqual({ major: 3, minor: 11, patch: 3 });
    expect(client.getFlutterMajor()).toBe(3);
  });
});
