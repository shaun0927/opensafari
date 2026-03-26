---
name: release-os
description: OpenSafari release workflow — triage, review, fix own PRs, merge, and optionally publish
---

# OpenSafari Release Workflow

$ARGUMENTS

---

## STEP 1: Status Check

Run all of these and report results:

```bash
git status
git stash list
git branch -a
gh pr list --state open --json number,title,headRefName,baseRefName,additions,deletions,author,files
npm run build
npm run lint
npm test
```

**Gate**: If build, lint, or tests fail, fix errors first. Do NOT proceed with any failures.

## STEP 2: Classify Open PRs

For each open PR, determine ownership:

| Type | How to Identify | Action |
|------|----------------|--------|
| **MY PR** | `author.login` matches repo owner | Review → Fix P0/P1 → Merge |
| **OTHER's PR** | Different author | Review → Post comment → Do NOT merge |

List all PRs in a table:

```
| PR # | Title | Author | Type | Files Changed |
|------|-------|--------|------|---------------|
```

## STEP 3: Triage Local Changes

Check for uncommitted local work:

```bash
git status
git stash list
git diff --stat
```

For each local change, classify:

| Change Type | Action |
|-------------|--------|
| Source code (`.ts`) changes | Create PR by category (feat/fix/refactor/chore). **All PR titles, descriptions, and commit messages MUST be in English.** |
| `.claude/` agents/commands | Validate YAML frontmatter, bundle into chore PR |
| Temp/experiment files | Delete if not needed |
| Stashed changes | Pop, resolve conflicts, commit or drop |

**Gate**: All local changes committed or discarded. `git status` shows clean working tree.

## STEP 4: Review Each PR

