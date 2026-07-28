import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/qa/appstoreconnect-build-status.mjs');
const FIXTURES = path.resolve(__dirname, '../../scripts/qa/fixtures-appstoreconnect-build-status');

function run(fixture: string) {
  const result = spawnSync('node', [SCRIPT, path.join(FIXTURES, fixture)], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stderr: result.stderr,
    stdout: result.stdout,
    json: JSON.parse(result.stdout),
  };
}

describe('scripts/qa/appstoreconnect-build-status.mjs', () => {
  it.each([
    ['processing.json', 'BUILD_PROCESSING'],
    ['available.json', 'BUILD_AVAILABLE'],
    ['beta-review-required.json', 'BETA_REVIEW_REQUIRED'],
    ['no-build.json', 'NO_BUILD'],
    ['unknown-with-secret.json', 'UNKNOWN'],
  ])('maps %s to %s', (fixture, status) => {
    const result = run(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.json.status).toBe(status);
    expect(result.stdout).not.toContain('SECRET_SHOULD_NOT_PRINT');
  });

  it('prints usage and exits 64 without an input path', () => {
    const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/Usage:/);
  });
});
