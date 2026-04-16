# Memory Budget — Module-Level Caches and Singletons

This document catalogues every module-level `Map`, `Set`, or cache variable in `src/`
that retains memory across tool calls. Its purpose is to make retention policies
explicit, enable capacity planning, and provide a stable contract that CI can verify.

## Cache Registry

| Cache / singleton | Location | Eviction policy | Max size (target) |
|---|---|---|---|
| `clients` (FlutterVMClient map) | [`src/flutter/vm-service-client.ts:679`](../src/flutter/vm-service-client.ts#L679) | Removed on disconnect + `removeFlutterVMClient()` | 2 MB / entry |
| `buckets` (telemetry rollup) | [`src/metrics/input-telemetry-rollup.ts:57`](../src/metrics/input-telemetry-rollup.ts#L57) | FIFO ring buffer, cap = `INPUT_TELEMETRY_ROLLUP_CAP` (1024) samples/key | 1 MB |
| `managed` (proxy map) | [`src/simulator/proxy-manager.ts:40`](../src/simulator/proxy-manager.ts#L40) | Removed on `stopProxyForDevice()` | 64 KB / entry |
| `reservedPorts` | [`src/simulator/proxy-manager.ts:42`](../src/simulator/proxy-manager.ts#L42) | Limited by port range (`PROXY_PORT_RANGE_DEFAULT` = 100) | < 4 KB |
| `activeRecordings` | [`src/tools/app-record-video.ts:21`](../src/tools/app-record-video.ts#L21) | Removed on stop | 1 KB / entry |
| `collectors` (console log) | [`src/tools/console-log.ts:9`](../src/tools/console-log.ts#L9) | FIFO, 500 entries/collector (`BufferedEventCollector(500)`) | 512 KB / collector |
| `collectors` (error log) | [`src/tools/error-log.ts:12`](../src/tools/error-log.ts#L12) | FIFO, 500 entries/collector (`BufferedEventCollector(500)`) | 512 KB / collector |
| `collectors` (network log) | [`src/tools/network-log.ts:11`](../src/tools/network-log.ts#L11) | FIFO, 500 entries/collector (`BufferedEventCollector(500)`) | 512 KB / collector |
| `managers` (breakpoint) | [`src/tools/flutter-breakpoints.ts:66`](../src/tools/flutter-breakpoints.ts#L66) | Per-device lifetime; cleared by `forgetBreakpointManager()` / `_resetBreakpointManagers()` | 64 KB / device |
| `logBuffers` (Flutter logs) | [`src/tools/flutter-logs.ts:19`](../src/tools/flutter-logs.ts#L19) | FIFO, `MAX_LOG_ENTRIES` (500) entries/device | 256 KB / device |
| `subscribed` (Flutter log subscriptions) | [`src/tools/flutter-logs.ts:20`](../src/tools/flutter-logs.ts#L20) | Per-device lifetime (Set of deviceId strings) | < 4 KB |
| `previousSnapshots` (allocation baselines) | [`src/tools/flutter-memory-profile.ts:63`](../src/tools/flutter-memory-profile.ts#L63) | LRU, `MAX_DEVICES` (16) entries | 128 KB / device |
| `proxies` (network proxy state) | [`src/tools/flutter-network.ts:42`](../src/tools/flutter-network.ts#L42) | FIFO, `MAX_ENTRIES` (1000) entries per device; removed on `handleStop()` | 1 MB / device |
| `trackers` (rebuild tracking) | [`src/tools/flutter-track-rebuilds.ts:51`](../src/tools/flutter-track-rebuilds.ts#L51) | `MAX_EVENTS_PER_TRACKER` (10,000) events; removed on stop | 2 MB / device |
| `flutterClientCache` | [`src/tools/native-input-backend.ts:670`](../src/tools/native-input-backend.ts#L670) | Per bundleId+deviceId; negative entries expire after `NEGATIVE_CACHE_TTL_MS` (30 s) | 64 KB / entry |
| `pools` (tab manager) | [`src/tools/tab-manager.ts:25`](../src/tools/tab-manager.ts#L25) | Per device; removed on `disposeDevice()` | 256 KB / pool |
| `peakRssBytes` / `sampleCount` (memory tracker) | [`src/metrics/memory-tracker.ts:55`](../src/metrics/memory-tracker.ts#L55) | Process lifetime (scalar integers) | < 1 KB |

## How to Update This Document

When a PR introduces a new module-level `Map`, `Set`, or any variable named
`cached*`, `*Cache`, or `*Pool` at the top level of a `src/**/*.ts` file, add a
row to the table above. Include:

1. The variable name and a short description.
2. A `src/file.ts:LINE` link pointing to the declaration line.
3. The eviction policy — how and when entries are removed.
4. A realistic upper-bound memory estimate.

The contract test in `tests/unit/memory-budget.test.ts` will fail if a documented
source location no longer exists (file deleted or line count changed by more than a
threshold). Update the line number when you move code.

## Testing

`tests/unit/memory-budget.test.ts` enforces this document as follows:

- It reads `docs/memory-budget.md` and parses every `src/` link in the table.
- For each link it asserts that the referenced file exists on disk.
- For rows that mention a named numeric constant (e.g. `INPUT_TELEMETRY_ROLLUP_CAP`,
  `MAX_DEVICES`, `MAX_ENTRIES`, `MAX_LOG_ENTRIES`, `MAX_EVENTS_PER_TRACKER`,
  `PROXY_PORT_RANGE_DEFAULT`, `NEGATIVE_CACHE_TTL_MS`), it reads the source file and
  checks that the constant declaration is present with the correct value, so the doc
  cannot silently drift from the code.

`scripts/check-memory-budget.ts` provides a complementary advisory scan: it greps
all `src/**/*.ts` files for module-level `new Map<` / `new Set<` patterns and warns
(without failing) about any cache that does not appear in this document.
