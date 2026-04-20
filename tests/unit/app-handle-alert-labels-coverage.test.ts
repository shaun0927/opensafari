/**
 * Coverage gate for the iOS 26.4 SpringBoard permission-label corpus (#67).
 *
 * Invariants this suite enforces:
 *
 *   1. The committed `src/tools/app-handle-alert-labels.generated.json`
 *      covers every locale in `MINIMUM_REQUIRED_LOCALES` (seeded at commit
 *      time against iOS 26.4). A future iOS release removing a locale will
 *      fail here with a pointer to the regeneration command.
 *   2. Every locale in the generated JSON has at least one accept label
 *      AND at least one dismiss label.
 *   3. The generator is deterministic: running the in-process extractor
 *      over the same fixtures twice produces byte-identical output.
 *   4. The committed JSON matches a fresh run of the generator against
 *      the currently-installed runtime (when available). This is a
 *      regression guard for "someone hand-edited the JSON". It is skipped
 *      gracefully when no iOS 26.4 runtime is present (CI / contributor
 *      laptops without Xcode).
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import committed from '../../src/tools/app-handle-alert-labels.generated.json';

// ---------------------------------------------------------------------------
// MINIMUM_REQUIRED_LOCALES — the locales present at commit time.
//
// Any iOS release that drops a locale from this list is a review-blocking
// regression. Add new locales here when the generator legitimately picks
// them up on a newer runtime; never silently shrink the list.
// ---------------------------------------------------------------------------
const MINIMUM_REQUIRED_LOCALES: readonly string[] = [
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en-AU',
  'en-GB',
  'en-IN',
  'es',
  'es-419',
  'es-US',
  'fi',
  'fr',
  'fr-CA',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'kk',
  'kn',
  'ko',
  'lt',
  'ml',
  'mr',
  'ms',
  'nl',
  'no',
  'or',
  'pa',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'yue-Hans',
  'zh-Hans',
  'zh-Hant',
  'zh-Hant-HK',
];

const REGEN_CMD =
  'npx ts-node scripts/dev/dump-springboard-permission-strings.ts > src/tools/app-handle-alert-labels.generated.json';

const GENERATED_FILE = path.resolve(
  __dirname,
  '../../src/tools/app-handle-alert-labels.generated.json',
);

function resolveRuntimeIfAvailable(): string | null {
  const candidates: string[] = [];
  if (process.env.OPENSAFARI_SIMRUNTIME) candidates.push(process.env.OPENSAFARI_SIMRUNTIME);
  try {
    const volRoot = '/Library/Developer/CoreSimulator/Volumes';
    if (fs.existsSync(volRoot)) {
      for (const vol of fs.readdirSync(volRoot)) {
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
    if (fs.existsSync(c)) return c;
  }
  return null;
}

describe('app-handle-alert-labels.generated.json coverage (#67)', () => {
  test('covers every MINIMUM_REQUIRED_LOCALES entry', () => {
    const actual = new Set(Object.keys(committed.locales));
    const missing = MINIMUM_REQUIRED_LOCALES.filter((loc) => !actual.has(loc));
    expect({
      missing,
      hint: missing.length
        ? `Regenerate via: ${REGEN_CMD} — or add missing locales to MINIMUM_REQUIRED_LOCALES intentionally.`
        : 'ok',
    }).toEqual({ missing: [], hint: 'ok' });
  });

  test('has at least 30 locales (issue #67 acceptance bar)', () => {
    expect(Object.keys(committed.locales).length).toBeGreaterThanOrEqual(30);
  });

  describe('each locale carries ≥ 1 accept and ≥ 1 dismiss label', () => {
    for (const [locale, bucket] of Object.entries(committed.locales)) {
      test(`${locale}/accept`, () => {
        expect(bucket.accept.length).toBeGreaterThanOrEqual(1);
      });
      test(`${locale}/dismiss`, () => {
        expect(bucket.dismiss.length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  test('accept/dismiss label arrays are de-duplicated', () => {
    for (const [locale, bucket] of Object.entries(committed.locales)) {
      expect(new Set(bucket.accept).size).toBe(bucket.accept.length);
      expect(new Set(bucket.dismiss).size).toBe(bucket.dismiss.length);
    }
  });

  test('locale keys are sorted alphabetically (deterministic output)', () => {
    const keys = Object.keys(committed.locales);
    const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
    expect(keys).toEqual(sorted);
  });

  test('carries the _generated metadata block', () => {
    const meta = (committed as unknown as { _generated?: Record<string, unknown> })._generated;
    expect(meta).toBeDefined();
    expect(meta?.generator).toBe('scripts/dev/dump-springboard-permission-strings.ts');
    expect(typeof meta?.runtime).toBe('string');
    expect(typeof meta?.regenerateCommand).toBe('string');
  });

  // ------------------------------------------------------------------------
  // Determinism + live-runtime regression guard.
  //
  // When an iOS 26.4 simruntime is installed, re-invoke the generator as a
  // subprocess and assert the output is byte-identical to the committed
  // JSON. When absent (CI without Xcode), skip with a warning-style message
  // instead of failing — the invariant is still checked whenever a
  // contributor has a runtime locally.
  // ------------------------------------------------------------------------
  const runtimePath = resolveRuntimeIfAvailable();
  const describeIfRuntime = runtimePath ? describe : describe.skip;

  describeIfRuntime('live-runtime regeneration matches committed JSON', () => {
    const scriptPath = path.resolve(
      __dirname,
      '../../scripts/dev/dump-springboard-permission-strings.ts',
    );

    function runGenerator(): string {
      const out = execFileSync(
        'npx',
        [
          'ts-node',
          '--transpile-only',
          '--skip-project',
          '-O',
          JSON.stringify({
            module: 'commonjs',
            moduleResolution: 'node',
            target: 'ES2022',
            esModuleInterop: true,
            strict: true,
          }),
          scriptPath,
          '--runtime',
          runtimePath!,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          // Pin the runtime the suite resolved so the subprocess cannot
          // drift to a different simruntime if multiple are installed.
          env: { ...process.env, OPENSAFARI_SIMRUNTIME: runtimePath! },
        },
      );
      return out;
    }

    test('generator output matches the committed file byte-for-byte', () => {
      const fresh = runGenerator();
      const onDisk = fs.readFileSync(GENERATED_FILE, 'utf8');
      if (fresh !== onDisk) {
        const freshPath = path.join(__dirname, '__fresh-generator-output.json');
        fs.writeFileSync(freshPath, fresh);
        throw new Error(
          `Committed JSON drifted from generator output. Regenerate via:\n  ${REGEN_CMD}\nDiff: ${freshPath}`,
        );
      }
      expect(fresh).toBe(onDisk);
    }, 120_000);

    test('generator is deterministic (two runs byte-identical)', () => {
      const a = runGenerator();
      const b = runGenerator();
      expect(a).toBe(b);
    }, 240_000);
  });
});
