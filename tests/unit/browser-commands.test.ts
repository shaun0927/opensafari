/**
 * Tests for BrowserCommands (#706 4/5).
 *
 * Covers:
 * - navigate happy path uses Page.navigate + readyState polling + batched final-state read
 * - screenshot uses Page.snapshotRect (NEVER captureScreenshot)
 * - click uses buildTapScript (document.createTouch, not new Touch())
 * - swipe uses buildSwipeScript
 * - type (fast mode) uses buildSetValueScript
 * - type (char-by-char mode) dispatches keydown/keypress/keyup per character
 * - longPress uses buildLongPressScript
 * - evaluate delegates to evaluateValue (Promise path, plain value path)
 * - getCookies falls back to document.cookie when Page.getCookies throws
 * - waitFor resolves when querySelector returns visible element
 * - waitFor rejects with TimeoutError when element never appears
 */

import { BrowserCommands, BrowserCommandSender } from '../../src/webkit/browser-commands';
import { TimeoutError } from '../../src/webkit/errors';

// ─── Fake sender ─────────────────────────────────────────────────────────────

class FakeSender implements BrowserCommandSender {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private handlers: Map<string, (params?: Record<string, unknown>) => unknown> = new Map();
  enabledDomains: string[] = [];

  /** Register a response for a given method. */
  on(method: string, handler: (params?: Record<string, unknown>) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler) return handler(params) as T;
    throw new Error(`FakeSender: no handler registered for ${method}`);
  }

  async enableDomain(domain: string): Promise<void> {
    this.enabledDomains.push(domain);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCmds(): { cmds: BrowserCommands; sender: FakeSender } {
  const sender = new FakeSender();
  const cmds = new BrowserCommands(sender);
  return { cmds, sender };
}

// ─── navigate ─────────────────────────────────────────────────────────────────

describe('BrowserCommands.navigate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends Page.navigate and polls readyState until complete', async () => {
    const { cmds, sender } = makeCmds();

    let readyStateCallCount = 0;
    sender
      .on('Page.navigate', () => ({}))
      .on('Runtime.evaluate', (params) => {
        const expr = (params?.expression as string) ?? '';
        // readyState polling
        if (expr === 'document.readyState') {
          readyStateCallCount++;
          return {
            result: { type: 'string', value: readyStateCallCount >= 2 ? 'complete' : 'loading' },
            wasThrown: false,
          };
        }
        // document.URL
        if (expr === 'document.URL') {
          return { result: { type: 'string', value: 'https://example.com' }, wasThrown: false };
        }
        // performance.getEntriesByType navigation status
        if (expr.includes('performance.getEntriesByType')) {
          return { result: { type: 'number', value: 200 }, wasThrown: false };
        }
        return { result: { type: 'string', value: 'complete' }, wasThrown: false };
      });

    const navigatePromise = cmds.navigate({ url: 'https://example.com' });

    // Advance timers to drive the polling loop
    await jest.runAllTimersAsync();

    const result = await navigatePromise;

    expect(result.url).toBe('https://example.com');
    expect(result.status).toBe(200);
    expect(result.loadTime).toBeGreaterThanOrEqual(0);

    const navigateCalls = sender.calls.filter(c => c.method === 'Page.navigate');
    expect(navigateCalls).toHaveLength(1);
    expect(navigateCalls[0].params?.url).toBe('https://example.com');

    expect(sender.enabledDomains).toContain('Page');
    expect(sender.enabledDomains).toContain('Network');
  });

  it('calls lastUrlSetter with the URL', async () => {
    const { cmds, sender } = makeCmds();

    sender
      .on('Page.navigate', () => ({}))
      .on('Runtime.evaluate', () => ({ result: { type: 'string', value: 'complete' }, wasThrown: false }));

    let capturedUrl = '';
    const navigatePromise = cmds.navigate({ url: 'https://test.com' }, (url) => { capturedUrl = url; });

    await jest.runAllTimersAsync();
    await navigatePromise;

    expect(capturedUrl).toBe('https://test.com');
  });
});

// ─── screenshot ───────────────────────────────────────────────────────────────

