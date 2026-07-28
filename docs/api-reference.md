# OpenSafari API Reference

## MCP Tools

### Core Tools (Tier 1)

#### navigate
Navigate to a URL in real Safari on iOS Simulator.
- **Input:** `{ url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }`
- **Output:** `{ url, status, loadTime }`

#### screenshot
Capture real Safari screen via WebKit Protocol.
- **Input:** `{ format?: 'png', fullPage?: boolean }`
- **Output:** Base64 encoded image

#### javascript
Execute JavaScript in page context via Runtime.evaluate.
- **Input:** `{ expression: string }`
- **Output:** Evaluation result

#### read_page
Extract visible text content from the page.
- **Input:** `{}`
- **Output:** Page text

#### click
Tap element by CSS selector or coordinates.
- **Input:** `{ selector?: string, x?: number, y?: number }`

#### type
Type text into input field.
- **Input:** `{ selector: string, text: string, delay?: number }`

#### scroll
Scroll page in direction.
- **Input:** `{ direction: 'up'|'down'|'left'|'right', amount: number }`

#### query_dom
Query DOM element with details.
- **Input:** `{ selector: string }`
- **Output:** `{ tag, text, attributes, boundingBox, computedStyles, isVisible }`

#### cookies
Get/set/clear Safari cookies (WebKit Page domain).
- **Input:** `{ action: 'get'|'set'|'clear', cookies?: Cookie[], domain?: string }`

#### device_boot
Boot a simulator device.
- **Input:** `{ device: string }` (preset key like 'iphone-17')

#### device_shutdown
Shutdown a simulator.
- **Input:** `{ deviceId?: string }`

### App Lifecycle Tools (Tier 2)

#### app_launch
Launch an app by bundle identifier on a booted iOS Simulator.
- **Input:** `{ bundleId: string, deviceId?: string, args?: string[], env?: Record<string, string> }`
- **Output:** `{ pid, bundleId, deviceId }`
- **Errors:** `APP_NOT_INSTALLED` if bundle ID not found, `DEVICE_NOT_BOOTED` if no booted simulator

#### app_terminate
Terminate a running app by bundle identifier.
- **Input:** `{ bundleId: string, deviceId?: string }`
- **Output:** `{ terminated: boolean, bundleId, deviceId }`
- **Errors:** `APP_NOT_INSTALLED` if bundle ID not found

#### app_activate
Bring an app to the foreground. Launches the app if not already running.
- **Input:** `{ bundleId: string, deviceId?: string }`
- **Output:** `{ activated: boolean, bundleId, deviceId }`

#### app_list_running
List running foreground apps (UIKit) with bundle IDs and PIDs.
- **Input:** `{ deviceId?: string }`
- **Output:** `{ deviceId, apps: [{ label, pid }], count }`

#### app_context
Report the current mobile context for a booted simulator using accessibility-tree heuristics plus the running-app list.
- **Input:** `{ deviceId?: string, expectedBundle?: string, requireMatch?: boolean, maxDepth?: number }`
- **Output:** `{ deviceId, surface, contextVerified, inferredBundleId?, expectedBundle?, expectedBundleMatch?, expectedBundleMatchConfidence?, reason, warnings, runningApps, visibleSummary }`
- **Errors:** `EXPECTED_BUNDLE_MISMATCH` when `requireMatch=true` and the expected bundle cannot be matched

#### app_testflight_iap_snapshot
Read-only TestFlight/IAP state snapshot that composes the current app state, installed-app hints, visible AX classifier signals, safe recovery hints, and optional debug-bundle path references. It never taps, types credentials, installs/updates apps, confirms purchases, or calls App Store Connect.
- **Input:** `{ deviceId?: string, expectedAppBundleId?: string, testflightBundleId?: string, includeEvidence?: boolean, maxVisibleNodes?: number, maxDepth?: number }`
  - `testflightBundleId` defaults to `com.apple.TestFlight`.
  - `includeEvidence` defaults to `false`; when `true`, the response attaches only a compact `debugBundle` reference/summary (paths, counts, redaction metadata), not raw logs.
