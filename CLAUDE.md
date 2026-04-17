# Claude Code Project Instructions

## Branch Strategy

```
feature/* → develop → main (release)
```

- All PRs target `develop` branch
- Release merges go from `develop` into `main`
- Tag-based npm publish triggers on `main` (v* tags)

## Build & Test

```bash
npm install && npm run build && npm test
```

## Code Quality

- All source code, comments, commit messages, and PR descriptions must be in English
- Use `console.error()` for logging — `console.log()` writes to stdout which carries MCP JSON-RPC and will corrupt the protocol
- No `puppeteer-core`, `CDP`, or Chrome dependencies — this project uses WebKit Remote Debugging Protocol
- Use `Page.getCookies` / `Page.setCookie` / `Page.deleteCookie` (NOT Network domain)
- Use `Page.snapshotRect` for screenshots (NOT `Page.captureScreenshot`)
- Use `document.createTouch()` / `document.createTouchList()` (NOT `new Touch()`)
- Use `Runtime.awaitPromise` as separate command (NOT as parameter to `Runtime.evaluate`)
- `simctl snapshot save/restore` does NOT exist — use `simctl clone` or WebKit cookie export

## Slash Commands

- `/release-os` — Full release workflow (triage → review → merge → publish)
- `/pr-review-os` — PR code review with P0/P1/P2 classification

## Debugging

- Set `OPENSAFARI_TRACE=1` to log MCP tool args + entry/exit timings to stderr.

## Key Architecture

```
OpenSafari = WebKitClient → WebKit Remote Debugging Protocol → Real Safari in Xcode Simulator
```

No playwright. No middleware. Direct protocol connection via ios-webkit-debug-proxy.
