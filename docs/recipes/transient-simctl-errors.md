# Handling Transient simctl Errors

`xcrun simctl` is the canonical hand-off between OpenSafari and the iOS
Simulator. Most subcommands are deterministic, but a small number emit
transient failures or informational stderr that look like errors but are
not. This note documents how OpenSafari currently handles them and the
patterns contributors should follow when wrapping new simctl calls.

## Categories

### 1. Transient surface timeouts

Right after high-velocity input events (e.g. `app_swipe_native` with
`distance >= 2000`, rapid scroll loops, or batched touch sequences),
`simctl io <udid> screenshot` can fail with:

```
The operation couldn't be completed.
Timeout waiting for screen surfaces
```

The simulator has accepted the input but is still compositing the
post-gesture frame; a retry 1–2 s later succeeds. This is documented by
Apple as a transient state, not a failure mode.

**Pattern**: retry with a short backoff. `app_screenshot_native` retries
up to 2 times with a 1.5 s delay (see
`src/tools/app-screenshot-native.ts`,
`captureWithRetry`). The number of retries absorbed is surfaced in the
response metadata as `retries: <n>` so callers can detect and tune for
flakiness.

```ts
// src/tools/app-screenshot-native.ts (excerpt)
if (!isTransientScreenshotError(msg) || attempt === SCREENSHOT_MAX_RETRIES) {
  throw err;
}
await sleep(SCREENSHOT_RETRY_DELAY_MS);
```

If you wrap a new simctl invocation that runs after high-velocity input,
follow this shape. Do **not** widen the retry pattern beyond
`Timeout waiting for screen surfaces` — other simctl failures (invalid
device state, unknown UDID, permission errors) are not transient and
must fail fast.

### 2. Informational stderr prefixes

Some simctl subcommands print informational lines on stderr even on
success. The most common is `simctl io … screenshot`:

```
Note: No display specified. Defaulting to display: <uuid> ...
```

Because `SimctlError` concatenates stderr verbatim into the error
message, these informational lines previously surfaced to MCP callers
as part of a failure response, masking the actual failure cause.

**Pattern**: filter known-informational prefixes before surfacing. The
filter lives in `stripInformationalStderr` in
`src/tools/app-screenshot-native.ts`. Keep the regex list narrow — only
add prefixes that Apple emits unconditionally on the success path.

```ts
const STDERR_NOISE_PATTERNS: RegExp[] = [
  /Note: No display specified\.[^\n]*/g,
];
```

When adding a new entry, write a unit test that asserts the failure
message *with* and *without* the prefix produces the same caller-visible
string for the success path, and a separate hard-failure path keeps the
underlying cause readable.

## When NOT to retry / filter

- **Invalid device state** (`Shutdown`, `Booting`, `Booted` mismatches):
  retrying does not help; surface immediately so the caller can boot or
  switch device.
- **Unknown UDID**: configuration error; surface immediately.
- **Permission errors** (TCC, sandbox): require human/automation
  intervention; surface immediately.
- **Any prefix the user can plausibly act on**: do not filter it out.

## Test conventions

For each retry / filter you introduce, add at minimum:

1. A unit test that the transient failure → retry → success path
   returns success (and the retry counter is reflected in metadata).
2. A unit test that the informational stderr is filtered out of a
   success response.
3. A unit test that a hard failure exhausts the retry budget and
   returns `isError: true` with a human-readable message.

See `tests/unit/app-screenshot-native.test.ts` for the canonical
example.

## Related

- Issue #651 — original report of both classes of bug
- PR #658 — `app_screenshot_native` retry + stderr filter
- PR #659 — `app_handle_alert` Tier 2.5 keyboard fallback (separate
  reliability fix on the alert path; transient-timeout handling is
  unrelated to alert handling)
