/**
 * Shared interface and type definitions for native input backends.
 *
 * Split from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. All concrete backends and the resolver depend on this module;
 * nothing here depends on them (no cycles).
 */

/**
 * Stable identifier for each concrete input backend. Included in tool call
 * results so MCP clients and users can audit which path dispatched their
 * input — useful when diagnosing focus-theft reports or confirming that a
 * call stayed on a headless tier.
 */
export type InputBackendKind =
  | 'flutter-vm'
  | 'simctl'
  | 'webkit'
  | 'applescript'
  | 'simhid'
  | 'ax-press'
  | 'pointer-service';

/**
 * A single tap event used in batch dispatch. Mirrors the signature of
 * `InputBackend.tap` but excludes the `deviceId` (supplied once at the
 * batch-call level) to avoid repetition in large queues.
 */
export interface BatchTapEvent {
  x: number;
  y: number;
  /** Optional long-press duration in seconds. */
  duration?: number;
}

export interface InputBackend {
  /** Stable identifier used for observability / audit logging. */
  readonly kind: InputBackendKind;

  tap(deviceId: string, x: number, y: number, duration?: number): Promise<void>;
  swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void>;
  /**
   * Type `text` into whatever is currently focused on `deviceId`.
   *
   * `delayMs` is an optional inter-character pause between consecutive key
   * sends, in milliseconds. Only the simhid backend honours it (other
   * backends bypass the software keyboard and have no equivalent failure
   * mode); they may safely ignore the argument. Required for segmented
   * OTP-style fields that drop characters when keys arrive too fast (issue
   * #639 Problem 2). Default 0 (no pause).
   */
  typeText(deviceId: string, text: string, delayMs?: number): Promise<void>;
  keypress(deviceId: string, keyCode: string): Promise<void>;
  sendKey(deviceId: string, keyName: string): Promise<void>;

  /**
   * Whether this backend supports the `tapBatch()` method for submitting
   * multiple tap events in a single logical call. Callers MUST check this
   * before calling `tapBatch()` — the method is absent on backends that
   * return `false`.
   *
   * **Unsupported combinations**: `tapBatch` is intentionally NOT available
   * on `SimctlInputBackend` (each simctl invocation opens a separate Xcode
   * process, so batching at the TS level provides no meaningful reduction),
   * `WebKitInputBackend` (JS injection is already in-process with no spawn
   * cost), `FlutterVMInputBackend` (same — evaluate over a WebSocket),
   * `AppleScriptInputBackend` (opt-in focus-stealing path; batching would
   * hide per-tap activation overhead rather than remove it), and
   * `PointerServiceInputBackend` (tap-ps subcommand is experimental;
   * batching is deferred until Phase 2 of #590).
   */
  supportsBatching(): boolean;

  /**
   * Submit multiple tap events to `deviceId` sequentially, reducing the
   * per-call overhead that a caller would otherwise pay by invoking
   * `tap()` in a loop.
   *
   * Only available when `supportsBatching()` returns `true`. Callers must
   * guard with `supportsBatching()` before calling this method; calling
   * it on a backend that does not advertise batching support is a
   * programming error and will throw.
   *
   * The events are dispatched in order. If any event fails, the batch
   * stops and rejects with that error — already-dispatched events are
   * NOT rolled back (HID injection is fire-and-forget at the OS level).
   */
  tapBatch?(deviceId: string, events: BatchTapEvent[]): Promise<void>;
}
