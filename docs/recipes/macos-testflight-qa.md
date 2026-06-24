# Host macOS TestFlight QA

This is for **macOS TestFlight.app on the host Mac**, not iOS Simulator TestFlight. Simulator tools still use `deviceId`; these `mac_*` tools target a running macOS process such as `com.apple.TestFlight` and never require a simulator.

## Minimal flow

```bash
osafari-call mac_app_launch '{"bundleId":"com.apple.TestFlight"}'
osafari-call mac_app_tree '{"bundleId":"com.apple.TestFlight","maxDepth":10}'
osafari-call mac_testflight_snapshot '{"appName":"Omofictions","artifactDir":"artifacts/omofictions-testflight"}'
osafari-call mac_testflight_install_update_open '{"appName":"Omofictions","artifactDir":"artifacts/omofictions-testflight"}'
osafari-call mac_testflight_qa_run '{
  "appName":"Omofictions",
  "expectedBundleId":"com.omofictions.omofictionsApp",
  "artifactDir":"artifacts/omofictions-testflight"
}'
```

`mac_testflight_qa_run` collects screenshot + AX evidence for `Ducats Shop`, `Payment Page`, `confirm-payment`, and `restore-purchases` when the iOS-on-Mac app exposes them.

## Human handoff blockers

OpenSafari does **not** enter Apple ID passwords, 2FA codes, invite acceptance, TestFlight terms, sandbox login, or StoreKit credentials. Those states return structured JSON (`APPLE_ID_REQUIRED`, `TWO_FACTOR_REQUIRED`, `INVITE_OR_GROUP_BLOCKED`, `TERMS_REQUIRED`, or `UNKNOWN_WITH_EVIDENCE`) plus artifact paths.

## Purchase confirmation

`confirm-payment` evidence is captured, but purchase confirmation is not pressed unless the caller explicitly supplies `allowPurchaseConfirm: true` and the UI is already visible/authorized.
