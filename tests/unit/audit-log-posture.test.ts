import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALLOWED_BACKEND_KINDS,
  assertAuditLogPosture,
  scanAuditLog,
} from '../../src/ci/audit-log-posture';

describe('src/ci/audit-log-posture', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-posture-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: string[]): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    return file;
  }

  it('returns a zero-entry report when the log is absent', () => {
    const report = scanAuditLog(path.join(tmpDir, 'nope.log'));
    expect(report).toEqual({
      total: 0,
      applescriptHits: 0,
      backendKinds: [],
      disallowedBackendKinds: [],
    });
  });

  it('reports zero hits when the log is empty', () => {
    const file = writeLog('empty.log', []);
    expect(scanAuditLog(file).total).toBe(0);
  });

  it('extracts backendKind values from top-level fields', () => {
    const file = writeLog('top-level.log', [
      '{"tool":"app_tap","backendKind":"simhid"}',
      '{"tool":"navigate","backendKind":"webkit"}',
      '{"tool":"flutter_tap","backendKind":"flutter-vm"}',
      '{"tool":"app_tap_element","backendKind":"ax-press"}',
    ]);
    const report = scanAuditLog(file);
    expect(report.backendKinds).toEqual(
      [...ALLOWED_BACKEND_KINDS].sort(),
    );
    expect(report.disallowedBackendKinds).toEqual([]);
    expect(report.applescriptHits).toBe(0);
  });

  it('extracts backendKind values even when nested inside args_summary strings', () => {
    const file = writeLog('nested.log', [
      '{"tool":"app_tap","args_summary":"{\\"kind\\":\\"x\\",\\"backendKind\\":\\"simhid\\"}"}',
    ]);
    const report = scanAuditLog(file);
    expect(report.backendKinds).toEqual(['simhid']);
  });

  it('flags disallowed backend kinds', () => {
    const file = writeLog('bad.log', [
      '{"tool":"app_tap","backendKind":"simhid"}',
      '{"tool":"app_tap","backendKind":"applescript"}',
      '{"tool":"app_tap","backendKind":"simctl"}',
    ]);
    const report = scanAuditLog(file);
    expect(report.backendKinds.sort()).toEqual(['applescript', 'simctl', 'simhid']);
    expect(report.disallowedBackendKinds.sort()).toEqual(['applescript', 'simctl']);
    expect(report.applescriptHits).toBe(1);
  });

  it('treats ax-press as an allowed headless backend', () => {
    const file = writeLog('ax-press.log', [
      '{"tool":"app_tap_element","backendKind":"ax-press"}',
    ]);
    const report = scanAuditLog(file);
    expect(report.backendKinds).toEqual(['ax-press']);
    expect(report.disallowedBackendKinds).toEqual([]);
    expect(report.applescriptHits).toBe(0);
  });

  it('is case-insensitive for applescript detection', () => {
    const file = writeLog('case.log', ['warning: AppleScript fallback engaged']);
    const report = scanAuditLog(file);
    expect(report.applescriptHits).toBe(1);
  });

  it('tolerates malformed JSONL lines without throwing', () => {
    const file = writeLog('malformed.log', [
      'not-json-at-all',
      '{"partial":',
      '{"tool":"app_tap","backendKind":"webkit"}',
    ]);
    const report = scanAuditLog(file);
    expect(report.total).toBe(3);
    expect(report.backendKinds).toEqual(['webkit']);
  });

  it('assertAuditLogPosture returns the report when clean', () => {
    const file = writeLog('clean.log', [
      '{"tool":"app_tap","backendKind":"simhid"}',
      '{"tool":"navigate","backendKind":"webkit"}',
    ]);
    const report = assertAuditLogPosture(file);
    expect(report.applescriptHits).toBe(0);
    expect(report.disallowedBackendKinds).toEqual([]);
  });

  it('assertAuditLogPosture throws when applescript is present', () => {
    const file = writeLog('violating.log', [
      '{"tool":"app_tap","backendKind":"applescript"}',
    ]);
    expect(() => assertAuditLogPosture(file)).toThrow(/applescript/);
  });

  it('assertAuditLogPosture names every disallowed kind in its error message', () => {
    const file = writeLog('multi-bad.log', [
      '{"tool":"app_tap","backendKind":"simctl"}',
      '{"tool":"app_tap","backendKind":"applescript"}',
    ]);
    expect(() => assertAuditLogPosture(file)).toThrow(/simctl/);
    expect(() => assertAuditLogPosture(file)).toThrow(/applescript/);
  });
});
