# CI Recipes

Practical, copy-paste CI recipes for running OpenSafari headless smoke tests, build verification, and simulator-based QA in automated pipelines.

For conceptual background on output formats, exit-code gating, and the `qa_full_audit` tool, see [docs/ci-integration.md](ci-integration.md).

---

## Prerequisites

Every CI machine that runs OpenSafari must satisfy the following requirements.

| Requirement | Version | Notes |
|---|---|---|
| **macOS runner** | Any (GitHub: `macos-latest`) | Xcode Simulator is macOS-only |
| **Node.js** | 18+ | `engines.node` constraint in `package.json` |
| **Xcode** | Any supported version | Provides `simctl`, Simulator runtime, and WebKit debug socket |
| **ios-webkit-debug-proxy** | Latest | `brew install ios-webkit-debug-proxy` |

> **Cloud CI note** — GitHub Actions `macos-latest`, CircleCI `macos` executors, and Buildkite/GitLab self-hosted macOS agents all satisfy these requirements. Linux and Windows runners cannot run Xcode Simulator.

---

## GitHub Actions Recipe

A complete workflow that covers three jobs:

1. **`smoke-test`** — boots a simulator, starts OpenSafari headlessly, navigates to a URL, and uploads a screenshot artifact.
2. **`build-and-unit-test`** — installs dependencies, builds, and runs unit tests (no simulator required).
3. **`headless-verify`** — boots a simulator and verifies the WebKit proxy connection before any test logic runs.

```yaml
# .github/workflows/opensafari-ci.yml
name: OpenSafari CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  # Prevent AppleScript/CGEvent fallback — keeps the runner mouse-free.
  OPENSAFARI_HEADLESS_ONLY: "1"
  NODE_VERSION: "20"

jobs:
  # ── Job 1: Build + unit tests (no simulator needed) ──────────────────────
  build-and-unit-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Unit tests
        run: npm run test:ci

      - name: Upload JUnit results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: unit-test-results
          path: test-results/junit.xml

  # ── Job 2: Simulator boot + headless verification ─────────────────────────
  headless-verify:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install ios-webkit-debug-proxy
        run: brew install ios-webkit-debug-proxy

      - name: Install opensafari globally
        run: npm install -g opensafari-mcp

      - name: Boot iOS Simulator (iPhone 16)
        run: |
          UDID=$(xcrun simctl list devices available -j \
            | node -e "
                const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
                const runtimes = Object.keys(d.devices).filter(r => r.includes('iOS'));
                const latest = runtimes[runtimes.length - 1];
                const iphone = d.devices[latest].find(dev => dev.name.includes('iPhone') && dev.isAvailable);
                console.log(iphone ? iphone.udid : '');
              ")
          echo "SIMULATOR_UDID=$UDID" >> $GITHUB_ENV
          xcrun simctl boot "$UDID"
          # Wait until the simulator reaches Booted state (max 60 s)
          for i in $(seq 1 30); do
            STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
            [ "$STATE" = "Booted" ] && break
            sleep 2
          done
          echo "Simulator booted: $UDID"

      - name: Start ios-webkit-debug-proxy
        run: |
          ios_webkit_debug_proxy -c "$SIMULATOR_UDID":9322 &
          sleep 2
          # Verify the proxy is responding
          curl --silent --fail --retry 5 --retry-delay 1 \
            http://localhost:9322/json/list \
            | node -e "
                const targets = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
                if (!Array.isArray(targets)) { console.error('Proxy returned unexpected response'); process.exit(1); }
                console.log('WebKit proxy OK — ' + targets.length + ' target(s)');
              "

      - name: Run headless smoke test
        run: |
          opensafari serve --http 3100 &
          SERVER_PID=$!
          sleep 3

          # Navigate and capture a screenshot via CLI
          opensafari tool navigate --url https://example.com
          opensafari tool screenshot --output smoke-screenshot.png

          kill $SERVER_PID || true

      - name: Upload screenshot artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-screenshots
          path: smoke-screenshot.png

  # ── Job 3: Full Safari smoke test ─────────────────────────────────────────
  smoke-test:
    runs-on: macos-latest
    needs: [build-and-unit-test]
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install ios-webkit-debug-proxy
        run: brew install ios-webkit-debug-proxy

      - name: Install opensafari globally
        run: npm install -g opensafari-mcp

      - name: Boot simulator and run QA audit
        run: |
          # Boot simulator (device_boot auto-starts ios-webkit-debug-proxy)
          opensafari serve --http 3100 &
          SERVER_PID=$!
          sleep 3

          opensafari tool device_boot --device "iPhone 16"

          # Wait up to 60 s for a booted simulator
          for i in $(seq 1 30); do
            COUNT=$(xcrun simctl list devices booted | grep -c 'Booted' || true)
            [ "$COUNT" -gt 0 ] && break
            sleep 2
          done

          # Run QA audit and emit JUnit XML
          opensafari audit \
            --url https://staging.example.com \
            --format junit \
            --output qa-results.xml

          kill $SERVER_PID || true

      - name: Publish QA test results
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: OpenSafari QA
          path: qa-results.xml
          reporter: java-junit

      - name: Upload QA report artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: qa-report
          path: qa-results.xml
```