- **Output:** `{ schemaVersion, collectedAt, device, expectedAppBundleId?, testflightBundleId, installedApps, foreground, classifier, recoveryHints, debugBundle?, redactions }`
  - `classifier` is the merged TestFlight/IAP classifier result (`phase`, `blocker`, `confidence`, `reason`, `nextSafeAction`, `matchedSignals`).
  - `recoveryHints` are limited to safe follow-ups: `app_alert_handle`, `app_activate`, and `debug_bundle_collect`; the snapshot itself is non-mutating.
- **Errors:** Structured MCP error envelopes such as `DEVICE_NOT_BOOTED` or `APP_STATE_UNKNOWN`. Password/token-like visible text is redacted from diagnostics.

#### app_tap
Tap at screen coordinates in the simulator.
- **Input:** `{ x: number, y: number, duration?: number, deviceId?: string, expectedBundle?: string, verifyContext?: boolean, settleMs?: number, raw?: boolean, requireInApp?: boolean, autoReactivate?: boolean, snapRadiusPx?: number, homeIndicatorGuardPx?: number }`
- **Output:** `{ status: "tapped", x, y, duration, deviceId, backend, verified?, effect?, sideEffect, foregroundBefore, foregroundAfter, snapped?, _meta, postInputContext?, warning? }`
- **Notes:** When `verifyContext=true` or `expectedBundle` is supplied, the tool waits `settleMs` (default 1200 ms) and attaches a post-input context probe.
  - `verified: false` + `effect: "verification_unavailable"` means transport succeeded but OpenSafari could not prove a UI change.
  - `TAP_NO_EFFECT` means the tap was dispatched and the post-action AX tree stayed unchanged.
