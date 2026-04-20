/**
 * Unit tests for the ax-bridge CLI wrapper (`cli/ax-bridge.ts`).
 *
 * Covers the Issue #41 single-snapshot promotion contract:
 *   - dump/query/inspect → APP_CONTENT_NOT_EXPOSED when the primary native
 *     response sets `chromeOnly: true`
 *   - legitimate hits (or zero-match-on-populated-app) pass through unchanged
 *   - `--ensure-semantics off` opts out of both bootstrap AND promotion
 *
 * The wrapper exposes `decidePromotion()` as a pure function so the
 * promotion matrix can be exercised without spawning the native binary or
 * the Node CLI process.
 */

import { decidePromotion, resolveChromeOnly } from '../../cli/ax-bridge';

const TEST_DEVICE = 'F19D0482-3539-4B74-A353-0229E415B64C';

function callDecide(opts: {
  command: 'dump' | 'query' | 'inspect';
  parsed: Record<string, unknown>;
  ensureSemanticsOff?: boolean;
  bootstrapApplicable?: boolean;
}) {
  return decidePromotion({
    command: opts.command,
    parsed: opts.parsed,
    deviceId: TEST_DEVICE,
    ensureSemanticsOff: opts.ensureSemanticsOff ?? false,
    bootstrapApplicable: opts.bootstrapApplicable ?? true,
  });
}

describe('decidePromotion — query', () => {
  test('total:0 + chromeOnly:true → promote APP_CONTENT_NOT_EXPOSED', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 0,
        matches: [],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: true,
      },
    });
    expect(decision.promote).toBe(true);
    expect(decision.code).toBe('APP_CONTENT_NOT_EXPOSED');
  });

  test('total:0 + chromeOnly:false → pass-through', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 0,
        matches: [],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: false,
      },
    });
    expect(decision.promote).toBe(false);
  });

  test('total:1 + chromeOnly:false → pass-through', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 1,
        matches: [{ role: 'AXTextField', path: '0/1' }],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: false,
      },
    });
    expect(decision.promote).toBe(false);
  });

  test('total:1 + chromeOnly:true → pass-through (legitimate hit beats chrome flag)', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 1,
        matches: [{ role: 'AXTextField', path: '0/1' }],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: true,
      },
    });
    expect(decision.promote).toBe(false);
  });

  test('missing chromeOnly field (legacy Swift) + total:0 → no promotion (TS query fallback is conservative)', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 0,
        matches: [],
        query: { role: 'AXTextField' },
        ambiguous: false,
      },
    });
    expect(decision.promote).toBe(false);
  });
});

describe('decidePromotion — inspect', () => {
  test('found:false + chromeOnly:true + ELEMENT_NOT_FOUND → promote', () => {
    const decision = callDecide({
      command: 'inspect',
      parsed: {
        error: 'Element not found at path: 0/99',
        code: 'ELEMENT_NOT_FOUND',
        path: '0/99',
        found: false,
        chromeOnly: true,
      },
    });
    expect(decision.promote).toBe(true);
    expect(decision.code).toBe('APP_CONTENT_NOT_EXPOSED');
  });

  test('found:false + chromeOnly:false + ELEMENT_NOT_FOUND → pass-through', () => {
    const decision = callDecide({
      command: 'inspect',
      parsed: {
        error: 'Element not found at path: 0/99',
        code: 'ELEMENT_NOT_FOUND',
        path: '0/99',
        found: false,
        chromeOnly: false,
      },
    });
    expect(decision.promote).toBe(false);
  });

  test('found AXNode payload (no error) → pass-through even when chromeOnly:true', () => {
    const decision = callDecide({
      command: 'inspect',
      parsed: {
        role: 'AXButton',
        label: 'Submit',
        path: '0/1',
        traits: [],
        frame: { x: 0, y: 0, width: 100, height: 40 },
        visible: true,
        enabled: true,
        focused: false,
        chromeOnly: true,
      },
    });
    expect(decision.promote).toBe(false);
  });
});