---

## Buildkite Recipe

Requires a self-hosted macOS agent. Tag your macOS agents with `os=macos` and `xcode=true`.

```yaml
# pipeline.yml
steps:
  - label: ":hammer: Build & Unit Tests"
    key: build
    agents:
      os: linux          # Build/lint can run on Linux
    command: |
      npm ci
      npm run build
      npm run test:ci
    artifact_paths:
      - "test-results/junit.xml"

  - label: ":iphone: Simulator Smoke Test"
    key: smoke
    depends_on: build
    agents:
      os: macos
      xcode: "true"
    env:
      OPENSAFARI_HEADLESS_ONLY: "1"
    command: |
      set -euo pipefail

      # ── Install dependencies ──────────────────────────────────────
      npm ci
      brew install ios-webkit-debug-proxy
      npm install -g opensafari-mcp

      # ── Boot simulator ────────────────────────────────────────────
      UDID=$(xcrun simctl list devices available -j \
        | node -e "
            const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const runtimes = Object.keys(d.devices).filter(r => r.includes('iOS'));
            const latest = runtimes[runtimes.length - 1];
            const iphone = d.devices[latest].find(dev => dev.name.includes('iPhone') && dev.isAvailable);
            console.log(iphone ? iphone.udid : '');
          ")
      xcrun simctl boot "$UDID"

      # ── Wait for Booted state (max 60 s) ──────────────────────────
      for i in $(seq 1 30); do
        STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
        [ "$STATE" = "Booted" ] && break
        sleep 2
      done

      # ── Start proxy and verify ────────────────────────────────────
      ios_webkit_debug_proxy -c "$UDID":9322 &
      sleep 2
      curl --silent --fail http://localhost:9322/json/list > /dev/null

      # ── Start opensafari and run smoke test ───────────────────────
      opensafari serve --http 3100 &
      SERVER_PID=$!
      sleep 3

      opensafari audit \
        --url https://staging.example.com \
        --format junit \
        --output qa-results.xml

      kill $SERVER_PID || true

    artifact_paths:
      - "qa-results.xml"
      - "screenshots/**/*.png"

  - label: ":clipboard: Upload JUnit Results"
    depends_on: smoke
    allow_dependency_failure: true
    command: |
      # Buildkite Test Analytics upload (optional)
      # curl -X POST https://analytics-api.buildkite.com/v1/uploads \
      #   -H "Authorization: Token token=$BUILDKITE_ANALYTICS_TOKEN" \
      #   -F "data=@qa-results.xml" \
      #   -F "format=junit"
      echo "Test results available as artifact: qa-results.xml"
```

---

## GitLab CI Recipe

Requires a self-hosted GitLab Runner registered on a macOS machine with the `macos` and `xcode` tags.

```yaml
# .gitlab-ci.yml
variables:
  OPENSAFARI_HEADLESS_ONLY: "1"
  NODE_VERSION: "20"

stages:
  - build
  - test
  - smoke

# ── Stage 1: Build + unit tests (Linux runner OK) ────────────────────────────
build-and-test:
  stage: build
  image: node:20
  script:
    - npm ci
    - npm run build
    - npm run test:ci
  artifacts:
    when: always
    reports:
      junit: test-results/junit.xml
    paths:
      - dist/
    expire_in: 1 hour

# ── Stage 2: Simulator smoke test (macOS runner required) ────────────────────
simulator-smoke:
  stage: smoke
  tags:
    - macos
    - xcode
  needs:
    - build-and-test
  variables:
    OPENSAFARI_HEADLESS_ONLY: "1"
  before_script:
    - brew install ios-webkit-debug-proxy
    - npm ci
    - npm install -g opensafari-mcp
  script:
    - |
      set -euo pipefail

      # ── Boot simulator ──────────────────────────────────────────────
      UDID=$(xcrun simctl list devices available -j \
        | node -e "
            const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const runtimes = Object.keys(d.devices).filter(r => r.includes('iOS'));
            const latest = runtimes[runtimes.length - 1];
            const iphone = d.devices[latest].find(dev => dev.name.includes('iPhone') && dev.isAvailable);
            console.log(iphone ? iphone.udid : '');
          ")
      xcrun simctl boot "$UDID"

      # ── Wait for Booted state ───────────────────────────────────────
      for i in $(seq 1 30); do
        STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
        [ "$STATE" = "Booted" ] && break
        sleep 2
      done

      # ── Start proxy ─────────────────────────────────────────────────
      ios_webkit_debug_proxy -c "$UDID":9322 &
      sleep 2
      curl --silent --fail http://localhost:9322/json/list > /dev/null

      # ── Run smoke test ──────────────────────────────────────────────
      opensafari serve --http 3100 &
      SERVER_PID=$!
      sleep 3

      opensafari audit \
        --url https://staging.example.com \
        --format junit \
        --output qa-results.xml

      kill $SERVER_PID || true

  after_script:
    # Always shut down the simulator to keep the host agent clean
    - xcrun simctl shutdown all || true

  artifacts:
    when: always
    reports:
      junit: qa-results.xml
    paths:
      - qa-results.xml
      - screenshots/
    expire_in: 7 days
```

