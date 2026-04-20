/**
 * TypeScript reference implementation of the ax-bridge device targeting
 * contract (GitHub issue #3). The production path is the Swift function
 * `resolveRequestedDevice` + `scoreWindow` / `findMatchingWindow` in
 * `src/native/ax-bridge.swift`; this file mirrors the same rubric so the
 * algorithm is unit-testable from Jest.
 *
 * The two implementations MUST stay in lock-step. Any change to the
 * resolution rules, ambiguity detection, or window scoring weights must
 * land in both files together.
 *
 * Input surfaces are pure data — the TS port does not shell out to simctl
 * or the AX subsystem. Callers that need the live data path should continue
 * to invoke `dist/ax-bridge` from the packaged binary.
 */

export const DEVICE_RESOLUTION_FAILED = 'DEVICE_RESOLUTION_FAILED' as const;
export const DEVICE_RESOLUTION_AMBIGUOUS = 'DEVICE_RESOLUTION_AMBIGUOUS' as const;
export const DEVICE_WINDOW_NOT_FOUND = 'DEVICE_WINDOW_NOT_FOUND' as const;
export const DEVICE_WINDOW_AMBIGUOUS = 'DEVICE_WINDOW_AMBIGUOUS' as const;

export type DeviceResolutionErrorCode =
  | typeof DEVICE_RESOLUTION_FAILED
  | typeof DEVICE_RESOLUTION_AMBIGUOUS
  | typeof DEVICE_WINDOW_NOT_FOUND
  | typeof DEVICE_WINDOW_AMBIGUOUS;

export interface SimulatorDeviceRecord {
  udid: string;
  name: string;
  runtimeIdentifier: string;
  state: string;
}

export interface AXWindowMetadata {
  title: string;
  identifier: string;
}

export interface ResolutionError {
  code: DeviceResolutionErrorCode;
  error: string;
}

export interface ResolveResult {
  target: SimulatorDeviceRecord | null;
  error: ResolutionError | null;
}

export interface WindowMatchResult {
  match: AXWindowMetadata | null;
  error: ResolutionError | null;
}

/**
 * Port of `resolveRequestedDevice` in ax-bridge.swift:312-367.
 *
 * Rules (must match Swift):
 *   - `any` → `{target:null, error:null}`. Permissive-mode caller accepts any window.
 *   - `booted` → exactly one booted device required. Multiple booted → DEVICE_RESOLUTION_AMBIGUOUS.
 *                Zero booted → DEVICE_RESOLUTION_FAILED.
 *   - UDID (case-insensitive exact match) → must be booted, else DEVICE_RESOLUTION_FAILED.
 *   - Device-name (case-sensitive exact match) → booted match wins; multiple booted → AMBIGUOUS;
 *     name exists but not booted → FAILED with diagnostic listing UDIDs.
 *   - No match → DEVICE_RESOLUTION_FAILED.
 */
export function resolveRequestedDevice(
  requested: string,
  devices: readonly SimulatorDeviceRecord[],
): ResolveResult {
  if (requested === 'any') {
    return { target: null, error: null };
  }

  const booted = devices.filter((d) => d.state === 'Booted');

  if (requested === 'booted') {
    if (booted.length === 1) return { target: booted[0], error: null };
    if (booted.length === 0) {
      return {
        target: null,
        error: {
          code: DEVICE_RESOLUTION_FAILED,
          error: 'Requested booted device, but no booted simulators were found.',
        },
      };
    }
    return {
      target: null,
      error: {
        code: DEVICE_RESOLUTION_AMBIGUOUS,
        error: `Requested booted device, but found multiple booted simulators: ${JSON.stringify(booted.map((d) => d.name))}`,
      },
    };
  }

  const udidMatches = devices.filter(
    (d) => d.udid.toLowerCase() === requested.toLowerCase(),
  );
  if (udidMatches.length > 0) {
    const device = udidMatches[0];
    if (device.state !== 'Booted') {
      return {
        target: null,
        error: {
          code: DEVICE_RESOLUTION_FAILED,
          error: `Requested device ${requested} resolved to ${device.name}, but that simulator is not booted.`,
        },
      };
    }
    return { target: device, error: null };
  }

  const allNameMatches = devices.filter((d) => d.name === requested);
  const bootedNameMatches = allNameMatches.filter((d) => d.state === 'Booted');
  if (bootedNameMatches.length === 1) return { target: bootedNameMatches[0], error: null };
  if (bootedNameMatches.length > 1) {
    return {
      target: null,
      error: {
        code: DEVICE_RESOLUTION_AMBIGUOUS,
        error: `Requested device name '${requested}' matched multiple booted simulators: ${JSON.stringify(bootedNameMatches.map((d) => d.udid))}`,
      },
    };
  }
  if (allNameMatches.length > 0) {
    return {
      target: null,
      error: {
        code: DEVICE_RESOLUTION_FAILED,
        error: `Requested device name '${requested}' matched ${allNameMatches.length} simulator(s) (${JSON.stringify(allNameMatches.map((d) => d.udid))}), but none are booted.`,
      },
    };
  }

  return {
    target: null,
    error: {
      code: DEVICE_RESOLUTION_FAILED,
      error: `Could not resolve requested device '${requested}' to a simulator via simctl list devices -j.`,
    },
  };
}

