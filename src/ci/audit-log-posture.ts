/**
 * Helpers for asserting on the posture of `~/.opensafari/audit.log`.
 *
 * The audit log is JSONL. We intentionally keep the scan tolerant of the
 * exact schema so regressions that add new fields (or move `backendKind`
 * between top-level and nested positions) do not silently pass.
 *
 * Two signals matter for the #540 acceptance criteria:
 *
 *   1. `applescriptHits` — any entry that mentions `applescript` (case
 *      insensitive) is a headless-posture violation when
 *      `OPENSAFARI_HEADLESS_ONLY=1` is set.
 *   2. `backendKinds` — the set of backend identifiers we can extract from
 *      the log, regardless of whether they live at the top level or inside
 *      a stringified `args_summary`. The allowed set is
 *      `{'flutter-vm','simhid','webkit'}`.
 */

import * as fs from 'node:fs';

/**
 * The only `InputBackendKind` values that satisfy the #540 acceptance
 * criterion. Keep this list narrow — any legacy backend (`applescript`,
 * `simctl`, `ax-press`) should be rejected by the posture check.
 */
export const ALLOWED_BACKEND_KINDS: readonly string[] = Object.freeze([
  'flutter-vm',
  'simhid',
  'webkit',
]);

export interface AuditLogPosture {
  /** Total JSONL lines inspected (including unparseable ones). */
  total: number;
  /** How many lines mention `applescript` (case-insensitive substring). */
  applescriptHits: number;
  /** All `backendKind` string values found anywhere in the log. */
  backendKinds: string[];
  /** Subset of `backendKinds` that are not in `ALLOWED_BACKEND_KINDS`. */
  disallowedBackendKinds: string[];
}

// Match both regular (`"backendKind":"simhid"`) and escape-quoted
// (`\"backendKind\":\"simhid\"`) forms — the latter shows up when the
// field is nested inside a stringified JSON payload (e.g. `args_summary`).
const BACKEND_KIND_REGEX = /\\?"backendKind\\?"\s*:\s*\\?"([A-Za-z0-9_-]+)\\?"/g;
const APPLESCRIPT_REGEX = /applescript/i;

/**
 * Scan the given audit log file and return a posture report. Absent logs
 * are treated as zero-entry (vacuous pass); callers decide whether that is
 * acceptable for their gate.
 */
export function scanAuditLog(logPath: string): AuditLogPosture {
  const report: AuditLogPosture = {
    total: 0,
    applescriptHits: 0,
    backendKinds: [],
    disallowedBackendKinds: [],
  };

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return report;
    }
    throw err;
  }

  const lines = raw.split('\n').filter((line) => line.length > 0);
  report.total = lines.length;

  const seenKinds = new Set<string>();

  for (const line of lines) {
    if (APPLESCRIPT_REGEX.test(line)) {
      report.applescriptHits += 1;
    }
    BACKEND_KIND_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BACKEND_KIND_REGEX.exec(line)) !== null) {
      seenKinds.add(match[1]);
    }
  }

  report.backendKinds = Array.from(seenKinds).sort();
  report.disallowedBackendKinds = report.backendKinds.filter(
    (kind) => !ALLOWED_BACKEND_KINDS.includes(kind),
  );

  return report;
}

/**
 * Convenience assertion used by the integration smoke tests. Throws with a
 * multi-line message that names the offending backend kinds and how often
 * they appeared so the Jest failure output is actionable.
 */
export function assertAuditLogPosture(logPath: string): AuditLogPosture {
  const report = scanAuditLog(logPath);
  const problems: string[] = [];
  if (report.applescriptHits > 0) {
    problems.push(
      `audit.log references applescript in ${report.applescriptHits}/${report.total} entries`,
    );
  }
  if (report.disallowedBackendKinds.length > 0) {
    problems.push(
      `disallowed backendKind(s) present: ${report.disallowedBackendKinds.join(', ')} (allowed: ${ALLOWED_BACKEND_KINDS.join(', ')})`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`audit log posture violated (${logPath}):\n  - ${problems.join('\n  - ')}`);
  }
  return report;
}
