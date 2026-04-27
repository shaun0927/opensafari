# ADR-0002 — Safari "Open in App" Smart App Banner automation on iOS Simulator

## Status

**No-Go.** OpenSafari will not ship a `waitForSmartBanner` option for
`app_open_url` (or any other tool) at this time. The Notes
paste-and-tap helper (`app_notes_paste_and_tap_url`, already landed)
remains the recommended close-gate channel for Universal Link
verification on Simulator.

This decision can be revisited if (a) the WebKit Remote Debug Protocol
becomes available against Safari's chrome — not just inspected pages —
or (b) the Swift `ax-bridge-native` walker is extended to enumerate
SpringBoard's window hierarchy (tracked separately in #660), at which
point the SpringBoard-hosted "◀ AppName" return pill becomes a
deterministic AX target.

## Context

Issue #667 (split out of #641 T3) asked whether OpenSafari can
deterministically wait for and tap Safari's "Open in App" Smart App
Banner on iOS 26 Simulator, and if so what the right contract for an
`app_open_url { waitForSmartBanner: true }` option would be. Apple
reviewers treat a Smart App Banner tap as a reviewer-equivalent
Universal Link tap, whereas `xcrun simctl openurl` is not accepted as
equivalent — so a working banner-tap path would unblock close-gate
evidence on the consumer side that today depends on the indirect
Notes paste-and-tap channel.

## Decision

**No-Go.** The empirical spike (below) shows that none of the three
candidate channels — WebKit DOM, native AX tree, screen-coordinate
tap — reaches the banner deterministically in OpenSafari's current
Simulator harness. The two affordances that *do* exist (the SpringBoard
"◀ AppName" return pill and the in-page HTML banner the site itself
renders) are either out-of-tree or site-specific.

## Empirical findings

The spike was run on:

- Host: macOS Apple Silicon
- Simulator: `iPhone 17 Pro` (UDID
  `D7D26213-C3E9-4623-BCCB-984CDF5D0793`), `iOS 26.4`
- Locale: `ko-KR`
- Target site: `https://omofictions.com/` (apex with
  `applinks:omofictions.com` association + 200 +
  `application/json` apple-app-site-association on
  `/.well-known/apple-app-site-association`)
- Installed app under test: `com.omofictions.omofictionsApp` (Flutter
  release/QA build)
- OpenSafari MCP: live install, post-#658/#659 merge

### Channel (a) — WebKit DOM (`read_page`, `query_dom`)

**Not available in the standard automation context.** The WebKit
Remote Debug Protocol bridge (`ios_webkit_debug_proxy` + Safari →
*Settings → Advanced → Web Inspector* enabled inside the Simulator)
must be running for `mcp__opensafari__navigate`, `read_page`, and
`query_dom` to succeed. In a fresh Simulator boot the protocol is
**not** running, and turning it on is itself a manual step (it can be
toggled per-Simulator via Settings, but is not provisioned by
`simctl boot`).

Even when the proxy is running, the `apple-itunes-app` meta-tag-driven
banner is rendered as Safari chrome **above** the inspected `<iframe>`
or the document root, which means it is unlikely to appear in the
DOM tree the WebKit Inspector returns. (We did not get to verify this
last point because the prerequisite proxy was not bootstrapped in the
spike environment; this is an additional reason to mark the channel
unreliable rather than the load-bearing one.)

For close-gate automation, requiring the user to enable Web Inspector
and start a proxy before every test run is a non-starter.

### Channel (b) — Native accessibility tree (`app_tree`, `app_query`)

**Does not see the banner.** With Safari foreground and the
`omofictions.com` page loaded, `mcp__opensafari__app_tree
{max_depth:4}` returned only Safari's chrome:

```text
0  AXButton  PageFormatMenuButton    "페이지 메뉴"
1  AXTextField  TabBarItemTitle      "주소" / value: "omofictions.com"
2  AXButton  ReloadButton            "새로 고침"
3  AXButton  BackButton              "뒤로"
4  AXButton  ForwardButton           "앞으로"
5  AXButton  ShareButton             "공유"
6  AXButton  SidebarButton           "북마크 보기"
7  AXButton  TabOverviewButton       "탭"
```

