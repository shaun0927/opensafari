/**
 * Unit tests for app_type_element tool.
 *
 * Tests the composite flow: query accessibility tree → tap to focus →
 * type text. Mocks the same boundaries as app-tap-element.test.ts
 * (accessibility bridge, semantics activator, input backend,
 * session manager) so these stay pure unit tests.
 */

// CI runners occasionally exceed Jest's 5000 ms default for the heavier
// composite flow tests in this file. Bump the file-scoped timeout so the
// slow-runner flakes stop masking real regressions.
jest.setTimeout(30000);
jest.mock('../../src/mcp-server', () => {
  const actual = jest.requireActual('../../src/mcp-server');
  return { ...actual, getWebKitClient: jest.fn().mockReturnValue(null) };
});

import { MCPServer } from '../../src/mcp-server';
import { registerAppTypeElementTool } from '../../src/tools/app-type-element';
import type { AXNode, AXQueryResult } from '../../src/native/ax-types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockInspect = jest.fn();
const mockTap = jest.fn().mockResolvedValue(undefined);
const mockTypeText = jest.fn().mockResolvedValue(undefined);
// Default to PRESS_NOT_ACTIONABLE so the pre-existing coordinate-tap +
// typeText tests continue to exercise the backend focus path. Tests that
// target the Tier-1.5 AX press focus override this with
// `mockPress.mockResolvedValueOnce({ ok: true, ... })`.
const mockPress = jest.fn().mockResolvedValue({
  ok: false,
  code: 'PRESS_NOT_ACTIONABLE',
  path: '',
  actions: [],
  role: null,
  identifier: null,
  label: null,
  message: 'Element does not support AXPress',
  axErrorCode: null,
});

jest.mock('../../src/native/accessibility-bridge', () => ({
  getAccessibilityBridge: () => ({
    query: mockQuery,
    dumpTree: jest.fn(),
    press: mockPress,
    inspect: mockInspect,
  }),
}));

jest.mock('../../src/native/semantics-activator', () => ({
  ensureSemanticsActive: jest.fn().mockResolvedValue(true),
  countNodes: jest.fn().mockReturnValue(10),
}));

// Mutable kind so individual tests can switch the dispatch tier (e.g. to
// `simhid` for Tier-3 readback coverage) without redefining the whole mock.
let mockBackendKind: 'simctl' | 'simhid' = 'simctl';

