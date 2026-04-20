# Contributing to OpenSafari

This document collects contributor-facing workflows that are too narrow to live
in the top-level README. Add new sections here when a task is performed rarely
enough that the steps would otherwise be re-discovered from git history.

## Regenerating the `app_handle_alert` locale corpus

The `app_handle_alert` MCP tool recognises permission-prompt button labels
across every locale shipped by the bundled iOS simulator runtime. The corpus
lives in `src/tools/app-handle-alert-labels.generated.json` and is produced
at build time from the runtime's TCC.framework / CoreIDVShared.framework
localized strings.

### When to regenerate

Regenerate the corpus when **any** of the following is true:

- The installed Xcode (or standalone CoreSimulator runtime) has bumped its
  iOS minor version (e.g. 26.4 → 26.5). New locales or renamed button
  labels ship with the runtime.
- A live permission prompt surfaces a button text that
  `tests/integration/handle-alert.live.test.ts` fails to match, and the
  observed text is a legitimate system-dialog label (not an app-owned
  custom prompt).
- The coverage test (`tests/unit/app-handle-alert-labels-coverage.test.ts`)
  fails its byte-identical check against a freshly-run generator — this
  means someone hand-edited the JSON.

Do **not** regenerate for:

- iOS release candidates or betas (we pin to the GA runtime).
- Per-contributor preferences (locale ordering, whitespace, etc.).

### How to regenerate

```bash
npx ts-node \
  --transpile-only --skip-project \
  -O '{"module":"commonjs","moduleResolution":"node","target":"ES2022","esModuleInterop":true,"strict":true}' \
  scripts/dev/dump-springboard-permission-strings.ts \
  > src/tools/app-handle-alert-labels.generated.json
```

Or, if your `ts-node` is configured for CommonJS by default:

```bash
npx ts-node scripts/dev/dump-springboard-permission-strings.ts \
  > src/tools/app-handle-alert-labels.generated.json
```

Verify the diff, then run:

```bash
npx jest --config jest.config.js --testPathPatterns='app-handle-alert-labels'
```

If `--runtime` auto-detection picks the wrong runtime (multiple installed
side-by-side), pass an explicit path:

```bash
npx ts-node scripts/dev/dump-springboard-permission-strings.ts \
  --runtime "/Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime" \
  > src/tools/app-handle-alert-labels.generated.json
```

Or via environment variable:

```bash
OPENSAFARI_SIMRUNTIME="…/iOS 26.4.simruntime" \
  npx ts-node scripts/dev/dump-springboard-permission-strings.ts \
  > src/tools/app-handle-alert-labels.generated.json
```

### Reviewing the regeneration PR

Include the SHA-256 of the regenerated JSON in the PR description so
reviewers can confirm determinism locally:

```bash
shasum -a 256 src/tools/app-handle-alert-labels.generated.json
```

Two independent runs of the generator against the same runtime MUST produce
byte-identical output. If they don't, the generator has a non-determinism
bug — do not land the PR until it's fixed.

### Troubleshooting

**Symptom:** Regenerated JSON is empty or has zero accept/dismiss labels for
every locale.

**Diagnosis:** Apple moved the permission-prompt strings out of
`TCC.framework` / `CoreIDVShared.framework` into a different framework. The
generator's hardcoded key prefixes no longer hit anything.

**Fix:** Re-discover the current home of the keys:

```bash
RUNTIME="/Library/Developer/CoreSimulator/Volumes/<volume>/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime/Contents/Resources/RuntimeRoot"

for fw in "$RUNTIME"/System/Library/PrivateFrameworks/*.framework \
          "$RUNTIME"/System/Library/Frameworks/*.framework; do
  f="$fw/en.lproj/Localizable.strings"
  [ -f "$f" ] || continue
  plutil -convert json -o - "$f" 2>/dev/null \
    | grep -q '"REQUEST_ACCESS_ALLOW"\|"AllowButton"\|"WebPresentmentProviderOptInAlertAllowButton"' \
    && echo "$fw"
done
```

Update `TCC_ACCEPT_KEY_PREFIXES` / `TCC_DISMISS_KEY_PREFIXES` /
`COREIDV_ACCEPT_KEYS` / `COREIDV_DISMISS_KEYS` in
`scripts/dev/dump-springboard-permission-strings.ts` to reflect the new
source-of-truth frameworks. Extend the script header comment with pointers
to the new location so the next person doesn't have to re-derive it.

**Symptom:** `xcode-select -p` points at Command Line Tools
(`/Library/Developer/CommandLineTools`) rather than Xcode.app.

**Fix:** Either install Xcode and run
`sudo xcode-select -s /Applications/Xcode.app`, or pass `--runtime` /
`OPENSAFARI_SIMRUNTIME` pointing at a CoreSimulator volume runtime.
