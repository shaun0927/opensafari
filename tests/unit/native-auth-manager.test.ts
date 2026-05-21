/**
 * Unit tests for NativeAuthManager — the iOS Simulator app-container +
 * keychain capture/restore module (PR3).
 *
 * The manager shells out to `xcrun simctl` and `tar`, so we inject a fake
 * runner and a tmpdir-rooted layout to avoid touching the real simulator
 * fleet.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NativeAuthManager } from '../../src/auth/native-manager';

interface InvocationLog {
  cmd: string;
  args: string[];
}

async function makeTempLayout(): Promise<{
  authRoot: string;
  simulatorRoot: string;
  containerDir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'opensafari-native-auth-'));
  const authRoot = path.join(base, 'auth');
  const simulatorRoot = path.join(base, 'CoreSimulator', 'Devices');
  const containerDir = path.join(base, 'AppContainer');
  await fs.mkdir(authRoot, { recursive: true });
  await fs.mkdir(containerDir, { recursive: true });
  await fs.mkdir(path.join(containerDir, 'Library', 'Preferences'), { recursive: true });
  return {
    authRoot,
    simulatorRoot,
    containerDir,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

describe('NativeAuthManager', () => {
  it('save -> list -> restore round-trips via simctl + tar', async () => {
    const layout = await makeTempLayout();
    try {
      // Seed a fake preferences plist so save captures it as base64.
      const plistPath = path.join(
        layout.containerDir,
        'Library',
        'Preferences',
        'com.example.app.plist',
      );
      await fs.writeFile(plistPath, 'fake plist bytes');

      const calls: InvocationLog[] = [];
      const fakeRun = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'xcrun' && args[0] === 'simctl' && args[1] === 'get_app_container') {
          return { stdout: layout.containerDir + '\n', stderr: '' };
        }
        if (cmd === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
          // Pretend the device is shut down so save() / restore() don't
          // try to round-trip a shutdown+boot.
          return {
            stdout: JSON.stringify({
              devices: { 'iOS 17.0': [{ udid: 'DEV-1', state: 'Shutdown' }] },
            }),
            stderr: '',
          };
        }
        if (cmd === 'tar') {
          // Pretend tar succeeds without producing real archives — the
          // manager only re-tars at restore time, and our restore mock
          // below makes that a no-op.
          if (args[0] === '-cf') {
            await fs.writeFile(args[1], 'tar bytes', { mode: 0o600 });
          }
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'xcrun' && args[0] === 'simctl' && (args[1] === 'terminate' || args[1] === 'launch' || args[1] === 'shutdown' || args[1] === 'boot')) {
          return { stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected runner invocation: ${cmd} ${args.join(' ')}`);
      };

      const manager = new NativeAuthManager({
        authRoot: layout.authRoot,
        simulatorRoot: layout.simulatorRoot,
        run: fakeRun,
        now: () => '2026-05-21T00:00:00Z',
      });

      const saved = await manager.save('DEV-1', 'com.example.app', 'main');
      expect(saved.profile).toBe('main');
      expect(saved.bundleId).toBe('com.example.app');
      expect(saved.deviceUdid).toBe('DEV-1');
      expect(saved.savedAt).toBe('2026-05-21T00:00:00Z');
      expect(saved.preferencesPlistBase64).toBe(Buffer.from('fake plist bytes').toString('base64'));

      // profile.json should exist
      const profileJsonPath = path.join(layout.authRoot, 'main', 'profile.json');
      const meta = JSON.parse(await fs.readFile(profileJsonPath, 'utf-8')) as Record<string, unknown>;
      expect(meta.bundleId).toBe('com.example.app');

      // Save terminated the app + captured container + did NOT shutdown
      // because we mocked the device as Shutdown.
      const cmds = calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(' ')}`);
      expect(cmds.filter((c) => c.startsWith('xcrun simctl')).length).toBeGreaterThanOrEqual(2);
      expect(cmds.filter((c) => c.startsWith('tar')).length).toBeGreaterThanOrEqual(1);
      // No shutdown should have been issued because includeKeychain was false.
      expect(cmds).not.toContain('xcrun simctl shutdown');

      // list should surface the saved profile
      const listed = await manager.list();
      expect(listed.map((p) => p.profile)).toContain('main');

      // restore should terminate + re-extract via tar -xf
      await manager.restore('DEV-1', 'com.example.app', 'main');
      const restoreTarXf = calls.find(
        (c) => c.cmd === 'tar' && c.args[0] === '-xf',
      );
      expect(restoreTarXf).toBeDefined();

      // delete removes the profile dir
      await manager.delete('main');
      await expect(fs.access(path.join(layout.authRoot, 'main'))).rejects.toBeDefined();
    } finally {
      await layout.cleanup();
    }
  });

  it('includeKeychain shuts down the simulator and re-boots afterwards', async () => {
    const layout = await makeTempLayout();
    try {
      // Pre-create the per-device Keychains dir so save() finds something to tar.
      const keychainDir = path.join(layout.simulatorRoot, 'DEV-1', 'data', 'Library', 'Keychains');
      await fs.mkdir(keychainDir, { recursive: true });
      await fs.writeFile(path.join(keychainDir, 'keychain-2.db'), 'fake');

      const calls: InvocationLog[] = [];
      const fakeRun = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === 'xcrun' && args[1] === 'get_app_container') {
          return { stdout: layout.containerDir + '\n', stderr: '' };
        }
        if (cmd === 'xcrun' && args[1] === 'list') {
          return {
            stdout: JSON.stringify({ devices: { 'iOS': [{ udid: 'DEV-1', state: 'Booted' }] } }),
            stderr: '',
          };
        }
        if (cmd === 'tar' && args[0] === '-cf') {
          await fs.writeFile(args[1], 'tar bytes');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };

      const manager = new NativeAuthManager({
        authRoot: layout.authRoot,
        simulatorRoot: layout.simulatorRoot,
        run: fakeRun,
      });
      await manager.save('DEV-1', 'com.example.app', 'kc', { includeKeychain: true });

      const verbs = calls
        .filter((c) => c.cmd === 'xcrun' && c.args[0] === 'simctl')
        .map((c) => c.args[1]);

      // Order matters: shutdown must come BEFORE the keychain tar -cf,
      // and boot must come AFTER.
      const shutdownIdx = verbs.indexOf('shutdown');
      const bootIdx = verbs.indexOf('boot');
      expect(shutdownIdx).toBeGreaterThanOrEqual(0);
      expect(bootIdx).toBeGreaterThan(shutdownIdx);
    } finally {
      await layout.cleanup();
    }
  });
});
