# Mobile semantic QA runtime

OpenSafari's mobile QA direction follows the SSOT in issue #795: portable MCP-native contracts, semantic actions over raw taps/relaunches, structured failures, and compact debugging evidence.

## State snapshot before action

Use `app_state_snapshot` when an agent needs to decide what to do next without mutating app state. The tool is read-only and reports:

- foreground/context classification and confidence
- expected bundle match
- visible AX summary and screen fingerprint
- Flutter VM connection and route hints when connected
- best-effort WebView hints
- recovery hints such as `app_switch_app`, `app_wait_for`, or `debug_bundle_collect`

Do not use a relaunch/reset as the first recovery step. If the snapshot is unknown or transitional, wait for a postcondition or collect a debug bundle before destructive recovery.

## Shared settle policy

High-level semantic actions should separate transport success from app-state success. A tap, deeplink, or text injection is only successful when its postcondition is met and, when requested, stable for `stableMs`.

The shared settle policy accepts AX query fields (`identifier`, `label`, `text`, `role`), condition (`exists`, `not_exists`, `visible`, `enabled`), `timeoutMs`, `intervalMs`, and `stableMs`.

## Semantic navigation

`app_goto_screen` now records state before/after, uses an already-on-target check when `waitFor` is supplied, dispatches deeplink navigation, and returns strategy/attempt/verification evidence. Relaunch/reset remains explicit opt-in work for higher-level callers and must not be treated as default navigation.

## Flutter selector quality

`qa_flutter_semantics` includes `selector_quality` by default. The report flags fragile automation selectors:

- missing `Semantics(identifier: ...)` on interactive widgets
- duplicate identifiers
- duplicate labels
- label-only selectors that may break across locales
- missing role/trait hints

Labels are still valuable for accessibility. The audit classifies risk for automation; it does not require removing human-readable labels.

## Deterministic Flutter VM attach

`flutter_connect` reports attach diagnostics that distinguish explicit URL, environment overrides, cached URL, fixed-port attempts, and log-scan fallback. For fast debug/profile QA sessions, prefer an explicit VM Service URL when available. Fixed-port mode can be used when the app is launched externally with a known VM service port and auth code.

Release builds generally do not expose VM Service and should use native AX semantics plus selector-quality audits.

## Scenario runner v2

`run_scenario` accepts `version: 2` for currently implemented mobile semantic steps: `recordState`, `launchApp`, `gotoScreen`, `tapElement`, `typeElement`, `waitFor`, `assertElement`, and `collectDebugBundle`. V2 results include per-device state, backend hint, verification, timing, and partial-failure data. Existing v1 browser scenarios remain compatible. V2 starts from the current simulator state by design; use an explicit `launchApp` step only when a scenario needs to foreground an app.

## Follow-up runtime contracts after PR #828

Semantic navigation is now controller-shaped: every strategy records an attempt,
skipped reason, selected strategy, verification evidence, and recovery hint. A
transport dispatch (`simctl openurl`, native tap, text injection, route mutation)
is never success without a route or AX postcondition.

Shared settle policies are available to high-level interaction and scenario
steps. `app_tap_element` and `app_type_element` preserve their historical behavior
when no `settle` object is supplied; when `settle.query` is supplied, the response
includes settle evidence and failed postconditions become tool errors.

Scenario v2 is stateful-by-default. Use explicit `launchApp` only when a scenario
requires a fresh foreground app. Otherwise, start from current state with
`recordState`, `gotoScreen`, `waitFor`, `tapElement`, `typeElement`, `popUntil`,
`dismissOverlay`, and `collectDebugBundle` steps. `gotoScreen` requires `query`,
`settle.query`, or a Flutter route target and cannot pass from deeplink dispatch
alone.

Flutter selector quality remains AX-first and release-compatible. When Flutter VM
is attached, findings may include best-effort route/widget/source hints; VM
absence is reported as data, not failure.