interface WindowCandidate {
  window: AXWindowMetadata;
  score: number;
}

/**
 * Port of `scoreWindow` in ax-bridge.swift:369-387. Integer scores are the
 * rubric — same weights, same tie-breaking rules. Returns null when the
 * window does not match at all.
 *
 * Score tiers:
 *   1000 — title or identifier contains the target's UDID (strongest signal)
 *    900 — title or identifier exactly equals the target's device name
 *    850 — title begins with `<name> –` or `<name> -` (Simulator canonical form)
 *    800 — title or identifier contains the target's device name
 *
 * For `any`, every window returns a flat score of 1.
 */
export function scoreWindow(
  window: AXWindowMetadata,
  requested: string,
  target: SimulatorDeviceRecord | null,
): WindowCandidate | null {
  if (requested === 'any') {
    return { window, score: 1 };
  }

  if (!target) return null;

  let score = 0;
  const { title, identifier } = window;
  if (title.includes(target.udid) || identifier.includes(target.udid)) {
    score = Math.max(score, 1000);
  }
  if (title === target.name || identifier === target.name) {
    score = Math.max(score, 900);
  }
  if (title.includes(target.name) || identifier.includes(target.name)) {
    score = Math.max(score, 800);
  }
  if (title.startsWith(`${target.name} –`) || title.startsWith(`${target.name} -`)) {
    score = Math.max(score, 850);
  }

  if (score === 0) return null;
  return { window, score };
}

/**
 * Port of `findMatchingWindow` in ax-bridge.swift:389-431.
 *
 * Rules:
 *   - Empty window list → DEVICE_WINDOW_NOT_FOUND.
 *   - `any` → returns the first window.
 *   - Otherwise, windows are scored via `scoreWindow` and sorted by
 *     descending score (with title used as a deterministic secondary sort).
 *   - Zero candidates scored → DEVICE_WINDOW_NOT_FOUND with window-title diagnostics.
 *   - Multiple candidates share the top score → DEVICE_WINDOW_AMBIGUOUS.
 *   - Single top-score winner → match.
 */
export function findMatchingWindow(
  windows: readonly AXWindowMetadata[],
  requested: string,
  target: SimulatorDeviceRecord | null,
): WindowMatchResult {
  if (windows.length === 0) {
    return {
      match: null,
      error: {
        code: DEVICE_WINDOW_NOT_FOUND,
        error: 'Simulator.app is running but no accessibility windows were found.',
      },
    };
  }

  if (requested === 'any') {
    return { match: windows[0], error: null };
  }

  const candidates: WindowCandidate[] = windows
    .map((w) => scoreWindow(w, requested, target))
    .filter((c): c is WindowCandidate => c !== null);

  const sorted = [...candidates].sort((lhs, rhs) => {
    if (lhs.score !== rhs.score) return rhs.score - lhs.score;
    return lhs.window.title < rhs.window.title ? -1 : lhs.window.title > rhs.window.title ? 1 : 0;
  });

  const best = sorted[0];
  if (!best) {
    return {
      match: null,
      error: {
        code: DEVICE_WINDOW_NOT_FOUND,
        error: `Could not map requested device ${requested} to a Simulator window. Visible windows: ${JSON.stringify(windows.map((w) => (w.identifier ? `${w.title} [id=${w.identifier}]` : w.title)))}`,
      },
    };
  }

  const topScorePeers = sorted.filter((c) => c.score === best.score);
  if (topScorePeers.length > 1) {
    return {
      match: null,
      error: {
        code: DEVICE_WINDOW_AMBIGUOUS,
        error: `Requested device ${requested} matched multiple Simulator windows with the same confidence: ${JSON.stringify(topScorePeers.map((c) => c.window.title))}`,
      },
    };
  }

  return { match: best.window, error: null };
}
