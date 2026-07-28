# OpenSafari Product Direction

**Status:** Canonical repository source of truth  
**Last reviewed:** 2026-07-28  
**Historical origin:** [issue #795](https://github.com/shaun0927/opensafari/issues/795)

## Purpose

OpenSafari is a portable, MCP-native automation, debugging, and parallel QA
runtime for real Apple-platform application surfaces. Its core product is real
iOS Simulator QA across Safari, native UIKit/SwiftUI apps, Flutter apps, and
embedded WebViews. Bounded host macOS automation is an adjacent surface when it
reuses the same semantic, evidence, and safety contracts.

The product direction is not to accumulate raw input tools. OpenSafari should
let any standards-compliant MCP client read state, express user intent, verify
postconditions, recover from transient failures, and collect compact evidence
without relying on client-specific prompts or manual simulator operation.

## Product Position

OpenSafari combines:

- real Xcode Simulator fidelity
- direct WebKit, Accessibility, Flutter VM, SimulatorKit, and `simctl`
  integration
- portable MCP tool contracts
- semantic actions with explicit postconditions
- local, redacted debugging evidence
- multi-simulator orchestration and comparable per-device results

OpenSafari is not an Appium clone, a generic XCTest replacement, an Android
automation runtime, a production credential manager, or a raw coordinate-input
library. Backend-specific primitives remain useful implementation tools, but
they are not the primary product contract.

## Supported Surfaces

| Surface | Product tier | Current status | Boundary |
|---|---|---|---|
| Safari in iOS Simulator | Core | Stable | Direct WebKit Remote Debugging through the simulator Web Inspector path |
| Native UIKit/SwiftUI apps in iOS Simulator | Core | Stable for lifecycle, AX inspection, and element-targeted actions | Coordinate-only input on newer Xcode releases has separate stability limits |
| Flutter apps in iOS Simulator | Core | Stable through AX; evolving through optional VM Service features | VM Service features require debug/profile builds and must degrade cleanly when unavailable |
| Native-app WebViews | Core | Evolving | Target identity depends on Web Inspector metadata and proxy capabilities |
| Parallel simulator workflows | Core | Evolving | Per-device results and partial failures are required; readiness and recovery still need hardening |
| Host macOS app/TestFlight QA | Adjacent Tier 2 | Evolving | Must remain bounded, evidence-driven, and separate from simulator-scoped device contracts |
| Physical iOS devices | Research only | Unproven | No production-ready claim until dedicated-device workflows are validated end to end |

Backend-specific stability details live in
[the iOS 26 input investigation](simhid-ios26-investigation.md#stability-commitments).
That document is authoritative for input-backend stability; this document is
authoritative for product scope and direction.

## Product Principles

### Portable MCP contracts first

The target contract for every agent-facing capability is a stable tool name,
explicit JSON schema, structured response, device/session identity, and
actionable failure information. A client should be able to choose its next
action without parsing free-form logs. Legacy handlers that have not completed
the structured-error migration are compatibility debt, not examples to copy.

### Semantic intent over raw operations

Prefer tools such as `app_goto_screen`, `app_wait_for`, `app_tap_element`,
`app_type_element`, `app_dismiss_overlay`, and `app_pop_until` over unverified
coordinate input. Sending a tap, opening a URL, or injecting text is transport
success; reaching the expected app state is product success.

### Read state before mutation

Agents should inspect current context before relaunching, resetting, clearing
permissions, or restoring authentication state. Destructive recovery must be
explicit and justified by observed state.

### Debugging evidence is a first-class surface

High-level failures should be explainable from local evidence such as a
screenshot, AX summary, app/context state, Flutter route, recent logs, crash
reports, backend health, network state, timing, and action trace. Evidence must
be compact and redacted by default.

### Parallel execution produces structured partial results

Fleet workflows must report each device independently, preserve artifacts per
device, and distinguish initialization failure from action failure. A fleet is
not ready merely because an initialization function returned.

### Backends are implementation details

WebKit, AX, Flutter VM Service, SimulatorKit, PointerService, `simctl`, proxy
processes, and AppleScript fallbacks may change independently. Public responses
should expose the selected backend and fallback evidence without forcing
ordinary clients to understand backend internals.

### Safety and privacy are product contracts

Authentication, OTP, biometric, keychain, TestFlight, and purchase-related
tools are local test accelerators. They must be explicit, redacted,
audit-friendly, and gated where transport or side effects increase risk.
Credentials, Apple ID secrets, 2FA codes, session tokens, and App Store Connect
private keys must not be requested through ordinary OpenSafari tool parameters
or written to artifacts.

## Capability Status

Status words have repository-wide meaning:

- **Stable:** default-on behavior with unit coverage and appropriate live or
  sentinel validation.
- **Evolving:** shipped and usable, but contracts or fallback behavior may
  still change as reliability gaps are closed.
- **Experimental:** opt-in behavior with known platform risk or incomplete
  validation.
- **Research only:** evidence or prototypes exist, but the repository makes no
  production-readiness claim.
- **Unsupported:** outside the current product boundary.

### Shipped foundations

- Safari navigation, inspection, cookies, screenshots, and iOS-specific QA
- simulator lifecycle, native app lifecycle, AX tree/query/press, alerts, and
  semantic element interaction
- Flutter AX automation plus optional VM Service inspection and profiling
- native WebView discovery and context switching with documented metadata limits
- read-only state snapshots, shared settle policies, semantic navigation, and
  scenario v2
- debug bundles, action traces, logs, crash evidence, and redaction
- batch tools, barriers, cross-device assertions/comparison, warm-pool and
  golden-device foundations
- browser and native auth profiles, biometric controls, developer/test OTP
  retrieval, and HTTP high-risk gating
- network interception, offline/throttle controls, and HAR capture
- bounded host macOS/TestFlight inspection and safe install/update/open actions

### Active hardening priorities

1. Complete structured error migration across all tools; no raw `isError`
   envelope should escape the shared taxonomy.
2. Make fleet initialization fail closed and preserve per-device readiness,
   attempts, and recovery evidence.
3. Bind native auth profiles to the intended bundle and device before restore;
   a mismatched target must fail before any container or keychain mutation.
4. Keep network/interceptor/HAR state session-scoped, observable, and reliably
   cleaned up or rehydrated.
5. Improve live validation for WebView identity, AX recovery, and host macOS
   TestFlight without widening credential or purchase authority.
6. Keep private-API sentinels tied to verified contract failures rather than CI
   setup, timeout, or runner-image noise.

## Semantic QA Contract

A high-level action should report:

- state observed before dispatch
- semantic target and selected strategy
- backend and fallback path
- postcondition and settle policy
- verification result and elapsed time
- structured error code, recoverability, and suggested next action on failure
- compact evidence or a debug-bundle reference when useful

Scenario execution must preserve this shape per step and per device. Existing
v1 browser scenarios remain compatible; mobile semantic scenarios use explicit
steps and start from current state unless `launchApp` is requested.

See [Mobile semantic QA runtime](mobile-semantic-qa.md) for the runtime contract
and [Debug bundle](debug-bundle.md) for evidence details.

## Architecture Boundaries

```text
MCP clients
    -> stable tool contracts and structured errors
    -> session, orchestration, safety, and evidence layers
    -> iOS Simulator backends
         - WebKit Remote Debugging for Safari/WebViews
         - AX bridge for semantic native inspection and actions
         - Flutter VM Service for optional debug/profile capabilities
         - simctl and SimulatorKit for lifecycle and input
    -> adjacent host macOS AX/TestFlight backends
```

Core iOS tools are device-scoped. Host macOS tools must not silently reuse or
invent simulator `deviceId` semantics. WebKit-specific constraints apply only
to the Safari/WebView backend, not to the entire product architecture.

## Explicit Non-Goals

- re-platforming on Appium, WebDriver, Playwright, or a bundled browser
- Android automation
- production authentication or identity-provider behavior
- unattended Apple ID, sandbox-account, 2FA, or tester-enrollment handling
- fictional runtime StoreKit configuration through `simctl`
- default-on focus stealing or unverified coordinate input
- production-ready physical-device automation claims without dedicated live
  validation

## Documentation Hierarchy

Use this order when documents disagree:

1. this product-direction document
2. capability and stability documents
3. registered MCP schemas and feature-specific runtime contracts; the API
   reference is supplemental until its catalog is complete
4. recipes and operational guides
5. ADRs, RFCs, spikes, issues, and pull requests as historical rationale

Issues and pull requests may explain why a decision was made, but the committed
repository must be sufficient to understand current scope without GitHub access.

## Change Policy

Any change to product scope, a stable contract, a safety boundary, or a
capability status must update this document in the same pull request. A feature
may be promoted from experimental/evolving to stable only when its default
behavior, failure contract, tests, and platform-specific validation agree.

Any PR adding or changing an agent-facing tool must answer:

1. What user intent does the tool represent?
2. What postcondition proves success?
3. Which structured errors are recoverable, and what should the client do next?
4. Which backend and fallback metadata are exposed?
5. What evidence is available on failure?
6. How does the tool behave with multiple sessions or devices?
7. Does it require destructive or high-risk gating?
8. Are secrets and account data redacted?
9. Is unit coverage present, and is live validation required?
10. Which canonical documentation must change?
