# Omofictions-App private-route QA lane

This document is the **environment contract** for running the scripted
Omofictions-App private-route QA lane from opensafari. It exists to satisfy
the Step 1 deliverable of issue
[#44](https://github.com/junghwan-oss/opensafari/issues/44) and to unblock
the verification box #8 of issue
[#34](https://github.com/junghwan-oss/opensafari/issues/34).

This repo (`opensafari`) owns the **driver** (install script, QA-lane script,
CI workflow). The **app under test** is owned by a separate team
(Omofictions-App); anything inside the app — accessibility identifiers,
test-account provisioning, StoreKit sandbox entitlements, build artefact
publication — is their deliverable. Keep the ownership split below in mind
when filing follow-up tickets.

> Scope boundary (enforced by CI path-guard): a PR closing #44 may touch only
> `docs/qa/**`, `scripts/qa/**`, `.github/workflows/omofictions-qa.yml`, and
> `.gitignore`. Any regression found while running the QA lane is filed as a
> separate opensafari issue, not patched here.

## 1. Ownership split

| Work item | Owner | Artefact |
|---|---|---|
| `docs/qa/omofictions-app.md`, install script, QA-lane script, CI workflow | opensafari maintainers | PRs against `junghwan-oss/opensafari` |
| `Semantics(identifier: …)` additions on signup / login / age-gate / wallet / detail / bookmark widgets | Omofictions-App maintainers | PR against Omofictions-App repo (tracking ID TBD — link back here when filed) |
| Simulator-compatible build artefact (`.app.zip` + SHA256 + download URL) | Omofictions-App maintainers | GitHub Release or artefact bucket |
| Test-account provisioning + StoreKit sandbox entitlements | Omofictions-App maintainers | Values filled into §3 of this doc |
| `omofictions_deeplinks_qa.json` (schema in §5) | Omofictions-App maintainers | Published alongside each QA build |

Until the Omofictions-App PR for stable accessibility identifiers lands, the
QA-lane script MUST be run with `--no-act` only (selector discovery mode).
See §6 for the current status of this blocking dependency.

## 2. Pinned simulator runtime

The QA lane is pinned to one simulator configuration. Changing this invalidates
any prior evidence attached to #44.

| Field | Value |
|---|---|
| Device | iPhone 16 |
| iOS runtime | 26.4 |
| Xcode toolchain | 26.4 |
| Appearance | Light (default) — dark-mode variants are filed as separate evidence runs |
| Locale / region | `en_US` / `US` |

Boot the pinned device once with:

```sh
xcrun simctl boot "iPhone 16"
xcrun simctl bootstatus "iPhone 16" -b
```

If the runner carries multiple iOS 26 runtimes, select explicitly:

```sh
xcrun simctl create "opensafari-qa" \
  "iPhone 16" \
  "com.apple.CoreSimulator.SimRuntime.iOS-26-4"
```

## 3. Build artefact and test account

Fill the values below into this section as the Omofictions-App team publishes
each QA build. Do NOT commit production credentials; use the `OMOFICTIONS_QA_*`
environment variables documented in §4 and store secrets in the CI secret
store.

| Field | Value |
|---|---|
| Source repo | `<TBD — Omofictions-App private repo URL>` |
| Build tag for the next evidence run | `<TBD — e.g. qa/2026-04-22>` |
| Artefact URL | `<TBD — signed URL to `.app.zip`>` |
| Artefact SHA256 | `<TBD — 64 hex chars>` |
| StoreKit config (`.storekit`) | `<TBD — path inside the build artefact>` |
| Test account (email) | via `OMOFICTIONS_QA_EMAIL` env var |
| Test account (password) | via `OMOFICTIONS_QA_PASSWORD` env var |
| Age-gate age | `19+` (over-18 branch) |

The test account posture is:

- A fresh account that has never completed signup is required for the signup
  scenario. Re-using an account causes step 2 (signup bootstrap) to fail with
  `EMAIL_ALREADY_REGISTERED`.
- At least one sandbox purchase must be available on the account prior to
  running the wallet-restore scenario. The QA-lane script seeds one via
  `step: "purchase_sandbox_prime"` if `evidence.existingPurchases === 0`; see
  Clarification 3 of #44.
- Before each nightly CI run the runner resets the StoreKit sandbox with
  `xcrun simctl storekit clear <udid>` and reloads the committed `.storekit`
  config. This isolates runs from each other.

## 4. Environment variables

| Variable | Purpose | Required in |
|---|---|---|
| `OMOFICTIONS_QA_DEVICE_ID` | Simulator UDID for all QA steps | setup.sh, private-route.mjs, workflow |
| `OMOFICTIONS_QA_BUILD_PATH` | Absolute path to the `.app` bundle after download+unzip | setup.sh, workflow |
| `OMOFICTIONS_QA_BUILD_SHA` | SHA256 of the downloaded build artefact | workflow (for build-meta logging) |
| `OMOFICTIONS_QA_DEEPLINKS_PATH` | Absolute path to `omofictions_deeplinks_qa.json` | private-route.mjs, workflow |
| `OMOFICTIONS_QA_EMAIL` | Test account email | private-route.mjs, workflow |
| `OMOFICTIONS_QA_PASSWORD` | Test account password | private-route.mjs, workflow |
| `OMOFICTIONS_BRIDGE_URL` | Opensafari JSON-RPC HTTP bridge endpoint (default `http://127.0.0.1:57337`) | private-route.mjs |

CI secrets map 1:1 to the `OMOFICTIONS_QA_*` variables. The `OMOFICTIONS_QA_EMAIL`
/ `OMOFICTIONS_QA_PASSWORD` pair MUST belong to a sandbox-only test account —
never a production account.

## 5. Deeplink manifest

The deeplink URLs used by step 4 of the scripted lane come from a manifest file
published alongside the Simulator build by the Omofictions-App team. The
QA-lane script does not hard-code any deeplink.

Schema (`omofictions_deeplinks_qa.json`):

```json
{
  "deeplinks": {
    "detail_paid": "omofictions://detail/<id>",
    "detail_free": "omofictions://detail/<id>",
    "wallet_root": "omofictions://wallet"
  },
  "build_sha": "…",
  "expires_at": "ISO-8601"
}
```

The QA-lane script aborts with `exit 73 (DEEPLINKS_STALE)` if `expires_at` is
in the past or `build_sha` does not match `OMOFICTIONS_QA_BUILD_SHA`. Refresh
the manifest by asking the Omofictions-App team to republish against the
current build.

## 6. Selectors table

The scripted lane uses accessibility identifiers, not labels, so the QA lane
survives label / copy changes. Every selector used by
`scripts/qa/omofictions-private-route.mjs` MUST appear here, with the build
it was last confirmed on.

Until the Omofictions-App PR adding stable `Semantics(identifier: …)` values
lands, this table is a **stub**. Run the script with `--no-act` to discover
what identifiers are actually present and fill in the `Observed identifier`
column; then ask the Omofictions-App team to canonicalise the `Expected
identifier` column before flipping `--no-act` off.

| Screen | Widget | Expected identifier | Observed identifier | Confirmed on build |
|---|---|---|---|---|
| Signup | email field | `signup-email-input` | `<TBD>` | `<TBD>` |
| Signup | password field | `signup-password-input` | `<TBD>` | `<TBD>` |
| Signup | confirm-password field | `signup-confirm-password-input` | `<TBD>` | `<TBD>` |
| Signup | Create Account CTA | `signup-create-account-cta` | `<TBD>` | `<TBD>` |
| Age-gate | 19+ button | `age-19-plus` | `<TBD>` | `<TBD>` |
| Age-gate | under-19 button | `age-under-19` | `<TBD>` | `<TBD>` |
| Landing | Home tab | `landing-tab-home` | `<TBD>` | `<TBD>` |
| Wallet | Restore Purchases button | `wallet-restore-purchases` | `<TBD>` | `<TBD>` |
| Detail | Info tab | `detail-tab-info` | `<TBD>` | `<TBD>` |
| Detail | Chapters tab | `detail-tab-chapters` | `<TBD>` | `<TBD>` |
| Detail | Comments tab | `detail-tab-comments` | `<TBD>` | `<TBD>` |
| Detail | Bookmark toggle | `detail-bookmark-toggle` | `<TBD>` | `<TBD>` |
| Detail | Purchase CTA | `detail-purchase-cta` | `<TBD>` | `<TBD>` |

## 7. Evidence format

Every verification-checklist tick in #44 is backed by a single
`artefact-<iso-timestamp>.zip` attached to the issue, containing:

- `run.log` — the full JSON log emitted by `scripts/qa/omofictions-private-route.mjs`.
- `screenshots/step-<N>-<step-name>.png` — one PNG per step, captured at step start.
- `simulator-log.txt` — `xcrun simctl spawn <udid> log show --style syslog --last 3m` dump for the run window.
- `device-meta.json` — UDID, iOS version, Xcode version, opensafari commit SHA, Omofictions-App build SHA.

The workflow in `.github/workflows/omofictions-qa.yml` packages these
artefacts automatically and uploads them as a single `actions/upload-artifact`
bundle per run.

## 8. Blocking dependencies

- [ ] Omofictions-App PR adding stable accessibility identifiers (table in §6)
  — status TBD. Until merged, QA lane is `--no-act` only and the workflow
  is `workflow_dispatch`-only (nightly deferred per #44 Clarification 4).
- [ ] Omofictions-App publishing a Simulator-compatible build artefact with
  a documented download URL — status TBD. Without this, §3 remains a stub
  and the CI workflow cannot download a build.
- [ ] Omofictions-App publishing `omofictions_deeplinks_qa.json` alongside
  each QA build — status TBD. Without this, step 4 of the QA lane exits
  with code `73 (DEEPLINKS_STALE)`.
- [ ] Self-hosted macOS runner with Xcode 26.4 + simulator tag available to
  the workflow — status TBD. Without this, §9 (nightly promotion) stays
  deferred.

Cross-link the Omofictions-App ticket ID here when filed.

## 9. Onboarding — developer laptop

Target: a developer who has never touched the Omofictions-App repo should be
able to reach `com.omofictions.omofictionsApp.app` foregrounded on a booted
iPhone 16 / iOS 26.4 simulator within 3 minutes of cloning this repo. The
3-minute figure is a target, not a blocker for issue closure — actual
measurement is recorded in the reviewer's comment on the closing PR.

Steps:

1. Clone `opensafari` and `cd` into it.
2. Ensure Xcode 26.4 is installed and a simulator for iPhone 16 / iOS 26.4 is present.
3. Download the QA build (§3) and unzip into a known path, capturing the SHA256.
4. Export the environment variables from §4.
5. Run:
   ```sh
   ./scripts/qa/omofictions-setup.sh \
     --device-id "$OMOFICTIONS_QA_DEVICE_ID" \
     --build-path "$OMOFICTIONS_QA_BUILD_PATH"
   ```
6. On exit 0, the app is installed and foregrounded. The script prints the
   launched PID for sanity. See `scripts/qa/omofictions-setup.sh` for exit-code
   semantics.

If the script exits 72, a stuck permission overlay was detected on the
simulator. See issue
[#43](https://github.com/junghwan-oss/opensafari/issues/43) for the
alert-dismiss fix that addresses this class of failure.

## 10. Running the scripted lane

After §9 succeeds:

```sh
node ./scripts/qa/omofictions-private-route.mjs \
  --device-id "$OMOFICTIONS_QA_DEVICE_ID" \
  --deeplinks "$OMOFICTIONS_QA_DEEPLINKS_PATH" \
  --no-act      # selector-discovery dry-run; omit once the §6 table is confirmed.
```

Expected wall time on a clean install: under 3 minutes. Exit 0 means every
step logged `ok: true`.

## 11. Cross-issue closure

Box 8 of #34 is checked once a green run of this QA lane is attached to #44.
The same run artefact is the evidence for closing:

- [#7](https://github.com/junghwan-oss/opensafari/issues/7) — IAP verification
- [#8](https://github.com/junghwan-oss/opensafari/issues/8) — Wallet + restore
- [#9](https://github.com/junghwan-oss/opensafari/issues/9) — Detail info tab
- [#10](https://github.com/junghwan-oss/opensafari/issues/10) — Detail chapter / comments
- [#11](https://github.com/junghwan-oss/opensafari/issues/11) — Detail purchase bar + bookmark

Each of those tickets is closed with a back-reference to the artefact set
attached to #44.