---

## Common Patterns

### Simulator boot wait pattern

Never assume a `simctl boot` call means the simulator is ready for interactions. Poll until the `Booted` state appears (or until your timeout expires):

```bash
xcrun simctl boot "$UDID"

# Poll until Booted (max 60 s)
for i in $(seq 1 30); do
  STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
  [ "$STATE" = "Booted" ] && break
  echo "Waiting for simulator... ($i/30)"
  sleep 2
done

if [ "$STATE" != "Booted" ]; then
  echo "ERROR: Simulator did not boot within 60 seconds" >&2
  exit 1
fi
```

### WebKit proxy connection verification

Before running any test logic, confirm the proxy is serving WebKit targets:

```bash
# Start proxy
ios_webkit_debug_proxy -c "$UDID":9322 &
sleep 2

# Verify — exits non-zero if the proxy is not reachable or returns invalid JSON
curl --silent --fail --retry 5 --retry-delay 1 \
  http://localhost:9322/json/list \
  | node -e "
      const targets = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (!Array.isArray(targets)) {
        console.error('Unexpected proxy response');
        process.exit(1);
      }
      console.log('Proxy OK — ' + targets.length + ' target(s)');
    "
```

### Screenshot artifact collection

Collect all PNG files produced during a run as a CI artifact. Pair with `if: always()` (GitHub Actions) or `when: always` (GitLab) so screenshots are retained even on failure:

```yaml
# GitHub Actions
- name: Upload screenshots
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: screenshots-${{ github.run_id }}
    path: |
      screenshots/
      *.png
    retention-days: 14

# GitLab CI
artifacts:
  when: always
  paths:
    - screenshots/
    - "*.png"
  expire_in: 14 days
```

### Environment variable configuration

