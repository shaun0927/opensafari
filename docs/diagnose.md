# `diagnose` Tool Reference

The `diagnose` tool reports backend availability, proxy status, environment, latency rollups, and memory metrics. It is **read-only** — no side effects, no GC, no RPC.

## Output schema

| Field | Type | Description |
|-------|------|-------------|
| `device` | object \| null | Active device info |
| `backends` | object | Per-backend availability (`simctl`, `webkit`, `applescript`, `simhid`) |
| `proxy` | object | ios-webkit-debug-proxy status |
| `environment` | object | Relevant env vars |
| `headless_verdict` | object | `{ safari, native, overall }` booleans |
| `latency` | array | Per-backend latency rollups (p50/p95/p99) |
| `memory` | object | Process memory snapshot (see below) |
| `memory_status` | `"ok"` \| `"warn"` | `"warn"` when RSS exceeds `OPENSAFARI_MEMORY_SOFT_CAP_MB` |

### `memory` block

| Field | Type | Description |
|-------|------|-------------|
| `rss_mb` | number | Current resident set size |
| `peak_rss_mb` | number | Peak RSS since process start |
| `heap_used_mb` | number | V8 heap used |
| `heap_total_mb` | number | V8 heap capacity |
| `external_mb` | number | Off-heap C++ memory |
| `array_buffers_mb` | number | ArrayBuffer allocations |
| `sample_count` | number | Number of RSS samples observed |
| `rss_growth_mb_per_hour` | number \| null | Estimated RSS growth rate |
| `soft_cap_mb` | number \| null | Configured soft cap (env var) |
| `notes` | string[] | Warnings (e.g., cache budget violations) |

## Environment variables

| Var | Default | Effect |
|-----|---------|--------|
| `OPENSAFARI_MEMORY_SOFT_CAP_MB` | unset | When set, `memory_status` turns `"warn"` if RSS exceeds this |
| `OPENSAFARI_TELEMETRY_INCLUDE_MEMORY` | unset | When `1`, input tool `_meta` includes memory snapshot |
