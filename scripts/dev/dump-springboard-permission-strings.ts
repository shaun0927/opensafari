#!/usr/bin/env ts-node
/**
 * scripts/dev/dump-springboard-permission-strings.ts
 *
 * Build-time corpus generator for `src/tools/app-handle-alert-labels.ts`.
 *
 * Extracts the localized strings used by iOS system permission prompts
 * ("Allow" / "Don't Allow" / "Cancel" / ...) from a local iOS simulator
 * runtime, across every locale that the runtime ships. Output is a
 * deterministic JSON document intended to be committed verbatim as
 *   src/tools/app-handle-alert-labels.generated.json
 * and regenerated only when the bundled Xcode simruntime changes.
 *
 * ---------------------------------------------------------------------------
 * Why not SpringBoard.framework?
 *
 *   The `#67` issue body speculated that the strings live in SpringBoard's
 *   strings bundle. They do not: SpringBoard.framework/*.lproj only ships
 *   CoverSheetCommon.strings + CursiveHello.plist. The permission prompt
 *   button labels are provided by the frameworks that own the prompt UI:
 *
 *     * `System/Library/PrivateFrameworks/TCC.framework/<locale>.lproj/Localizable.strings`
 *       — standard permission prompts (Photos, Camera, Contacts, Calendar,
 *         Location, Microphone, Tracking, etc.). Keys used here:
 *
 *           REQUEST_ACCESS_ALLOW                      -> "Allow"
 *           REQUEST_ACCESS_ALLOW_kTCCService*         -> service-specific Allow
 *           REQUEST_ACCESS_DENY                       -> "Don't Allow"
 *           REQUEST_ACCESS_DENY_kTCCService*          -> service-specific Deny
 *           REQUEST_ACCESS_CANCEL                     -> "Cancel"
 *           REQUEST_ACCESS_DONT_ALLOW                 -> "Don't Allow"
 *           REQUEST_ACCESS_DONT_ALLOW_kTCCService*    -> service-specific
 *           REQUEST_ACCESS_LEARN_MORE_kTCCService*    -> "Continue"
 *           REQUEST_ACCESS_SUBSEQUENT_ALLOW_*         -> "Use App"
 *           REQUEST_ACCESS_SUBSEQUENT_DENY_*          -> "Cancel"
 *           REMINDER_REQUEST_ACCESS_ALLOW_*           -> "Allow Full Access"
 *
 *     * `System/Library/PrivateFrameworks/CoreIDVShared.framework/<locale>.lproj/Localizable.strings`
 *       — Identity Verification (Digital ID / Web Presentment) prompts:
 *
 *           WebPresentmentProviderOptInAlertAllowButton      -> "Allow"
 *           WebPresentmentProviderOptInAlertDontAllowButton  -> "Don't Allow"
 *           WebPresentmentNoEligibleDocumentsDefaultButton   -> "OK"
 *           DigitalPresentmentBiometricAlertCancel           -> "Cancel"
 *
 *   If Apple moves these keys in a future iOS release, the failure mode is
 *   "locale count in the generated JSON drops to 0" — the coverage test in
 *   `tests/unit/app-handle-alert-labels-coverage.test.ts` will catch that.
 *
 *   To re-discover the current home of the keys, run from a RuntimeRoot:
 *
 *     RUNTIME="/Library/Developer/CoreSimulator/Volumes/<volume>/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot"
 *     for fw in "$RUNTIME"/System/Library/PrivateFrameworks/*.framework; do
 *       f="$fw/en.lproj/Localizable.strings"
 *       [ -f "$f" ] || continue
 *       plutil -convert json -o - "$f" 2>/dev/null \
 *         | grep -q '"REQUEST_ACCESS_ALLOW"\|"WebPresentmentProviderOptInAlertAllowButton"' && echo "$fw"
 *     done
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *
 *   # Defaults: auto-detect a runtime in /Library/Developer/CoreSimulator/Volumes
 *   #          then fall back to the Xcode.app-bundled path.
 *   npx ts-node scripts/dev/dump-springboard-permission-strings.ts \
 *     > src/tools/app-handle-alert-labels.generated.json
 *
 *   # Explicit runtime override (either root or .../RuntimeRoot):
 *   npx ts-node scripts/dev/dump-springboard-permission-strings.ts \
 *     --runtime "/Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime"
 *
 *   # Or via env var:
 *   OPENSAFARI_SIMRUNTIME="<...>.simruntime" npx ts-node scripts/dev/dump-springboard-permission-strings.ts
 *
 * Output JSON shape (stable / sorted):
 *
 *   {
 *     "_generated": {
 *       "generator": "scripts/dev/dump-springboard-permission-strings.ts",
 *       "runtime": "iOS 26.4 (23E244)",
 *       "regenerateCommand": "npx ts-node scripts/dev/dump-springboard-permission-strings.ts > src/tools/app-handle-alert-labels.generated.json"
 *     },
 *     "runtime": "iOS 26.4 (23E244)",
 *     "locales": {
 *       "ko": { "accept": ["허용", ...], "dismiss": ["취소", "허용 안 함", ...] },
 *       ...
 *     }
 *   }
 *
 * Non-goals:
 *   - No runtime loading. This script exists purely to produce a committed
 *     artifact; the production MCP tool never shells out to plutil.
 *   - No OCR-based label inference.
 *   - No support for iOS < 26.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Source-of-truth key sets. Update alongside iOS releases if Apple adds new
// buttons to the permission-prompt matrix.
// ---------------------------------------------------------------------------

/** TCC.framework keys whose value is an accept-style label. */
const TCC_ACCEPT_KEY_PREFIXES = [
  'REQUEST_ACCESS_ALLOW',
  'REQUEST_ACCESS_FULL_',
  'REQUEST_ACCESS_SUBSEQUENT_ALLOW_',
  'REQUEST_ACCESS_LEARN_MORE_',
  'REQUEST_ACCESS_ADD_',
  'REMINDER_REQUEST_ACCESS_ALLOW_',
];

