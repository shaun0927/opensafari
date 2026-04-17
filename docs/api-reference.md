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

#### app_reset
Reset app state: terminate, reset privacy permissions, uninstall. The app must be reinstalled after reset.
- **Input:** `{ bundleId: string, deviceId?: string }`
- **Output:** `{ reset: boolean, bundleId, deviceId, steps: string[] }`
- **Steps:** `terminated` → `privacy_reset` → `uninstalled` (each step proceeds independently)

#### app_webview_connect
Detect WebView targets inside a running native app and list available ones.
- **Input:** `{ bundleId?: string, deviceId?: string }`
- **Output:** `{ deviceId, targets: [{ id, title, url, type, classificationReason }], count }`
- **`classificationReason`** values: `bundle_match` | `proxy_type` | `url_scheme`
  - `bundle_match` — target matched via `bundleId` parameter (metadata fields or title/url substring). When `bundleId` is provided, HTTPS WebViews such as payment-return pages or OAuth callbacks are promoted from `safari` to `webview` classification via this reason.
  - `proxy_type` — proxy-supplied `type` field on the target determined classification (e.g. `type: 'WebView'` overrides URL-scheme heuristics).
  - `url_scheme` — fallback heuristic: non-http(s) schemes → `webview`; http(s) or empty/about:blank → `safari`.

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
