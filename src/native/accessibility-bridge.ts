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

/**
 * Maximum characters retained per line in the diagnostic tails on the
 * `BRIDGE_EXEC_FAILED` path. The bridge runs with `maxBuffer: 10 MB` so a
 * degenerate single-line output could otherwise produce a multi-megabyte
 * error message. 512 chars is roughly one terminal screen and enough to
 * carry a stack frame, a `swiftc` diagnostic, or a JSON fragment without
 * blowing log volume.
 */
const STREAM_TAIL_MAX_LINES = 5;
const STREAM_TAIL_MAX_LINE_LENGTH = 512;

function formatStreamTail(label: string, value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  const truncated = trimmed
    .split('\n')
    .slice(-STREAM_TAIL_MAX_LINES)
    .map((line) =>
      line.length > STREAM_TAIL_MAX_LINE_LENGTH
        ? `${line.slice(0, STREAM_TAIL_MAX_LINE_LENGTH)}…[+${
            line.length - STREAM_TAIL_MAX_LINE_LENGTH
          } chars]`
        : line,
    )
    .join(' / ');
  return ` | ${label}: ${truncated}`;
}

/**
 * Issue #842: structured AX walker topology, parsed from the `walker_*`
 * JSON-line stderr events the Swift bridge emits under `--debug`
 * (#660 PR C / #691). Attached to a thrown {@link AccessibilityBridgeError}
 * on a recoverable failure so the next real failure is self-diagnosing
 * without a manual repro.
 */
export interface AxTopologyWindow {
  role: string;
  subrole: string;
  title: string;
  identifier: string;
}

export interface AxTopologyOverlaySample {
  depth: number;
  role: string;
  label: string | null;
}

export interface AxTopologyWinner {
  depth: number;
  role: string;
  label: string | null;
  score: number;
  appSemanticsCount: number;
}

export interface AxTopology {
  /** Number of AX children Simulator.app exposed (device window + menubar, …). */
  windowCount?: number;
  windows?: AxTopologyWindow[];
  /** Count of overlay-suspect roles (AXSheet/AXAlert/…) the walk encountered. */
  overlayRolesSeen?: number;
  overlaySamples?: AxTopologyOverlaySample[];
  /** Winning content-root candidate, or null when the walk found none. */
  winner?: AxTopologyWinner | null;
}

/**
 * Time budget for the best-effort `--debug` re-capture on the failure
 * path. Kept short: this runs only after an AX read already failed, so a
 * second hang must not compound the original latency.
 */
const AX_DEBUG_RECAPTURE_TIMEOUT_MS = 8_000;

/**
 * Parse the Swift bridge's `--debug` stderr (one JSON object per line)
 * into a compact {@link AxTopology}. Non-JSON lines and unrelated debug
 * events are ignored. Returns `undefined` when no `walker_*` event is
 * present, so a quiet/empty stream never produces a noisy empty object.
 */
export function parseWalkerTopology(stderr: string | undefined): AxTopology | undefined {
  if (!stderr) return undefined;
  let found = false;
  const topology: AxTopology = {};

  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;

    let evt: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      evt = parsed as Record<string, unknown>;
    } catch {
      // Not JSON (e.g. a stray log line) — skip.
      continue;
    }

    switch (evt.event) {
      case 'walker_app_windows_enumerated':
        found = true;
        if (typeof evt.count === 'number') topology.windowCount = evt.count;
        if (Array.isArray(evt.windows)) {
          topology.windows = evt.windows.map((w) => {
            const win = (w ?? {}) as Record<string, unknown>;
            return {
              role: String(win.role ?? ''),
              subrole: String(win.subrole ?? ''),
              title: String(win.title ?? ''),
              identifier: String(win.identifier ?? ''),
            };
          });
        }
        break;
      case 'walker_overlay_roles_seen':
        found = true;
        if (typeof evt.count === 'number') topology.overlayRolesSeen = evt.count;
        if (Array.isArray(evt.samples)) {
          topology.overlaySamples = evt.samples.map((s) => {
            const sample = (s ?? {}) as Record<string, unknown>;
            return {
              depth: Number(sample.depth ?? 0),
              role: String(sample.role ?? ''),
              label: sample.label == null ? null : String(sample.label),
            };
          });
        }
        break;
      case 'walker_winner':
        found = true;
        topology.winner = {
          depth: Number(evt.depth ?? 0),
          role: String(evt.role ?? ''),
          label: evt.label == null ? null : String(evt.label),
          score: Number(evt.score ?? 0),
          appSemanticsCount: Number(evt.appSemanticsCount ?? 0),
        };
        break;
      case 'walker_winner_none':
        found = true;
        topology.winner = null;
        break;
      default:
        break;
    }
  }

  return found ? topology : undefined;
}