describe('BrowserCommands.screenshot', () => {
  it('uses Page.snapshotRect (never captureScreenshot)', async () => {
    const { cmds, sender } = makeCmds();

    const fakeBase64 = Buffer.from('fake-png').toString('base64');

    sender
      .on('Runtime.evaluate', () => ({
        result: { type: 'object', objectId: 'obj-1' },
        wasThrown: false,
      }))
      .on('Runtime.callFunctionOn', () => ({
        result: { type: 'object', value: { w: 390, h: 844 } },
        wasThrown: false,
      }))
      .on('Page.snapshotRect', () => ({
        dataURL: `data:image/png;base64,${fakeBase64}`,
      }));

    const buf = await cmds.screenshot();

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe('fake-png');

    const snapshotCalls = sender.calls.filter(c => c.method === 'Page.snapshotRect');
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0].params?.coordinateSystem).toBe('Viewport');

    // Verify captureScreenshot was never called
    const captureCalls = sender.calls.filter(c => c.method === 'Page.captureScreenshot');
    expect(captureCalls).toHaveLength(0);
  });

  it('passes clip options to Page.snapshotRect', async () => {
    const { cmds, sender } = makeCmds();

    const fakeBase64 = Buffer.from('clipped').toString('base64');

    sender
      .on('Runtime.evaluate', () => ({
        result: { type: 'object', objectId: 'obj-1' },
        wasThrown: false,
      }))
      .on('Runtime.callFunctionOn', () => ({
        result: { type: 'object', value: { w: 390, h: 844 } },
        wasThrown: false,
      }))
      .on('Page.snapshotRect', (_params) => ({
        dataURL: `data:image/png;base64,${fakeBase64}`,
      }));

    await cmds.screenshot({ clip: { x: 10, y: 20, width: 100, height: 200 } });

    const snapshotCall = sender.calls.find(c => c.method === 'Page.snapshotRect');
    expect(snapshotCall?.params?.x).toBe(10);
    expect(snapshotCall?.params?.y).toBe(20);
    expect(snapshotCall?.params?.width).toBe(100);
    expect(snapshotCall?.params?.height).toBe(200);
  });
});

// ─── click ────────────────────────────────────────────────────────────────────

describe('BrowserCommands.click', () => {
  it('uses buildTapScript (document.createTouch pattern) for coordinate target', async () => {
    const { cmds, sender } = makeCmds();

    let capturedExpression = '';
    sender.on('Runtime.evaluate', (params) => {
      capturedExpression = (params?.expression as string) ?? '';
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });

    await cmds.click({ x: 100, y: 200 });

    expect(capturedExpression).toContain('document.createTouch');
    expect(capturedExpression).toContain('touchstart');
    expect(capturedExpression).toContain('touchend');
    expect(capturedExpression).toContain('el.click()');
    // Must NOT use new Touch()
    expect(capturedExpression).not.toContain('new Touch(');
  });

  it('resolves element center for string selector target', async () => {
    const { cmds, sender } = makeCmds();

    const expressions: string[] = [];
    sender.on('Runtime.evaluate', (params) => {
      const expr = (params?.expression as string) ?? '';
      expressions.push(expr);
      if (expr.includes('getBoundingClientRect')) {
        // Return element center
        return { result: { type: 'object', objectId: 'obj-1' }, wasThrown: false };
      }
      if (expr.includes('document.createTouch')) {
        return { result: { type: 'undefined', value: undefined }, wasThrown: false };
      }
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });
    sender.on('Runtime.callFunctionOn', () => ({
      result: { type: 'object', value: { x: 50, y: 75 } },
      wasThrown: false,
    }));

    await cmds.click('#my-button');

    const tapCall = expressions.find(e => e.includes('document.createTouch'));
    expect(tapCall).toBeTruthy();
    // The tap script should contain the resolved coordinates
    expect(tapCall).toContain('50');
    expect(tapCall).toContain('75');
  });
});

// ─── swipe ────────────────────────────────────────────────────────────────────

