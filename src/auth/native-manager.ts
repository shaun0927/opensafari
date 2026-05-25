/**
 * Native iOS app auth manager — captures and restores the data that lives
 * inside an installed iOS Simulator app, separately from the WebKit/Safari
 * cookie-based AuthManager.
 *
 * Captures
 *   - The app's data container (`xcrun simctl get_app_container <udid> <bid>
 *     data`). This covers `Library/Preferences/<bid>.plist` (where
 *     `shared_preferences` and `flutter_secure_storage`'s UserDefaults
 *     fallback live), `Library/Application Support/` (sqflite, hive,
 *     Drift, custom DBs), and `Documents/` (file-based stores).
 *   - Optionally the per-device Keychain dir
 *     (`~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Library/Keychains/`),
 *     which carries `flutter_secure_storage`'s default backing store.
 *
 * Why a separate manager
 *   AuthManager is WebKit-only: it speaks `Page.getCookies` and JS-side
 *   `localStorage`. Flutter native apps store nothing in either. Trying to
 *   shoehorn native capture into the cookie code path would couple the
 *   two surfaces and force every existing WebKit auth caller to learn
 *   about simctl. Keep them apart; share only the on-disk root
 *   (`~/.opensafari/auth`).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const defaultExecFile = promisify(execFile);

/** Result of a captured native auth profile. Persisted as `profile.json`. */
export interface NativeAuthProfile {
  profile: string;
  bundleId: string;
  deviceUdid: string;
  savedAt: string;
  containerArchive: string;
  keychainArchive?: string;
  /** Base64 of `Library/Preferences/<bundleId>.plist` for quick inspection. */
  preferencesPlistBase64?: string;
}

export interface NativeAuthSaveOptions {
  /** Also capture `~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Library/Keychains/`.
   *  Requires shutting the simulator down so SecurityKeychain releases its
   *  open file handles; the manager re-boots afterwards unless
   *  `keepSimulatorBooted: false` is set. */
  includeKeychain?: boolean;
  /** When `includeKeychain` was applied and the sim was booted, re-boot
   *  after the keychain capture finishes. Defaults to true. */
  keepSimulatorBooted?: boolean;
}

export interface NativeAuthRestoreOptions {
  /** Re-launch the app via `simctl launch` after restore. Default false —
   *  callers typically want to drive launch via their own `app_launch` hook
   *  so the existing telemetry surfaces apply. */
  relaunch?: boolean;
}

type CmdRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Internal default runner — wraps `child_process.execFile` and decodes the
 *  buffer as UTF-8 so callers can treat both fields as strings. */
