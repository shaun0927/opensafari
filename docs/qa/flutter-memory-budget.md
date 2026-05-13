# Flutter memory budget validation with OpenSafari

This recipe turns the existing `flutter_allocation_profile` VM Service tool into a merge/post-merge memory check inspired by Flutter DevTools Memory, `leak_tracker`, and memlab.

## Contract

1. Boot a simulator and launch a Flutter debug/profile build.
2. Run `flutter_connect` for the target device/bundle.
3. Capture a baseline with `flutter_allocation_profile` using `gc_before=true`.
4. Perform the user flow under test with OpenSafari app/native/webview tools.
5. Capture a diff with `flutter_allocation_profile` using `gc_before=true` and `diff_against_previous=true`.
6. Evaluate the returned entries with budgets:
   - `maxTotalDeltaBytes`
   - `maxClassDeltaBytes`
   - `maxClassDeltaInstances`
   - `ignoreClassPatterns` for known runtime noise.
7. Store the JSON report as a CI/live-validation artifact.

## Out of scope

- Requiring target apps to include `leak_tracker`.
- Embedding Flutter DevTools.
- Running against release builds where VM Service is unavailable.

## Merge validation

- Unit test: `npm test -- --runTestsByPath tests/unit/flutter-memory-budget.test.ts`
- Live validation: run the baseline/action/diff flow above against a Flutter debug/profile fixture and confirm the budget report passes or fails with top growing classes.