describe('decidePromotion — dump', () => {
  test('chromeOnly:true → promote', () => {
    const decision = callDecide({
      command: 'dump',
      parsed: {
        role: 'AXWindow',
        label: 'iPhone 16 -- iOS 17.0',
        path: '',
        traits: [],
        frame: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
        enabled: true,
        focused: false,
        chromeOnly: true,
      },
    });
    expect(decision.promote).toBe(true);
    expect(decision.code).toBe('APP_CONTENT_NOT_EXPOSED');
  });

  test('chromeOnly:false → pass-through', () => {
    const decision = callDecide({
      command: 'dump',
      parsed: {
        role: 'AXWindow',
        label: 'My App',
        path: '',
        traits: [],
        frame: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
        enabled: true,
        focused: false,
        children: [
          {
            role: 'AXTextField',
            identifier: 'email',
            label: 'Email',
            value: '',
            traits: [],
            frame: { x: 0, y: 0, width: 100, height: 40 },
            visible: true,
            enabled: true,
            focused: false,
            path: '0',
          },
        ],
        chromeOnly: false,
      },
    });
    expect(decision.promote).toBe(false);
  });

  test('error response → no promotion', () => {
    const decision = callDecide({
      command: 'dump',
      parsed: {
        error: 'Accessibility permission not granted.',
        code: 'AX_PERMISSION_DENIED',
      },
    });
    expect(decision.promote).toBe(false);
  });
});

describe('decidePromotion — --ensure-semantics off opt-out', () => {
  test('query chromeOnly:true + ensureSemanticsOff → no promotion', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 0,
        matches: [],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: true,
      },
      ensureSemanticsOff: true,
    });
    expect(decision.promote).toBe(false);
  });

  test('inspect found:false + chromeOnly:true + ensureSemanticsOff → no promotion', () => {
    const decision = callDecide({
      command: 'inspect',
      parsed: {
        error: 'Element not found at path: 0/99',
        code: 'ELEMENT_NOT_FOUND',
        path: '0/99',
        found: false,
        chromeOnly: true,
      },
      ensureSemanticsOff: true,
    });
    expect(decision.promote).toBe(false);
  });

  test('dump chromeOnly:true + ensureSemanticsOff → no promotion', () => {
    const decision = callDecide({
      command: 'dump',
      parsed: {
        role: 'AXWindow',
        label: 'iPhone 16 -- iOS 17.0',
        path: '',
        traits: [],
        frame: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
        enabled: true,
        focused: false,
        chromeOnly: true,
      },
      ensureSemanticsOff: true,
    });
    expect(decision.promote).toBe(false);
  });
});

describe('decidePromotion — bootstrap-not-applicable cases', () => {
  test('command without device id (bootstrapApplicable:false) → no promotion regardless', () => {
    const decision = callDecide({
      command: 'query',
      parsed: {
        total: 0,
        matches: [],
        query: { role: 'AXTextField' },
        ambiguous: false,
        chromeOnly: true,
      },
      bootstrapApplicable: false,
    });
    expect(decision.promote).toBe(false);
  });
});

describe('resolveChromeOnly — TS heuristic fallback for legacy Swift', () => {
  test('returns Swift-supplied chromeOnly when present (boolean)', () => {
    expect(resolveChromeOnly('dump', { chromeOnly: true })).toBe(true);
    expect(resolveChromeOnly('dump', { chromeOnly: false })).toBe(false);
  });

  test('returns false for query when chromeOnly absent (TS fallback inconclusive)', () => {
    expect(resolveChromeOnly('query', { total: 0 })).toBe(false);
  });

  test('falls back to TS heuristic on dump when chromeOnly absent', () => {
    // A populated tree with a text field — TS heuristic returns false.
    const populated = {
      role: 'AXWindow',
      label: 'My App',
      identifier: 'root',
      children: [
        { role: 'AXTextField', label: 'Email', identifier: 'email', children: [] },
      ],
    };
    expect(resolveChromeOnly('dump', populated)).toBe(false);
  });
});
