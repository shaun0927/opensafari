# TestFlight + IAP human-in-the-loop recipe

This recipe documents the supported semi-automated path for TestFlight sandbox
IAP QA: OpenSafari collects state and evidence, a human handles Apple ID / 2FA
or TestFlight account prompts, then OpenSafari resumes system-sheet handling and
app/backend verification.

It is intentionally **not** a full unattended TestFlight purchase bot. Do not
send Apple ID passwords, 2FA codes, App Store Connect keys, or sandbox account
credentials through OpenSafari tools or CI logs.

## Simulator StoreKit testing vs. TestFlight sandbox IAP

Use the right lane for the question you are asking:

| Lane | Runs on | What it proves | How purchases are verified |
|---|---|---|---|
| Xcode StoreKit config testing | Simulator app built with a `.storekit` file in the Xcode scheme | Product UI, localized purchase sheets, entitlement UI, and app-side StoreKit handling in a deterministic simulator sandbox | App-side debug UI/logs or backend assertions; see [StoreKit Automation](../storekit-automation.md) |
| TestFlight sandbox IAP | TestFlight-installed build, usually requiring a signed-in Apple ID / sandbox tester state | The shipped TestFlight build can reach Apple's sandbox purchase flow and your backend/app entitlement path | App-side helper/log or backend verification only |

OpenSafari can drive generic simulator/app surfaces in both lanes, but the
TestFlight lane can stop on Apple account, 2FA, invitation, build-availability,
or tester-eligibility screens. Those are human handoff points, not automation
bypass targets.

## Tool availability

Current tools used below:

