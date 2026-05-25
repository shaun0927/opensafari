/**
 * Unit tests for PR15 — app_pop_until.
 *
 * The Dart-side popUntil is exercised only against a real Flutter app,
 * but expression generation and result parsing happen on the Node side
 * and are worth pinning here.
 */

import { __forTests } from '../../src/tools/app-pop-until';

const { buildExpression, parsePopResult } = __forTests;

describe('app_pop_until buildExpression', () => {
  it('builds an isFirst predicate for until=first', () => {
    const expr = buildExpression({ until: 'first' });
    expect(expr).toContain('popUntil((r) => r.isFirst)');
    expect(expr).toContain('rootElement');
    expect(expr).toContain('opensafari_pop:');
  });

  it('builds a route-name predicate for until=route with escape handling', () => {
    const expr = buildExpression({ until: 'route', name: "/it's-fine" });
    // Single quote should be escaped to prevent breaking the Dart string.
    expect(expr).toContain("r.settings.name == '/it\\'s-fine'");
  });

  it('builds a count-bounded pop loop for until=count', () => {
    const expr = buildExpression({ until: 'count', count: 3 });
    expect(expr).toContain('popped < 3');
    expect(expr).toContain('nav.canPop()');
    expect(expr).toContain('popped += 1');
  });
});

describe('app_pop_until parsePopResult', () => {
  it('parses the bare ok marker', () => {
    expect(parsePopResult('opensafari_pop:ok')).toEqual({ ok: true, status: 'ok' });
  });

  it('parses the ok marker with popped count', () => {
    expect(parsePopResult('opensafari_pop:ok:popped=2')).toEqual({
      ok: true,
      status: 'ok',
      popped: 2,
    });
  });

  it('parses the error marker', () => {
    const result = parsePopResult('opensafari_pop:error:Some Dart exception');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toBe('Some Dart exception');
  });

  it('parses no_root / no_navigator', () => {
    expect(parsePopResult('opensafari_pop:no_root').ok).toBe(false);
    expect(parsePopResult('opensafari_pop:no_navigator').ok).toBe(false);
  });

  it('returns unknown when prefix missing', () => {
    expect(parsePopResult('garbage')).toEqual({ ok: false, status: 'unknown' });
  });
});
