/**
 * Native Accessibility Bridge
 *
 * TypeScript wrapper around the ax-bridge Swift helper.
 * Invokes the compiled Swift binary to read the iOS Simulator's
 * accessibility tree via the macOS AXUIElement API.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { AXNode, AXQuery, AXQueryResult, AXDumpOptions, AXQueryOptions } from './ax-types';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 15_000;

export class AccessibilityBridge {
  private bridgePath: string | null = null;

  /**
   * Resolve the path to the ax-bridge binary or Swift source.
   *
   * Search order:
   *   1. Compiled binary — parent dir (tsc output layout: dist/native/)
   *   2. Compiled binary — same dir (webpack flat layout: dist/)
   *   3. Swift source — parent dir
   *   4. Swift source — same dir (postbuild copy to dist/)
   *   5. Dev-only source tree fallback, gated behind OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1
   */
  private async resolveBridgePath(): Promise<string> {
    if (this.bridgePath) return this.bridgePath;

    const candidates: string[] = [
      // 1. Compiled binary — parent dir (tsc output layout: dist/native/)
      path.resolve(__dirname, '..', 'ax-bridge'),
      // 2. Compiled binary — same dir (webpack flat layout: dist/)
      path.resolve(__dirname, 'ax-bridge'),
      // 3. Swift source — parent dir
      path.resolve(__dirname, '..', 'ax-bridge.swift'),
      // 4. Swift source — same dir (postbuild copy to dist/)
      path.resolve(__dirname, 'ax-bridge.swift'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.bridgePath = candidate;
        return candidate;
      }
    }

    // 5. Dev-only: source tree fallback (same gate as sim-hid-bridge)
    if (process.env.OPENSAFARI_ALLOW_SWIFT_INTERPRETER === '1') {
      const devSrc = path.resolve(__dirname, '..', '..', 'src', 'native', 'ax-bridge.swift');
      if (fs.existsSync(devSrc)) {
        this.bridgePath = devSrc;
        return devSrc;
      }
    }

    const searched = candidates.map(c => `  - ${c}`).join('\n');
    throw new AccessibilityBridgeError(
      `ax-bridge not found. Searched:\n${searched}\n` +
      'Run npm run build or set OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1 for dev mode.',
      'BRIDGE_NOT_FOUND',
    );
  }

  /**
   * Execute the bridge with given arguments and parse JSON output.
   */
  private async exec<T>(args: string[]): Promise<T> {
    const bridgePath = await this.resolveBridgePath();

    let cmd: string;
    let cmdArgs: string[];

    if (bridgePath.endsWith('.swift')) {
      // Interpret Swift source directly
      cmd = 'swift';
      cmdArgs = [bridgePath, ...args];
    } else {
      // Run compiled binary
      cmd = bridgePath;
      cmdArgs = args;
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large trees
      });

      if (stderr) {
        console.error(`[ax-bridge] ${stderr.trim()}`);
      }

      const parsed = JSON.parse(stdout);

      // Check for error response from the bridge
      if (parsed.error) {
        throw new AccessibilityBridgeError(parsed.error, parsed.code ?? 'AX_ERROR');
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof AccessibilityBridgeError) throw err;

      const error = err as Error & { stderr?: string; code?: string; killed?: boolean };

      if (error.killed) {
        throw new AccessibilityBridgeError(
          'Accessibility tree dump timed out. The app may have too many elements.',
          'AX_TIMEOUT',
        );
      }

      // Try to parse error JSON from stderr
      if (error.stderr) {
        try {
          const errJson = JSON.parse(error.stderr);
          if (errJson.error) {
            throw new AccessibilityBridgeError(errJson.error, errJson.code ?? 'AX_ERROR');
          }
        } catch (parseErr) {
          if (parseErr instanceof AccessibilityBridgeError) throw parseErr;
          // Not JSON, fall through to surface raw stderr below.
        }
      }

      // Include the bridge's stderr tail in the thrown message. Without this
      // the caller only sees `Command failed: <cmd>` and every CI failure
      // looks identical regardless of root cause (unsigned binary, missing
      // TCC, simulator not booted, swift interpreter compile error, etc.).
      const stderrTail = error.stderr
        ? ` | stderr: ${error.stderr.trim().split('\n').slice(-5).join(' / ')}`
        : '';
      throw new AccessibilityBridgeError(
        `ax-bridge failed (${cmd}): ${error.message}${stderrTail}`,
        'BRIDGE_EXEC_FAILED',
      );
    }
  }

  /**
   * Dump the full accessibility tree for a device.
   */
  async dumpTree(options?: AXDumpOptions): Promise<AXNode> {
    const args = ['dump'];
    if (options?.deviceId) args.push('--device', options.deviceId);
    if (options?.maxDepth) args.push('--max-depth', String(options.maxDepth));
    else args.push('--max-depth', String(DEFAULT_MAX_DEPTH));
    return this.exec<AXNode>(args);
  }

  /**
   * Query the accessibility tree for elements matching criteria.
   * Returns structured results with ambiguity detection.
   */
  async query(query: AXQuery, options?: AXQueryOptions): Promise<AXQueryResult> {
    const args = ['query'];
    if (options?.deviceId) args.push('--device', options.deviceId);
    if (query.identifier) args.push('--id', query.identifier);
    if (query.label) args.push('--label', query.label);
    if (query.text) args.push('--text', query.text);
    if (query.role) args.push('--role', query.role);
    args.push('--max-results', String(options?.maxResults ?? DEFAULT_MAX_RESULTS));
    return this.exec<AXQueryResult>(args);
  }

  /**
   * Inspect a specific element by its index path.
   * Returns detailed metadata for a single element.
   */
  async inspect(elementPath: string, deviceId?: string): Promise<AXNode> {
    const args = ['inspect', '--path', elementPath];
    if (deviceId) args.push('--device', deviceId);
    return this.exec<AXNode>(args);
  }

  /**
   * Invoke `AXPress` on the element at `elementPath`.
   *
   * Tier 1.5 headless tap path — interaction routed through the macOS
   * accessibility API instead of OS-level input synthesis, so the user's
   * mouse cursor never moves and `Simulator.app` does not have to be
   * foregrounded. Works on every Xcode version, and is the only path that
   * covers native (non-Flutter) apps on Xcode 26+ where
   * `SimulatorKitHIDInputBackend` tap/swipe was disabled pending the Apple
   * `IndigoHIDMessageForMouseNSEvent` regression (see #537 / #552).
   *
   * Response shape is uniform — the bridge always exits 0 and emits a
   * `PressResponse` on stdout. The caller branches on `ok`:
   *
   *   - `ok === true` — press succeeded.
   *   - `ok === false && code === 'PRESS_NOT_ACTIONABLE'` — element does
   *     not advertise `AXPress`; the caller should transparently fall back
   *     to a coordinate-based tap.
   *   - `ok === false && code === 'PRESS_FAILED'` — `AXPress` was
   *     advertised but `AXUIElementPerformAction` returned non-success;
   *     the caller should surface this to the user.
   *
   * Bridge-level problems (accessibility permission denied, simulator not
   * running, unknown command, missing argument, element not found) still
   * exit non-zero and throw `AccessibilityBridgeError` as usual.
   */
  async press(elementPath: string, deviceId?: string): Promise<AXPressResponse> {
    const args = ['press', '--path', elementPath];
    if (deviceId) args.push('--device', deviceId);
    return this.exec<AXPressResponse>(args);
  }
}