const realRunner: CmdRunner = async (cmd, args) => {
  const { stdout, stderr } = await defaultExecFile(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Override the default home dir lookup so tests can avoid hitting the
 *  user's real `~/.opensafari` and `~/Library/Developer/CoreSimulator`. */
interface NativeAuthManagerDeps {
  authRoot?: string;
  simulatorRoot?: string;
  run?: CmdRunner;
  /** Override for `Date.now`/`new Date()` to make savedAt deterministic in tests. */
  now?: () => string;
}

export class NativeAuthManager {
  private readonly authRoot: string;
  private readonly simulatorRoot: string;
  private readonly run: CmdRunner;
  private readonly now: () => string;

  constructor(deps?: NativeAuthManagerDeps) {
    this.authRoot = deps?.authRoot ?? path.join(os.homedir(), '.opensafari', 'auth', 'native');
    this.simulatorRoot = deps?.simulatorRoot
      ?? path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
    this.run = deps?.run ?? realRunner;
    this.now = deps?.now ?? (() => new Date().toISOString());
  }

  async save(
    deviceUdid: string,
    bundleId: string,
    profileName: string,
    options?: NativeAuthSaveOptions,
  ): Promise<NativeAuthProfile> {
    const profileDir = await this.ensureProfileDir(profileName);

    // The app must be terminated so the data container is not being
    // written to under us — Sqlite would otherwise produce a torn archive.
    try {
      await this.run('xcrun', ['simctl', 'terminate', deviceUdid, bundleId]);
    } catch {
      // Already not running — fine.
    }

    const containerDir = await this.resolveContainerDir(deviceUdid, bundleId);
    const containerArchive = path.join(profileDir, 'container.tar');
    await this.run('tar', ['-cf', containerArchive, '-C', containerDir, '.']);

    let keychainArchive: string | undefined;
    if (options?.includeKeychain) {
      const wasBooted = await this.isBooted(deviceUdid);
      if (wasBooted) {
        await this.run('xcrun', ['simctl', 'shutdown', deviceUdid]);
      }
      try {
        const keychainDir = this.keychainDirFor(deviceUdid);
        try {
          await fs.access(keychainDir);
          keychainArchive = path.join(profileDir, 'keychains.tar');
          await this.run('tar', ['-cf', keychainArchive, '-C', keychainDir, '.']);
        } catch {
          // No keychain dir on this device — leave keychainArchive undefined.
        }
      } finally {
        if (wasBooted && options?.keepSimulatorBooted !== false) {
          await this.run('xcrun', ['simctl', 'boot', deviceUdid]);
        }
      }
    }

    let preferencesPlistBase64: string | undefined;
    try {
      const plistPath = path.join(containerDir, 'Library', 'Preferences', `${bundleId}.plist`);
      preferencesPlistBase64 = (await fs.readFile(plistPath)).toString('base64');
    } catch {
      // No preferences file — likely a fresh install or non-Flutter app.
    }

    const profile: NativeAuthProfile = {
      profile: profileName,
      bundleId,
      deviceUdid,
      savedAt: this.now(),
      containerArchive,
      keychainArchive,
      preferencesPlistBase64,
    };
    await fs.writeFile(
      path.join(profileDir, 'profile.json'),
      JSON.stringify(profile, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    return profile;
  }

  async restore(
    deviceUdid: string,
    bundleId: string,
    profileName: string,
    options?: NativeAuthRestoreOptions,
  ): Promise<NativeAuthProfile> {
    const profileDir = path.join(this.authRoot, sanitize(profileName));
    const data = JSON.parse(
      await fs.readFile(path.join(profileDir, 'profile.json'), 'utf-8'),
    ) as NativeAuthProfile;

    try {
      await this.run('xcrun', ['simctl', 'terminate', deviceUdid, bundleId]);
    } catch {
      // Already terminated.
    }

    const containerDir = await this.resolveContainerDir(deviceUdid, bundleId);

    // Wipe the active container and replace it from the archive. We avoid
    // removing the root directory itself (the system retains a handle to
    // it) — clear only its visible children so a clean `tar -xf` populates
    // them again with the captured state.
    for (const entry of await fs.readdir(containerDir)) {
      await fs.rm(path.join(containerDir, entry), { recursive: true, force: true });
    }
    await this.run('tar', ['-xf', data.containerArchive, '-C', containerDir]);

    if (data.keychainArchive) {
      const wasBooted = await this.isBooted(deviceUdid);
      if (wasBooted) {
        await this.run('xcrun', ['simctl', 'shutdown', deviceUdid]);
      }
      try {
        const keychainDir = this.keychainDirFor(deviceUdid);
        await fs.mkdir(keychainDir, { recursive: true });
        for (const entry of await fs.readdir(keychainDir).catch(() => [])) {
          await fs.rm(path.join(keychainDir, entry), { recursive: true, force: true });
        }
        await this.run('tar', ['-xf', data.keychainArchive, '-C', keychainDir]);
      } finally {
        if (wasBooted) {
          await this.run('xcrun', ['simctl', 'boot', deviceUdid]);
        }
      }
    }

    if (options?.relaunch) {
      await this.run('xcrun', ['simctl', 'launch', deviceUdid, bundleId]);
    }

    return data;
  }

  async list(): Promise<NativeAuthProfile[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.authRoot);
    } catch {
      return [];
    }
    const profiles: NativeAuthProfile[] = [];
    for (const name of entries) {
      try {
        const json = await fs.readFile(
          path.join(this.authRoot, name, 'profile.json'),
          'utf-8',
        );
        profiles.push(JSON.parse(json) as NativeAuthProfile);
      } catch {
        // skip
      }
    }
    return profiles;
  }

  async delete(profileName: string): Promise<void> {
    await fs.rm(path.join(this.authRoot, sanitize(profileName)), {
      recursive: true,
      force: true,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async ensureProfileDir(profileName: string): Promise<string> {
    const dir = path.join(this.authRoot, sanitize(profileName));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async resolveContainerDir(deviceUdid: string, bundleId: string): Promise<string> {
    const { stdout } = await this.run('xcrun', [
      'simctl', 'get_app_container', deviceUdid, bundleId, 'data',
    ]);
    const containerDir = stdout.trim();
    if (!containerDir) {
      throw new Error(`Native auth: could not resolve data container for ${bundleId} on ${deviceUdid}`);
    }
    return containerDir;
  }

  private keychainDirFor(deviceUdid: string): string {
    return path.join(this.simulatorRoot, deviceUdid, 'data', 'Library', 'Keychains');
  }

  private async isBooted(udid: string): Promise<boolean> {
    try {
      const { stdout } = await this.run('xcrun', ['simctl', 'list', 'devices', '-j']);
      const parsed = JSON.parse(stdout) as {
        devices: Record<string, Array<{ udid: string; state: string }>>;
      };
      for (const list of Object.values(parsed.devices)) {
        for (const d of list) {
          if (d.udid === udid) return d.state === 'Booted';
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