/** TCC.framework keys whose value is a dismiss-style label. */
const TCC_DISMISS_KEY_PREFIXES = [
  'REQUEST_ACCESS_DENY',
  'REQUEST_ACCESS_DONT_ALLOW',
  'REQUEST_ACCESS_CANCEL',
  'REQUEST_ACCESS_SUBSEQUENT_DENY_',
];

/** CoreIDVShared.framework keys. */
const COREIDV_ACCEPT_KEYS = new Set([
  'WebPresentmentProviderOptInAlertAllowButton',
  'WebPresentmentNoEligibleDocumentsDefaultButton', // "OK"
]);
const COREIDV_DISMISS_KEYS = new Set([
  'WebPresentmentProviderOptInAlertDontAllowButton',
  'DigitalPresentmentBiometricAlertCancel',
]);

// ---------------------------------------------------------------------------
// Locale mapping: Apple .lproj dir -> BCP-47-ish tag we use in the JSON.
// ---------------------------------------------------------------------------

/**
 * Map an Apple lproj directory basename (e.g. "zh_CN") to the canonical
 * locale tag we use in the generated JSON ("zh-Hans"). For tags we don't
 * have an explicit rule for, we normalize "_" -> "-".
 */
function canonicaliseLocale(lproj: string): string {
  const map: Record<string, string> = {
    zh_CN: 'zh-Hans',
    zh_HK: 'zh-Hant-HK',
    zh_TW: 'zh-Hant',
    yue_CN: 'yue-Hans',
    pt_BR: 'pt-BR',
    pt_PT: 'pt-PT',
    es_419: 'es-419',
    es_US: 'es-US',
    en_AU: 'en-AU',
    en_GB: 'en-GB',
    fr_CA: 'fr-CA',
  };
  if (map[lproj]) return map[lproj];
  return lproj.replace('_', '-');
}

// ---------------------------------------------------------------------------
// Runtime discovery.
// ---------------------------------------------------------------------------