For EACH open PR (both mine and others'), in order:

### 4a. Run `/pr-review-os <N>`

This produces a P0/P1/P2 issue list and verdict.

### 4b. Take action based on ownership + verdict

**MY PR with P0s**:
1. `git checkout <branch>`
2. Fix ALL P0 issues
3. `npm run build` — must pass
4. Commit and push fixes
5. Re-run `/pr-review-os <N>` — must have P0 = 0
6. If P1s remain, fix those too
7. Repeat until P0 = 0 and P1 = 0

**MY PR, P0 = 0 and P1 = 0**:
1. Post review to GitHub (use `--comment` for self-PRs)

**OTHER's PR with P0 or P1**:
1. Post review to GitHub: `gh pr review <N> --request-changes --body "<review>"`
2. Do NOT fix their code. Do NOT merge. Leave for the author.

**OTHER's PR, clean**:
1. Post review to GitHub: `gh pr review <N> --approve --body "<review>"`
2. Still do NOT merge unless user explicitly says to.

**Gate**: Every PR has a posted GitHub review comment before proceeding.

## STEP 5: Pre-merge Checks

Before merging ANY PR, verify ALL of these:

```bash
npm ci                                                 # must pass (lockfile in sync)
npm run build                                          # must pass
npm run lint                                           # must pass (no errors)
npm test                                               # must pass (ALL test suites green)
git diff --name-only HEAD | wc -l                      # must be 0 (clean tree)
```

Also grep for known anti-patterns:

```bash
# Protocol safety
grep -r "console\.log(" src/ --include="*.ts"          # must be 0 — MCP stdio breaks
grep -r "puppeteer\|CDPClient\|CDPSession" src/ --include="*.ts" | grep -v "//"  # must be 0 — no Chrome deps
grep -r "Network\.setCookie\|Network\.getAllCookies\|Network\.clearBrowserCookies" src/ --include="*.ts"  # must be 0 — use Page domain
grep -r "captureScreenshot" src/ --include="*.ts"      # must be 0 — use Page.snapshotRect
grep -r "new Touch(" src/ --include="*.ts"             # must be 0 — use document.createTouch
grep -r "simctl snapshot save\|simctl snapshot restore" src/ --include="*.ts"  # must be 0 — does not exist
```

### MCP Protocol Conformance

Verify the MCP server produces spec-compliant responses:

```bash
# 1. Initialize response must contain ONLY: protocolVersion, capabilities, serverInfo
INIT_RESPONSE=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"conformance-test","version":"1.0.0"}}}' | timeout 10 node dist/cli/index.js serve 2>/dev/null | head -1)
INIT_KEYS=$(echo "$INIT_RESPONSE" | jq -r '.result | keys | sort | join(",")')
echo "Initialize result keys: $INIT_KEYS"

# 2. serverInfo.version matches package.json version
SERVER_VERSION=$(echo "$INIT_RESPONSE" | jq -r '.result.serverInfo.version')
PACKAGE_VERSION=$(node -p "require('./package.json').version")
echo "Server version: $SERVER_VERSION, Package version: $PACKAGE_VERSION"
```

**Gate**: All checks must pass. If any fail, fix before merging.

## STEP 6: Merge (MY PRs only)

For each MY PR:

```bash
gh pr merge <N> --merge --delete-branch
git checkout main && git pull origin main
npm run build                                          # verify after each merge
npm test                                               # verify tests pass after each merge
```

Do NOT merge OTHER's PRs unless the user explicitly says to.

## STEP 7: Cleanup

```bash
# Delete merged local branches
git branch --merged main | grep -v 'main\|develop' | xargs -r git branch -d

# Delete stale remote branches (story/feature branches left after PR merge)
git branch -r | grep -v "HEAD\|main\|develop" | sed 's|origin/||' | while read branch; do
  git push origin --delete "$branch" 2>/dev/null
done

# Prune remote tracking refs
git remote prune origin

# Verify clean state
git branch -a
gh pr list --state open
npm run build
git log --oneline -10
```

## STEP 8: Publish (only if user requests)

### 8a. Verify CI passes on main

**CRITICAL**: Do NOT publish until CI is green on main.

```bash
gh run list --branch main --limit 1 --json status,conclusion,databaseId
```

**Gate**: CI must pass. Do NOT proceed if any job failed.

### 8b. Publish to npm

```bash
npm version patch   # or minor/major per user request
git push origin main --tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
npm publish
```

Skip this step entirely unless the user explicitly asks for a version bump or publish.

### 8c. Post-publish: Local Environment Sync

```bash
# 1. Kill ALL opensafari processes
pkill -f "opensafari-mcp" || true
pkill -f "_npx.*opensafari" || true
sleep 1

# 2. Clear npx cache
rm -rf ~/.npm/_npx/*/node_modules/opensafari-mcp
rm -rf ~/.npm/_npx/*/package-lock.json

# 3. Update global npm package
npm install -g opensafari-mcp@latest

# 4. Verify version consistency
echo "src:    $(node -p \"require('./package.json').version\")" && \
echo "dist:   $(node dist/cli/index.js --version 2>/dev/null)" && \
echo "global: $(npm ls -g opensafari-mcp 2>/dev/null | grep opensafari)" && \
echo "npm:    $(npm view opensafari-mcp version)"
```

**Gate**: All versions must match. After verification, restart Claude Code.

---

## Completion Checklist

- [ ] Every open PR has a GitHub review comment posted
- [ ] All MY PRs: P0 = 0, P1 = 0, merged
- [ ] All OTHER's PRs: reviewed and commented (NOT merged)
- [ ] Anti-pattern grep: no console.log, no Chrome/CDP deps, no wrong WebKit methods
- [ ] MCP Protocol: `initialize` response spec-compliant
- [ ] MCP Protocol: `serverInfo.version` matches `package.json`
- [ ] `npm run build` passes on main
- [ ] `npm test` passes — ALL suites green
- [ ] `npm run lint` passes — no errors
- [ ] No unnecessary branches remain
- [ ] Working tree is clean
- [ ] (If published) CI green on main before publish
- [ ] (If published) Global npm package matches published version
- [ ] (If published) npx cache cleared
