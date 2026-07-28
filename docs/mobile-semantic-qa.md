# Mobile Semantic QA Runtime

This document defines the runtime contract for the mobile semantic surface. The
canonical product scope and priorities live in
[Product Direction](product-direction.md).

## State Before Action

Use `app_state_snapshot` when an agent needs to choose its next action without
mutating app state. The read-only response includes:

- foreground/context classification and confidence
- expected bundle match
- visible AX summary and screen fingerprint
- Flutter VM connection and route hints when connected
- best-effort WebView hints
- non-destructive recovery hints such as `app_switch_app`, `app_wait_for`, or
  `debug_bundle_collect`

Relaunch, reset, permission clearing, and auth restoration are not default
recovery. If state is unknown or transitional, wait for a postcondition or
collect evidence first.

## Verified Semantic Actions

A semantic action separates transport dispatch from app-state success. A tap,
deeplink, text injection, or route mutation succeeds only when its explicit AX
or Flutter postcondition is observed.

Controller-shaped tools report the selected strategy, attempts, skipped
reasons, backend/fallback evidence, verification result, elapsed time, and a
recovery hint on failure. `app_goto_screen` also records state before and after
navigation and performs an already-on-target check when a target is supplied.

## Shared Settle Policy

High-level interaction and scenario steps accept a shared settle policy with:

- AX query fields: `identifier`, `label`, `text`, `role`
- condition: `exists`, `not_exists`, `visible`, or `enabled`
- `timeoutMs`, `intervalMs`, and `stableMs`

`app_tap_element` and `app_type_element` preserve their historical dispatch-only
behavior when no settle object is supplied. When `settle.query` is present, the
response includes settle evidence and an unmet postcondition becomes a tool
error.

## Scenario Runner v2

`run_scenario` with `version: 2` is stateful by default. Supported mobile steps
include:

- `recordState`
- `launchApp`
- `gotoScreen`
- `waitFor`
- `tapElement`
- `typeElement`
- `assertElement`
- `popUntil`
- `dismissOverlay`
- `collectDebugBundle`

Use `launchApp` only when the scenario requires a fresh foreground app.
`gotoScreen` requires an AX query, `settle.query`, or Flutter route target; a
deeplink dispatch alone cannot pass. Results preserve per-device state, backend
hints, verification, timing, and partial-failure data. Existing browser v1
scenarios remain compatible.

## Flutter Selector Quality

`qa_flutter_semantics` includes `selector_quality` by default and flags:

- missing `Semantics(identifier: ...)` on interactive widgets
- duplicate identifiers or labels
- label-only selectors that may break across locales
- missing role/trait hints

Human-readable labels remain important for accessibility. The audit reports
automation risk; it does not recommend removing accessible labels.

## Flutter VM Attach

`flutter_connect` reports whether attach used an explicit URL, environment
override, cached URL, fixed port, or log-scan fallback. Prefer an explicit VM
Service URL for fast debug/profile sessions. Release builds generally do not
expose VM Service and should continue through native AX semantics.

VM absence is data, not a failure. When attached, tools may add best-effort
route, widget, source, performance, or memory evidence without changing the AX
baseline contract.
