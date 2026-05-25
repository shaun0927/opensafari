/**
 * Unit test for PR12 — flutter_get_route payload parser.
 *
 * The Dart-side expression is exercised only against a real Flutter app,
 * but the JSON parsing/edge cases happen on the Node side and are worth
 * pinning down here.
 */

import { __forTests } from '../../src/tools/flutter-get-route';

const { parseRoutePayload, ROUTE_EXPRESSION } = __forTests;

describe('flutter_get_route parser', () => {
  it('parses a successful modal_route payload', () => {
    const raw = 'opensafari_route:{"name":"/home","source":"modal_route"}';
    expect(parseRoutePayload(raw)).toEqual({ name: '/home', source: 'modal_route' });
  });

  it('parses an unknown / no-route payload', () => {
    const raw = 'opensafari_route:{"name":null,"source":"unknown"}';
    expect(parseRoutePayload(raw)).toEqual({ name: null, source: 'unknown' });
  });

  it('handles the no_root branch', () => {
    const raw = 'opensafari_route:{"name":null,"source":"no_root"}';
    expect(parseRoutePayload(raw)).toEqual({ name: null, source: 'no_root' });
  });

  it('handles an error payload with embedded message', () => {
    const raw = 'opensafari_route:{"name":null,"source":"error","error":"NoSuchMethodError"}';
    expect(parseRoutePayload(raw)).toEqual({
      name: null,
      source: 'error',
      error: 'NoSuchMethodError',
    });
  });

  it('returns unknown when prefix missing', () => {
    expect(parseRoutePayload('garbage output without prefix')).toEqual({
      name: null,
      source: 'unknown',
    });
  });

  it('returns unknown when JSON is malformed', () => {
    expect(parseRoutePayload('opensafari_route:not json at all')).toEqual({
      name: null,
      source: 'unknown',
    });
  });
});

describe('flutter_get_route expression', () => {
  it('is non-empty Dart that wraps in IIFE', () => {
    expect(ROUTE_EXPRESSION.length).toBeGreaterThan(100);
    expect(ROUTE_EXPRESSION.startsWith('(()')).toBe(true);
    // Sanity: it references the rootElement walk we depend on.
    expect(ROUTE_EXPRESSION).toContain('rootElement');
    expect(ROUTE_EXPRESSION).toContain('_ModalScopeStatus');
    expect(ROUTE_EXPRESSION).toContain('opensafari_route:');
  });
});
