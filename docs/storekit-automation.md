# StoreKit / In-App Purchase QA on the iOS Simulator

OpenSafari does **not** ship a `simctl storekit` wrapper, because Apple's
`simctl` command line tool has no `storekit` subcommand on any released Xcode
(verified through Xcode 26.4 — `xcrun simctl storekit` returns
`Unrecognized subcommand: storekit`). The earlier `app_storekit_*` tools were
removed in the #588 follow-up because they were built on a CLI surface that
does not exist.

This guide documents the supported, working path for IAP QA against the Xcode
StoreKit Testing sandbox, using OpenSafari's existing accessibility-driven
tools.

## What you have to set up outside OpenSafari

StoreKit Testing is configured at **build time**, not at automation time:

1. Add a `.storekit` configuration file to your Xcode project.
2. In the scheme's *Run* / *Test* options, set **StoreKit Configuration** to
   that file.
3. Build the app for the simulator with that scheme.

After this, the simulator process loads the configured products on launch — no
runtime `configure` call is needed (or possible) from outside the app.

For Flutter apps using `in_app_purchase` + `in_app_purchase_storekit`, the same
applies: configure the iOS Runner scheme in Xcode.

Reference: Apple — *Setting up StoreKit Testing in Xcode*.

## Driving StoreKit purchase sheets from OpenSafari

Once the app is built with a StoreKit configuration, the product list and
purchase confirmation sheets are driven by the system. Tap the in-app *Buy*
button via the normal element APIs, then handle the system sheet with
`app_alert_handle` against the AX layer.

Localized labels for the common StoreKit sheet buttons are pre-catalogued in
`src/native/system-button-catalog.ts` (`storekit.signIn`, `storekit.cancel`).
For the *Confirm* / *Buy* / *Subscribe* primary buttons, pass a
`buttonLabels` candidate list so the same script works on en-US and ko-KR
simulators.

```jsonc
// 1. Tap the in-app Buy button (your app's UI)
{ "tool": "app_tap_element", "params": { "label": "Buy lifetime" } }

// 2. Confirm the system StoreKit sheet (multi-locale)
{ "tool": "app_alert_handle", "params": {
    "buttonLabels": ["Confirm", "확인", "Buy", "구매", "Subscribe", "구독"]
} }

// 3. Verify entitlement was granted (your app's UI again)
{ "tool": "app_assert_element", "params": { "label": "Premium active" } }
```

`app_alert_handle` resolves the label list against the macOS `AXUIElement`
accessibility API (`ax-bridge`), the same path that already handles the
StoreKit password sheet. Telemetry: success responses report
`_meta._telemetry[].backend = "ax-press"`.

## Walk-through — en-US

```
1. Boot simulator:                device_boot
2. Install your app built with    (xcodebuild / flutter build ios)
   the StoreKit scheme
3. Launch app:                    app_launch { bundleId: "com.example.myapp" }
4. Trigger purchase:              app_tap_element { label: "Buy lifetime" }
5. Confirm StoreKit sheet:        app_alert_handle { buttonLabels: ["Confirm", "Buy"] }
6. Wait for entitlement to land:  app_wait_for { ... }
7. Assert UI updated:             app_assert_element { label: "Premium active" }
```

## Walk-through — ko-KR

```
1. 시뮬레이터 부팅:              device_boot
2. StoreKit scheme 으로 빌드한    (xcodebuild / flutter build ios)
   앱 설치
3. 앱 실행:                      app_launch { bundleId: "com.example.myapp" }
4. 구매 트리거:                  app_tap_element { label: "평생 이용권 구매" }
5. StoreKit 시트 확인:           app_alert_handle { buttonLabels: ["확인", "구매"] }
6. 영수증 반영 대기:             app_wait_for { ... }
7. UI 갱신 확인:                 app_assert_element { label: "프리미엄 활성" }
```

## Receipt verification

There is no headless way to pull a sandbox receipt out of an arbitrary app's
container. `Documents/receipt` is a legacy iOS 6 path that modern apps do not
use, and the `StoreKitTest` framework that exposes JWS transactions
(`Transaction.all`, `Transaction.jsonRepresentation`) runs **in-process** in
the app under test.

Two options that actually work today:

1. **App-side helper.** Have the app under test surface the latest receipt or
   `Transaction.jsonRepresentation` payload to a debug screen / log line, and
   read it via `app_query` or `app_logs`. This is the path most CI fixtures
   take.
2. **Server-side verification.** Submit the receipt to your backend as part of
   the purchase flow and assert the backend response in your test, not the
   on-device receipt.

If a Swift bridge SDK direction is later approved (tracked separately as a
research RFC following #588), it would use approach #1 with a standard helper
module so this doc could collapse into a single tool call.

## What is intentionally not provided

- `app_storekit_configure` — there is no `simctl storekit configure`. Use the
  Xcode scheme.
- `app_storekit_test_session` — there is no `simctl storekit test-session`.
  Use the AX-driven sheet pattern above; refunds need either the StoreKit
  Testing menu in Xcode or an in-app debug hook.
- `app_storekit_receipt` — receipts are not stored at a stable headless path
  on modern iOS; see *Receipt verification*.

## Disabling system-sheet automation in CI

If you need to skip StoreKit sheets entirely in a particular CI job (e.g. when
the build was made with no StoreKit configuration), gate the sheet step on a
flag in your test runner. There is no environment escape hatch in OpenSafari
for this, because the underlying tools (`app_alert_handle`,
`app_tap_element`) are already general-purpose.