/**
 * Opt-in gate (issue #842). The success path is never affected; only a
 * recoverable dump/query failure triggers the one-shot `--debug`
 * re-capture, and only when this is set.
 */
function axDebugOnFailureEnabled(): boolean {
  return process.env.OPENSAFARI_AX_DEBUG_ON_FAILURE === '1';
}

export interface AccessibilityBridgeOptions {
  /**
   * Pre-resolve the bridge path, bypassing the filesystem search.
   *
   * Dependency-injection seam used by tests (issue #643 recovery fixture)
   * so a fake ax-bridge stand-in can be exercised without touching the
   * production binary layout or environment variables. Production callers
   * should omit this and rely on `resolveBridgePath()`.
   */
  bridgePath?: string;
}

export class AccessibilityBridge {
  private bridgePath: string | null = null;

  constructor(options?: AccessibilityBridgeOptions) {
    if (options?.bridgePath) {
      this.bridgePath = options.bridgePath;
    }
  }

  /**
   * Resolve the path to the ax-bridge-native binary or its Swift source.
   *
   * Only the native Swift binary (`ax-bridge-native`) and its source are
   * considered here. The Node wrapper at `dist/ax-bridge` is invoked from
   * `cli/` — it MUST NOT appear in this candidate list, otherwise a failed
   * native compile would cause the wrapper to `execFile` itself recursively
   * (fork bomb).
   *
   * Search order:
   *   1. Compiled native binary — parent dir (tsc output layout: dist/native/)
   *   2. Compiled native binary — same dir (webpack flat layout: dist/)
   *   3. Swift source — parent dir
   *   4. Swift source — same dir (postbuild copy to dist/)
   *   5. Dev-only source tree fallback, gated behind OPENSAFARI_ALLOW_SWIFT_INTERPRETER=1
   */
  private async resolveBridgePath(): Promise<string> {
    if (this.bridgePath) return this.bridgePath;

    const candidates: string[] = [
      // 1. Compiled native binary — parent dir (tsc output layout: dist/native/)
      path.resolve(__dirname, '..', 'ax-bridge-native'),
      // 2. Compiled native binary — same dir (webpack flat layout: dist/)
      path.resolve(__dirname, 'ax-bridge-native'),
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
      `ax-bridge-native not found. Searched:\n${searched}\n` +
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

    // Captured outside the inner `try` so the SyntaxError path on
    // `JSON.parse(stdout)` can still surface diagnostic tails — Node's
    // `SyntaxError` does not carry stdout/stderr, so without this the
    // catch block would degrade to `BRIDGE_EXEC_FAILED: SyntaxError …`
    // with no clue what the bridge actually printed.
    let capturedStdout: string | undefined;
    let capturedStderr: string | undefined;

    try {
      const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large trees
      });
      capturedStdout = stdout;
      capturedStderr = stderr;

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

      const error = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: string;
        killed?: boolean;
      };

      if (error.killed) {
        throw new AccessibilityBridgeError(
          'Accessibility tree dump timed out. The app may have too many elements.',
          'AX_TIMEOUT',
        );
      }

      // Prefer the captured streams (populated only on the resolve path
      // before `JSON.parse` throws) over `error.stdout/stderr` (populated
      // by Node when `execFile` rejects with non-zero exit). Either source
      // gives us actual bridge output; both are undefined for unrelated
      // errors (e.g. spawn failure, ENOENT).
      const stdoutForDiag = error.stdout ?? capturedStdout;
      const stderrForDiag = error.stderr ?? capturedStderr;