Page content is not in this tree at all (Safari renders WKWebView
content via a CALayer/RemoteLayerHost surface that does not bridge
into the macOS-side AX hierarchy that `ax-bridge-native` walks).

Critically, the iOS-rendered **"◀ Omofictions App"** return pill
visible in the top-left of the status bar of the post-navigation
screenshot (see "Screenshot evidence" below) is **also** absent from
the AX tree. That pill is hosted by SpringBoard, not Safari, so it
does not appear in Safari's AX subtree even though it is on screen.
Reaching it would require the SpringBoard explicit-walk fix tracked in
#660, and even after that fix the pill is the *return-to-app*
affordance, not the Smart App Banner.

### Channel (c) — Screen-coordinate tap

**Possible but non-deterministic.** Both the SpringBoard return pill
and any future Smart App Banner would have to be addressed by
`mcp__opensafari__app_tap {x, y}` against fixed coordinates. The
banner's absolute position depends on:

- Status bar height (varies by Dynamic Island vs notch device class)
- Smart Banner being shown vs collapsed (Safari sometimes auto-hides
  it on subsequent visits)
- iOS appearance setting (light vs dark mode shifts the banner
  background but not size)

For close-gate evidence — where Apple's reviewers expect a clean tap
on the canonical banner — a coordinate tap with a 5-pixel tolerance
that *might* land on a different UI element on a different device
class is not acceptable.

### Banner presentation timing — first-visit vs subsequent

**Did not observe the standard Smart App Banner at all.** The first
navigation to `https://omofictions.com/` via
`mcp__opensafari__app_open_url` (which routes through `xcrun simctl
openurl com.apple.mobilesafari https://...`) produced the page but
**no** Smart App Banner header overlay. Instead:

