# Extending the alert button label corpus

`app_handle_alert` classifies a candidate AX node as `accept` / `dismiss` by
matching its label against a corpus baked into
[`src/tools/app-handle-alert-labels.ts`](../../src/tools/app-handle-alert-labels.ts).
The corpus ships with English, Korean, Japanese, and Simplified Chinese
variants for the buttons Apple's first-party permission sheets render on iOS
26.

If your app surfaces a localized banner whose button text is **not** part of
this corpus — for example an Apple Intelligence onboarding pane, an
in-house consent sheet, or an unsupported locale — you can extend the corpus
at runtime via `registerExtraLabels`:

```ts
import {
  registerExtraLabels,
  type AlertAction,
  type AlertLocale,
} from 'opensafari/tools/app-handle-alert-labels';

// At process startup, before any app_handle_alert call:
registerExtraLabels('accept', 'ko', [
  '계속하기',          // app-specific "Continue"
  'Apple Intelligence 사용', // onboarding banner
]);
registerExtraLabels('dismiss', 'ko', [
  '나중에 하기',
]);
```

Behavior:

- Added labels participate in both `matchLabel()` and `flattenLabels()`
  immediately. No restart is required.
- Duplicates (exact string equality, before normalization) are silently
  skipped.
- Calls are additive; there is intentionally no `clearExtraLabels()` —
  removing a label means restarting the process. This keeps test
  isolation and crash-recovery semantics simple.
- Labels are normalized at match time (NFC, fancy-whitespace collapse,
  case-folding), so you do **not** need to pre-normalize the strings you
  register.

## Why a registry rather than a config file?

Per-app extensions tend to be tightly coupled to the app's own resource
bundle: the canonical source of truth for button text is the same `.strings`
file the app already uses for its UI. Treating `registerExtraLabels` as a
runtime API lets the host app emit the labels it actually ships with,
without forking opensafari or maintaining a separate JSON manifest that can
drift.

## Limitations

`pasteboard-input.ts` keeps its own paste-permission corpus
(`ACCEPT_PASTE_LABELS`) for now. If you also need to extend that corpus,
file a follow-up — the same pattern can be added without touching the
public API of either module.

## Related

- Issue #639 Problem 4c — corpus extensibility for iOS 26 button text.