/**
 * Uniform press response. `actions` mirrors the full
 * `AXUIElementCopyActionNames` list so callers can log what else the
 * element supports when diagnosing unexpected `PRESS_NOT_ACTIONABLE`
 * fallbacks.
 */
export interface AXPressResponse {
  ok: boolean;
  code: 'OK' | 'PRESS_NOT_ACTIONABLE' | 'PRESS_FAILED';
  path: string;
  actions: string[];
  role: string | null;
  identifier: string | null;
  label: string | null;
  /**
   * Human-readable diagnostic surfaced by the Swift bridge for
   * `PRESS_NOT_ACTIONABLE` / `PRESS_FAILED`. The field is intentionally
   * named `message` rather than `error` so it does not trigger
   * `AccessibilityBridge.exec()`'s `parsed.error` auto-throw path —
   * bridge-level failures (permissions, device-not-found, missing args)
   * still surface via non-zero exit + `{ error, code }` on stdout.
   */
  message: string | null;
  axErrorCode: number | null;
}

export class AccessibilityBridgeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AccessibilityBridgeError';
  }
}

// Singleton
let bridge: AccessibilityBridge | null = null;

export function getAccessibilityBridge(): AccessibilityBridge {
  if (!bridge) {
    bridge = new AccessibilityBridge();
  }
  return bridge;
}
