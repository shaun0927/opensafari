# OpenChrome → OpenSafari Module Audit

## Date: 2026-03-25

## Architecture Principle
```
OpenChrome:  CDPClient (puppeteer-core) → Chrome DevTools Protocol → Real Chrome
OpenSafari:  WebKitClient (custom)      → WebKit Remote Debugging Protocol → Real Safari in Simulator
```

---

## mcp-server.ts Imports (1364 lines)

| Line | Import Path | Classification | Notes |
|------|-------------|---------------|-------|
| 5-15 | `./types/mcp` | COPY | Pure MCP protocol types |
| 16 | `./transports/index` | COPY | Abstract transport interface |
| 17 | `./session-manager` | REWRITE | Deep puppeteer-core + CDP deps |
| 18 | `./dashboard/index` | DEFER | Terminal TUI, no browser deps but not MVP |
| 19 | `./resources/usage-guide` | ADAPT | Text references "Chrome" |
| 20 | `./hints` | DEFER | Hint engine — post-MVP |
| 21 | `./utils/schema-validator` | COPY | Pure JSON schema |
| 22 | `./utils/format-age` | COPY | Pure date formatting |
| 23 | `./utils/format-error` | COPY | Pure error formatting |
| 24 | `./cdp/connection-pool` | DROP | Replaced by SimulatorPool |
| 25 | `./cdp/client` | DROP | Replaced by WebKitClient |
| 26 | `./chrome/launcher` | DROP | Replaced by SimulatorManager |
| 27 | `./chrome/pool` | DROP | Replaced by SimulatorPool |
| 28 | `./types/tool-manifest` | COPY | Pure type definitions |
| 29 | `./config/defaults` | ADAPT | Chrome-specific constant names |
| 30 | `./watchdog/event-loop-monitor` | COPY | Node.js event loop monitor |
| 31 | `./utils/rate-limiter` | COPY | Pure token bucket |
| 32 | `./config/global` | ADAPT | Chrome config fields → Simulator fields |
| 33 | `./config/tool-tiers` | COPY | Pure tool name-to-tier map |
| 34 | `./metrics/collector` | ADAPT | `openchrome_` metric prefix |
| 35 | `./security/audit-logger` | COPY | File-based audit logger |
| 36 | `./version` | COPY | Reads package.json version |
| 37 | `./errors/timeout` | COPY | Pure error class (rename class name) |
| 38 | `./journal/task-journal` | ADAPT | `~/.openchrome/` path |

## session-manager.ts Imports (1706 lines)

| Line | Import Path | Classification | Notes |
|------|-------------|---------------|-------|
| 7 | `puppeteer-core` | DROP | Page, Target, BrowserContext |
| 8 | `./types/session` | ADAPT | Contains `BrowserContext` reference |
| 9 | `./cdp/client` | DROP | Replaced by WebKitClient |
| 10 | `./cdp/connection-pool` | DROP | Replaced by SimulatorPool |
| 11 | `./chrome/pool` | DROP | Replaced by SimulatorPool |
| 12 | `./config/global` | ADAPT | Chrome config fields |
| 13 | `./utils/request-queue` | COPY | Pure FIFO queue |
| 14 | `./utils/ref-id-manager` | ADAPT | Uses `Page` from puppeteer |
| 15 | `./utils/smart-goto` | DROP | puppeteer-specific navigation |
| 16 | `./config/defaults` | ADAPT | Chrome-named constants |
| 18 | `./router` | DROP | Chrome/Lightpanda routing |
| 19 | `./types/browser-backend` | REWRITE | Enum → Interface |
| 20 | `./storage-state` | DROP | Uses puppeteer Page; replaced by AuthManager |
| 22 | `./security/domain-guard` | COPY | Pure domain matching |
| 23 | `./utils/puppeteer-helpers` | DROP | Accesses puppeteer internals |
| 24 | `./utils/safe-title` | DROP | Uses puppeteer Page |

## Directory Summary

| Directory | Lines | Classification | Notes |
|-----------|-------|---------------|-------|
| transports/ | 559 | **COPY** | stdio + HTTP MCP transports |
| security/ | 308 | **COPY** | Audit logger, sanitizer, domain guard |
| errors/ | 38 | **COPY** | Rename `OpenChromeTimeoutError` → `OpenSafariTimeoutError` |
| types/mcp.ts | ~100 | **COPY** | MCP protocol types |
| types/tool-manifest.ts | ~50 | **COPY** | Tool definition types |
| types/session.ts | ~100 | **REWRITE** | Contains puppeteer-core `BrowserContext` |
| types/browser-backend.ts | 34 | **REWRITE** | Enum → Interface |
| config/ | 492 | **ADAPT** | Chrome config → Simulator config |
| watchdog/event-loop-monitor | ~150 | **COPY** | Pure Node.js |
| watchdog/disk-monitor | ~150 | **ADAPT** | `~/.openchrome/` path |
| watchdog/health-endpoint | ~200 | **ADAPT** | Chrome status fields |
| watchdog/chrome-monitor | ~100 | **REWRITE** | → simulator-monitor |
| metrics/ | 207 | **ADAPT** | `openchrome_` prefix |
| journal/ | 245 | **ADAPT** | `~/.openchrome/` path |
| utils/ (pure) | ~1500 | **COPY** | 12 pure utility files |
| utils/ (puppeteer) | ~1500 | **DROP/ADAPT** | puppeteer-dependent utilities |
| cdp/ | 2767 | **DROP** | Replaced by webkit/ |
| chrome/ | 2192 | **DROP** | Replaced by simulator/ |
| router/ | 430 | **DROP** | No hybrid mode |
| lightpanda/ | 212 | **DROP** | Not needed |
| orchestration/ | 2145 | **REWRITE** | CDP deps in workflow engine |
| dashboard/ | 1676 | **DEFER** | Terminal TUI — post-MVP |
| hints/ | 822 | **DEFER** | Hint engine — post-MVP |
| tools/ | 14614 | **DEFER** | Reimplemented in Epic 1B/1C/1D |

## Files Safe to Copy (zero browser deps)

```
transports/index.ts
transports/stdio.ts
transports/http.ts
security/audit-logger.ts
security/content-sanitizer.ts
security/domain-guard.ts
errors/timeout.ts
types/mcp.ts
types/tool-manifest.ts
config/tool-tiers.ts
watchdog/event-loop-monitor.ts
utils/format-age.ts
utils/format-error.ts
utils/url-utils.ts
utils/with-timeout.ts
utils/rate-limiter.ts
utils/request-queue.ts
utils/schema-validator.ts
version.ts
```

## String Renames Required

| File | Find | Replace |
|------|------|---------|
| metrics/collector.ts | `openchrome_` | `opensafari_` |
| journal/task-journal.ts | `~/.openchrome/` | `~/.opensafari/` |
| watchdog/disk-monitor.ts | `~/.openchrome/` | `~/.opensafari/` |
| watchdog/health-endpoint.ts | `openchrome_` | `opensafari_` |
| errors/timeout.ts | `OpenChromeTimeoutError` | `OpenSafariTimeoutError` |
