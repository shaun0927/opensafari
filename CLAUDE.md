# Claude Code Project Instructions

## Branch Strategy

```
feature/* → develop → main (release)
```

- All PRs target `develop` branch
- Release merges go from `develop` into `main`
- Tag-based npm publish triggers on `main` (v* tags)

### Stacked / multi-part work

Avoid long chains of interdependent feature branches that each PR into the previous one. When `0.6.3` was cut, several PRs (#810/#811/#808/#812) were stranded outside `develop` by a stacked-PR topology and had to be rescued via a single catch-up integration PR (#814).

Rules to prevent recurrence:

- **Each PR targets `develop` directly.** Do not target another feature branch unless the base is already merged to `develop`.
- **If work must be split into parts, land each part to `develop` before opening the next**, or open them in parallel against `develop` and resolve conflicts at merge time — never as a chain where part N depends on unmerged part N-1.
- **If a chain is unavoidable, the final integration PR must target `develop`** and the intermediate branches must be deleted, not left as dangling bases.
- Keep one logical concern per PR; do not bundle a refactor + feature + CI change so that a CI failure in one strands the others.

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

## Key Architecture

```
MCP contracts
  -> session, orchestration, safety, and evidence layers
  -> WebKit / AX / Flutter VM / simctl / SimulatorKit backends
  -> real Safari, WebViews, native iOS, and Flutter apps in Xcode Simulator
  -> bounded host macOS AX/TestFlight workflows
```

[Product Direction](docs/product-direction.md) is the authority for product
scope, stability vocabulary, safety boundaries, and architectural direction.

No Playwright/WebDriver re-platforming and no bundled browser. Safari/WebView
automation uses direct WebKit Remote Debugging through ios-webkit-debug-proxy;
the WebKit-specific rules above do not describe native AX, Flutter VM,
SimulatorKit, `simctl`, or host macOS backends.