- **Safety layer (issue [#644](https://github.com/shaun0927/opensafari/issues/644)):**
  - `sideEffect` is always reported: `"none"`, `"out_of_bounds"`, `"ax_snapped"`, or `"app_backgrounded"`.
  - Raw coordinates outside the device frame, or inside the bottom `homeIndicatorGuardPx` (default 10) guard band, are rejected with `TAP_OUT_OF_BOUNDS` (`sideEffect: "out_of_bounds"`, `dispatched: false`). This prevents raw taps near the bottom edge from being reinterpreted as home-gesture swipes.
  - By default (`raw !== true`) the tool scans the pre-tap AX tree for modals (`AXSheet` / `AXDialog` / `AXAlert` / `AXSystemDialog`) and snaps the input coordinate onto the closest enabled `AXButton` centre within `snapRadiusPx` (default 24). The snapped target is invoked via the AX press path; `snapped = { from, to, elementPath, via }` is attached to the response. Pass `raw: true` to disable the snap.
  - When `requireInApp` is `true` (default) and the pre-tap AX surface was the target app but the post-tap surface is SpringBoard or Simulator chrome, the response returns `APP_BACKGROUNDED` (`sideEffect: "app_backgrounded"`, `isError: true`). Set `requireInApp: false` to downgrade this to a warning while still reporting the side effect.
  - Set `autoReactivate: true` to automatically call `simctl launch <deviceId> <expectedBundle>` on detected background transitions; the response records `recovered: true/false`. Requires `expectedBundle` to be supplied.

#### app_swipe_native
Perform a swipe gesture on the simulator.
- **Input:** `{ direction: "up"|"down"|"left"|"right", startX?: number, startY?: number, distance?: number, duration?: number, deviceId?: string, expectedBundle?: string, verifyContext?: boolean, settleMs?: number }`
- **Output:** `{ status: "swiped", from, to, distance, duration, deviceId, backend, _meta, postInputContext?, warning? }`
- **Notes:** When `verifyContext=true` or `expectedBundle` is supplied, the tool waits `settleMs` (default 1200 ms) and attaches a post-input context probe.
- **Raw CLI:** For driving the same diagnostics without MCP — via the `dist/sim-hid-bridge` wrapper — see the full CLI, wrapper flags, response shape, and classification table in [headless-architecture.md § Raw SimHID CLI reference](headless-architecture.md#raw-simhid-cli-reference).

#### app_reset
Reset app state: terminate, reset privacy permissions, uninstall. The app must be reinstalled after reset.
- **Input:** `{ bundleId: string, deviceId?: string }`
- **Output:** `{ reset: boolean, bundleId, deviceId, steps: string[] }`
- **Steps:** `terminated` → `privacy_reset` → `uninstalled` (each step proceeds independently)

#### app_webview_connect
Detect WebView targets inside a running native iOS app and list available ones. Classifies each target as `safari` vs `webview` and surfaces a `classificationReason` for debuggability. Uses ios-webkit-debug-proxy to enumerate all open debugging targets on the device.

- **Input:**
  - `bundleId?: string` — Optional. When provided, targets whose proxy-supplied metadata (`appId`, `bundleId`, or `app_id` fields) matches the value, or whose `title`/`url` contains it as a substring, are promoted to `webview` via the `bundle_match` rule. The result list is then restricted to those bundle-matched WebViews.
  - `deviceId?: string` — Optional simulator UDID. Defaults to the active device when omitted.
- **Output:**
  ```json
  {
    "deviceId": "string",
    "targets": [
      {
        "id": "string",
        "title": "string",
        "url": "string",
        "type": "safari | webview",
        "classificationReason": "bundle_match | proxy_type | url_scheme"
      }
    ],
    "count": "number"
  }
  ```
- **Classification priority** (first match wins):
  1. `bundle_match` — `bundleId` argument matches the target's proxy metadata or appears as a substring in the `title`/`url`. Classifies the target as `webview`. HTTPS WebViews such as payment-return pages or OAuth callbacks are promoted via this rule when `bundleId` is supplied.
  2. `proxy_type` — proxy emits a `type` field: `safari`/`mobilesafari` → `safari`; any value containing `webview` → `webview`.
  3. `url_scheme` (fallback) — empty URL or `about:blank` → `safari`; non-`http(s)` scheme → `webview`; `http(s)` → `safari`.
- **Notes:**
  - `webSocketDebuggerUrl` is intentionally stripped from the response. Use `set_active_context` with the returned `id` to switch into a WebView target.
  - See also: `set_active_context`.

#### app_alert_handle
Accept, dismiss, or press a named button on a system alert/dialog on a booted iOS Simulator.

- **Input:**
  - `action?: 'accept' | 'dismiss'` — Accept (Return key) or dismiss (Escape key) the alert. Used only when no `buttonLabel`/`buttonLabels` is provided.
  - `buttonLabel?: string` — Exact button label to press (case-insensitive, trimmed). Walks the front-most alert's accessibility tree and invokes `AXPress` on the first match. Takes precedence over `action`.
  - `buttonLabels?: string[]` — Ordered list of candidate labels tried in priority order; the first match is pressed. Takes precedence over `buttonLabel` and `action`. Useful for multi-locale support.
  - `deviceId?: string` — Simulator UDID. Falls back to the active device if omitted.
- **Output:** `{ handled: true, buttonLabel?, action?, deviceId, method, verified?, effect?, _meta }`
- **Errors:**
  - `DEVICE_NOT_BOOTED` — No booted simulator found.
  - `MISSING_PARAMS` — Neither `action` nor `buttonLabel`/`buttonLabels` provided.
  - `INVALID_ACTION` — `action` is not `"accept"` or `"dismiss"`.
  - `NO_MATCHING_BUTTON` — None of the supplied labels matched a visible button; the error payload includes `visibleLabels` listing what was found.
  - `ALERT_HANDLE_FAILED` — Key send or AX press failed.
  - `ALERT_HANDLE_NO_EFFECT` — A button press was dispatched but the same alert stayed visible, so OpenSafari could not confirm dismissal/transition.
- **Examples:**
  ```json
  // Keyboard fallback — accept the default button
  { "action": "accept" }

  // Press a specific button by label (StoreKit, permission sheet, etc.)
  { "buttonLabel": "Allow While Using App" }

  // Multi-locale: try the localized label first, then English fallback
  { "buttonLabels": ["앱을 사용하는 동안 허용", "Allow While Using App"] }
  ```
- **Notes:**
  - The `buttonLabel`/`buttonLabels` path uses macOS `AXUIElement` accessibility API (`ax-bridge`) — it works on StoreKit password sheets, 3-button permission dialogs, and any alert where the default button is not the accept action.
  - `_meta._telemetry[0].backend` is `"ax-press"` on the label path and the backend kind (e.g. `"simctl"`) on the keyboard path.
  - Successful responses carry `verified: true` only when the alert subtree changes after the press. If the same alert remains visible, the tool returns `ALERT_HANDLE_NO_EFFECT` instead of a plain success.
  - For non-English simulators, build the candidate list with `resolveLocalizedButtonLabels` from `src/native/localized-button-matcher.ts` or seed it from `src/native/system-button-catalog.ts`.
  - For StoreKit / In-App Purchase QA see [StoreKit Automation Guide](storekit-automation.md).

#### app_handle_alert
Accept or dismiss the currently visible simulator alert using a locale-aware detector (en / ko / ja / zh-Hans) with AppleScript fallback. Unlike `app_alert_handle`, this tool does not take explicit button labels — it infers the correct button from the AX tree + built-in label corpus and is designed for permission prompts and iOS 26 full-screen modals.
- **Input:**
  - `action: 'accept' | 'dismiss'` — Accept or dismiss the dialog.
  - `deviceId?: string` — Simulator UDID (active device if omitted).
  - `fallback?: 'permission_reset' | 'none'` — When Tier 1 (AX-scan) and Tier 2 (AppleScript) both miss the dialog, opt in to `xcrun simctl privacy <udid> reset <service>` with a service inferred from `visibleStaticTexts`. Default `'none'`.
  - `dryRun?: boolean` — When `fallback='permission_reset'`, report the `simctl` command that would run without executing it. Default `false`.
- **Output fields (always present):**
  - `dismissed: boolean` — Whether the dialog was confirmed gone.
  - `strategy: 'ax-scan' | 'applescript-sheet' | 'permission-reset' | 'none'` — Which tier succeeded.
  - `strategy_attempted: string[]` — Ordered list of tiers tried.
  - `matchedButton?: string` — Label of the button that was pressed (ax-scan only).
  - `reason: 'ok' | 'no_candidate_button' | 'ax_scan_timeout' | ...` — Closed enum from `src/errors/alert-reasons.ts`.
  - `surface: 'simulator_chrome' | 'system_dialog_unknown' | 'app_content'` — Inferred post-call context.
  - `visibleButtons: string[]`, `visibleStaticTexts: string[]` — Raw AX diagnostics.
  - `suggestedLabelsToAdd: string[]` — Labels observed in the tree but missing from the corpus — use this to file a one-PR corpus update when a new locale or dialog shows up.
  - `fallbackAvailable: string[]` — Recovery options (e.g. `"permission_reset"`, `"simulator_reboot"`).
  - `elapsedMs: number`, `handledAt: string` (ISO).
- **Tiers:**
  1. AX-scan — dumps the native AX tree and presses the best matching button via `AXPress`.
  2. AppleScript fallback — clicks a button labeled from the full corpus inside `sheet 1 of window 1`.
  3. `permission_reset` (opt-in) — when both tiers fail and `fallback='permission_reset'`, the tool infers a permission service (`location`, `photos`, `contacts`, `notifications`, `tracking`, `camera`, `microphone`, `bluetooth`, `calendars`, `reminders`) from `visibleStaticTexts` and runs `xcrun simctl privacy <udid> reset <service>`. If two or more services match, the response is `reason: 'permission_reset_ambiguous'` and no command is executed; if none match, `reason: 'permission_reset_unknown_service'`.
- **Additional output when Tier 3 runs:** `permissionReset: { service, servicesConsidered, executed, dryRun, command?, error? }`.
- **Use when:** a system permission prompt (location, photos, ATT, etc.) blocks automation and you do not know the exact locale-specific label. Opt in to `fallback: 'permission_reset'` as a recovery option when the dialog itself cannot be detected. Use `app_alert_handle` instead when you want to press a specific in-app button by label.

#### app_open_url

Open a URL or deep link on an iOS Simulator via `xcrun simctl openurl`. Routes to the appropriate app handler (e.g. Safari for `https://`, or a custom scheme like `myapp://`).

- **Input:**
  - `url: string` — URL or deep link to open (required).
  - `deviceId?: string` — Simulator UDID. Uses active device if omitted.
  - `captureLogs?: object` — If provided, synchronously captures `os_log` entries around the URL-open event and returns them in `result.logs`. See [`captureLogs` parameters](#capturelogs-parameters) below.
- **Output:** `{ url, deviceId, openedAt, logs? }`
  - `logs` is present only when `captureLogs` is supplied; shape is the [`captureLogs` response](#capturelogs-response).

#### app_deeplink

Open deep links or Universal Links in the iOS Simulator. Supports custom URL schemes (`myapp://path`) and Universal Links (`https://…`).

- **Input:**
  - `url: string` — Deep link URL (required). Must include a scheme (`://`).
  - `deviceId?: string` — Simulator UDID. Uses active device if omitted.
  - `captureLogs?: object` — If provided, synchronously captures `os_log` entries around the deep-link open. See [`captureLogs` parameters](#capturelogs-parameters) below.
- **Output:** `{ url, deviceId, openedAt, logs? }`
  - `logs` is present only when `captureLogs` is supplied; shape is the [`captureLogs` response](#capturelogs-response).

#### `captureLogs` parameters

Both `app_open_url` and `app_deeplink` accept an optional `captureLogs` object. All fields are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `bundleId` | `string` | — | `os_log` process filter (`process == <bundleId>`). |
| `level` | `'default' \| 'info' \| 'debug' \| 'error' \| 'fault'` | — | Minimum message severity. |
| `search` | `string` | — | Substring filter applied to the composed message. |
| `prerollMs` | `number` | `2000` | How far back to pull logs relative to the URL-open timestamp. |
| `silenceMs` | `number` | `1500` | Stop collecting once this many ms elapse with no new matching entry. |
| `maxDurationMs` | `number` | `8000` | Hard upper bound on the collection window. |

#### `captureLogs` response

When `captureLogs` is supplied the tool appends a `logs` field to its response:

```jsonc
{
  "entries": [ /* unified-log JSON objects from `log show --style json` */ ],
  "windowStart": "2026-04-27T10:00:00.000Z",  // ISO-8601 start of log query window
  "windowEnd":   "2026-04-27T10:00:08.000Z",  // ISO-8601 end of collection
  "truncated": false,                           // always false (reserved)
  "stopReason": "silence"                       // "silence" | "max_duration"
}
```

On error the `logs` field is instead:

```jsonc
{
  "error": "<message>",
  "stopReason": "error",
  "windowStart": "...",
  "windowEnd": "..."
}
```

See [docs/recipes/universal-link-channels.md](recipes/universal-link-channels.md) for end-to-end usage examples.

#### app_notes_paste_and_tap_url

Reviewer-equivalent Universal Link tap via Notes.app. Launches Notes (`com.apple.mobilenotes`), paste-injects the URL into the note body, waits for iOS Data Detector to produce an `AXLink`, and taps it. Use this instead of `app_open_url` when Apple-review parity matters.

- **Input:**
  - `url: string` — Universal Link or HTTPS URL to paste (required). Must include `://`.
  - `deviceId?: string` — Simulator UDID. Uses active device if omitted.
  - `settleMs?: number` — Ms to wait after paste before scanning for the detected link. Default: `500`.
  - `focusTimeoutMs?: number` — Max ms to wait for the Notes editor to be AX-queryable. Default: `4000`.
  - `linkTapTimeoutMs?: number` — Max ms to wait for iOS Data Detector to expose an `AXLink`. Default: `4000`.
  - `restorePasteboard?: boolean` — Restore the simulator pasteboard after paste. Default: `true`.
- **Output:**
  ```jsonc
  {
    "url": "https://example.com/detail/abc",
    "deviceId": "...",
    "notesLaunchedAt": "2026-04-27T10:00:00.000Z",
    "linkTappedAt":    "2026-04-27T10:00:02.500Z",
    "linkElement": { "path": "0/1/3", "label": "example.com/detail/abc" },
    "durationMs": 2500
  }
  ```
- **Errors:** Thrown as `{ error: string }` with `isError: true` when Notes editor never becomes queryable, Data Detector produces no link within `linkTapTimeoutMs`, or the `AXPress` on the link fails.
- **Notes:** See [docs/recipes/universal-link-channels.md](recipes/universal-link-channels.md) for the full channel comparison and recommended close-gate flow.

#### device_network_set

Toggle the iOS Simulator host-level network state so native apps (Flutter, UIKit) see real `SocketException` / `NSURLErrorNotConnectedToInternet`. Unlike `network_offline` (WebKit-only), this targets `URLSession` and `dart:io HttpClient` traffic.

Requires one-time host setup (passwordless sudoers + `/etc/pf.conf` anchor). See [docs/tools/device-network.md](tools/device-network.md).

- **Input:**
  - `mode: 'online' | 'offline' | 'airplane'` — Target network state (required). `"offline"` and `"airplane"` share a code path; `"online"` restores connectivity and is idempotent.
  - `udid?: string` — Device UDID. Defaults to the sole booted simulator.
  - `mechanism?: 'pfctl' | 'nlc' | 'auto'` — Blocking mechanism. `"auto"` selects `pfctl` when elevated privileges are configured, otherwise falls back to Network Link Conditioner. Default: `"auto"`.
- **Output (success):**
  ```jsonc
  {
    "ok": true,
    "deviceId": "...",
    "mode": "offline",
    "mechanism": "pfctl",   // resolved mechanism, or null when going online
    "appliedAt": "2026-04-27T10:00:00.000Z",
    "previousMode": "online"
  }
  ```
- **Errors:** `{ ok: false, error: string, ... }` with `isError: true` for `invalid_mode`, `invalid_mechanism`, `udid_not_booted`, `no_booted_device`, `ambiguous_device`, `mechanism_conflict`, and blocker failures.

#### device_network_get

Read the current simulated network state set by `device_network_set`. Returns the last-applied mode and mechanism for a given device.

- **Input:**
  - `udid?: string` — Device UDID. Defaults to the sole booted simulator.
- **Output:**
  ```jsonc
  {
    "ok": true,
    "deviceId": "...",
    "mode": "offline",       // "online" | "offline" | "airplane"
    "mechanism": "pfctl",    // "pfctl" | "nlc" | null
    "activeSince": "2026-04-27T10:00:00.000Z"  // null when mode is "online"
  }
  ```

### Advanced Tools (Tier 2)

inspect, wait_for, long_press, swipe, press, dismiss_keyboard, select_option, device_list, device_rotate, appearance_toggle

### Batch & Orchestration (Tier 3)

batch_navigate, batch_screenshot, batch_execute, cross_viewport_compare, workflow_init, workflow_status, workflow_collect, workflow_collect_partial, workflow_cleanup, worker_update, worker_complete

### QA Detectors (Tier 3)

qa_auto_zoom, qa_touch_targets, qa_hover_only, qa_input_type, qa_safe_area, qa_keyboard_overlap, qa_horizontal_overflow, qa_100vh, qa_fixed_stacking, qa_scroll_lock, qa_dark_mode, qa_orientation, qa_pwa_meta, qa_full_audit

#### qa_full_audit

Run all 13 iOS QA detectors and generate a scored report.

- **Input:**
  - `url?: string` — URL to audit (uses current page if omitted)
  - `format?: 'markdown' | 'junit' | 'json' | 'html'` — Report format (default: `markdown`)
    - `markdown` — Human-readable Markdown summary (default)
    - `junit` — JUnit XML for CI systems (GitHub Actions, Jenkins, CircleCI)
    - `json` — Structured JSON for programmatic processing or dashboards
    - `html` — Self-contained HTML report saved to disk; returns the file path
  - `annotate?: boolean` — Overlay issue bounding boxes on a screenshot (default: `false`, `markdown` format only)
- **Output:** Report content as text (or file path for `html` format)
- **CI usage:** See [CI/CD Integration](ci-integration.md) for example GitHub Actions workflows, exit code gating, and Jenkins/CircleCI examples.

## Claude Code Configuration

```json
{
  "mcpServers": {
    "opensafari": {
      "command": "opensafari",
      "args": ["serve"]
    }
  }
}
```
