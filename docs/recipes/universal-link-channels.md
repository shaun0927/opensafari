# Universal Link channels in the iOS Simulator

**Audience**: teams shipping iOS apps that rely on Universal Links
(`applinks:example.com`) and need to produce Apple-review-equivalent
evidence — typically a screenshot or log snippet from the "user pastes a
link and taps it" flow that Apple's docs describe.

**tl;dr**: the iOS Simulator can reproduce the **Notes paste-and-tap** and
**Safari URL-bar** flows deterministically. It cannot reproduce
**iMessage** or **Mail** flows — those require a real device. The
**Safari Smart App Banner** flow is under investigation (see [follow-up
spike](#safari-smart-app-banner-follow-up-spike)).

## Channel matrix

| Channel                                 | Apple treats as …                  | Simulator support           | OpenSafari tool                                                                                   |
|-----------------------------------------|------------------------------------|-----------------------------|---------------------------------------------------------------------------------------------------|
| `xcrun simctl openurl`                  | indirect (does not count as a tap) | fully supported             | `mcp__opensafari__app_open_url`                                                                   |
| Safari URL bar → type URL → Return      | equivalent to a reviewer tap       | supported                   | `mcp__opensafari__navigate` then `app_open_url`, or the underlying `simctl openurl` call          |
| **Notes** — paste a URL, tap detected link | **equivalent to a reviewer tap**   | **supported via T1 helper** | **`mcp__opensafari__app_notes_paste_and_tap_url`**                                                |
| Safari "Open in App" Smart App Banner   | equivalent to a reviewer tap       | investigation pending       | — (see [spike](#safari-smart-app-banner-follow-up-spike))                                         |
| iMessage — tap a received link          | equivalent to a reviewer tap       | **not available**           | — (not implementable — see [limitation](#imessage--mail))                                         |
| Mail.app — tap a link in a message body | equivalent to a reviewer tap       | **not available**           | — (not implementable — see [limitation](#imessage--mail))                                         |

## Recommended close-gate flow

For App Review evidence and QA repros, prefer:

1. **Notes paste-and-tap** via `app_notes_paste_and_tap_url`. This is the
   closest reviewer-parity channel available in the Simulator: the tool
   launches Notes, paste-injects the URL, waits for iOS Data Detector to
   produce an `AXLink`, and taps it. A successful tap routes through the
   same `LSOpenURL` path as a real reviewer tap.
2. **Unified-log capture** via the `captureLogs` option on
   `app_open_url` / `app_deeplink` so you can assert that your app's
   Universal Link handler ran (e.g. `[UniversalLink] Resolved …`) in a
   single tool call. See
   [`capture-logs-window.ts`](../../src/observability/capture-logs-window.ts)
   for the contract.

A minimal example:

```jsonc
// 1. Paste-and-tap via Notes.
{ "tool": "app_notes_paste_and_tap_url",
  "arguments": {
    "url": "https://example.com/detail/abc",
    "linkTapTimeoutMs": 5000
  }
}

// 2. Capture the Universal Link handler's log output around the tap.
{ "tool": "app_deeplink",
  "arguments": {
    "url": "https://example.com/detail/abc",
    "captureLogs": {
      "bundleId": "com.example.myapp",
      "search":   "[UniversalLink]",
      "prerollMs": 2000,
      "silenceMs": 1500,
      "maxDurationMs": 8000
    }
  }
}
```

## iMessage / Mail

The iOS Simulator does **not** provision iMessage or SMS — there is no
public API to synthesise an inbound message, and `xcrun simctl` does not
expose a verb for this. Mail.app has the same issue: there is no public
API to programmatically compose or deliver a message into the Mail
inbox.

For App Review evidence where an iMessage / Mail tap is specifically
requested, a real device is required. Options:

- Use a real iPhone attached to Xcode, trigger the deep link via a test
  link sent from a second device, and capture the `os_log` stream with
  `log stream --predicate 'process == "<YourApp>"'` from the host.
- Fall back to **Notes paste-and-tap** (see above). Apple's
  documentation (linked below) states that the Universal Link handler
  path is the same regardless of which first-party app initiated the
  tap, so Notes paste-and-tap is defensible as reviewer-equivalent
  evidence for apps where the `applinks:` association is otherwise
  verified.

This is a platform limitation, not an OpenSafari gap.

## Safari Smart App Banner follow-up spike

The `<meta name="apple-itunes-app" …>` Smart App Banner that Safari
injects when the associated app is installed is **Apple-rendered
proprietary UI**. Before adding a `waitForSmartBanner: true` option to
`app_open_url`, we need to characterise the banner's structure (WebKit
DOM vs native AX tree, reliability across iOS versions). See the
tracking issue referenced from #641.

Until that spike resolves, the recommended close-gate path is the
**Notes paste-and-tap** flow.

## References

- Apple — Supporting Associated Domains
  <https://developer.apple.com/documentation/xcode/supporting-associated-domains>
- Apple — Allowing Apps and Websites to Link to Your Content
  <https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content>
- `apple-app-site-association` format
  <https://developer.apple.com/documentation/xcode/supporting-associated-domains#Add-the-associated-domain-file-to-your-website>
