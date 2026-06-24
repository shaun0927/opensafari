# TestFlight/IAP automation

## App Store Connect build-status probe

Use `scripts/qa/appstoreconnect-build-status.mjs` when CI has already fetched App Store Connect build JSON and OpenSafari only needs a safe readiness classification:

```sh
node scripts/qa/appstoreconnect-build-status.mjs path/to/appstoreconnect-builds.json
```

The script prints one compact JSON object with `status`, `reason`, and selected non-secret build metadata. It does not read, persist, or print App Store Connect credentials/private keys.

Statuses:

- `BUILD_PROCESSING` — latest build still has a processing/uploading state.
- `BUILD_AVAILABLE` — latest build is processed or marked ready for testing.
- `BETA_REVIEW_REQUIRED` — latest build is blocked by beta review or compliance state.
- `NO_BUILD` — the JSON contains no build records.
- `UNKNOWN` — a build exists, but known status fields are missing or unrecognized.

Fixture smoke checks:

```sh
node scripts/qa/appstoreconnect-build-status.mjs scripts/qa/fixtures-appstoreconnect-build-status/available.json
node scripts/qa/appstoreconnect-build-status.mjs --self-check
```