1. SpringBoard rendered the **"◀ Omofictions App"** return pill in the
   top-left status bar. This is iOS's "back to the app you came from"
   affordance — distinct from the Smart App Banner. It is reachable
   only via SpringBoard AX (out of scope, see #660) or coordinate tap
   (non-deterministic).
2. The omofictions.com site itself rendered an **HTML/CSS in-page
   banner** at the bottom of the viewport reading
   "First 3 episodes are free on OmO!". This is *site-rendered*, not
   *Apple-rendered*, so its DOM/AX behaviour is governed by the site
   and unrelated to the Smart App Banner contract.

The banner contract Apple documents — `<meta name="apple-itunes-app">`
header overlay rendered by Safari above the document — was either
not configured by `omofictions.com` or auto-suppressed by Safari for
the navigation source (`simctl openurl` may signal "non-user-initiated
navigation" in a way that suppresses the banner; we did not
characterise this further because the higher-priority finding above
already fails the No-Go gate).

### Screenshot evidence

`mcp__opensafari__app_screenshot_native` after the navigation
(captured 2026-04-27T02:58:12Z) shows:

- Status bar: `9:41` left of the Dynamic Island, **"◀ Omofictions
  App"** below the time. SpringBoard-hosted; not in Safari AX tree.
- Page body: omofictions.com landing page — "OmO" wordmark, hero
  carousel "The Northern Grand Duke's Hamster", category tags,
  episode grid.
- Bottom overlay: site-rendered "First 3 episodes are free on OmO!"
  banner with a close (×) affordance.
- Bottom Safari chrome: tabbed-mode address bar reading
  `omofictions.com`, reload, back, forward, share, bookmarks, tabs.

No Apple-rendered Smart App Banner overlay between the status bar and
the page header at any point during the spike.

## Consequences

### What this means for the close-gate channel

The recommended channel for App Review close-gate evidence on
Simulator remains the **Notes paste-and-tap helper**
(`app_notes_paste_and_tap_url`) shipped under #641 T1. That tool:

- Pastes the URL into Notes via `typeViaPasteboard`
- Waits for iOS Data Detector to produce an `AXLink` element
- Taps the detected element via `getAccessibilityBridge().press(...)`
- Resolves into the installed app via Universal Link routing

Notes-detected `AXLink` taps *are* AX-deterministic and are accepted
by the iOS UL routing layer, so this channel produces evidence Apple
reviewers can cross-check.

### What this means for `app_open_url`

`mcp__opensafari__app_open_url` retains its current contract: it
delegates to `xcrun simctl openurl`, which Apple reviewers do **not**
treat as a user-initiated UL tap. We will document this limitation
explicitly in `docs/recipes/universal-link-channels.md` so consumers
can choose the right tool for their evidence requirements.

### When to revisit

This decision should be reopened if any of the following becomes true:

1. **WebKit Remote Debug Protocol becomes always-on for Safari
   chrome.** Today the protocol attaches to inspected pages, not
   Safari's own UI. If a future Simulator runtime exposes the chrome
   itself as a debuggable target, the Smart App Banner becomes a
   first-class DOM element and channel (a) becomes deterministic.
2. **`ax-bridge-native` enumerates SpringBoard.** The work tracked in
   #660 (PR C — SpringBoard explicit AXApplication union walk) makes
   the **"◀ AppName"** return pill addressable as an AX node. That is
   not the Smart App Banner, but it provides an equivalent
   deterministic Universal Link affordance for sites that don't render
   their own in-page banner.
3. **Apple ships a deterministic banner identifier.** If a future iOS
   release adds an accessibility identifier to the Smart App Banner
   (e.g. `SmartAppBannerBuyButton`), it would become reachable via
   Safari's existing AX tree without any of the changes above.

## Alternatives considered

### Coordinate tap with iOS device-class lookup

We considered shipping `waitForSmartBanner` as a coordinate-tap
implementation that consults a per-device-class lookup table for the
banner's expected y-offset. Rejected because:

- The lookup table grows with every new iOS-version × device-class
  combination, becoming a maintenance liability.
- Banner visibility itself is non-deterministic (auto-hides on
  subsequent visits within a session), so even a correct coordinate
  can land on the page below the banner instead of the banner itself.
- Apple reviewers may flag the resulting tap as non-user-initiated if
  the response timing differs from a real touch.

### Synthesise a "user-initiated navigation" via WebKit JS

We considered injecting a top-level `window.location.href = ...`
assignment into a WebKit-controlled tab to bypass the
`simctl openurl` non-user-initiated flag. Rejected because:

- It is the same `simctl`-driven entry from the iOS UL routing layer's
  perspective; the navigation source flag is not changed by the
  injection target.
- Even if it did flip the flag, Safari's banner heuristics include
  origin reputation and user-engagement signals that a freshly-booted
  Simulator does not satisfy.

### Hard-code an `apple-itunes-app` meta tag for OpenSafari fixtures

We considered shipping an OpenSafari-controlled fixture site that
renders a known `apple-itunes-app` meta tag and using *that* origin
for spikes. Rejected because:

- Close-gate evidence requires the *production* origin, not a fixture.
- The DOM-channel and AX-channel limitations above apply equally
  whether the origin is fixture or production.

## Implementation impact

- No new MCP tool surface lands.
- No changes to `app_open_url` contract.
- `docs/recipes/universal-link-channels.md` will gain a short
  paragraph cross-referencing this ADR (filed as a follow-up under
  the same issue).

## References

- Spike issue: #667
- Parent: #641 (P2 iOS Universal Link channels in Simulator)
- Recommended close-gate channel that ships today:
  `app_notes_paste_and_tap_url` (#641 T1)
- Related deferred work: #660 (Swift `ax-bridge-native`
  UNUserNotificationCenter / SpringBoard enumeration). PR C of that
  series would unblock revisit-condition (2) above.
- Apple docs: Supporting Associated Domains —
  https://developer.apple.com/documentation/xcode/supporting-associated-domains

## Spike artefacts

The empirical observations above were captured by:

```text
$ xcrun simctl boot D7D26213-C3E9-4623-BCCB-984CDF5D0793
$ open -a Simulator
$ # MCP: app_launch { bundleId: "com.apple.mobilesafari" }
$ # MCP: app_open_url { url: "https://omofictions.com/" }
$ # MCP: app_screenshot_native { format: "png" }
$ # MCP: app_tree { max_depth: 4 }
```

The full AX tree dump and the screenshot are reproducible with the
same commands against the same UDID; they are intentionally not
checked into the repo because the page content of `omofictions.com`
is mutable.
