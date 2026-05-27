# app_pop_until

`app_pop_until` collapses repeated `Navigator.pop` calls (or, in PR2, native
back-gestures) into a single semantic action. It targets one of three
predicates and — when supplied a `postcondition` — verifies the resulting
screen state before reporting success.

## When to use `app_pop_until` vs. `app_tap_element`

- **Use `app_pop_until`** when the goal is "leave this screen / dismiss this
  modal / return to a known route." It works for modal/bottom-sheet routes
  that lack a tappable AppBar back button, and it bounds the number of pops
  by the `until` predicate.
- **Use `app_tap_element`** when the back affordance is a specific button
  (e.g. a custom toolbar). `app_pop_until` is intentionally agnostic to the
  UI affordance.
- **Pair with `app_goto_screen`** when the goal is to *reach* a route rather
  than leave one — that tool dispatches a deeplink and verifies arrival.

## Inputs

```ts
{
  until: 'first' | 'route' | 'count',
  name?: string,           // required when until === 'route'
  count?: number,          // required when until === 'count', positive integer
  device_id?: string,      // optional — falls back to sole booted device
  postcondition?: {
    identifier?: string,
    label?: string,
    text?: string,
    role?: string,
    route?: string,        // ModalRoute.of(root).settings.name (Flutter VM only)
    timeoutMs?: number,    // default 3000
    intervalMs?: number,   // default 250
  },
  maxAttempts?: number,            // bounds native fallback ladder attempts
  interAttemptDelayMs?: number,    // default 250
  forceFallback?: boolean,         // skip the VM path even when connected
}
```

At least one of `identifier`/`label`/`text`/`role`/`route` must be supplied
inside `postcondition` when the field is present. `route` requires an
active Flutter VM connection; in non-VM native fallback contexts provide
`identifier`, `label`, `text`, or `role` so AX can verify the screen. The
AX fields work in both VM and native contexts.

## Response shape

```ts
{
  ok: boolean,                   // true iff postcondition verified (or no postcondition)
  status: 'ok' | 'unverified' | string,
  popped?: number,               // count of successful dispatches for until === 'count'
  target: PopUntil,              // echoed input
  strategy: 'flutter_vm' | 'native_back' | 'edge_swipe' | 'escape_key',
  attempts: [{
    n: number,
    action: string,              // e.g. 'flutter_vm.popUntil'
    elapsedMs: number,
    ok: boolean,
    detail?: string,
  }],
  postcondition: {
    requested: boolean,
    kind?: 'ax_query' | 'route',
    verified?: boolean,
    query?: { identifier?, label?, text?, role? },
    route?: string,
    elapsedMs?: number,
    polls?: number,
    finalMatchCount?: number,
    error?: string,
  }
}
```

When the postcondition is supplied and is **not** verified, the response
sets `isError: true` — downstream auto-retry layers can treat this as a
recoverable failure.

## Failure modes

| ErrorCode | Meaning | Caller action |
|---|---|---|
| `INVALID_INPUT` | `until` enum / `count` shape invalid, or `postcondition` has no signal field | Fix input and retry |
| `MISSING_REQUIRED_PARAM` | `name` missing for `until: 'route'` | Supply `name` |
| `DEVICE_NOT_BOOTED` | No booted simulator and no explicit `device_id` | Boot a device |
| `FLUTTER_VM_NOT_CONNECTED` | VM Service unreachable (release build, etc.) | Native fallback runs automatically; emitted only when fallback also bails |
| `FLUTTER_EVAL_FAILED` | VM evaluate threw or `opensafari_pop:no_root`/`no_navigator` | Inspect attempts[0].detail; re-run `app_context` to confirm UI is mounted |
| `POP_UNTIL_EXHAUSTED` | All native fallback strategies tried without satisfying postcondition | Inspect attempts[], consider a longer `timeoutMs` or a more specific postcondition |
| `POP_UNTIL_NO_FALLBACK_AVAILABLE` | No native input backend selectable (e.g. SimulatorKit HID + PointerService both unavailable) | Connect Flutter VM or boot a different simulator |
| `MISSING_POSTCONDITION` | Native fallback for `until: 'first' \| 'route'` requires a postcondition (route or AX query) | Supply one |

## Examples

Pop everything until you land on the first route, then verify a known
identifier is visible:

```jsonc
{
  "until": "first",
  "postcondition": { "identifier": "home_tab_button", "timeoutMs": 4000 }
}
```

Pop until the `/library` route is current, verifying via the strongest
signal available (Flutter route name):

```jsonc
{
  "until": "route",
  "name": "/library",
  "postcondition": { "route": "/library" }
}
```

Pop exactly twice, then check that a "Saved" label re-appears:

```jsonc
{ "until": "count", "count": 2, "postcondition": { "label": "Saved" } }
```
