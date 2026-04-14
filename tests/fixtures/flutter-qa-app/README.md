# flutter-qa-app

A minimal Flutter iOS fixture app for opensafari Flutter QA integration tests.
This fixture is referenced by [issue #422](https://github.com/shaun0927/opensafari/issues/422) verification items:

- Verifying `app_tree` populates on a Flutter **release** build after activation.
- Verifying `app_query` finds `Semantics(identifier: ...)` widgets (Flutter 3.19+).

## Bundle ID

```
com.opensafari.fixtures.flutterQaApp
```

## Widget roster and expected AX selectors

| Widget | Expected selector |
|---|---|
| `Semantics(label: 'Login', child: ElevatedButton(...))` | `Semantics(label: 'Login')` |
| `Semantics(identifier: 'login-btn', label: 'Submit', child: ElevatedButton(...))` | `Semantics(identifier: 'login-btn')` |
| `Semantics(identifier: 'email-field', textField: true, label: 'Email', child: TextField(...))` | `Semantics(identifier: 'email-field')` |
| `Text('Counter: $_counter')` | text containing `"Counter:"` |

The `identifier` property maps to `accessibilityIdentifier` on iOS (Flutter 3.19+), which is
what opensafari's `app_query` targets when filtering by identifier.

## How to build and install

```sh
# Build in release mode and install on a booted simulator
./tests/fixtures/flutter-qa-app/build.sh --mode release --device-id <udid> --install

# Build in debug mode without installing
./tests/fixtures/flutter-qa-app/build.sh --mode debug
```

Replace `<udid>` with a booted iOS Simulator UDID. If `--device-id` is omitted the script
picks the first booted simulator automatically.

## Notes

- This fixture is **not** shipped in the npm package -- it is dev/test infrastructure only.
- `pubspec.lock` is committed for reproducibility.
- The app deliberately does **not** call `SemanticsBinding.instance.ensureSemantics()`.
  The release-build verification tests that opensafari's activator handles lazy semantics
  without requiring app-side changes.