| Variable | Values | Purpose |
|---|---|---|
| `OPENSAFARI_HEADLESS_ONLY` | `1` | Block AppleScript/CGEvent fallback. Throws `HeadlessInputUnavailableError` instead of moving the physical mouse cursor. **Always set to `1` in CI.** |
| `OPENSAFARI_PROXY_PORT` | Port number (default `9322`) | Override WebKit proxy port when the default is already in use. |
| `OPENSAFARI_ALLOW_FOCUS_INPUT` | `1` | Re-enable focus-stealing input (for non-headless local runs only — never set in CI). |
| `OPENSAFARI_SAVE_FAILURE_SCREENSHOTS` | `1` | Local opt-in for the integration-suite screenshot-on-failure reporter. Auto-detects the booted simulator via `xcrun simctl list devices booted` when `OSF_DEVICE_ID` is unset, so devs can triage a red test locally without also exporting `CI=true`. |
| `OSF_DEVICE_ID` | Simulator UDID | Explicit simulator target for the screenshot reporter and other integration helpers. Set by CI after booting; dev can use `OPENSAFARI_SAVE_FAILURE_SCREENSHOTS=1` instead to skip the export. |
| `OSF_SCREENSHOT_DIR` | Directory path | Override base directory for failure screenshots (default `test-output/screenshots/`). |
| `OPENSAFARI_INPUT_TELEMETRY_META` | `0` / `false` to disable | Controls whether input-tool responses carry `_meta._telemetry` (per-call `elapsed_ms`, `ok`, `operation`). **On by default since 0.5.0** (#595). Set to `0` only when payload size matters and you are not inspecting per-call timing. |

```bash
# Recommended CI environment
export OPENSAFARI_HEADLESS_ONLY=1
# _meta._telemetry is on by default; uncomment to opt out:
# export OPENSAFARI_INPUT_TELEMETRY_META=0
```

### QA-ready Flutter build

Release builds compile Dart to AOT and reject runtime `evaluate` calls with `code 113`, which surfaces as `FlutterVMInputBackendError { code: 'VM_NO_EVALUATE' }`. The router then falls through to Tier 1.5 AX-press (element-targeted tools only) and ultimately AppleScript for coordinate gestures — the slowest and most fragile path, and — on Xcode 26+ where Tier-1 SimHID tap/swipe is disabled pending #491 — the only remaining coordinate fallback. See [Build-mode × Xcode tier matrix](./flutter-inspector.md#build-mode--xcode-tier-matrix-596) for the full routing table.

The right "QA-ready" build differs by target. The Flutter toolchain blocks `--profile` for simulator targets, so simulator QA must use `--debug`; profile mode is reserved for physical-device QA.

#### iOS Simulator — use `--debug`

**Recommendation:** build simulator QA artifacts with `flutter build ios --simulator --debug`. This is the only mode the Flutter toolchain accepts for `--simulator` targets and keeps `FlutterVMInputBackend` (Tier 0) active.

Trying `--profile` against the simulator fails fast — Flutter exits with *"Profile mode is not supported for simulators."* (verified against Flutter 3.41.5 / Dart 3.11.3 on iPhone 17 Pro Sim, iOS 26.4). Use `--debug` for the simulator and reserve `--profile` for physical-device runs.

```bash
# Build a debug-mode simulator bundle (only mode the Flutter toolchain accepts; keeps Tier 0).
flutter build ios --simulator --debug --target lib/main_qa.dart

# Install and launch so flutter_connect lands on Tier 0.
APP=build/ios/iphonesimulator/Runner.app
xcrun simctl install booted "$APP"
xcrun simctl launch --console booted "$(plutil -extract CFBundleIdentifier raw "$APP/Info.plist")"
```

```yaml
# GitHub Actions — QA-ready Flutter simulator build
- name: Build Flutter (debug mode for simulator)
  run: flutter build ios --simulator --debug --target lib/main_qa.dart

- name: Install + launch on booted simulator
  run: |
    APP=build/ios/iphonesimulator/Runner.app
    BUNDLE=$(plutil -extract CFBundleIdentifier raw "$APP/Info.plist")
    xcrun simctl install booted "$APP"
    xcrun simctl launch booted "$BUNDLE"
```

#### Physical iOS device — use `--profile`

**Recommendation:** for physical-device QA where you want perf parity with release, use `flutter build ios --profile`. Profile mode keeps the Dart VM Service online (so Tier 0 remains active) while running close to release performance — the same trade-off `flutter run --profile` makes for Flutter's own tooling.

```bash
# Build a profile-mode IPA for a physical device (keeps VM Service; runs near release perf).
flutter build ios --profile --target lib/main_qa.dart

# Install and launch via your usual device tooling (Xcode, ios-deploy, devicectl, etc.).
```

> **Why not `--release` on either target?** The Dart AOT runtime in release mode has no expression compiler, so Tier 0 probes fail and every subsequent tap/swipe degrades to AppleScript (or silently fails under `OPENSAFARI_HEADLESS_ONLY=1`). Choose `--debug` for simulator QA and `--profile` for device QA to keep Tier 0 alive.

### Reading `_meta._telemetry` in CI

Every input-tool response (`app_tap`, `app_swipe`, `app_type_text`, `app_tap_element`, etc.) embeds a compact telemetry projection under `result._meta._telemetry`. Use it to assert on per-call latency without scraping stderr.

```js
// Node — direct invocation
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const res = await client.callTool({ name: 'app_tap', arguments: { x: 100, y: 200 } });
const events = res._meta?._telemetry ?? [];
for (const e of events) {
  if (!e.ok) throw new Error(`app_tap failed: ${e.error}`);
  if (e.elapsed_ms > 500) console.error(`slow tap: ${e.elapsed_ms}ms`);
}
```

```yaml
# GitHub Actions — failing the job when any op exceeds a budget
- name: Smoke run with latency budget
  run: |
    node scripts/run-smoke.mjs > out.json
    node -e '
      const r = JSON.parse(require("fs").readFileSync("out.json", "utf8"));
      const events = (r._meta && r._meta._telemetry) || [];
      const slow = events.filter(e => e.elapsed_ms > 500);
      if (slow.length) { console.error("latency budget exceeded", slow); process.exit(1); }
    '
```

To suppress the field (e.g., matching legacy golden files), set `OPENSAFARI_INPUT_TELEMETRY_META=0` at the job or step level.

### JUnit output generation

OpenSafari's `qa_full_audit` tool emits JUnit-compatible XML directly. Pass `--format junit` to the CLI or `format: "junit"` via MCP:

```bash
# CLI
opensafari audit \
  --url https://staging.example.com \
  --format junit \
  --output qa-results.xml

# JUnit XML maps each detector to a <testcase>
# Critical/high failures → <failure />
# Low severity → <skipped />
# Detector errors → <error />
```

See [docs/ci-integration.md](ci-integration.md#report-format-reference) for the full JUnit schema mapping.

---

## Troubleshooting

### Simulator never reaches `Booted` state

**Symptom:** The boot-wait loop times out after 60 seconds.

**Common causes and fixes:**

- **No available device** — run `xcrun simctl list devices available` to confirm the target device type is installed. Install missing runtimes via Xcode → Settings → Platforms.
- **Xcode not agreed to license** — run `sudo xcodebuild -license accept` once on the agent machine.
- **Stale simulator process** — run `xcrun simctl shutdown all` before booting to clear orphaned simulators from previous jobs.

### `ios_webkit_debug_proxy` exits immediately

**Symptom:** The proxy process exits within 1–2 seconds and `curl http://localhost:9322/json/list` fails.

**Common causes and fixes:**

- **Simulator not yet booted** — always wait for `Booted` state before starting the proxy.
- **Port conflict** — another process is already using port 9322. Set `OPENSAFARI_PROXY_PORT` to a free port and pass `-c "$UDID":$OPENSAFARI_PROXY_PORT` to `ios_webkit_debug_proxy`.
- **Proxy not installed** — run `brew install ios-webkit-debug-proxy` in the agent setup step, not just locally.

### `HeadlessInputUnavailableError` in CI

**Symptom:** Input tools (`app_tap`, `app_type_text`, etc.) throw `HeadlessInputUnavailableError`.

**Fix:** This is expected behavior when `OPENSAFARI_HEADLESS_ONLY=1` and no headless input backend is available for the target app. For Safari/WebView targets, ensure the WebKit connection is established first (`device_boot` + proxy start). For native app targets on Xcode 26+, the `webkit` input backend requires an active WebKit context — attach one via `app_webview_connect` if the app contains a WebView, or use `simctl` input on Xcode ≤16.

### Screenshots are blank or all-black

**Symptom:** Screenshot artifacts are saved but contain a black or empty image.

**Common causes and fixes:**

- **Safari not yet loaded** — add a `wait_for` or a short sleep after `navigate` before capturing the screenshot.
- **Simulator UI not initialized** — some CI runners boot the simulator but the display compositor is not ready. Add `sleep 5` after confirming `Booted` state.
- **Wrong context** — if the active context is set to `native` instead of `safari`, browser screenshots will be empty. Call `set_active_context` with `context: "safari"` before screenshotting.

### `npm run test:ci` fails on macOS runners

**Symptom:** Tests that rely on `jest.ci.config.js` fail with missing module errors.

**Fix:** Run `npm ci` (not `npm install`) to ensure a clean, lockfile-driven install. The `--force` flag used in the project's own CI lint job is not needed for test runs.

### Port 9322 already in use across parallel jobs

**Symptom:** Multiple CI jobs running on the same agent machine conflict on port 9322.

**Fix:** Assign a unique `OPENSAFARI_PROXY_PORT` per job (e.g. using a job index or a free-port utility) and pass the same value to both `ios_webkit_debug_proxy` and `opensafari serve`.

---

---

## Specialized Recipes

End-to-end, scenario-specific recipes that extend the generic flows above. Each
recipe pins to a specific `opensafari-mcp` version so that teams can copy the
manifest verbatim and know exactly which APIs it relies on.

| Recipe | Covers | Pinned version |
|---|---|---|
| [Flutter + IAP (ko-KR)](recipes/flutter-iap-ko-kr.md) | boot → launch → deep-link → StoreKit purchase → ko-KR alert accept → receipt assert → backend verify | `opensafari-mcp@0.4.9` |

---

## See also

- [CI Integration](ci-integration.md) — Output formats, exit-code gating, JUnit schema, native artifact collection
- [Getting Started](getting-started.md) — Local setup guide
- [Troubleshooting](troubleshooting.md) — General failure modes
- [StoreKit Automation](storekit-automation.md) — Tool reference for `app_storekit_configure` / `app_storekit_test_session` / `app_storekit_receipt`