      // Issue #842: opt-in self-diagnosis. On a recoverable dump/query
      // failure, re-invoke once with `--debug` and parse the `walker_*`
      // topology so the thrown error carries why the AX read came up empty
      // (sibling window vs in-subtree vs degraded read) without a manual
      // repro. The success path never reaches here, so stderr volume on a
      // healthy dump is unchanged. Best-effort: a failed re-capture leaves
      // topology undefined and never masks the original error.
      const command = args[0];
      const topology =
        axDebugOnFailureEnabled() && (command === 'dump' || command === 'query')
          ? await this.captureAxTopologyOnFailure(cmd, cmdArgs)
          : undefined;

      // Issue #693 WU1: the bridge writes its structured ErrorJSON
      // (`{ error, code }`) to STDOUT and then `exit(1)`, NOT to stderr —
      // see `outputError()` in `src/native/ax-bridge.swift`. The previous
      // implementation only inspected `error.stderr` here, so every typed
      // bridge error (DEVICE_CONTENT_ROOT_EMPTY, DEVICE_RESOLUTION_FAILED,
      // SIMULATOR_NOT_RUNNING, etc.) collapsed to the generic
      // `Command failed: <cmd>` tail and the caller could not branch on
      // `code`. Try stdout first; keep stderr as a fallback so legacy
      // callers that emit JSON on stderr (or `swift` interpreter compile
      // errors) still surface cleanly.
      const structuredCandidates = [stdoutForDiag, stderrForDiag];
      for (const candidate of structuredCandidates) {
        if (!candidate) continue;
        try {
          const errJson = JSON.parse(candidate);
          if (errJson && typeof errJson === 'object' && typeof errJson.error === 'string') {
            throw new AccessibilityBridgeError(
              errJson.error,
              typeof errJson.code === 'string' ? errJson.code : 'AX_ERROR',
              topology,
            );
          }
        } catch (parseErr) {
          if (parseErr instanceof AccessibilityBridgeError) throw parseErr;
          // Not JSON — fall through and try the next stream.
        }
      }

      // Include both stdout and stderr tails in the thrown message so the
      // caller sees the same diagnostic shape regardless of which stream
      // the bridge wrote to. Without this the message degrades to
      // `Command failed: <cmd>` and every CI failure looks identical
      // regardless of root cause (unsigned binary, missing TCC, simulator
      // not booted, swift interpreter compile error, etc.). Per-line
      // truncation prevents a single mega-line from exploding the error
      // message — `maxBuffer` is 10 MB and a degenerate dump on a deep
      // tree could fill it.
      throw new AccessibilityBridgeError(
        `ax-bridge failed (${cmd}): ${error.message}` +
          formatStreamTail('stdout', stdoutForDiag) +
          formatStreamTail('stderr', stderrForDiag),
        'BRIDGE_EXEC_FAILED',
        topology,
      );
    }
  }

  /**
   * Best-effort `--debug` re-capture for issue #842. Re-invokes the
   * already-failed command once with `--debug` appended and parses the
   * `walker_*` topology from stderr. Never throws: the bridge re-invoke
   * itself usually exits non-zero (the original failure reproduces), so we
   * read stderr off the rejection and parse it. Returns `undefined` on any
   * problem so the caller's primary error is never masked.
   */
  private async captureAxTopologyOnFailure(
    cmd: string,
    cmdArgs: string[],
  ): Promise<AxTopology | undefined> {
    try {
      const debugArgs = cmdArgs.includes('--debug') ? cmdArgs : [...cmdArgs, '--debug'];
      const result = await execFileAsync(cmd, debugArgs, {
        timeout: AX_DEBUG_RECAPTURE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      }).catch((e: { stderr?: string }) => ({ stderr: e?.stderr }));
      return parseWalkerTopology(result.stderr);
    } catch {
      return undefined;
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
    /**
     * Issue #842: AX walker topology parsed from a best-effort `--debug`
     * re-capture, present only on recoverable dump/query failures when
     * `OPENSAFARI_AX_DEBUG_ON_FAILURE=1`. Undefined otherwise.
     */
    public readonly topology?: AxTopology,
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
