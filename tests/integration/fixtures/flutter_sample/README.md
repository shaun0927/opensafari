# osftest

Flutter fixture for opensafari live integration tests.

## Structure

Every interactive widget is normally wrapped in `Semantics(identifier:, label:)`
so the accessibility bridge can locate it without relying on implementation-
detail labels Flutter generates for raw widgets. The `status_label` Text is
the canonical signal each test reads back to confirm a tap or keystroke
actually landed on the right element.

### Bare GestureDetector (no `Semantics`)

A `GestureDetector` wrapped in an amber `Container` lives near the top of the
home `ListView`, right after `status_label`. It is **intentionally not wrapped
in `Semantics`** so coordinate-only taps that do not hit any `Semantics` node
can still be observed: tapping it sets `_status = 'bare:<count>'` and the
change propagates through the existing `status_label` readback.

This region is the coordinate-tap surface used by
`tests/integration/pointer-service.live.test.ts` (issue #590 Phase 1). Do not
add a `Semantics` wrapper around it — that would defeat the test.

## Rebuild & install

Dart source changes require rebuilding the iOS Runner and reinstalling on the
target simulator before live tests can exercise them:

```
cd tests/integration/fixtures/flutter_sample
flutter install --device-id <udid>
```

## Upstream docs

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)
