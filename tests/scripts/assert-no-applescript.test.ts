import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/assert-no-applescript.js');

function run(auditLog: string | null): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (auditLog === null) {
    env.OPENSAFARI_AUDIT_LOG = '/nonexistent/path/audit.log';
  } else {
    env.OPENSAFARI_AUDIT_LOG = auditLog;
  }
  const result = spawnSync('node', [SCRIPT], { env, encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('scripts/assert-no-applescript.js', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-no-applescript-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 when the audit log is absent', () => {
    const result = run(null);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/not present/);
  });

  it('exits 0 when the audit log has no applescript reference', () => {
    const file = path.join(tmpDir, 'clean.log');
    fs.writeFileSync(
      file,
      '{"tool":"app_tap","backendKind":"simhid"}\n{"tool":"navigate","backendKind":"webkit"}\n',
    );
    const result = run(file);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/free of applescript references/);
  });

  it('exits 1 and prints offending lines when applescript is mentioned', () => {
    const file = path.join(tmpDir, 'bad.log');
    fs.writeFileSync(
      file,
      '{"tool":"app_tap","backendKind":"simhid"}\n{"tool":"app_tap","backendKind":"applescript"}\n',
    );
    const result = run(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/::error::audit\.log references applescript/);
    expect(result.stderr).toMatch(/"backendKind":"applescript"/);
  });

  it('matches case-insensitively', () => {
    const file = path.join(tmpDir, 'mixedcase.log');
    fs.writeFileSync(file, 'loaded AppleScript backend as a fallback\n');
    const result = run(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mixedcase\.log:1/);
  });

  it('caps printed offenders at 20 lines', () => {
    const file = path.join(tmpDir, 'flood.log');
    const content = Array.from({ length: 50 }, () => 'applescript').join('\n');
    fs.writeFileSync(file, content + '\n');
    const result = run(file);
    expect(result.status).toBe(1);
    const offenderLines = result.stderr.split('\n').filter((l) => /flood\.log:\d+:/.test(l));
    expect(offenderLines).toHaveLength(20);
  });
});
