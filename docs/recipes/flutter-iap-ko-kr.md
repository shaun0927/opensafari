# Recipe — End-to-End Flutter + IAP (ko-KR)

A paste-ready CI recipe for the most common commercial Flutter scenario:
**boot → launch → deep-link → StoreKit purchase → ko-KR alert accept → receipt assert → backend verify**.

This recipe uses only tools that ship with `opensafari-mcp@0.4.9`:

- [`app_launch`](../api-reference.md#app_launch) — install/launch the app bundle
- `app_deeplink` — drive the purchase flow via a deep link
- [`app_storekit_configure`](../storekit-automation.md#app_storekit_configure) — load the `.storekit` config
- `app_tap_element` — tap the in-app buy button by AX label
- [`app_alert_handle`](../api-reference.md#app_alert_handle) — dismiss the ko-KR StoreKit sheet by localized label (#589)
- [`app_storekit_test_session`](../storekit-automation.md#app_storekit_test_session) — list + approve the sandbox transaction
- [`app_storekit_receipt`](../storekit-automation.md#app_storekit_receipt) — pull the sandbox receipt for backend verification

> **Why a dedicated ko-KR recipe?** The StoreKit confirmation sheet is rendered by iOS in the device locale. With `AppleLocale=ko_KR` the primary button reads **구입** — `app_alert_handle`'s default `action: "accept"` code-path (which presses the first button by index) works, but matching by label (`buttonLabels: ["구입", "Buy"]`) is the fork-safe pattern that survives future iOS reorderings of the sheet and double-checks that the right app is on screen before pressing. See [`docs/api-reference.md#app_alert_handle`](../api-reference.md#app_alert_handle) and the [ko-KR StoreKit gotchas](#ko-kr-storekit-gotchas) section below.

---

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| macOS runner | any with Xcode Simulator | GitHub `macos-latest` / self-hosted |
| Xcode | 14 or later (for `simctl storekit`) | Xcode → Settings → Platforms |
| Node.js | 18+ | `actions/setup-node@v4` |
| Flutter | any supported | manual install on the runner |
| `opensafari-mcp` | **`0.4.9` (pinned)** | `npm install -g opensafari-mcp@0.4.9` |
| `ios-webkit-debug-proxy` | latest | `brew install ios-webkit-debug-proxy` |
| `.storekit` config | checked into the repo | Xcode → File → New → StoreKit Configuration |

Version pin rationale: this recipe targets the StoreKit and `app_alert_handle` localization APIs introduced in `opensafari-mcp@0.4.9` (PRs #614, #607). Bump the pin together with the recipe when newer APIs land.

> **Tool availability note.** `app_launch`, `app_deeplink`, `app_tap_element`, `app_alert_handle`, and the three `app_storekit_*` tools are all MCP tools. This recipe invokes them over the MCP JSON-RPC interface via `opensafari serve`. If your CI already drives OpenSafari through a different transport (stdio, subprocess), swap the `curl` invocations below for the equivalent tool call and keep the argument shapes identical.

---

## GitHub Actions variant

Drop this workflow into `.github/workflows/flutter-iap.yml` and commit the `.storekit` config (or fetch it in a step).

```yaml
# .github/workflows/flutter-iap.yml
name: Flutter IAP (ko-KR)

on:
  pull_request:
    paths:
      - 'lib/**'
      - 'ios/**'
      - '**/*.storekit'
      - '.github/workflows/flutter-iap.yml'
  workflow_dispatch:

env:
  OPENSAFARI_HEADLESS_ONLY: "1"
  OPENSAFARI_MCP_VERSION: "0.4.9"
  APP_BUNDLE_ID: "com.example.myapp"
  STOREKIT_CONFIG: "ios/Config.storekit"
  DEEPLINK: "myapp://store/buy?sku=ducat_100"
  BUY_BUTTON_LABEL: "듀캣 충전"
  STOREKIT_ACCEPT_LABELS: "구입,Buy"   # matched by app_alert_handle in order

jobs:
  flutter-iap-ko-kr:
    runs-on: macos-latest
    timeout-minutes: 25

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: subosito/flutter-action@v2
        with:
          channel: stable

      - name: Install opensafari-mcp (pinned)
        run: npm install -g opensafari-mcp@${{ env.OPENSAFARI_MCP_VERSION }}

      - name: Install ios-webkit-debug-proxy
        run: brew install ios-webkit-debug-proxy

      - name: Boot simulator (ko-KR)
        id: sim
        run: |
          set -euo pipefail
          UDID=$(xcrun simctl list devices available -j \
            | node -e "
                const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
                const runtimes = Object.keys(d.devices).filter(r => r.includes('iOS'));
                const latest = runtimes[runtimes.length - 1];
                const iphone = d.devices[latest].find(x => x.name.includes('iPhone') && x.isAvailable);
                console.log(iphone.udid);
              ")
          echo "udid=$UDID" >> "$GITHUB_OUTPUT"
          echo "SIMULATOR_UDID=$UDID" >> "$GITHUB_ENV"

          xcrun simctl boot "$UDID"
          for i in $(seq 1 30); do
            STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
            [ "$STATE" = "Booted" ] && break
            sleep 2
          done

          # Force ko-KR across the whole simulator.
          xcrun simctl spawn "$UDID" defaults write -g AppleLocale -string ko_KR
          xcrun simctl spawn "$UDID" defaults write -g AppleLanguages -array ko-KR en
          xcrun simctl shutdown "$UDID"
          xcrun simctl boot "$UDID"
          for i in $(seq 1 30); do
            STATE=$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)
            [ "$STATE" = "Booted" ] && break
            sleep 2
          done

      - name: Build Flutter (profile — keeps VM Service online)
        run: flutter build ios --simulator --profile --target lib/main_qa.dart

      - name: Install + launch the fixture
        run: |
          set -euo pipefail
          APP=build/ios/iphonesimulator/Runner.app
          xcrun simctl install "$SIMULATOR_UDID" "$APP"

      - name: Start opensafari MCP server
        run: |
          opensafari serve --http 3100 &
          echo "OPENSAFARI_PID=$!" >> "$GITHUB_ENV"
          # Wait for /health, timeout 30 s.
          for i in $(seq 1 15); do
            curl --silent --fail http://127.0.0.1:3100/health && break || sleep 2
          done

      - name: Launch app
        run: |
          osafari-call app_launch '{"bundleId":"'"$APP_BUNDLE_ID"'","deviceId":"'"$SIMULATOR_UDID"'"}'

      - name: Configure StoreKit sandbox
        run: |
          osafari-call app_storekit_configure \
            '{"configPath":"'"$(pwd)/$STOREKIT_CONFIG"'","udid":"'"$SIMULATOR_UDID"'"}'

      - name: Drive the buy flow
        run: |
          # Either a deep-link or a tap — pick whichever your app supports.
          osafari-call app_deeplink '{"url":"'"$DEEPLINK"'","deviceId":"'"$SIMULATOR_UDID"'"}'
          osafari-call app_tap_element '{"label":"'"$BUY_BUTTON_LABEL"'","timeout":10000,"deviceId":"'"$SIMULATOR_UDID"'"}'

      - name: Accept the ko-KR StoreKit sheet
        run: |
          IFS=',' read -r -a LABELS <<< "$STOREKIT_ACCEPT_LABELS"
          JSON_LABELS=$(printf '%s\n' "${LABELS[@]}" | node -e "
            const xs = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
            console.log(JSON.stringify(xs));
          ")
          osafari-call app_alert_handle \
            '{"buttonLabels":'"$JSON_LABELS"',"udid":"'"$SIMULATOR_UDID"'"}'

      - name: Approve the sandbox transaction
        id: approve
        run: |
          TX_JSON=$(osafari-call app_storekit_test_session \
            '{"action":"list","udid":"'"$SIMULATOR_UDID"'"}')
          TX_ID=$(echo "$TX_JSON" | node -e "
            const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const pending = (r.transactions || []).find(t => t.state === 'pending');
            if (!pending) { console.error('No pending transaction'); process.exit(1); }
            console.log(pending.id);
          ")
          echo "tx_id=$TX_ID" >> "$GITHUB_OUTPUT"
          osafari-call app_storekit_test_session \
            '{"action":"approve","transactionId":"'"$TX_ID"'","udid":"'"$SIMULATOR_UDID"'"}'

      - name: Extract receipt
        id: receipt
        run: |
          RECEIPT_JSON=$(osafari-call app_storekit_receipt \
            '{"bundleId":"'"$APP_BUNDLE_ID"'","udid":"'"$SIMULATOR_UDID"'"}')
          echo "$RECEIPT_JSON" > receipt.json
          BYTES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('receipt.json','utf8')).bytes)")
          [ "$BYTES" -gt 0 ] || { echo "::error::Empty receipt"; exit 1; }

      - name: Backend verify
        env:
          BACKEND_URL: ${{ secrets.IAP_VERIFY_URL }}
          BACKEND_TOKEN: ${{ secrets.IAP_VERIFY_TOKEN }}
        run: |
          RECEIPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('receipt.json','utf8')).receipt)")
          STATUS=$(curl --silent --output response.json --write-out '%{http_code}' \
            -H "Authorization: Bearer $BACKEND_TOKEN" \
            -H 'Content-Type: application/json' \
            --data "$(jq -n --arg r "$RECEIPT" '{receipt:$r,sandbox:true}')" \
            "$BACKEND_URL/iap/verify")
          [ "$STATUS" = "200" ] || { cat response.json; exit 1; }
          jq -e '.ok == true' response.json

      - name: Shut down simulator
        if: always()
        run: |
          [ -n "${OPENSAFARI_PID:-}" ] && kill "$OPENSAFARI_PID" || true
          xcrun simctl shutdown all || true

      - name: Upload diagnostics on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: flutter-iap-ko-kr-diagnostics
          path: |
            receipt.json
            response.json
            build/ios/iphonesimulator/*.log
          retention-days: 14
```

`osafari-call` is a small helper for calling MCP tools over HTTP — drop this into `scripts/osafari-call.sh` and `chmod +x` it, or inline the curl:

```bash
#!/usr/bin/env bash
# scripts/osafari-call.sh — minimal MCP tool invoker.
set -euo pipefail
TOOL="$1"
ARGS="${2:-{}}"
curl --silent --fail --show-error \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg n "$TOOL" --argjson a "$ARGS" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')" \
  http://127.0.0.1:3100/mcp \
  | jq '.result.content[0].text | fromjson'
```

---

## Generic shell variant

Same recipe, no CI-specific syntax. Use this from any macOS shell (Buildkite agent, GitLab runner, local laptop).

```bash
#!/usr/bin/env bash
# flutter-iap-ko-kr.sh — end-to-end Flutter IAP smoke for ko-KR locale.
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────
OPENSAFARI_MCP_VERSION="${OPENSAFARI_MCP_VERSION:-0.4.9}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.example.myapp}"
STOREKIT_CONFIG="${STOREKIT_CONFIG:-ios/Config.storekit}"
DEEPLINK="${DEEPLINK:-myapp://store/buy?sku=ducat_100}"
BUY_BUTTON_LABEL="${BUY_BUTTON_LABEL:-듀캣 충전}"
STOREKIT_ACCEPT_LABELS='["구입","Buy"]'
BACKEND_URL="${BACKEND_URL:?set BACKEND_URL=https://api.example.com}"
BACKEND_TOKEN="${BACKEND_TOKEN:?set BACKEND_TOKEN=<token>}"

# ── One-time install (idempotent) ──────────────────────────────────
command -v opensafari >/dev/null 2>&1 \
  || npm install -g "opensafari-mcp@${OPENSAFARI_MCP_VERSION}"
command -v ios_webkit_debug_proxy >/dev/null 2>&1 \
  || brew install ios-webkit-debug-proxy

# ── Boot simulator, force ko-KR ────────────────────────────────────
UDID=$(xcrun simctl list devices available -j \
  | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const rt = Object.keys(d.devices).filter(r => r.includes('iOS')).pop();
      console.log(d.devices[rt].find(x => x.name.includes('iPhone') && x.isAvailable).udid);
    ")
xcrun simctl boot "$UDID" || true
for i in $(seq 1 30); do
  [ "$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)" = "Booted" ] && break
  sleep 2
done
xcrun simctl spawn "$UDID" defaults write -g AppleLocale -string ko_KR
xcrun simctl spawn "$UDID" defaults write -g AppleLanguages -array ko-KR en
xcrun simctl shutdown "$UDID"
xcrun simctl boot "$UDID"
for i in $(seq 1 30); do
  [ "$(xcrun simctl list devices | grep "$UDID" | grep -o 'Booted' || true)" = "Booted" ] && break
  sleep 2
done

# ── Build + install Flutter fixture ────────────────────────────────
flutter build ios --simulator --profile --target lib/main_qa.dart
xcrun simctl install "$UDID" build/ios/iphonesimulator/Runner.app

# ── Start opensafari ──────────────────────────────────────────────
OPENSAFARI_HEADLESS_ONLY=1 opensafari serve --http 3100 &
OPENSAFARI_PID=$!
trap 'kill "$OPENSAFARI_PID" 2>/dev/null || true; xcrun simctl shutdown all || true' EXIT
for i in $(seq 1 15); do
  curl --silent --fail http://127.0.0.1:3100/health && break || sleep 2
done

call() {
  local tool="$1" args="${2:-{}}"
  curl --silent --fail --show-error \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg n "$tool" --argjson a "$args" \
      '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')" \
    http://127.0.0.1:3100/mcp \
    | jq '.result.content[0].text | fromjson'
}

# ── Run the recipe ─────────────────────────────────────────────────
call app_launch             "$(jq -n --arg b "$APP_BUNDLE_ID" --arg d "$UDID" '{bundleId:$b,deviceId:$d}')"
call app_storekit_configure "$(jq -n --arg c "$(pwd)/$STOREKIT_CONFIG" --arg d "$UDID" '{configPath:$c,udid:$d}')"
call app_deeplink           "$(jq -n --arg u "$DEEPLINK" --arg d "$UDID" '{url:$u,deviceId:$d}')"
call app_tap_element        "$(jq -n --arg l "$BUY_BUTTON_LABEL" --arg d "$UDID" '{label:$l,timeout:10000,deviceId:$d}')"
call app_alert_handle       "$(jq -n --argjson ls "$STOREKIT_ACCEPT_LABELS" --arg d "$UDID" '{buttonLabels:$ls,udid:$d}')"

TX_ID=$(call app_storekit_test_session "$(jq -n --arg d "$UDID" '{action:"list",udid:$d}')" \
  | jq -r '.transactions[] | select(.state == "pending") | .id' | head -n1)
test -n "$TX_ID" || { echo "No pending transaction" >&2; exit 1; }

call app_storekit_test_session "$(jq -n --arg t "$TX_ID" --arg d "$UDID" \
  '{action:"approve",transactionId:$t,udid:$d}')"
call app_storekit_receipt "$(jq -n --arg b "$APP_BUNDLE_ID" --arg d "$UDID" \
  '{bundleId:$b,udid:$d}')" > receipt.json

RECEIPT=$(jq -r '.receipt' receipt.json)
STATUS=$(curl --silent --output response.json --write-out '%{http_code}' \
  -H "Authorization: Bearer $BACKEND_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg r "$RECEIPT" '{receipt:$r,sandbox:true}')" \
  "$BACKEND_URL/iap/verify")
[ "$STATUS" = "200" ] || { cat response.json; exit 1; }
jq -e '.ok == true' response.json

echo "IAP smoke passed — transaction $TX_ID, receipt $(jq -r .bytes receipt.json) bytes"
```

---

## ko-KR StoreKit gotchas

1. **Set locale **before** booting.** Writing `AppleLocale` after a boot does not re-render already-mounted SpringBoard strings. Always: write defaults → shutdown → boot.
2. **Sheet labels are not stable across iOS minor versions.** iOS 17 shows **구입**; iOS 18 introduced a confirmation sub-sheet titled **확인하려면 이중 클릭하십시오** with the confirm button still labelled **구입**. Match by a **list** of candidate labels: `buttonLabels: ["구입", "Buy"]`. `app_alert_handle` tries them in order and returns the matched label — treat the first string in the list as your preferred match (#589).
3. **"Ask to Buy" gate.** If a Family Sharing parent flow is active, the sheet becomes **구입 요청하기** and produces a pending transaction that must be approved out-of-band. Disable Ask to Buy at the top of the recipe: `app_storekit_test_session { action: "askToBuy", enabled: false }`.
4. **Profile builds only.** Run `flutter build ios --simulator --profile`, never `--release`. Release AOT rejects `Runtime.evaluate` with `code 113` and the router falls through to AppleScript, which is blocked under `OPENSAFARI_HEADLESS_ONLY=1`. See [CI Recipes → QA-ready Flutter build](../ci-recipes.md#qa-ready-flutter-build).
5. **Receipt timing.** The sandbox receipt is written after `app_storekit_test_session { action: "approve" }` returns. If `app_storekit_receipt` comes back with `NO_RECEIPT`, poll with a short backoff (max 5×500 ms) before failing the job — iOS occasionally flushes the receipt lazily on first app resume.
6. **`OPENSAFARI_DISABLE_STOREKIT=1` must be unset in IAP jobs.** Many repos set it globally to keep generic Safari CI cheap; this recipe does not work with it set.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `app_alert_handle` returns `NO_BUTTON_MATCH` | Locale not applied, or the sheet is not yet on screen | Re-check simulator locale with `xcrun simctl spawn $UDID defaults read -g AppleLocale`; add `app_wait_for` on the sheet title before calling `app_alert_handle`. |
| `app_storekit_configure` fails with `MISSING_FILE` | Path in `configPath` is relative | The recipe uses `$(pwd)/$STOREKIT_CONFIG` — always absolute. |
| `app_storekit_test_session { action: "list" }` returns `[]` | The in-app purchase call never reached StoreKit | Confirm the buy-button tap resolved — `app_tap_element` returns the element's frame, assert on it before continuing. |
| `app_storekit_receipt` returns `NO_RECEIPT` | Receipt not yet flushed | See gotcha #5 above — retry with backoff. |
| Sheet appears but shows English labels | Locale was not set before the first boot | See gotcha #1. Shut the simulator, re-write `AppleLocale` / `AppleLanguages`, boot again. |

---

## Follow-ups

- **en-US** and **ja-JP** variants — copy this file, swap `STOREKIT_ACCEPT_LABELS` to `["Buy"]` and `["購入","Buy"]` respectively. Tracked as a future docs task.
- **Pin update cadence** — bump `OPENSAFARI_MCP_VERSION` together with this recipe whenever a newer `opensafari-mcp` ships a StoreKit- or alert-handle-relevant change; link the diff in the changelog entry.

---

## See also

- [CI Recipes](../ci-recipes.md) — the general-purpose recipes this one extends
- [StoreKit Automation](../storekit-automation.md) — tool reference for the three `app_storekit_*` tools
- [API Reference — `app_alert_handle`](../api-reference.md#app_alert_handle) — localized button matching (#589)
- [CI Integration](../ci-integration.md) — output formats, exit-code gating, JUnit schema
