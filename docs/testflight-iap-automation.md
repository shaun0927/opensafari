# TestFlight / IAP automation notes

OpenSafari's supported TestFlight direction is conservative: classify the current state, collect redacted evidence, and stop at Apple account / 2FA / tester-enrollment blockers. Host macOS TestFlight is an adjacent Tier 2 surface under [Product Direction](product-direction.md), not a silent expansion of the simulator core. Do not pass Apple ID, sandbox account, 2FA, or App Store Connect private-key material through OpenSafari tool parameters or logs.

## Build availability probe

Use `scripts/qa/appstoreconnect-build-status.mjs` when CI has already fetched App Store Connect build JSON and only needs a safe TestFlight readiness classification:

```bash
node scripts/qa/appstoreconnect-build-status.mjs path/to/appstoreconnect-builds.json
```

The script emits compact JSON with `status`, `reason`, and selected non-secret build metadata. Statuses are:

- `BUILD_PROCESSING` — latest build still has a processing/uploading state.
- `BUILD_AVAILABLE` — latest build is processed or marked ready for testing.
- `BETA_REVIEW_REQUIRED` — latest build is blocked by beta review or compliance state.
- `NO_BUILD` — the JSON contains no build records.
- `UNKNOWN` — a build exists, but known status fields are missing or unrecognized.

The script accepts pre-fetched JSON only. It does not store credentials, does not upload builds, and does not call App Store Connect by itself.

## Runtime state probe

Use `app_testflight_iap_snapshot` for the simulator/runtime side. It is read-only: it does not tap, type credentials, install/update apps, confirm purchases, or call App Store Connect.

```json
{
  "tool": "app_testflight_iap_snapshot",
  "params": {
    "expectedAppBundleId": "com.example.MyApp",
    "includeEvidence": true,
    "maxVisibleNodes": 30,
    "maxDepth": 8
  }
}
```

The response includes installed-app hints, foreground/context hints, classifier result, safe recovery hints, and optional debug-bundle path summaries.

## Verification

```bash
node scripts/qa/appstoreconnect-build-status.mjs scripts/qa/fixtures-appstoreconnect-build-status/available.json
node scripts/qa/appstoreconnect-build-status.mjs --self-check
npm test -- --runTestsByPath tests/scripts/appstoreconnect-build-status.test.ts tests/unit/app-testflight-iap-snapshot.test.ts tests/unit/testflight-iap-classifier.test.ts --runInBand
```

For the human-in-the-loop purchase flow, see [TestFlight + IAP human loop](recipes/testflight-iap-human-loop.md).


## Host macOS TestFlight vs Simulator TestFlight

Simulator TestFlight/IAP automation remains device-scoped and uses `app_testflight_iap_snapshot`. Host macOS TestFlight automation uses the new `mac_*` tools against `/Applications/TestFlight.app` / `com.apple.TestFlight` and does not require `deviceId`. See [Host macOS TestFlight QA](recipes/macos-testflight-qa.md).
