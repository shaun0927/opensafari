import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALLOWED_BACKEND_KINDS,
  assertAuditLogPosture,
  scanAuditLog,
} from '../../src/ci/audit-log-posture';

/**
 * Runs against the real `~/.opensafari/audit.log` produced by earlier live
 * smoke tests in the same CI job. Lives in `tests/integration/` so the
 * default `npm test` pass skips it — the smoke workflow invokes it
 * explicitly via `--runTestsByPath`.
 *
 * Gate: if `$OPENSAFARI_AUDIT_LOG` is set, use that path (lets CI point at
 * an alternate collector). Otherwise fall back to the runtime location.
 *
 * Refs: #540 acceptance criterion
 *   "Telemetry: backendKind in {'flutter-vm','simhid','webkit'} only
 *    (applescript = 0)"
 */
describe('audit.log posture — backendKind constraint', () => {
  const logPath =
    process.env.OPENSAFARI_AUDIT_LOG ||
    path.join(os.homedir(), '.opensafari', 'audit.log');

  it(`has no 'applescript' references (${logPath})`, () => {
    const report = scanAuditLog(logPath);
    expect(report.applescriptHits).toBe(0);
  });

  it('records only backendKind values in the allowed set', () => {
    const report = scanAuditLog(logPath);
    for (const kind of report.backendKinds) {
      expect(ALLOWED_BACKEND_KINDS).toContain(kind);
    }
    expect(report.disallowedBackendKinds).toEqual([]);
  });

  it('assertAuditLogPosture does not throw', () => {
    expect(() => assertAuditLogPosture(logPath)).not.toThrow();
  });
});
