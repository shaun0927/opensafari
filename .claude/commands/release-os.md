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

List all PRs in a table (include mergeable status):

```bash
# Get mergeable status for all open PRs
gh pr list --state open --json number,mergeable,mergeStateStatus \
  --jq '.[] | "\(.number) | \(.mergeable) | \(.mergeStateStatus)"'
```

```
| PR # | Title | Author | Type | Files Changed | Mergeable |
|------|-------|--------|------|---------------|-----------|
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

## STEP 6: Merge Readiness & Conflict Resolution

Before merging, ensure every MY PR is mergeable. Process ALL my PRs in this step before moving to STEP 7.

### 6a. Determine merge order

```bash
# Check mergeable status for all MY PRs
for N in <list of MY PR numbers>; do
  gh pr view $N --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus \
    --jq '"\(.number) | \(.title) | \(.mergeable) | \(.mergeStateStatus) | \(.baseRefName)"'
done
```

Sort PRs for merge order:
1. **MERGEABLE** PRs first (no conflicts — merge immediately)
2. **CONFLICTING** PRs next (need rebase before merge)
3. Within each group, smaller PRs (fewer changed files) first — reduces cascading conflicts

### 6b. For each PR: check and resolve conflicts

For EACH MY PR in the determined order:

```bash
# 1. Check current mergeable status (may change after prior merges)
MERGE_STATUS=$(gh pr view <N> --json mergeable --jq '.mergeable')
echo "PR #<N> mergeable: $MERGE_STATUS"
```

**If MERGEABLE**: skip to 6c.

**If CONFLICTING**: resolve via rebase:

```bash
# 2. Fetch latest and checkout the PR branch
git fetch origin
BASE_BRANCH=$(gh pr view <N> --json baseRefName --jq '.baseRefName')
git checkout <branch>

# 3. Rebase onto the latest base branch
git rebase "origin/$BASE_BRANCH"
```

**If rebase has conflicts**:
1. For each conflicting file, open and resolve the conflict manually
2. `git add <resolved files>`
3. `git rebase --continue`
4. Repeat until rebase completes
5. If conflicts are too complex to resolve automatically, **STOP and ask the user**

```bash
# 4. Force-push the rebased branch
git push --force-with-lease origin <branch>

# 5. Wait for CI to pass after rebase
gh pr checks <N> --watch --fail-fast

# 6. Re-verify mergeable status
MERGE_STATUS=$(gh pr view <N> --json mergeable --jq '.mergeable')
echo "PR #<N> after rebase: $MERGE_STATUS"
```

**Gate**: `mergeable` must be `MERGEABLE` and CI must pass. If still CONFLICTING after rebase, investigate and fix. Do NOT proceed with a conflicting PR.

### 6c. Merge the PR

```bash
# Resolve base branch BEFORE merge (gh pr view works; after merge the PR is closed)
BASE_BRANCH=$(gh pr view <N> --json baseRefName --jq '.baseRefName')

# Merge into the base branch (usually develop)
gh pr merge <N> --merge --delete-branch

# Sync the base branch locally after merge
git checkout "$BASE_BRANCH" && git pull origin "$BASE_BRANCH"

# Verify build/tests pass on the updated base branch
npm run build
npm test
```

**CRITICAL**: After EACH merge, remaining PRs may now have new conflicts. Loop back to 6b for the next PR — always re-check `mergeable` status before attempting merge.

### 6d. Post-merge verification

After ALL my PRs are merged:

```bash
# Verify all MY PRs show as merged
for N in <list of MY PR numbers>; do
  gh pr view $N --json state --jq '"\(.state)"'
done

# Ensure no PR was left behind
gh pr list --state open --author @me
```

**Gate**: All MY PRs must show `MERGED`. If any remain open, diagnose and retry from 6b.

Do NOT merge OTHER's PRs unless the user explicitly says to.

## STEP 7: Cleanup

```bash
# Delete local branches merged into develop
git checkout develop
git branch --merged develop | grep -v 'main\|develop' | xargs -r git branch -d

# Also delete branches merged into main
git branch --merged main | grep -v 'main\|develop' | xargs -r git branch -d

# Delete stale remote branches (feature branches left after PR merge)
# Only delete branches whose PRs are already merged/closed
for branch in $(git branch -r | grep -v "HEAD\|main\|develop" | sed 's|origin/||'); do
  # Check if any open PR uses this branch
  OPEN_PR=$(gh pr list --state open --head "$branch" --json number --jq 'length')
  if [ "$OPEN_PR" = "0" ]; then
    git push origin --delete "$branch" 2>/dev/null && echo "Deleted: $branch"
  else
    echo "Kept (open PR): $branch"
  fi
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

## STEP 9: Local Development Sync (always run)

After merging PRs (even without publishing to npm), sync the local environment:

```bash
# 1. Switch to develop and pull latest
cd /Users/jh0927/opensafari
git checkout develop
git pull origin develop

# 2. Install dependencies (in case package.json changed)
npm install

# 3. Build from source
npm run build

# 4. Link locally (creates global symlink to local dist/)
npm link

# 5. Verify local CLI works
node dist/cli/index.js --version
node dist/cli/index.js doctor

# 6. Verify the symlink points to this repo
ls -la $(npm prefix -g)/lib/node_modules/opensafari-mcp
```

**Note**: `npm link` creates a symlink — subsequent `npm run build` updates are reflected immediately without re-linking. No session restart needed.

**Gate**: `node dist/cli/index.js --version` outputs correct version. `doctor` runs without errors.

---

## Completion Checklist

- [ ] Every open PR has a GitHub review comment posted
- [ ] All MY PRs: P0 = 0, P1 = 0
- [ ] All MY PRs: merge conflicts resolved (rebased onto base branch)
- [ ] All MY PRs: CI green after rebase (if rebased)
- [ ] All MY PRs: merged successfully — verified via `gh pr view <N> --json state`
- [ ] All OTHER's PRs: reviewed and commented (NOT merged)
- [ ] Anti-pattern grep: no console.log, no Chrome/CDP deps, no wrong WebKit methods
- [ ] MCP Protocol: `initialize` response spec-compliant
- [ ] MCP Protocol: `serverInfo.version` matches `package.json`
- [ ] `npm run build` passes on base branch after all merges
- [ ] `npm test` passes — ALL suites green
- [ ] `npm run lint` passes — no errors
- [ ] No unnecessary branches remain (only branches with open PRs kept)
- [ ] Working tree is clean
- [ ] Local: `npm link` completed, `doctor` runs clean
- [ ] (If published) CI green on main before publish
- [ ] (If published) Global npm package matches published version
- [ ] (If published) npx cache cleared