describe('BrowserCommands.swipe', () => {
  it('uses buildSwipeScript with touchmove steps', async () => {
    const { cmds, sender } = makeCmds();

    let swipeExpression = '';
    sender.on('Runtime.evaluate', (params) => {
      const expr = (params?.expression as string) ?? '';
      if (expr.includes('innerWidth')) {
        return { result: { type: 'object', objectId: 'vp' }, wasThrown: false };
      }
      swipeExpression = expr;
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });
    sender.on('Runtime.callFunctionOn', () => ({
      result: { type: 'object', value: { width: 390, height: 844 } },
      wasThrown: false,
    }));

    await cmds.swipe('up');

    expect(swipeExpression).toContain('touchstart');
    expect(swipeExpression).toContain('touchmove');
    expect(swipeExpression).toContain('touchend');
    expect(swipeExpression).toContain('document.createTouch');
    // Must NOT use new Touch()
    expect(swipeExpression).not.toContain('new Touch(');
  });
});

// ─── type ─────────────────────────────────────────────────────────────────────

describe('BrowserCommands.type', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fast mode uses buildSetValueScript (prototype-walk setter)', async () => {
    const { cmds, sender } = makeCmds();

    const expressions: string[] = [];
    sender.on('Runtime.evaluate', (params) => {
      expressions.push((params?.expression as string) ?? '');
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });

    await cmds.type('#input', 'hello');

    // Should have a focus script + a setValue script
    const setValueExpr = expressions.find(e => e.includes("el.value =") || e.includes("desc.set.call"));
    expect(setValueExpr).toBeTruthy();
    expect(setValueExpr).toContain('hello');
    // Uses prototype-walk to avoid cross-realm TypeError
    expect(setValueExpr).toContain('Object.getPrototypeOf');
    expect(setValueExpr).toContain("new Event('input'");
    expect(setValueExpr).toContain("new Event('change'");
  });

  it('char-by-char mode dispatches keydown/keypress/keyup per character', async () => {
    const { cmds, sender } = makeCmds();

    const expressions: string[] = [];
    sender.on('Runtime.evaluate', (params) => {
      expressions.push((params?.expression as string) ?? '');
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });

    const typePromise = cmds.type('#input', 'ab', { delay: 1 });
    await jest.runAllTimersAsync();
    await typePromise;

    // Should have: 1 focus + 2 char scripts (one per char)
    const charScripts = expressions.filter(e => e.includes("KeyboardEvent('keydown'"));
    expect(charScripts).toHaveLength(2);
    expect(charScripts[0]).toContain('"a"');
    expect(charScripts[1]).toContain('"b"');
    charScripts.forEach(s => {
      expect(s).toContain("KeyboardEvent('keydown'");
      expect(s).toContain("KeyboardEvent('keypress'");
      expect(s).toContain("KeyboardEvent('keyup'");
    });
  });
});

// ─── longPress ────────────────────────────────────────────────────────────────

describe('BrowserCommands.longPress', () => {
  it('uses buildLongPressScript with touchstart hold then touchend', async () => {
    const { cmds, sender } = makeCmds();

    let longPressExpr = '';
    sender.on('Runtime.evaluate', (params) => {
      const expr = (params?.expression as string) ?? '';
      if (expr.includes('getBoundingClientRect')) {
        return { result: { type: 'object', objectId: 'obj-1' }, wasThrown: false };
      }
      longPressExpr = expr;
      return { result: { type: 'undefined', value: undefined }, wasThrown: false };
    });
    sender.on('Runtime.callFunctionOn', () => ({
      result: { type: 'object', value: { x: 60, y: 80 } },
      wasThrown: false,
    }));

    await cmds.longPress('#target', 800);

    expect(longPressExpr).toContain('touchstart');
    expect(longPressExpr).toContain('touchend');
    expect(longPressExpr).toContain('document.createTouch');
    expect(longPressExpr).toContain('800');
    // Must NOT use new Touch()
    expect(longPressExpr).not.toContain('new Touch(');
  });
});

// ─── evaluate ─────────────────────────────────────────────────────────────────

