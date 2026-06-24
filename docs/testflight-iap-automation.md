# TestFlight / IAP automation notes

OpenSafari's supported TestFlight direction is conservative: classify the current state, collect redacted evidence, and stop at Apple account / 2FA / tester-enrollment blockers. Do not pass Apple ID, sandbox account, 2FA, or App Store Connect private-key material through OpenSafari tool parameters or logs.

## Build availability probe

Use `scripts/qa/appstoreconnect-build-status.mjs` when CI has already fetched App Store Connect build JSON and only needs a safe TestFlight readiness classification:

```bash
node scripts/qa/appstoreconnect-build-status.mjs path/to/appstoreconnect-builds.json
```

The script emits compact JSON with one of:

- `BUILD_PROCESSING` — latest build is still processing.
- `BUILD_AVAILABLE` — latest build appears available for TestFlight use.
- `BETA_REVIEW_REQUIRED` — latest build is blocked on beta app review.
- `NO_BUILD` — input contained no build records.
- `UNKNOWN` — metadata did not match a known availability state.

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
node scripts/qa/appstoreconnect-build-status.mjs tests/fixtures/appstoreconnect-build-status/available.json
npm test -- --runTestsByPath tests/scripts/appstoreconnect-build-status.test.ts tests/unit/app-testflight-iap-snapshot.test.ts tests/unit/testflight-iap-classifier.test.ts --runInBand
```

For the human-in-the-loop purchase flow, see [TestFlight + IAP human loop](recipes/testflight-iap-human-loop.md).