- [`app_state_snapshot`](../mobile-semantic-qa.md#state-snapshot-before-action) — read-only state before deciding the next action.
- [`app_activate`](../api-reference.md#app_activate) / [`app_launch`](../api-reference.md#app_launch) — foreground TestFlight or the app under test.
- [`app_alert_handle`](../api-reference.md#app_alert_handle) — press visible system sheet buttons by label, including StoreKit confirmation sheets.
- `app_tap_element` — tap your app's stable purchase control by accessibility label/identifier.
- [`app_query`](../api-reference.md) / [`app_logs`](../api-reference.md) — read app-visible state or logs for entitlement/receipt evidence.
- [`debug_bundle_collect`](../debug-bundle.md) — collect screenshot, AX summary, logs, crashes, and route hints.

TestFlight/IAP-specific snapshot tool:

- [`app_testflight_iap_snapshot`](../api-reference.md#app_testflight_iap_snapshot) — a read-only composed snapshot that classifies TestFlight install/account/StoreKit/backend blockers and returns `phase`, `blocker`, `confidence`, `nextSafeAction`, and optional evidence path summaries.

## JSON-RPC helper

The examples assume a local HTTP MCP server:

```bash
export OPENSAFARI_HTTP_TOKEN="${OPENSAFARI_HTTP_TOKEN:?set in CI secrets}"
opensafari serve --http 3100 &
SERVER_PID=$!

osafari-call() {
  local tool="$1"
  local params="${2:-{}}"
  curl --silent --fail \
    -H "Authorization: Bearer $OPENSAFARI_HTTP_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg tool "$tool" --argjson params "$params" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$tool,arguments:$params}}')" \
    http://127.0.0.1:3100/mcp
}
```

Keep credentials out of `params`; use the simulator UI directly for human
Apple ID / 2FA steps.

## Flow

### 1. Snapshot before TestFlight install/update

Start by collecting a read-only TestFlight/IAP snapshot. Use the generic `app_state_snapshot` only as a fallback when running an older OpenSafari version.

```bash
# Current safe snapshot: read-only, no taps.
osafari-call app_testflight_iap_snapshot \
  '{
    "expectedAppBundleId": "com.example.MyApp",
    "includeEvidence": true,
    "maxVisibleNodes": 30,
    "maxDepth": 8
  }' | tee artifacts/testflight-iap-before.json
```

Interpretation:

- `TESTFLIGHT_INSTALL_AVAILABLE` or `TESTFLIGHT_UPDATE_AVAILABLE`: a human or a
  higher-level TestFlight install step may proceed.
- `APPLE_ID_SIGN_IN_REQUIRED`, `TWO_FACTOR_REQUIRED`, or similar account state:
  stop automation and hand off to a human.
- Unknown state: collect evidence before trying recovery.

### 2. Human handoff for Apple ID / 2FA

When the snapshot or visible simulator screen shows an Apple ID, 2FA, sandbox
account, invite, or TestFlight terms blocker, stop the automation lane and print
an explicit handoff message. Do not retry blindly and do not ask OpenSafari to
enter credentials.

```bash
cat <<'HANDOFF'
HUMAN ACTION REQUIRED
- The simulator is blocked on Apple account, sandbox tester, TestFlight invite,
  or 2FA UI.
- Complete the prompt directly in the Simulator/TestFlight UI.
- Do not paste Apple ID passwords or 2FA codes into OpenSafari, CI variables, or
  JSON-RPC parameters.
- When the screen is past the blocker, resume at step 3.
HANDOFF

osafari-call debug_bundle_collect \
  '{
    "includeScreenshot": true,
    "includeAxTree": true,
    "includeLogs": true,
    "artifactDir": "artifacts/testflight-human-handoff"
  }' | tee artifacts/testflight-human-handoff/bundle.json
```

Safe stop condition: automation remains paused until the account/2FA/TestFlight
screen is no longer the foreground blocker.

### 3. Resume after the human step

After the human completes the account step, foreground either TestFlight or the
app under test and refresh state.

```bash
# Foreground TestFlight to continue install/update if needed.
osafari-call app_activate '{ "bundleId": "com.apple.TestFlight" }'

# Or foreground the installed app once TestFlight shows Open / the app is ready.
osafari-call app_launch '{ "bundleId": "com.example.MyApp" }'

# Re-snapshot before mutating app state.
osafari-call app_state_snapshot \
  '{
    "expectedBundleId": "com.example.MyApp",
    "maxVisibleNodes": 30,
    "maxDepth": 8
  }' | tee artifacts/testflight-state-after-human.json
```

If the resumed snapshot still shows account or 2FA UI, return to step 2. If it
shows the app under test, proceed to the purchase trigger that your test harness
owns (for example, a deep link or semantic tap on your app's buy button).

### 4. Confirm the StoreKit sheet with `app_alert_handle`

Trigger the purchase from your app UI, then handle the system confirmation sheet
by explicit candidate labels. The label list should include the simulator locale
used by the TestFlight lane.

```bash
# Example app-specific purchase trigger. Replace selector with your app's stable
# accessibility label/identifier.
osafari-call app_tap_element \
  '{ "label": "Buy lifetime", "bundle_id": "com.example.MyApp" }'

# Confirm the StoreKit system sheet by label.
osafari-call app_alert_handle \
  '{
    "buttonLabels": ["Confirm", "Buy", "Subscribe", "확인", "구매", "구독"]
  }' | tee artifacts/storekit-confirmation.json
```

If `app_alert_handle` returns `NO_MATCHING_BUTTON`, do not fall back to random
coordinates. Capture evidence and inspect visible labels.

### 5. Collect evidence with `debug_bundle_collect`

Collect a compact evidence bundle after the purchase attempt, on any blocker,
and before destructive recovery such as app reinstall or simulator reset.

```bash
osafari-call debug_bundle_collect \
  '{
    "includeScreenshot": true,
    "includeAxTree": true,
    "includeLogs": true,
    "includeCrashes": true,
    "includeFlutterRoute": true,
    "artifactDir": "artifacts/testflight-iap-after-purchase"
  }' | tee artifacts/testflight-iap-after-purchase/bundle.json
```

The bundle is local evidence only. Upload it through your CI artifact system if
needed, and rely on OpenSafari redaction for common token/password patterns;
do not intentionally log secrets.

### 6. Verify entitlement through the app or backend

Receipt verification must be owned by the app under test or the backend. Do not
try to scrape arbitrary app containers for sandbox receipts.

App-side helper/log example:

```bash
# App exposes a debug entitlement label or receipt status text.
osafari-call app_query \
  '{ "text": "Premium active", "max_results": 5 }' \
  | tee artifacts/app-entitlement-query.json

# Or assert against a redacted app log line emitted by a debug/test build.
osafari-call app_logs \
  '{
    "bundleId": "com.example.MyApp",
    "since": "2m",
    "search": "iap_verification=success"
  }' | tee artifacts/app-iap-logs.json
```

Backend verification example:

```bash
# Use your backend's test endpoint or CI helper, not OpenSafari, to verify the
# transaction/entitlement reached the server. Keep tokens in CI secrets.
curl --silent --fail \
  -H "Authorization: Bearer ${BACKEND_QA_TOKEN:?set in CI secrets}" \
  "https://staging-api.example.com/qa/users/${QA_USER_ID}/entitlements/premium" \
  | tee artifacts/backend-entitlement.json
```

Pass criteria should combine UI/app evidence and backend/app-side verification,
for example: StoreKit sheet handled, app shows premium state, and backend reports
an active sandbox entitlement for the QA user.

## Troubleshooting

| Blocker | Signal | Next safe action |
|---|---|---|
| Build not visible in TestFlight | Snapshot/AX tree shows no app, no Install/Update/Open button | Check build availability outside OpenSafari (App Store Connect, release notes, invite status). Re-snapshot after the build is available. |
| Apple ID sign-in required | Visible Apple ID login, password, sandbox account, or media services prompt | Pause automation and hand off to a human. Never pass credentials through OpenSafari. Resume with a fresh snapshot. |
| 2FA required | Visible verification-code or trusted-device prompt | Pause automation for human completion. Collect `debug_bundle_collect` if the lane needs evidence, then resume with `app_state_snapshot`. |
| TestFlight terms/invite blocker | TestFlight shows terms, unavailable invite, expired build, or tester not accepted | Human accepts terms/invite or fixes tester enrollment outside OpenSafari. Re-run snapshot; do not retry install loops. |
| StoreKit sheet not found | Purchase trigger ran, but `app_alert_handle` reports `NO_MATCHING_BUTTON` | Collect debug bundle, inspect `visibleLabels`, add locale-specific labels, or fix the app trigger. Do not use coordinate fallback. |
| StoreKit confirmation has no effect | `app_alert_handle` reports `ALERT_HANDLE_NO_EFFECT` or the same sheet remains | Re-snapshot and collect evidence. If account auth is requested, hand off to human; otherwise retry once with the exact visible label. |
| Purchase completes but entitlement is absent | App UI/log or backend does not show premium state | Collect bundle and app/backend logs. Investigate app receipt handling or backend sandbox verification; do not claim purchase success from sheet dismissal alone. |
| Unknown foreground state | Snapshot confidence is low or `app_testflight_iap_snapshot` reports `UNKNOWN_WITH_EVIDENCE` | Wait briefly, snapshot again, then collect `debug_bundle_collect`. Escalate with artifacts instead of resetting first. |
| Simulator/app crash | Debug bundle includes fresh crash or app is no longer foreground | Attach crash/log artifacts to the failure. Reinstall/relaunch only after evidence is captured. |

## CI guardrails

- Keep TestFlight sandbox lanes opt-in and non-blocking unless a pre-authenticated
  simulator/device pool is maintained by humans.
- Always snapshot before install/update, after any human handoff, and before
  destructive recovery.
- Treat Apple ID/2FA/account prompts as stop conditions, not errors to bypass.
- State plainly in CI output that the lane is semi-automated and may require a
  human account step.
