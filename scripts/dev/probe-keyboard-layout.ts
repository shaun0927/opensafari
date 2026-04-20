#!/usr/bin/env ts-node
/**
 * scripts/dev/probe-keyboard-layout.ts — investigative helper for issue #39.
 *
 * Given a booted iOS simulator UDID, this script dumps every plausible signal
 * that might expose the currently active software keyboard layout. Its output
 * is the load-bearing artifact for deciding whether Tier 1 (automatic keyboard
 * switching) in the issue-#39 layered defense is actually implementable on
 * iOS 26.4, or whether the design has to escalate to Tier 2 (ax-value /
 * pasteboard) per addendum §1.
 *
 * The script is opt-in and deliberately not registered as an npm script —
 * it shells out to `xcrun`, `plutil`, and reads files under the simulator's
 * data container, which is more intrusive than anything shipped in the
 * production MCP surface.
 *
 * Usage:
 *   npx ts-node scripts/dev/probe-keyboard-layout.ts <UDID>
 *   npx ts-node scripts/dev/probe-keyboard-layout.ts booted
 *
 * Output:
 *   Single JSON document to stdout documenting each probed signal, so the
 *   result can be archived verbatim in the Tier-1 design PR or paste-dumped
 *   into the issue thread.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { extractSoftwareLayout, isLatinSoftwareLayout } from '../../src/tools/keyboard-layout';

const execFileAsync = promisify(execFile);

interface ProbeResult {
  name: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  notes?: string;
}

async function runCapturing(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
}

async function resolveUDID(arg: string): Promise<string> {
  if (arg && arg !== 'booted') return arg;
  const { stdout } = await execFileAsync('xcrun', [
    'simctl', 'list', 'devices', '--json', 'booted',
  ]);
  const parsed = JSON.parse(stdout) as {
    devices: Record<string, Array<{ udid: string; state: string }>>;
  };
  for (const runtimeDevices of Object.values(parsed.devices)) {
    for (const dev of runtimeDevices) {
      if (dev.state === 'Booted') return dev.udid;
    }
  }
  throw new Error('No booted simulator found; pass an explicit UDID.');
}

/**
 * Probe 1 — `defaults read` against the Preferences plist inside the device's
 * data container via `simctl spawn`. This is the signal the issue addendum
 * suggested first. `AppleKeyboards` is an array of layout keys like
 * `en_US@sw=QWERTY;hw=Automatic`.
 */
async function probeDefaults(udid: string): Promise<ProbeResult> {
  const { stdout, stderr, code } = await runCapturing('xcrun', [
    'simctl', 'spawn', udid,
    'defaults', 'read', '.GlobalPreferences', 'AppleKeyboards',
  ]);
  if (code !== 0) {
    return {
      name: 'simctl-spawn-defaults-AppleKeyboards',
      ok: false,
      error: stderr.trim() || `exit ${code}`,
    };
  }
  return {
    name: 'simctl-spawn-defaults-AppleKeyboards',
    ok: true,
    value: stdout.trim(),
    notes: 'Raw `defaults read .GlobalPreferences AppleKeyboards` output.',
  };
}

/**
 * Probe 2 — walk the Preferences/ directory for TextInput.plist and dump it
 * via `plutil -convert json`. Includes the `.GlobalPreferences.plist` as a
 * secondary source — issue addendum called both out explicitly.
 */
async function probePreferencesFiles(udid: string): Promise<ProbeResult> {
  const base = path.join(
    homedir(),
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    udid,
    'data',
    'Library',
    'Preferences',
  );
  if (!fs.existsSync(base)) {
    return {
      name: 'preferences-dir',
      ok: false,
      error: `Preferences directory not found: ${base}`,
    };
  }
  const candidates = fs
    .readdirSync(base)
    .filter((f) => f.toLowerCase().includes('textinput') || f === '.GlobalPreferences.plist');

  const dumps: Record<string, unknown> = {};
  for (const file of candidates) {
    const abs = path.join(base, file);
    const { stdout, stderr, code } = await runCapturing('plutil', [
      '-convert', 'json', '-o', '-', abs,
    ]);
    if (code !== 0) {
      dumps[file] = { error: stderr.trim() || `exit ${code}` };
      continue;
    }
    try {
      dumps[file] = JSON.parse(stdout);
    } catch (err) {
      dumps[file] = { error: `json parse failed: ${(err as Error).message}` };
    }
  }
  return {
    name: 'preferences-files',
    ok: true,
    value: { base, files: dumps },
    notes:
      'Full plist contents of any TextInput*.plist and .GlobalPreferences.plist in the device container.',
  };
}

