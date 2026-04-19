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
- **Output:** `{ handled: true, buttonLabel?, action?, deviceId, method, _meta }`
- **Errors:**
  - `DEVICE_NOT_BOOTED` — No booted simulator found.
  - `MISSING_PARAMS` — Neither `action` nor `buttonLabel`/`buttonLabels` provided.
  - `INVALID_ACTION` — `action` is not `"accept"` or `"dismiss"`.
  - `NO_MATCHING_BUTTON` — None of the supplied labels matched a visible button; the error payload includes `visibleLabels` listing what was found.
  - `ALERT_HANDLE_FAILED` — Key send or AX press failed.
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
  - For non-English simulators, build the candidate list with `resolveLocalizedButtonLabels` from `src/native/localized-button-matcher.ts` or seed it from `src/native/system-button-catalog.ts`.
  - For StoreKit / In-App Purchase QA see [StoreKit Automation Guide](storekit-automation.md).

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
