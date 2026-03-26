---
name: pr-review-os
description: Review PRs in opensafari repo with priority-based issue classification
---

# OpenSafari PR Review

**Target**: $ARGUMENTS

- No argument → review ALL open PRs (`gh pr list --state open`)
- PR number → review that PR
- "latest" → most recent open PR

---

## STEP 1: Gather Context

For EACH PR, run:

```bash
gh pr view <N> --json title,body,additions,deletions,files,commits,headRefName,baseRefName
gh pr diff <N>
```

Read every changed file in full. Do NOT review from the diff alone.

## STEP 2: Find Issues

Check the diff against these 6 areas. For EACH issue found, classify as P0/P1/P2.

| Area | What to Check |
|------|---------------|
| **WebKit Protocol** | Correct domain usage (Page for cookies, not Network), `Page.snapshotRect` not `captureScreenshot`, `Runtime.awaitPromise` separate from `evaluate`, `emulateUserGesture: true` on interaction evals |
| **iOS Safari Compatibility** | `document.createTouch()` not `new Touch()`, `document.createTouchList()` for TouchEvent, no hover-dependent interactions, font-size >= 16px for inputs |
| **Simulator** | `simctl` commands exist and are correct, no `simctl snapshot save/restore` (doesn't exist), ports per-device (not hardcoded 9222), `simctl status_bar override` for deterministic screenshots |
| **MCP Protocol** | No `console.log()` in src/ (breaks stdio), `tools/list` response valid, `serverInfo.version` matches package.json, no `oneOf`/`anyOf` in inputSchema properties |
| **Architecture** | No puppeteer/CDP/Chrome dependencies, `BrowserBackend` interface respected, typed (no `any`), dead code removed |
| **Reliability** | Error handling (no swallowed promises), resource cleanup (simulators shutdown), timeout enforcement, crash recovery paths tested |

## STEP 3: Classify Each Issue

| Priority | Definition | Merge Gate |
|----------|-----------|------------|
| **P0** | **Blocker** — security hole, MCP protocol corruption, wrong WebKit Protocol method, Chrome/puppeteer dependency leaked, silent auth bypass | **Must fix before merge** |
| **P1** | **Must fix** — simulator crash not handled, resource leak, wrong simctl command, missing error handling, iOS Safari API incompatibility | **Should fix in this PR** |
| **P2** | **Improve** — code style, docs, minor perf, unlikely edge cases | **Can be follow-up** |

Confidence threshold: only report findings with confidence >= 60/100.

## STEP 4: Write Review

Use this exact format:

```
## PR #<N>: <title>

### P0 — Blockers (must fix before merge)
- [ ] **[P0]** Description — `file:line` (Confidence: XX/100)
  - Impact: ...
  - Fix: ...

### P1 — Must Fix (should fix in this PR)
- [ ] **[P1]** Description — `file:line` (Confidence: XX/100)
  - Fix: ...

### P2 — Improve (can be follow-up)
- [ ] **[P2]** Description — `file:line`
  - Suggestion: ...

### Summary
| Priority | Count |
|----------|-------|
| P0 | X |
| P1 | X |
| P2 | X |

### Verdict
- P0 = 0, P1 = 0 → APPROVE
- P0 = 0, P1 > 0 → REQUEST_CHANGES (fixable)
- P0 > 0 → BLOCK

### Merge Notes
- Conflict files with other PRs (if any)
- Recommended merge order (if multiple PRs)
```

## STEP 5: Post to GitHub — MANDATORY

Do NOT skip this step. Post the review on EVERY reviewed PR.

**Language Rule**: ALL review comments MUST be written in English.

```bash
# P0 > 0:
gh pr review <N> --request-changes --body "<Step 4 output>"

# P0 = 0, P1 > 0:
gh pr review <N> --request-changes --body "<Step 4 output>"

# P0 = 0, P1 = 0:
gh pr review <N> --approve --body "<Step 4 output>"
```

Note: self-PRs cannot be approved via API. Use `--comment` instead of `--approve` for own PRs.

---

## OpenSafari Domain Knowledge

Key files:
- `src/webkit/client.ts` — WebKitClient: WebKit Remote Debugging Protocol connection, message correlation, heartbeat, reconnection
- `src/simulator/manager.ts` — SimulatorManager: xcrun simctl wrapper (boot, shutdown, screenshot, appearance, rotation)
- `src/simulator/pool.ts` — SimulatorPool: multi-device management, idle shutdown, resource monitoring
- `src/simulator/batch.ts` — BatchExecutor: parallel operations across all simulators
- `src/session-manager.ts` — Session/worker/connection tracking
- `src/mcp-server.ts` — MCP tool registration and JSON-RPC handling
- `src/orchestration/workflow-engine.ts` — Multi-device QA workflow orchestration
- `src/qa/detectors/*.ts` — 13 iOS QA detectors (auto-zoom, touch targets, safe area, etc.)
- `src/qa/audit.ts` — QAAudit: runs all detectors, calculates score
- `src/auth/manager.ts` — AuthManager: cookie export/import for login persistence
- `src/types/browser-backend.ts` — BrowserBackend interface (26 methods)
- `src/comparison/cross-viewport.ts` — Cross-viewport capture and comparison

Common P0/P1 patterns specific to OpenSafari:
1. `Network.setCookie` instead of `Page.setCookie` — wrong WebKit domain (P0)
2. `Page.captureScreenshot` instead of `Page.snapshotRect` — Chrome CDP method, not WebKit (P0)
3. `new Touch()` instead of `document.createTouch()` — not supported in iOS Safari (P0)
4. `simctl snapshot save/restore` — does not exist in any Xcode version (P0)
5. `console.log()` in src/ — MCP stdio protocol corruption (P0)
6. Missing `emulateUserGesture: true` on `Runtime.evaluate` for interactions (P1)
7. `awaitPromise` as parameter to `Runtime.evaluate` — must be separate `Runtime.awaitPromise` command (P1)
8. Hardcoded port 9222 for multi-simulator — ios-webkit-debug-proxy assigns per-device ports (P1)
9. `result.data` instead of `result.dataURL` for screenshot — WebKit returns dataURL format (P1)
10. `result.exceptionDetails` instead of `result.wasThrown` — Chrome CDP field, not WebKit (P1)