interface ResolvedRuntime {
  /** Path to the `.simruntime` bundle (or its RuntimeRoot). */
  simruntimePath: string;
  /** Path to the RuntimeRoot inside the simruntime. */
  runtimeRoot: string;
  /** e.g. "iOS 26.4 (23E244)". */
  version: string;
}

function resolveRuntime(explicit?: string): ResolvedRuntime {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.OPENSAFARI_SIMRUNTIME) {
    candidates.push(process.env.OPENSAFARI_SIMRUNTIME);
  }
  // Default search: standalone CoreSimulator volume first (newer installs).
  // Sort volume names before evaluating so the result is deterministic
  // across machines where fs.readdirSync returns entries in filesystem order.
  try {
    const volRoot = '/Library/Developer/CoreSimulator/Volumes';
    if (fs.existsSync(volRoot)) {
      const volumes = fs.readdirSync(volRoot).slice().sort();
      for (const vol of volumes) {
        const p = path.join(
          volRoot,
          vol,
          'Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime',
        );
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  } catch {
    /* ignore */
  }
  // Fallback: Xcode-bundled path.
  try {
    const developerDir = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    candidates.push(
      path.join(
        developerDir,
        'Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime',
      ),
    );
  } catch {
    /* xcode-select not available */
  }

  for (const c of candidates) {
    const resolved = resolveOneRuntime(c);
    if (resolved) return resolved;
  }
  const tried = candidates.join('\n  ');
  throw new Error(
    `Could not locate an iOS 26.4 simruntime. Pass --runtime <path> or set OPENSAFARI_SIMRUNTIME.\nSearched:\n  ${tried}`,
  );
}

function resolveOneRuntime(candidate: string): ResolvedRuntime | null {
  if (!fs.existsSync(candidate)) return null;
  // Accept either the `.simruntime` root or its `RuntimeRoot`.
  const simruntimePath = candidate.endsWith('RuntimeRoot')
    ? path.dirname(path.dirname(candidate))
    : candidate;
  const runtimeRoot = candidate.endsWith('RuntimeRoot')
    ? candidate
    : path.join(candidate, 'Contents/Resources/RuntimeRoot');
  if (!fs.existsSync(runtimeRoot)) return null;
  const systemVersion = path.join(runtimeRoot, 'System/Library/CoreServices/SystemVersion.plist');
  if (!fs.existsSync(systemVersion)) return null;
  const info = readPlist(systemVersion) as Record<string, string>;
  const productName = info.ProductName ?? 'iPhone OS';
  const productVersion = info.ProductVersion ?? '?';
  const build = info.ProductBuildVersion ?? '?';
  const label = productName === 'iPhone OS' ? 'iOS' : productName;
  return {
    simruntimePath,
    runtimeRoot,
    version: `${label} ${productVersion} (${build})`,
  };
}

// ---------------------------------------------------------------------------
// Plist parsing via `plutil -convert json -o - <file>`. Works for both
// binary and XML strings files.
// ---------------------------------------------------------------------------

function readPlist(file: string): unknown {
  const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function readStringsFile(file: string): Record<string, string> | null {
  if (!fs.existsSync(file)) return null;
  const raw = readPlist(file);
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-framework extraction.
// ---------------------------------------------------------------------------

interface LocaleBucket {
  accept: Set<string>;
  dismiss: Set<string>;
}

function matchesAnyPrefix(key: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (key === p || key.startsWith(`${p}_`) || key.startsWith(p)) {
      // The prefix list is curated; each prefix must match at the start.
      // (Using startsWith only is sufficient because prefixes are unique.)
      if (key.startsWith(p)) return true;
    }
  }
  return false;
}

function extractFromTcc(strings: Record<string, string>, bucket: LocaleBucket): void {
  for (const [key, value] of Object.entries(strings)) {
    const v = value.trim();
    if (!v) continue;
    // Skip sentence-shaped values — accept/dismiss labels are short button
    // labels, not explanation bodies. Heuristic: drop anything with '%@' or
    // longer than ~40 chars (covers CJK/RTL safely).
    if (v.includes('%@') || v.length > 40) continue;
    if (matchesAnyPrefix(key, TCC_ACCEPT_KEY_PREFIXES)) {
      bucket.accept.add(v);
      continue;
    }
    if (matchesAnyPrefix(key, TCC_DISMISS_KEY_PREFIXES)) {
      bucket.dismiss.add(v);
    }
  }
}

function extractFromCoreIdv(strings: Record<string, string>, bucket: LocaleBucket): void {
  for (const [key, value] of Object.entries(strings)) {
    const v = value.trim();
    if (!v || v.includes('%@') || v.length > 40) continue;
    if (COREIDV_ACCEPT_KEYS.has(key)) bucket.accept.add(v);
    else if (COREIDV_DISMISS_KEYS.has(key)) bucket.dismiss.add(v);
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { runtime?: string } {
  const out: { runtime?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime') {
      out.runtime = argv[i + 1];
      i++;
    } else if (a.startsWith('--runtime=')) {
      out.runtime = a.slice('--runtime='.length);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: dump-springboard-permission-strings.ts [--runtime <simruntime-path>]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function listLocaleDirs(frameworkDir: string): string[] {
  if (!fs.existsSync(frameworkDir)) return [];
  return fs
    .readdirSync(frameworkDir)
    .filter((e) => e.endsWith('.lproj'))
    .map((e) => e.slice(0, -'.lproj'.length));
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'en'));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runtime = resolveRuntime(args.runtime);
  const tccDir = path.join(runtime.runtimeRoot, 'System/Library/PrivateFrameworks/TCC.framework');
  const idvDir = path.join(
    runtime.runtimeRoot,
    'System/Library/PrivateFrameworks/CoreIDVShared.framework',
  );

  const localeLprojs = new Set<string>([...listLocaleDirs(tccDir), ...listLocaleDirs(idvDir)]);

  const buckets: Record<string, LocaleBucket> = {};
  for (const lproj of localeLprojs) {
    const tag = canonicaliseLocale(lproj);
    const bucket = (buckets[tag] ??= { accept: new Set(), dismiss: new Set() });
    const tccStrings = readStringsFile(path.join(tccDir, `${lproj}.lproj`, 'Localizable.strings'));
    if (tccStrings) extractFromTcc(tccStrings, bucket);
    const idvStrings = readStringsFile(path.join(idvDir, `${lproj}.lproj`, 'Localizable.strings'));
    if (idvStrings) extractFromCoreIdv(idvStrings, bucket);
  }

  // Build deterministic output.
  const localeTags = Object.keys(buckets).sort((a, b) => a.localeCompare(b, 'en'));
  const locales: Record<string, { accept: string[]; dismiss: string[] }> = {};
  for (const tag of localeTags) {
    const b = buckets[tag];
    if (b.accept.size === 0 && b.dismiss.size === 0) continue;
    locales[tag] = {
      accept: sortedUnique(b.accept),
      dismiss: sortedUnique(b.dismiss),
    };
  }

  const output = {
    _generated: {
      generator: 'scripts/dev/dump-springboard-permission-strings.ts',
      runtime: runtime.version,
      regenerateCommand:
        'npx ts-node scripts/dev/dump-springboard-permission-strings.ts > src/tools/app-handle-alert-labels.generated.json',
    },
    runtime: runtime.version,
    locales,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

// Allow import-without-execution for in-process tests.
if (require.main === module) {
  main();
}

export {
  canonicaliseLocale,
  extractFromCoreIdv,
  extractFromTcc,
  resolveRuntime,
  readStringsFile,
  TCC_ACCEPT_KEY_PREFIXES,
  TCC_DISMISS_KEY_PREFIXES,
  COREIDV_ACCEPT_KEYS,
  COREIDV_DISMISS_KEYS,
};
export type { ResolvedRuntime, LocaleBucket };
