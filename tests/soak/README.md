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

The test samples RSS every 60 seconds using `process.memoryUsage()` and
persists the full sample array to `tests/soak/output/rss-baseline.json`
so CI can upload it as a workflow artifact for trend analysis.

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
3. Capture a heap snapshot: re-run with `node --expose-gc` and enable the
   `v8.writeHeapSnapshot()` path (currently marked TODO in the test).
   Heap snapshots are written to `process.cwd()` by default.

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
