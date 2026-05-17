/**
 * Unit tests for ax-bridge --help output.
 *
 * Shells out to `node dist/ax-bridge --help` (and per-subcommand variants)
 * to verify exit 0 and the expected usage header is present.
 *
 * Requires the project to be built first (`npm run build`).
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

const DIST_AX_BRIDGE = path.resolve(__dirname, '..', '..', 'dist', 'ax-bridge');

const COMMANDS = ['dump', 'query', 'inspect', 'press', 'context'] as const;

describe('ax-bridge --help', () => {
  it('top-level --help exits 0 and prints usage header', () => {
    const result = spawnSync('node', [DIST_AX_BRIDGE, '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ax-bridge <command>');
    expect(result.stdout).toContain('Commands:');
  });

  it('top-level -h exits 0 and prints usage header', () => {
    const result = spawnSync('node', [DIST_AX_BRIDGE, '-h'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ax-bridge <command>');
    expect(result.stdout).toContain('Commands:');
  });

  it('no arguments exits 0 and prints top-level help', () => {
    const result = spawnSync('node', [DIST_AX_BRIDGE], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ax-bridge <command>');
    expect(result.stdout).toContain('Commands:');
  });

  for (const cmd of COMMANDS) {
    it(`${cmd} --help exits 0 and prints usage header`, () => {
      const result = spawnSync('node', [DIST_AX_BRIDGE, cmd, '--help'], {
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ax-bridge <command>');
      expect(result.stdout).toContain('Commands:');
    });
  }

  it('top-level help lists all five commands', () => {
    const result = spawnSync('node', [DIST_AX_BRIDGE, '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    for (const cmd of COMMANDS) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('query --help includes query-specific flags', () => {
    const result = spawnSync('node', [DIST_AX_BRIDGE, 'query', '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--role');
    expect(result.stdout).toContain('--label');
    expect(result.stdout).toContain('--text');
    expect(result.stdout).toContain('--identifier');
  });
});