describe('BrowserCommands.evaluate', () => {
  it('returns plain value for non-object result', async () => {
    const { cmds, sender } = makeCmds();

    sender.on('Runtime.evaluate', () => ({
      result: { type: 'number', value: 42 },
      wasThrown: false,
    }));

    const result = await cmds.evaluate<number>('21 + 21');
    expect(result).toBe(42);
  });

  it('awaits Promise results via Runtime.awaitPromise', async () => {
    const { cmds, sender } = makeCmds();

    sender
      .on('Runtime.evaluate', () => ({
        result: { type: 'object', subtype: 'promise', objectId: 'promise-obj-1' },
        wasThrown: false,
      }))
      .on('Runtime.awaitPromise', () => ({
        result: { type: 'string', value: 'resolved-value' },
        wasThrown: false,
      }));

    const result = await cmds.evaluate<string>('Promise.resolve("resolved-value")');
    expect(result).toBe('resolved-value');

    const awaitCalls = sender.calls.filter(c => c.method === 'Runtime.awaitPromise');
    expect(awaitCalls).toHaveLength(1);
    expect(awaitCalls[0].params?.promiseObjectId).toBe('promise-obj-1');
    expect(awaitCalls[0].params?.returnByValue).toBe(true);
  });

  it('serializes non-Promise object via Runtime.callFunctionOn', async () => {
    const { cmds, sender } = makeCmds();

    sender
      .on('Runtime.evaluate', () => ({
        result: { type: 'object', objectId: 'obj-2' },
        wasThrown: false,
      }))
      .on('Runtime.callFunctionOn', () => ({
        result: { type: 'object', value: { foo: 'bar' } },
        wasThrown: false,
      }));

    const result = await cmds.evaluate<{ foo: string }>('({foo:"bar"})');
    expect(result).toEqual({ foo: 'bar' });
  });
});

// ─── getCookies fallback ───────────────────────────────────────────────────────

describe('BrowserCommands.getCookies', () => {
  it('falls back to document.cookie when Page.getCookies throws', async () => {
    const { cmds, sender } = makeCmds();

    sender
      .on('Page.getCookies', () => { throw new Error('not supported'); })
      .on('Runtime.evaluate', () => ({
        result: { type: 'string', value: 'name=value; other=data' },
        wasThrown: false,
      }));

    const cookies = await cmds.getCookies();
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('name');
    expect(cookies[0].value).toBe('value');
    expect(cookies[1].name).toBe('other');
    expect(cookies[1].value).toBe('data');
  });

  it('returns Page.getCookies results when supported', async () => {
    const { cmds, sender } = makeCmds();

    sender.on('Page.getCookies', () => ({
      cookies: [
        { name: 'session', value: 'abc123', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true },
      ],
    }));

    const cookies = await cmds.getCookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('session');
    expect(cookies[0].httpOnly).toBe(true);
  });
});

// ─── waitFor ──────────────────────────────────────────────────────────────────

describe('BrowserCommands.waitFor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves when querySelector returns a visible element', async () => {
    const { cmds, sender } = makeCmds();

    sender.on('Runtime.evaluate', () => ({
      result: {
        type: 'object',
        objectId: 'el-1',
      },
      wasThrown: false,
    }));
    sender.on('Runtime.callFunctionOn', () => ({
      result: {
        type: 'object',
        value: {
          selector: '#btn',
          tag: 'button',
          text: 'Click me',
          attributes: {},
          boundingBox: { x: 0, y: 0, width: 100, height: 44 },
          computedStyles: { display: 'block', visibility: 'visible', opacity: '1', fontSize: '16px', color: '#000', backgroundColor: 'transparent', position: 'static', zIndex: 'auto', overflow: 'visible' },
          isVisible: true,
        },
      },
      wasThrown: false,
    }));

    const waitPromise = cmds.waitFor('#btn');
    await jest.runAllTimersAsync();
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('rejects with TimeoutError when element never appears', async () => {
    const { cmds, sender } = makeCmds();

    sender.on('Runtime.evaluate', () => ({
      result: { type: 'null', value: null },
      wasThrown: false,
    }));

    const waitPromise = cmds.waitFor('#missing', { timeout: 100 });
    // Attach rejection handler before advancing timers to avoid unhandled rejection warning
    const rejection = expect(waitPromise).rejects.toBeInstanceOf(TimeoutError);
    await jest.runAllTimersAsync();
    await rejection;
  });
});