jest.mock('../../src/tools/native-input-backend', () => ({
  getInputBackend: jest.fn(async () => ({
    get kind() {
      return mockBackendKind;
    },
    tap: mockTap,
    typeText: mockTypeText,
  })),
  resetInputBackend: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({
    getSoleDeviceId: () => 'test-device-id',
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<AXNode> = {}): AXNode {
  return {
    role: 'AXTextField',
    label: 'Email',
    identifier: 'email_field',
    traits: [],
    frame: { x: 20, y: 100, width: 350, height: 40 },
    visible: true,
    enabled: true,
    focused: false,
    path: '0/1',
    ...overrides,
  };
}

function makeQueryResult(matches: AXNode[], ambiguous = false): AXQueryResult {
  return {
    matches,
    total: matches.length,
    query: {},
    ambiguous,
  };
}

// ── Test setup ─────────────────────────────────────────────────────────────

let server: MCPServer;
let handler: (
  sessionId: string,
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

beforeAll(() => {
  server = {
    registerTool: jest.fn((_schema: unknown, fn: unknown) => {
      handler = fn as typeof handler;
    }),
  } as unknown as MCPServer;

  registerAppTypeElementTool(server);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockBackendKind = 'simctl';
  // Default: readback echoes the typed text so the Tier-3 verification
  // path reports `verified: true` for the existing tests (backend !=
  // 'simhid' in the default mock, so inspect is not actually invoked —
  // see the Tier-3 block at the bottom of the file for simhid-specific
  // coverage).
  mockInspect.mockReset();
  mockInspect.mockResolvedValue({
    role: 'AXTextField',
    traits: [],
    frame: { x: 0, y: 0, width: 100, height: 40 },
    visible: true,
    enabled: true,
    focused: true,
    path: '0/1',
    value: '',
  });
  // See the matching note in `app-tap-element.test.ts` — `clearAllMocks`
  // does not drain `mockResolvedValueOnce` queues, so reset the press
  // mock completely and reinstall the default before each test.
  mockPress.mockReset();
  mockPress.mockResolvedValue({
    ok: false,
    code: 'PRESS_NOT_ACTIONABLE',
    path: '',
    actions: [],
    role: null,
    identifier: null,
    label: null,
    message: 'Element does not support AXPress',
    axErrorCode: null,
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('app_type_element', () => {
  it('types into element found by label', async () => {
    const node = makeNode({ label: 'Email', frame: { x: 20, y: 100, width: 350, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      label: 'Email',
      text: 'user@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('typed');
    expect(body.length).toBe(16);
    expect(body.coordinates).toEqual({ x: 195, y: 120 }); // 20+175, 100+20
    // Tap to focus
    expect(mockTap).toHaveBeenCalledWith('test-device-id', 195, 120);
    // Then type
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'user@example.com', 0);
    // Tap must come before typeText
    const tapOrder = mockTap.mock.invocationCallOrder[0];
    const typeOrder = mockTypeText.mock.invocationCallOrder[0];
    expect(tapOrder).toBeLessThan(typeOrder);
  });

  it('types into element found by identifier', async () => {
    const node = makeNode({ identifier: 'username_input', frame: { x: 10, y: 200, width: 200, height: 44 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'username_input',
      text: 'alice',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.status).toBe('typed');
    expect(body.coordinates).toEqual({ x: 110, y: 222 });
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'alice', 0);
  });

  it('uses index to disambiguate multiple fields', async () => {
    const nodes = [
      makeNode({ identifier: 'field_0', frame: { x: 0, y: 100, width: 100, height: 40 } }),
      makeNode({ identifier: 'field_1', frame: { x: 0, y: 200, width: 100, height: 40 } }),
    ];
    mockQuery.mockResolvedValue(makeQueryResult(nodes));

    await handler('session', {
      role: 'AXTextField',
      text: 'hello',
      index: 1,
      timeout: 0,
      focusDelay: 0,
    });

    expect(mockTap).toHaveBeenCalledWith('test-device-id', 50, 220);
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'hello', 0);
  });

  it('returns error when text is missing or empty', async () => {
    const missing = await handler('session', { label: 'Email' });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text).error).toContain('text');

    const empty = await handler('session', { label: 'Email', text: '' });
    expect(empty.isError).toBe(true);
    expect(JSON.parse(empty.content[0].text).error).toContain('text');
  });

  it('returns error when no locator is provided', async () => {
    const result = await handler('session', { text: 'hello' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('query parameter');
  });

  it('returns error when element is not found', async () => {
    mockQuery.mockResolvedValue(makeQueryResult([]));

    const result = await handler('session', {
      label: 'NonExistent',
      text: 'hello',
      timeout: 0,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('Element not found');
    expect(mockTap).not.toHaveBeenCalled();
    expect(mockTypeText).not.toHaveBeenCalled();
  });

  it('returns error when element is not visible', async () => {
    const node = makeNode({ visible: false, frame: { x: 0, y: 0, width: 0, height: 0 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      label: 'Hidden',
      text: 'nope',
      timeout: 0,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain('not visible');
    expect(mockTypeText).not.toHaveBeenCalled();
  });

  it('waits between tap-to-focus and typing when focusDelay > 0', async () => {
    const node = makeNode({ frame: { x: 0, y: 0, width: 100, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    let tapCompletedAt = 0;
    let typeStartedAt = 0;
    mockTap.mockImplementation(async () => {
      tapCompletedAt = Date.now();
    });
    mockTypeText.mockImplementation(async () => {
      typeStartedAt = Date.now();
    });

    await handler('session', {
      label: 'Field',
      text: 'x',
      timeout: 0,
      focusDelay: 75,
    });

    // Typing started at least ~75ms after tap completed. Allow a
    // small tolerance for scheduler jitter.
    expect(typeStartedAt - tapCompletedAt).toBeGreaterThanOrEqual(60);
  });

  it('never sends the `text` param as part of the bridge query', async () => {
    // `text` is overloaded to mean "text to type" here, so it MUST NOT be
    // forwarded to the accessibility query (which treats it as a substring
    // match against value/label) — otherwise the query could fail to find
    // the empty field we are about to populate.
    const node = makeNode({ frame: { x: 10, y: 20, width: 100, height: 40 } });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    await handler('session', {
      label: 'Password',
      text: 'supersecret',
      timeout: 0,
      focusDelay: 0,
    });

    const forwardedQuery = mockQuery.mock.calls[0][0];
    expect(forwardedQuery).not.toHaveProperty('text');
    expect(forwardedQuery).toMatchObject({ label: 'Password' });
  });

  it('returns element metadata in response', async () => {
    const node = makeNode({
      role: 'AXTextField',
      label: 'Search',
      identifier: 'search_input',
      path: '0/2/3',
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'search_input',
      text: 'query',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.element).toEqual({
      role: 'AXTextField',
      label: 'Search',
      identifier: 'search_input',
      path: '0/2/3',
    });
    expect(body.backend).toBe('simctl');
    expect(body.deviceId).toBe('test-device-id');
  });
});

describe('app_type_element — Tier 1.5 AX press focus', () => {
  it('focuses via AX press and still types through the backend', async () => {
    const node = makeNode({
      role: 'AXTextField',
      label: 'Email',
      identifier: 'email_field',
      path: '0/3',
      frame: { x: 20, y: 200, width: 340, height: 40 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/3',
      actions: ['AXPress'],
      role: 'AXTextField',
      identifier: 'email_field',
      label: 'Email',
      message: null,
      axErrorCode: null,
    });

    const result = await handler('session', {
      identifier: 'email_field',
      text: 'user@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.status).toBe('typed');
    // Focus came from AX press; typing still goes through backend (Tier
    // 1 simhid keys in production; mocked simctl here).
    expect(body.focusBackend).toBe('ax-press');
    expect(body.backend).toBe('simctl');
    expect(mockPress).toHaveBeenCalledWith('0/3', 'test-device-id');
    // Coordinate tap MUST NOT fire when AX press focused the element.
    expect(mockTap).not.toHaveBeenCalled();
    expect(mockTypeText).toHaveBeenCalledWith('test-device-id', 'user@example.com', 0);
  });

  it('falls back to coordinate tap when the text field is not AX-pressable', async () => {
    const node = makeNode({
      role: 'AXTextField',
      identifier: 'plain_text',
      path: '0/4',
      frame: { x: 10, y: 300, width: 100, height: 30 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Default PRESS_NOT_ACTIONABLE resolution applies.

    const result = await handler('session', {
      identifier: 'plain_text',
      text: 'hi',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.focusBackend).toBe('simctl');
    expect(mockTap).toHaveBeenCalledTimes(1);
    expect(mockTypeText).toHaveBeenCalledTimes(1);
  });

  it('honours OPENSAFARI_DISABLE_AX_PRESS=1 (skips press and uses coordinate tap)', async () => {
    const node = makeNode({
      role: 'AXTextField',
      identifier: 'email_field',
      path: '0/3',
      frame: { x: 20, y: 200, width: 340, height: 40 },
    });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockPress.mockResolvedValueOnce({
      ok: true,
      code: 'OK',
      path: '0/3',
      actions: ['AXPress'],
      role: 'AXTextField',
      identifier: 'email_field',
      label: 'Email',
      message: null,
      axErrorCode: null,
    });

    const prev = process.env.OPENSAFARI_DISABLE_AX_PRESS;
    process.env.OPENSAFARI_DISABLE_AX_PRESS = '1';
    try {
      const result = await handler('session', {
        identifier: 'email_field',
        text: 'hi',
        timeout: 0,
        focusDelay: 0,
      });
      const body = JSON.parse(result.content[0].text);

      expect(result.isError).toBeUndefined();
      expect(mockPress).not.toHaveBeenCalled();
      expect(mockTap).toHaveBeenCalledTimes(1);
      expect(body.focusBackend).toBe('simctl');
    } finally {
      if (prev === undefined) {
        delete process.env.OPENSAFARI_DISABLE_AX_PRESS;
      } else {
        process.env.OPENSAFARI_DISABLE_AX_PRESS = prev;
      }
    }
  });
});

describe('app_type_element — Tier 3 readback verification (issue #39)', () => {
  function mkNode(overrides: Partial<AXNode> = {}): AXNode {
    return {
      role: 'AXTextField',
      label: 'Email',
      identifier: 'email-field',
      traits: [],
      frame: { x: 20, y: 100, width: 350, height: 40 },
      visible: true,
      enabled: true,
      focused: false,
      path: '0/1',
      ...overrides,
    };
  }

  it('reports verified: true when observed AXValue contains the typed text (simhid backend)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: 'qa@example.com',
    });

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'qa@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe(true);
    expect(body.verify_method).toBe('ax-value-readback');
    expect(body.backend).toBe('simhid');
    expect(mockInspect).toHaveBeenCalledWith('0/5', 'test-device-id');
  });

  it('reports verified: false and sets isError when readback diverges (Korean transliteration case)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Issue #39 symptom: Korean 2-Set IME transliterates the HID keycodes.
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: '@ㄷㅌㅁ네|ㄷ.채',
    });

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'qa@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.verify_method).toBe('ax-value-readback');
    expect(body.verify_reason).toContain('qa@example.com');
    expect(body.verify_reason).toContain('ㄷㅌ');
    expect(body.backend).toBe('simhid');
  });

  it('reports verified: "unknown" when the element exposes no AXValue (password field)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5', identifier: 'password-field' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: undefined,
    });

    const result = await handler('session', {
      identifier: 'password-field',
      text: 'hunter2',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('ax-value-not-readable');
  });

  it('reports verified: "unknown" when bridge.inspect throws during readback', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockRejectedValueOnce(new Error('bridge exploded'));

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'hello',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('readback-failed');
    expect(body.verify_reason).toContain('bridge exploded');
  });

  it('skips readback entirely when the dispatch tier is not simhid', async () => {
    mockBackendKind = 'simctl'; // default mock; readback should be a no-op
    const node = mkNode({ path: '0/5' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'plain',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('skipped-non-simhid');
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it('honors verify: false by skipping readback on simhid', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'secret-totp',
      verify: false,
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('skipped-non-simhid');
    expect(body.verify_reason).toContain('verify: false');
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it('truncates long observed values in verify_reason to cap PII leakage', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/5' });
    const longObserved = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: longObserved,
    });

    const result = await handler('session', {
      identifier: 'email-field',
      text: 'qa@example.com',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.verified).toBe(false);
    // The full 50-char observed string must NOT appear verbatim; the
    // truncation ellipsis is the proof the cap ran.
    expect(body.verify_reason).toContain('…');
    expect(body.verify_reason).not.toContain(longObserved);
  });

  it('emits TEXT_INPUT_DROPPED with droppedIndices when readback mismatches on a Latin layout', async () => {
    // Issue #639 Problem 2: when the keyboard layout is Latin (or unknown)
    // and readback diverges, the tool must return a structured
    // TEXT_INPUT_DROPPED error with code, expected, actual, and droppedIndices.
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/6' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Simulate a field that silently dropped characters at indices 1 and 3:
    // expected "123456" → actual "1356" (chars '2' at idx 1 and '4' at idx 3 dropped).
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: '1356',
    });
    // detectKeyboardLayout calls execFile(xcrun simctl ...) — mock it to
    // return null (layout detection unavailable), which is the Latin/unknown
    // branch that should trigger TEXT_INPUT_DROPPED instead of
    // TEXT_INPUT_LAYOUT_MISMATCH.

    const result = await handler('session', {
      identifier: 'otp-field',
      text: '123456',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('TEXT_INPUT_DROPPED');
    expect(body.error.expected).toBe('123456');
    expect(body.error.actual).toBe('1356');
    expect(body.error.droppedIndices).toEqual([1, 3]);
  });

  // Codex P1 review on PR #680 — the readback mismatch payload was
  // echoing the raw caller input, exposing PII (passwords, tokens,
  // emails) in tool responses and downstream telemetry. The same
  // VERIFY_ECHO_LEN truncation that protects `verify_reason` now
  // protects the structured error payload.
  it('truncates expected/actual in TEXT_INPUT_DROPPED to avoid PII leakage (codex P1 #680)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/6' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Long sensitive-looking input ( > VERIFY_ECHO_LEN = 24 chars ) so we
    // can assert truncation. The trailing characters are dropped, so
    // droppedIndices is non-empty and the error code stays
    // TEXT_INPUT_DROPPED. Pattern is intentionally generic to avoid
    // tripping the host's secret scanners on a test fixture.
    const long = 'CorrectHorseBatteryStapleSentinel';
    const dropped = 'CorrectHorseBatteryStaple';
    mockInspect.mockResolvedValueOnce({ ...node, value: dropped });

    const result = await handler('session', {
      identifier: 'token-field',
      text: long,
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('TEXT_INPUT_DROPPED');
    expect(body.error.expected).toMatch(/…$/);
    expect(body.error.expected.length).toBeLessThanOrEqual(25); // 24 + ellipsis
    expect(body.error.expected).not.toContain('Sentinel');
    expect(body.error.actual.length).toBeLessThanOrEqual(25);
    // The full caller input must NOT leak through to the response.
    expect(body.error.expected).not.toBe(long);
  });

  // Issue #760 — secure text fields (password inputs) return an OS-masked
  // AXValue (bullet chars) regardless of the underlying plaintext. The
  // verifier must report `verified: 'unknown'` for this element class
  // instead of escalating to TEXT_INPUT_DROPPED / TEXT_INPUT_LAYOUT_MISMATCH
  // and surfacing `isError: true`, otherwise every password paste is
  // rejected as a typing failure.
  it('reports verified: "unknown" on AXSecureTextField (mask cannot be compared) (#760)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/7', role: 'AXTextField' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockResolvedValueOnce({
      ...node,
      // iOS exposes the role as AXTextField with AXSecureTextField as a
      // trait; some surfaces expose the lower-case alias. Either signal
      // must trigger the skip.
      role: 'AXTextField',
      traits: ['AXSecureTextField', 'secure text field'],
      value: '••••••••••••••••',
    });

    const result = await handler('session', {
      identifier: 'password-field',
      text: '0ZPGw9^sxpJHx2$h',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('ax-value-not-readable');
    expect(body.verify_reason).toContain('secure');
    // Must NOT escalate to a structured input error — secure-field masking
    // is inconclusive, not a divergence.
    expect(body.error).toBeUndefined();
  });

  it('treats role === AXSecureTextField as a secure field even when traits are empty (#760)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/8', role: 'AXSecureTextField' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    mockInspect.mockResolvedValueOnce({
      ...node,
      role: 'AXSecureTextField',
      traits: [],
      value: '••••••••',
    });

    const result = await handler('session', {
      identifier: 'password-field',
      text: 'hunter2!',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(body.verified).toBe('unknown');
    expect(body.verify_method).toBe('ax-value-not-readable');
  });

  // Codex P2 review on PR #680 — when the divergence is an insertion
  // (e.g. auto-format inserts a space) rather than a drop, the payload
  // would have carried `code: TEXT_INPUT_DROPPED` with empty
  // droppedIndices, which is contradictory and misleads remediation
  // logic. The branch now returns the neutral TEXT_INPUT_MISMATCH code
  // when no drops are detected.
  it('emits TEXT_INPUT_MISMATCH (not TEXT_INPUT_DROPPED) on insertion-only divergence (codex P2 #680)', async () => {
    mockBackendKind = 'simhid';
    const node = mkNode({ path: '0/6' });
    mockQuery.mockResolvedValue(makeQueryResult([node]));
    // Insertion-only: input "123456" → readback "123 456" (auto-format
    // added a space). Every expected char is still present in actual,
    // so computeDroppedIndices returns []; the code must NOT claim a
    // drop occurred.
    mockInspect.mockResolvedValueOnce({
      ...node,
      value: '123 456',
    });

    const result = await handler('session', {
      identifier: 'card-field',
      text: '123456',
      timeout: 0,
      focusDelay: 0,
    });
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('TEXT_INPUT_MISMATCH');
    expect(body.error.code).not.toBe('TEXT_INPUT_DROPPED');
    expect(body.error.expected).toBe('123456');
    expect(body.error.actual).toBe('123 456');
    // Drop-specific field MUST be absent on the neutral code.
    expect(body.error.droppedIndices).toBeUndefined();
  });
});
