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
