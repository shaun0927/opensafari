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
}
