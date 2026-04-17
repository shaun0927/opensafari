# Memory Soak Tests

Long-session soak tests for memory SLO verification (issue #554).

## What the soak test does

`long-session.soak.test.ts` runs the OpenSafari tool handlers in a tight
round-robin loop for **60 minutes** against a booted iOS simulator and
asserts that resident-set-size (RSS) growth stays within defined SLOs:

| SLO | Threshold |
|-----|-----------|
| Absolute RSS growth (final - initial) | ≤ 100 MB |
| Rolling 10-minute RSS growth rate | ≤ 3 MB/min |
| Retained-object class growth (30 min → 60 min) | ≤ 1000 instances / class |

The test samples RSS every 60 seconds using `process.memoryUsage()` and
persists the full sample array to `tests/soak/output/rss-baseline.json`
so CI can upload it as a workflow artifact for trend analysis.

Three V8 heap snapshots are written via `v8.writeHeapSnapshot()` (no
`--expose-gc` required) at the 0 / 30 / 60-minute marks to
`tests/soak/output/heap-{0,30,60}min.heapsnapshot`. The test asserts
that no retained-object class grows by more than 1000 instances between
the 30-minute and 60-minute marks — the window after caches are warm
but while leaks would be compounding.

Four backend tiers are exercised in round-robin order:

| Tier | Operation |
|------|-----------|
| 0 — Flutter VM | `flutter_evaluate` (trivial expression) |
| 1 — SimHID keys | `app_key_input` (no-op key sequence) |
| 1.5 — AX press | `app_tap_element` (safe accessibility element) |
| 3 — WebKit | `app_query` (trivial DOM query) |

> **Note:** The individual tier handlers are currently stubbed with
> representative memory-allocation patterns. Replace each stub with the
> real handler import once the per-tool API surface is stabilised
> (tracked in issue #554 follow-up).

## How to run locally

```bash
OPENSAFARI_RUN_SOAK=1 npx jest tests/soak/ --testTimeout=3700000
```

Prerequisites:
- macOS with Xcode installed
- At least one iOS 17+ simulator runtime available (`xcrun simctl list runtimes`)
- The project built: `npm run build`

The test will boot an `iPhone 16` simulator automatically. If one is
already booted it will be reused (fastest path).

## What the assertions mean

**RSS delta ≤ 100 MB** — The process is not leaking heap or native memory
at a rate that would threaten a multi-hour agent session. 100 MB gives
ample headroom for warm caches and JIT growth while still catching real
leaks.

**Rolling growth rate ≤ 3 MB/min** — Even if the absolute delta is small,
a sustained linear leak would exhaust available memory over a long enough
run. 3 MB/min equates to 180 MB/hour; any region of the run that exceeds
this indicates a local leak correlated with one of the backend tiers.

## How to interpret failures

### RSS delta exceeds 100 MB

1. Check the per-sample log emitted to stderr — identify which minute the
   growth accelerated.
2. Correlate with which tier was running at that time (tiers rotate every
   3 seconds, so a spike in minute *N* implicates calls *N*×20 through
   *(N+1)*×20).
3. On any SLO failure, the test already logs the three heap-snapshot paths
   and the top-20 retained-class growers (0 → 60 min and 30 → 60 min) to
   stderr. Download them from the `rss-baseline-*` CI artifact and open in
   Chrome DevTools → Memory → Load profile.

### Retained-class growth exceeds 1000 instances

1. The failure log lists the top-20 growers directly — look for unexpected
   app-level classes (`FlutterVMClient`, `WebKitClient`, any MCP tool
   response type) or oversized internal arrays.
2. Cross-reference against `docs/memory-budget.md`: if the class is backed
   by one of the documented caches, the cache's eviction policy likely has
   a bug.
3. Inspect the `heap-30min.heapsnapshot` → `heap-60min.heapsnapshot` pair
   in DevTools using "Comparison" mode to see which specific objects are
   retained.

### Growth rate exceeds 3 MB/min

1. Look at `tests/soak/output/rss-baseline.json` for the raw sample
   array.
2. Identify the 10-minute window with the highest growth rate.
3. Narrow down the tier by checking which operations were active during
   that window.

### Simulator boot failure

- Verify `xcrun simctl list devices` shows at least one available device.
- If no `iPhone 16` is available, the test will attempt to create one.
  Ensure the matching runtime is installed in Xcode.

## Nightly CI

The soak test runs nightly at 03:00 UTC via
`.github/workflows/memory-soak.yml`. On failure the workflow posts a
comment on issue #554 and, after 7 consecutive failures, opens a new
issue labelled `memory-regression`.