/**
 * Probe 3 — `simctl status_bar <udid> list`. Issue addendum wanted this ruled
 * in or out explicitly. On every iOS 17+ simulator we've checked it only
 * exposes cellular/time overrides, never the active keyboard, but we dump it
 * anyway so the Tier-1 PR can cite the null result directly.
 */
async function probeStatusBar(udid: string): Promise<ProbeResult> {
  const { stdout, stderr, code } = await runCapturing('xcrun', [
    'simctl', 'status_bar', udid, 'list',
  ]);
  return code === 0
    ? {
        name: 'simctl-status_bar-list',
        ok: true,
        value: stdout.trim(),
        notes: 'Expected to NOT contain keyboard info on iOS 17+.',
      }
    : {
        name: 'simctl-status_bar-list',
        ok: false,
        error: stderr.trim() || `exit ${code}`,
      };
}

/**
 * Probe 4 — derive the "active" layout from the `AppleKeyboards` array by
 * running the matcher over each entry. Without a deterministic "which entry
 * is currently selected" signal this only answers "are ALL installed keyboards
 * Latin?", but it still lets us fail closed when any non-Latin entry is
 * present — the safest default for a silent-corruption fix.
 */
function analyzeAppleKeyboards(rawDefaultsOutput: string | undefined): ProbeResult {
  if (!rawDefaultsOutput) {
    return {
      name: 'analysis-AppleKeyboards',
      ok: false,
      error: 'no defaults output to parse',
    };
  }
  // `defaults read … AppleKeyboards` emits an NSArray in OpenStep syntax.
  // We extract anything that looks like `…@sw=…` — an approximation that is
  // good enough for the investigation helper and avoids pulling in a parser.
  const entries = Array.from(rawDefaultsOutput.matchAll(/"[^"]*@[^"]+"/g))
    .map((m) => m[0].slice(1, -1))
    .filter((e) => e.includes('@sw=') || e.includes(';sw='));
  const classified = entries.map((key) => ({
    key,
    softwareLayout: extractSoftwareLayout(key),
    isLatin: isLatinSoftwareLayout(key),
  }));
  const hasNonLatin = classified.some((c) => !c.isLatin);
  return {
    name: 'analysis-AppleKeyboards',
    ok: true,
    value: {
      entries: classified,
      allLatin: !hasNonLatin,
      hasNonLatin,
    },
    notes:
      'Fails closed when any entry is non-Latin; does NOT yet tell us which entry is active.',
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('Usage: probe-keyboard-layout.ts <UDID|booted>');
    process.exit(64);
  }
  const udid = await resolveUDID(argv[0]);

  const defaultsResult = await probeDefaults(udid);
  const prefsResult = await probePreferencesFiles(udid);
  const statusBarResult = await probeStatusBar(udid);
  const analysis = analyzeAppleKeyboards(
    defaultsResult.ok && typeof defaultsResult.value === 'string'
      ? (defaultsResult.value as string)
      : undefined,
  );

  const report = {
    udid,
    timestamp: new Date().toISOString(),
    probes: [defaultsResult, prefsResult, statusBarResult, analysis],
    verdict:
      analysis.ok && (analysis.value as { allLatin?: boolean }).allLatin === true
        ? 'ALL_LATIN_INSTALLED'
        : 'POSSIBLY_NON_LATIN',
    notes: [
      'Paste this JSON into the Tier-1 design PR per issue #39 addendum §1.',
      'If every probe fails to expose the *currently active* keyboard (not just',
      'the installed list), Tier 1 is deferred and Tier 2 becomes the sole fix.',
    ],
  };

  // stdout is the caller's JSON artifact; use console.log here since this is
  // a standalone dev script, not the MCP server.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
