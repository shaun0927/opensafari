# Debug bundle

OpenSafari's `debug_bundle_collect` MCP tool composes existing debugging
helpers (screenshot, AX tree summary, system/app logs, fresh crash
reports, Flutter route, action trace) into a single compact JSON payload.
The intent is to make a failed semantic action *explainable without
manually re-running the simulator flow* (#795 SSOT P1 — Mobile debugging
bundle).

## Schema (v1)

```ts
{
  schemaVersion: '1',
  collectedAt: '2026-05-27T12:34:56.789Z',
  device: { udid, name?, state? },
  session: { soleDeviceId },
  diagnose: { memory: { rss_mb, peak_rss_mb, heap_used_mb, heap_total_mb, sample_count } }
            | { error: string },
  screenshot: { path: string, bytes: number } | { error } | { skipped: true },
  ax:         { rootRole, childCount, depth, path? } | { error } | { skipped: true },
  logs:       { tail, lineCount, window, path?, redactionTags } | { error } | { skipped: true },
  crashes:    [{ filename, mtimeMs }] | { error } | { skipped: true },
  flutter:    { connected, route?, error? } | { skipped: true },
  network:    { hint } | { skipped: true },
  actionTrace: [{ action, status, context, startedAtMs, endedAtMs }],
  redactions: { applied: string[], policy: 'default-v1' }
}
```

Every evidence section is best-effort: an individual collector failure
shows up inline as `{ error: '...' }` rather than failing the bundle.
Only "no booted device and no `deviceId` supplied" surfaces as an MCP
error response (`ErrorCode.DEVICE_NOT_BOOTED`).

## Redaction (default-v1)

`src/observability/redaction.ts` scrubs the following patterns from logs
and stringified diagnose output:

- `Bearer <token>` → `Bearer [REDACTED]`
- `Authorization: <value>` → `Authorization: [REDACTED]`
- JWTs (`eyJ...` 3-segment) → `[REDACTED_JWT]`
- AWS access keys (`AKIA…`) → `[REDACTED_AWS_KEY]`
- GitHub PATs (`ghp_… / ghs_…`) → `[REDACTED_GH_TOKEN]`
- Env keys matching
  `/token|secret|password|api[_-]?key|credential|authorization|cookie|session/i`
  → value replaced with `[REDACTED]`

`redactions.applied` surfaces the unique set of tags that scrubbed
anything (e.g. `logs.bearer`, `env.AUTH_TOKEN`) so an agent can audit
what was scrubbed without seeing the secret itself.

## Auto-attach on failure (#798 PR2)

Five action tools accept an opt-in input parameter:

| Tool | Parameter |
|---|---|
| `app_tap_element` | `collectDebugBundleOnFailure: boolean` |
| `app_type_element` | `collectDebugBundleOnFailure: boolean` |
| `app_goto_screen` | `collectDebugBundleOnFailure: boolean` |
| `app_pop_until` | `collectDebugBundleOnFailure: boolean` |
| `app_dismiss_overlay` | `collectDebugBundleOnFailure: boolean` |

When the parameter is `true` **and** the tool returns a recoverable
error envelope (per the `ERROR_CATALOG` `recoverable` flag), the response
payload gains two fields:

```jsonc
{
  "error": "DEVICE_NOT_BOOTED",
  "message": "…",
  "recoverable": true,
  "suggestion": "…",
  "debugBundle": { /* DebugBundle */ },
  "debugBundleTool": "app_tap_element"
}
```

Irrecoverable codes (e.g. `RESOURCE_EXHAUSTED`,
`POP_UNTIL_NO_FALLBACK_AVAILABLE`) are *not* bundled — there is no retry
the agent can do, so the bundle would be waste.

### Global env override

Setting `OPENSAFARI_DEBUG_BUNDLE_ON_FAILURE=1` (or `=true`/`=yes`)
forces auto-attach on for the 5 wired tools regardless of the per-call
parameter. Useful for CI runs where every recoverable failure should
carry evidence.

## Artifacts

By default, `screenshot.png`, `ax-tree.json`, and `logs.txt` are written
to `${TMPDIR}/opensafari-debug/<iso-timestamp>/`. Pass `artifactDir` to
override.

## Out of scope

- HAR / network-intercept capture lifecycle is owned by its tool today.
  `debug_bundle_collect` reports a placeholder when `includeNetwork:
  true` is passed; auto-attach defaults to `includeNetwork: false`.
- Bundles are not compressed or uploaded anywhere — the artifact paths
  are local to the host. An agent that wants to ship them upstream can
  read the files itself.
