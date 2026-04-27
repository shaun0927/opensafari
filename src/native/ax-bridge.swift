#!/usr/bin/env swift
//
// ax-bridge.swift — Accessibility tree bridge for iOS Simulator
//
// Reads the native accessibility tree from a running iOS Simulator
// via the macOS AXUIElement API. Outputs structured JSON to stdout.
//
// Usage:
//   ax-bridge dump   --device <UDID|device-name|booted|any> [--max-depth N]
//   ax-bridge query  --device <UDID|device-name|booted|any> [--id X] [--label X] [--text X] [--role X]
//   ax-bridge inspect --device <UDID|device-name|booted|any> --path <index-path>
//   ax-bridge press   --device <UDID|device-name|booted|any> --path <index-path>
//

import ApplicationServices
import Foundation

// MARK: - JSON Output Types

struct AXNodeJSON: Codable {
    let role: String
    let label: String?
    let value: String?
    let identifier: String?
    let traits: [String]
    let frame: FrameJSON
    let visible: Bool
    let enabled: Bool
    let focused: Bool
    let children: [AXNodeJSON]?
    let path: String
    // Issue #41: only emitted on the root node returned by `dump` and on the
    // node returned by a successful `inspect`. Optional so per-child nodes
    // do not carry the noise — the wrapper only ever inspects the top-level
    // value to decide whether to promote a result to APP_CONTENT_NOT_EXPOSED.
    var chromeOnly: Bool?

    init(role: String, label: String?, value: String?, identifier: String?,
         traits: [String], frame: FrameJSON, visible: Bool, enabled: Bool,
         focused: Bool, children: [AXNodeJSON]?, path: String,
         chromeOnly: Bool? = nil) {
        self.role = role
        self.label = label
        self.value = value
        self.identifier = identifier
        self.traits = traits
        self.frame = frame
        self.visible = visible
        self.enabled = enabled
        self.focused = focused
        self.children = children
        self.path = path
        self.chromeOnly = chromeOnly
    }
}

struct FrameJSON: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct QueryResultJSON: Codable {
    let matches: [AXNodeJSON]
    let total: Int
    let query: QueryJSON
    let ambiguous: Bool
    // Issue #41: chromeOnly is computed from the same content tree the query
    // was evaluated against. The wrapper uses it to promote `total: 0`
    // results into typed APP_CONTENT_NOT_EXPOSED instead of issuing a
    // second native dump call.
    let chromeOnly: Bool
}

struct QueryJSON: Codable {
    let identifier: String?
    let label: String?
    let text: String?
    let role: String?
    let traits: [String]?
}

struct ErrorJSON: Codable {
    let error: String
    let code: String
}

/// Issue #41: ELEMENT_NOT_FOUND emitted by `inspect` carries the same
/// `chromeOnly` flag the wrapper relies on for query/dump promotion. The
/// wrapper inspects this field to decide whether to upgrade the response
/// to APP_CONTENT_NOT_EXPOSED.
struct InspectNotFoundJSON: Codable {
    let error: String
    let code: String
    let path: String
    let found: Bool
    let chromeOnly: Bool
}

/// Uniform response for `ax-bridge press`.
///
/// A non-zero exit code is reserved for unrecoverable bridge-level problems
/// (accessibility permission denied, simulator not running, unknown
/// command, missing argument). Anything specific to the press operation —
/// element not actionable, live `AXUIElementPerformAction` failure — is
/// reported in-band with `ok: false` and a stable `code`. The TypeScript
/// caller treats `PRESS_NOT_ACTIONABLE` as "fall back to coordinate tap"
/// and `PRESS_FAILED` as "surface to the user".
struct PressResponseJSON: Codable {
    let ok: Bool
    let code: String
    let path: String
    let actions: [String]
    let role: String?
    let identifier: String?
    let label: String?
    // Use `message` instead of `error` so the uniform response does not
    // collide with AccessibilityBridge's stdout-level error-shape detector
    // (`if (parsed.error) throw ...`). Bridge-level errors — permission
    // denied, simulator not running, unknown command — still use
    // `outputError` and exit non-zero, which routes through the existing
    // throw path.
    let message: String?
    let axErrorCode: Int32?
}

// MARK: - AXUIElement Helpers

// Issue #660: Per-element messaging timeout for every AXUIElement the
// bridge touches. Without this, `AXUIElementCopyAttributeValue` against
// an unresponsive system process (SpringBoard hosting a permission
// sheet, a Simulator window whose AX server has degraded) blocks for
// the AX framework's 6 s default — long enough that the wrapper's own
// timeout fires first and the bridge looks like it has hung silently.
//
// Setting a 1.5 s timeout makes those blocks return
// `kAXErrorCannotComplete` (-25204) which the call sites already treat
// as "attribute unavailable", so the dump returns a partial tree
// quickly instead of dragging the whole pipeline. The TS wrapper then
// surfaces the partial result and the caller can fall back to its
// keyboard-fallback path (#659) or its retry policy.
//
// `AXUIElementSetMessagingTimeout` is per-element: it does NOT
// propagate from a parent to children, so we apply it everywhere a new
// element enters the bridge — at the application root in `main()` and
// at every child returned by `getChildren()`. The matched-window and
// content-root paths are covered transitively because both arrive via
// `getChildren()` walks.
let AX_MESSAGING_TIMEOUT_SECONDS: Float = 1.5

@discardableResult
func setAxMessagingTimeoutSafe(_ element: AXUIElement,
                               _ seconds: Float = AX_MESSAGING_TIMEOUT_SECONDS) -> AXError {
    return AXUIElementSetMessagingTimeout(element, seconds)
}

func getStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? String
}

func getBoolAttr(_ element: AXUIElement, _ attr: String) -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return false }
    if let num = value as? NSNumber { return num.boolValue }
    if let str = value as? String { return str == "1" || str.lowercased() == "true" }
    return false
}

func getPosition(_ element: AXUIElement) -> (Double, Double)? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as String as CFString, &value) == .success,
          let axValue = value else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(axValue as! AXValue, .cgPoint, &point) else { return nil }
    return (Double(point.x), Double(point.y))
}

func getSize(_ element: AXUIElement) -> (Double, Double)? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as String as CFString, &value) == .success,
          let axValue = value else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(axValue as! AXValue, .cgSize, &size) else { return nil }
    return (Double(size.width), Double(size.height))
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as String as CFString, &value) == .success else {
        return []
    }
    let children = (value as? [AXUIElement]) ?? []
    // Issue #660: every child entering the bridge gets the messaging
    // timeout applied so subsequent attribute reads on it can't hang
    // for the framework's 6 s default. See `setAxMessagingTimeoutSafe`
    // for rationale.
    for child in children {
        setAxMessagingTimeoutSafe(child)
    }
    return children
}

// MARK: - Tree Building

func buildNode(_ element: AXUIElement, path: String, maxDepth: Int, currentDepth: Int,
               originX: Double = 0, originY: Double = 0) -> AXNodeJSON {
    let role = getStringAttr(element, kAXRoleAttribute as String) ?? "unknown"
    let title = getStringAttr(element, kAXTitleAttribute as String)
    let desc = getStringAttr(element, kAXDescriptionAttribute as String)
    let label = title ?? desc
    let value = getStringAttr(element, kAXValueAttribute as String)
    let identifier = getStringAttr(element, kAXIdentifierAttribute as String)

    let pos = getPosition(element) ?? (0, 0)
    let sz = getSize(element) ?? (0, 0)

    let enabled = !getBoolAttr(element, "AXElementBusy")
    let focused = getBoolAttr(element, kAXFocusedAttribute as String)
    let visible = sz.0 > 0 && sz.1 > 0

    var traits: [String] = []
    if let subrole = getStringAttr(element, kAXSubroleAttribute as String) {
        traits.append(subrole)
    }
    if let roleDesc = getStringAttr(element, kAXRoleDescriptionAttribute as String), roleDesc != role {
        traits.append(roleDesc)
    }

    // Normalize position relative to simulator window origin
    let frame = FrameJSON(
        x: pos.0 - originX,
        y: pos.1 - originY,
        width: sz.0,
        height: sz.1
    )

    var childNodes: [AXNodeJSON]? = nil
    if currentDepth < maxDepth {
        let children = getChildren(element)
        if !children.isEmpty {
            childNodes = children.enumerated().map { (i, child) in
                buildNode(child, path: path.isEmpty ? "\(i)" : "\(path)/\(i)",
                          maxDepth: maxDepth, currentDepth: currentDepth + 1,
                          originX: originX, originY: originY)
            }
        }
    }

    return AXNodeJSON(
        role: role, label: label, value: value, identifier: identifier,
        traits: traits, frame: frame, visible: visible, enabled: enabled,
        focused: focused, children: childNodes, path: path
    )
}

// MARK: - Simulator Discovery

struct SimulatorDeviceRecord {
    let udid: String
    let name: String
    let runtimeIdentifier: String
    let state: String
}

struct WindowCandidate {
    let window: AXUIElement
    let score: Int
    let title: String
    let identifier: String
}

func runCommand(_ launchPath: String, arguments: [String]) -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: launchPath)
    task.arguments = arguments
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try? task.run()
    // Drain stdout BEFORE waiting for exit. Swift `Process` pipes have a
    // ~64KB in-kernel buffer; if the child writes more than that, its
    // `write` blocks until something reads, and `waitUntilExit()` then
    // hangs forever (classic pipe deadlock). `simctl list devices -j`
    // output easily exceeds 64KB on machines with many runtimes.
    // stderr is redirected to /dev/null so only stdout can fill up.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    guard task.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)
}

func findSimulatorPID() -> pid_t? {
    guard let output = runCommand("/usr/bin/pgrep", arguments: ["-x", "Simulator"])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
          let pid = Int32(output.components(separatedBy: "\n").first ?? "") else {
        return nil
    }
    return pid
}

func listSimulatorDevices() -> [SimulatorDeviceRecord] {
    guard let output = runCommand("/usr/bin/xcrun", arguments: ["simctl", "list", "devices", "-j"]),
          let data = output.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let devices = root["devices"] as? [String: Any] else {
        return []
    }

    var records: [SimulatorDeviceRecord] = []
    for (runtimeIdentifier, value) in devices {
        // Only include iOS Simulator runtimes. watchOS, tvOS, visionOS/xrOS
        // simulators share the same simctl output but are irrelevant to this
        // bridge which targets iOS Simulator windows exclusively.
        let isIOSRuntime = runtimeIdentifier.contains("com.apple.CoreSimulator.SimRuntime.iOS")
            || runtimeIdentifier.hasPrefix("iOS ")
        guard isIOSRuntime else { continue }
        guard let entries = value as? [[String: Any]] else { continue }
        for entry in entries {
            guard let udid = entry["udid"] as? String,
                  let name = entry["name"] as? String,
                  let state = entry["state"] as? String else {
                continue
            }
            let isAvailable = (entry["isAvailable"] as? Bool) ?? true
            guard isAvailable else { continue }
            records.append(SimulatorDeviceRecord(
                udid: udid,
                name: name,
                runtimeIdentifier: runtimeIdentifier,
                state: state
            ))
        }
    }
    return records
}

func windowDiagnostics(_ windows: [AXUIElement]) -> [String] {
    windows.map { window in
        let title = getStringAttr(window, kAXTitleAttribute as String) ?? "<untitled>"
        let identifier = getStringAttr(window, kAXIdentifierAttribute as String) ?? ""
        return identifier.isEmpty ? title : "\(title) [id=\(identifier)]"
    }
}

func resolveRequestedDevice(_ requested: String) -> (target: SimulatorDeviceRecord?, error: ErrorJSON?) {
    if requested == "any" { return (nil, nil) }

    let devices = listSimulatorDevices()
    let booted = devices.filter { $0.state == "Booted" }

    if requested == "booted" {
        if booted.count == 1 { return (booted[0], nil) }
        if booted.isEmpty {
            return (nil, ErrorJSON(
                error: "Requested booted device, but no booted simulators were found.",
                code: "DEVICE_RESOLUTION_FAILED"
            ))
        }
        return (nil, ErrorJSON(
            error: "Requested booted device, but found multiple booted simulators: \(booted.map { $0.name })",
            code: "DEVICE_RESOLUTION_AMBIGUOUS"
        ))
    }

    let udidMatches = devices.filter { $0.udid.caseInsensitiveCompare(requested) == .orderedSame }
    if let device = udidMatches.first {
        guard device.state == "Booted" else {
            return (nil, ErrorJSON(
                error: "Requested device \(requested) resolved to \(device.name), but that simulator is not booted.",
                code: "DEVICE_RESOLUTION_FAILED"
            ))
        }
        return (device, nil)
    }

    // Search ALL devices by name first, then filter by boot state. This
    // mirrors the UDID path: an existing-but-not-booted device returns a
    // specific "device exists but not booted" error instead of a generic
    // "couldn't resolve" that hides the root cause from the caller.
    let allNameMatches = devices.filter { $0.name == requested }
    let bootedNameMatches = allNameMatches.filter { $0.state == "Booted" }
    if bootedNameMatches.count == 1 { return (bootedNameMatches[0], nil) }
    if bootedNameMatches.count > 1 {
        return (nil, ErrorJSON(
            error: "Requested device name '\(requested)' matched multiple booted simulators: \(bootedNameMatches.map { $0.udid })",
            code: "DEVICE_RESOLUTION_AMBIGUOUS"
        ))
    }
    if !allNameMatches.isEmpty {
        return (nil, ErrorJSON(
            error: "Requested device name '\(requested)' matched \(allNameMatches.count) simulator(s) (\(allNameMatches.map { $0.udid })), but none are booted.",
            code: "DEVICE_RESOLUTION_FAILED"
        ))
    }

    return (nil, ErrorJSON(
        error: "Could not resolve requested device '\(requested)' to a simulator via simctl list devices -j.",
        code: "DEVICE_RESOLUTION_FAILED"
    ))
}

func scoreWindow(_ window: AXUIElement, requested: String, target: SimulatorDeviceRecord?) -> WindowCandidate? {
    let title = getStringAttr(window, kAXTitleAttribute as String) ?? ""
    let identifier = getStringAttr(window, kAXIdentifierAttribute as String) ?? ""

    if requested == "any" {
        return WindowCandidate(window: window, score: 1, title: title, identifier: identifier)
    }

    guard let target = target else { return nil }

    var score = 0
    if title.contains(target.udid) || identifier.contains(target.udid) { score = max(score, 1000) }
    if title == target.name || identifier == target.name { score = max(score, 900) }
    if title.contains(target.name) || identifier.contains(target.name) { score = max(score, 800) }
    if title.hasPrefix("\(target.name) –") || title.hasPrefix("\(target.name) -") { score = max(score, 850) }

    guard score > 0 else { return nil }
    return WindowCandidate(window: window, score: score, title: title, identifier: identifier)
}

func findMatchingWindow(_ app: AXUIElement, requested: String, target: SimulatorDeviceRecord?) -> (window: AXUIElement?, error: ErrorJSON?) {
    let windows = getChildren(app)
    guard !windows.isEmpty else {
        return (nil, ErrorJSON(
            error: "Simulator.app is running but no accessibility windows were found.",
            code: "DEVICE_WINDOW_NOT_FOUND"
        ))
    }

    if requested == "any" {
        if let first = windows.first { return (first, nil) }
    }

    let candidates = windows.compactMap { scoreWindow($0, requested: requested, target: target) }
    let sorted = candidates.sorted { lhs, rhs in
        if lhs.score != rhs.score { return lhs.score > rhs.score }
        return lhs.title < rhs.title
    }

    guard let best = sorted.first else {
        return (nil, ErrorJSON(
            error: "Could not map requested device \(requested) to a Simulator window. Visible windows: \(windowDiagnostics(windows))",
            code: "DEVICE_WINDOW_NOT_FOUND"
        ))
    }

    // Primary rule: if more than one window shares the top score, the match is
    // ambiguous regardless of whether the titles are identical or different
    // and regardless of score tier. Even at the UDID-exact tier (score=1000),
    // two windows matching the same UDID must not be silently collapsed to
    // one — that would route AX traffic to an arbitrary simulator. Surface
    // DEVICE_WINDOW_AMBIGUOUS on every score tie.
    let topScorePeers = sorted.filter { $0.score == best.score }
    if topScorePeers.count > 1 {
        let peerTitles = topScorePeers.map { $0.title }
        return (nil, ErrorJSON(
            error: "Requested device \(requested) matched multiple Simulator windows with the same confidence: \(peerTitles)",
            code: "DEVICE_WINDOW_AMBIGUOUS"
        ))
    }

    return (best.window, nil)
}

// MARK: - Device Content Root Search

/// Exact case-sensitive labels that belong to the Simulator chrome — buttons
/// in the title bar, toolbar, and menu bar. Any node whose `AXLabel` matches
/// is rejected so a chrome-only shape cannot score as a content-root
/// candidate.
let SimulatorChromeDenylistExact: Set<String> = [
    "Action", "Home", "Save Screen", "Rotate",
    "Volume Up", "Volume Down", "Sleep/Wake",
    "AXCloseButton", "AXFullScreenButton", "AXMinimizeButton"
]

/// Matches the simulator window title shape
/// ("iPhone 16 Verify 77-80 – iOS 26.4"). The separator is a literal em
/// dash, not an ASCII hyphen — that is what Simulator emits.
func isSimulatorWindowTitleLabel(_ label: String) -> Bool {
    return label.hasPrefix("iPhone ") && label.contains(" – iOS ")
}

func isChromeLabel(_ label: String?) -> Bool {
    guard let label = label, !label.isEmpty else { return false }
    if SimulatorChromeDenylistExact.contains(label) { return true }
    if isSimulatorWindowTitleLabel(label) { return true }
    return false
}

/// AX roles that indicate a subtree exposes app-level semantics. Chrome
/// buttons (denylisted labels) are excluded from this count at scoring time.
let AppSemanticsRoles: Set<String> = [
    "AXTextField", "AXStaticText", "AXButton", "AXCell", "AXImage", "AXLink"
]

struct ContentRect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func getFrameRect(_ element: AXUIElement) -> ContentRect? {
    guard let pos = getPosition(element), let sz = getSize(element) else { return nil }
    return ContentRect(x: pos.0, y: pos.1, width: sz.0, height: sz.1)
}

/// Expected device-content rectangle inside a Simulator window. Insets are
/// empirical (matched against the `iOSContentGroup` frame observed on Xcode
/// 26.4); the per-edge tolerance in `fitsExpectedRect` absorbs per-device
/// variance.
func expectedContentRect(window: AXUIElement) -> ContentRect? {
    guard let wf = getFrameRect(window) else { return nil }
    let bezelInsetX: Double = 25
    let bezelInsetY: Double = 102  // title bar + bezel top
    let bezelInsetBot: Double = 16
    return ContentRect(
        x: wf.x + bezelInsetX,
        y: wf.y + bezelInsetY,
        width: wf.width - 2 * bezelInsetX,
        height: wf.height - bezelInsetY - bezelInsetBot
    )
}

func fitsExpectedRect(_ candidate: ContentRect, expected: ContentRect, tolerance: Double = 15) -> Bool {
    let leftDelta = abs(candidate.x - expected.x)
    let topDelta = abs(candidate.y - expected.y)
    let rightDelta = abs((candidate.x + candidate.width) - (expected.x + expected.width))
    let bottomDelta = abs((candidate.y + candidate.height) - (expected.y + expected.height))
    return leftDelta <= tolerance
        && topDelta <= tolerance
        && rightDelta <= tolerance
        && bottomDelta <= tolerance
}

func hasContentGroupTrait(_ element: AXUIElement) -> Bool {
    if let subrole = getStringAttr(element, kAXSubroleAttribute as String), subrole == "iOSContentGroup" {
        return true
    }
    if let roleDesc = getStringAttr(element, kAXRoleDescriptionAttribute as String), roleDesc == "iOSContentGroup" {
        return true
    }
    return false
}

/// Count app-semantics descendants in the subtree rooted at `element`, up to
/// `cap`. Chrome-labelled AXButton nodes do not contribute. Used both for
/// the scoring signal and for the fallback "has any semantics" probe.
func countAppSemanticsDescendants(_ element: AXUIElement, cap: Int = 5) -> Int {
    var count = 0
    var stack: [AXUIElement] = getChildren(element)
    while !stack.isEmpty && count < cap {
        let node = stack.removeLast()
        let role = getStringAttr(node, kAXRoleAttribute as String) ?? ""
        if AppSemanticsRoles.contains(role) {
            if role == "AXButton" {
                let label = getStringAttr(node, kAXTitleAttribute as String)
                    ?? getStringAttr(node, kAXDescriptionAttribute as String)
                if !isChromeLabel(label) {
                    count += 1
                }
            } else {
                count += 1
            }
            if count >= cap { break }
        }
        stack.append(contentsOf: getChildren(node))
    }
    return min(count, cap)
}

func scoreContentCandidate(_ element: AXUIElement, expected: ContentRect?) -> (score: Int, appSemanticsCount: Int) {
    var score = 0
    let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""

    if (role == "AXGroup" || role == "AXScrollArea") && hasContentGroupTrait(element) {
        score += 10
    }

    if let expected = expected, let frame = getFrameRect(element) {
        if fitsExpectedRect(frame, expected: expected) {
            score += 8
        }
    }

    let descendants = countAppSemanticsDescendants(element, cap: 5)
    score += descendants * 5

    if role == "AXToolbar" || role == "AXMenuBar" {
        score -= 10
    }

    if getChildren(element).isEmpty {
        score -= 5
    }

    return (score, descendants)
}

struct ContentCandidate {
    let element: AXUIElement
    let score: Int
    let appSemanticsCount: Int
}

/// Recursive, scored content-root search.
///
/// Walks the matched Simulator window up to `maxDepth` levels. For each
/// non-rejected descendant we compute a deterministic integer score via
/// `scoreContentCandidate` and track the highest-scored candidate.
/// Traversal terminates early once any candidate clears score ≥ 25 AND
/// contains at least one app-semantics descendant.
///
/// Returns `nil` when no candidate's subtree contains an
/// `AppSemanticsRoles` match. The caller should then emit
/// `DEVICE_CONTENT_ROOT_EMPTY` rather than falling back to the bare
/// `AXWindow` (the pre-refactor behavior responsible for the silent-empty
/// content bug).
func findDeviceContentRecursively(_ window: AXUIElement, maxDepth: Int = 8) -> (element: AXUIElement, originX: Double, originY: Double)? {
    let expected = expectedContentRect(window: window)
    var best: ContentCandidate? = nil
    var earlyExit = false

    func visit(_ element: AXUIElement, depth: Int) {
        if earlyExit { return }

        let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""
        let label = getStringAttr(element, kAXTitleAttribute as String)
            ?? getStringAttr(element, kAXDescriptionAttribute as String)

        if depth > 0 {
            if role == "AXMenuBar" || role == "AXWindow" { return }
            if isChromeLabel(label) { return }
        }

        if depth > 0 {
            let scored = scoreContentCandidate(element, expected: expected)
            let candidate = ContentCandidate(
                element: element,
                score: scored.score,
                appSemanticsCount: scored.appSemanticsCount
            )
            if best == nil || candidate.score > best!.score {
                best = candidate
            }
            if candidate.score >= 25 && candidate.appSemanticsCount > 0 {
                earlyExit = true
                return
            }
        }

        if depth < maxDepth {
            for child in getChildren(element) {
                visit(child, depth: depth + 1)
                if earlyExit { return }
            }
        }
    }

    visit(window, depth: 0)

    guard let winner = best else { return nil }
    if winner.appSemanticsCount == 0 {
        return nil
    }

    let pos = getPosition(winner.element) ?? (0, 0)
    return (winner.element, pos.0, pos.1)
}

// MARK: - Query Matching

func normalizeQueryText(_ value: String) -> String {
    let collapsedWhitespace = value
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)

    return collapsedWhitespace.folding(
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
        locale: Locale.current
    )
}

func normalizedContains(_ haystack: String?, needle: String) -> Bool {
    guard let haystack = haystack else { return false }
    let normalizedNeedle = normalizeQueryText(needle)
    if normalizedNeedle.isEmpty { return false }
    return normalizeQueryText(haystack).contains(normalizedNeedle)
}

func matchesQuery(_ node: AXNodeJSON, identifier: String?, label: String?, text: String?, role: String?) -> Bool {
    if let id = identifier {
        guard node.identifier == id else { return false }
    }
    if let lbl = label {
        guard normalizedContains(node.label, needle: lbl) else { return false }
    }
    if let txt = text {
        let hasText = normalizedContains(node.value, needle: txt)
            || normalizedContains(node.label, needle: txt)
        guard hasText else { return false }
    }
    if let r = role {
        guard node.role == r || node.role == "AX\(r)" else { return false }
    }
    return true
}

func collectMatches(_ node: AXNodeJSON, identifier: String?, label: String?, text: String?, role: String?,
                    results: inout [AXNodeJSON], maxResults: Int) {
    guard results.count < maxResults else { return }

    if matchesQuery(node, identifier: identifier, label: label, text: text, role: role) {
        // Return node without deep children for query results
        let flat = AXNodeJSON(
            role: node.role, label: node.label, value: node.value,
            identifier: node.identifier, traits: node.traits, frame: node.frame,
            visible: node.visible, enabled: node.enabled, focused: node.focused,
            children: nil, path: node.path
        )
        results.append(flat)
    }

    if let children = node.children {
        for child in children {
            collectMatches(child, identifier: identifier, label: label, text: text, role: role,
                           results: &results, maxResults: maxResults)
        }
    }
}

/// Resolve a live AXUIElement by index path (e.g. "0/2/1").
/// Unlike `navigateToPath` which returns the serialised `AXNodeJSON`, this
/// walks the live AX hierarchy so callers can invoke actions like `AXPress`
/// against the real element handle.
func resolveLiveElement(_ root: AXUIElement, path: String) -> AXUIElement? {
    if path.isEmpty { return root }
    let components = path.split(separator: "/")
    var current = root
    for comp in components {
        guard let idx = Int(comp) else { return nil }
        let children = getChildren(current)
        guard idx >= 0, idx < children.count else { return nil }
        current = children[idx]
    }
    return current
}

/// Read the list of accessibility actions a live element advertises.
/// Returns an empty array when the action-names lookup fails — callers
/// should treat the empty result as "no actions known" rather than
/// "action definitely unsupported", but for press routing we treat it
/// the same (fall through).
func getActionNames(_ element: AXUIElement) -> [String] {
    var ref: CFArray?
    let result = AXUIElementCopyActionNames(element, &ref)
    guard result == .success, let arr = ref as? [String] else { return [] }
    return arr
}

/// Navigate to a specific element by index path (e.g. "0/2/1")
func navigateToPath(_ node: AXNodeJSON, path: String) -> AXNodeJSON? {
    if path.isEmpty || path == node.path { return node }

    let targetComponents = path.split(separator: "/").map { String($0) }
    let nodeComponents = node.path.split(separator: "/").map { String($0) }

    // If we're at the target, return this node
    if targetComponents.count == nodeComponents.count { return node }

    // Navigate into children
    guard let children = node.children,
          targetComponents.count > nodeComponents.count else { return nil }

    let nextIndex = nodeComponents.isEmpty ? 0 : nodeComponents.count
    guard nextIndex < targetComponents.count,
          let childIdx = Int(targetComponents[nextIndex]),
          childIdx < children.count else { return nil }

    return navigateToPath(children[childIdx], path: path)
}

// MARK: - Chrome-only Heuristic (Issue #41)

/// Roles that indicate real app content (text input surfaces). Any node
/// matching one of these proves the tree is not chrome-only.
let appContentRoles: Set<String> = [
    "AXTextField",
    "AXSecureTextField",
    "AXTextArea",
    "AXWebArea",
]

/// Labels emitted by the Simulator chrome itself (Action button, hardware
/// keys, the toolbar, etc.). Mirrors `CHROME_LABELS` in
/// `src/native/semantics-activator.ts`.
let chromeLabels: Set<String> = [
    "Action",
    "Volume Up",
    "Volume Down",
    "Sleep/Wake",
    "Home",
    "Save Screen",
    "Rotate",
    "Capture Pointer",
    "Capture Keyboard",
]

/// Detect device-name labels like `iPhone 16 Pro -- iOS 17.0` or
/// `iPad Air -- iOS 17.0`. Mirrors `isChromeValue()` in TS.
func isChromeValueString(_ value: String) -> Bool {
    if value.range(of: "^iPhone\\b", options: .regularExpression) != nil { return true }
    if value.range(of: "^iPad\\b", options: .regularExpression) != nil { return true }
    if value.range(of: "^iOS \\d", options: .regularExpression) != nil { return true }
    return false
}

func flattenAXNodes(_ node: AXNodeJSON) -> [AXNodeJSON] {
    var acc: [AXNodeJSON] = [node]
    if let children = node.children {
        for child in children {
            acc.append(contentsOf: flattenAXNodes(child))
        }
    }
    return acc
}

/// Single source of truth for "this content tree is just Simulator chrome".
/// Mirrors `isLikelyChromeOnlyTree()` in `src/native/semantics-activator.ts`
/// — keep the two implementations in sync until Issue #40 introduces a
/// shared denylist.
func isChromeOnlyContent(_ root: AXNodeJSON) -> Bool {
    let nodes = flattenAXNodes(root)
    if nodes.count > 20 { return false }
    if nodes.contains(where: { ($0.identifier ?? "").isEmpty == false }) { return false }
    if nodes.contains(where: { appContentRoles.contains($0.role) }) { return false }

    var meaningful: [String] = []
    for n in nodes {
        if let l = n.label, !l.isEmpty { meaningful.append(l) }
        if let v = n.value, !v.isEmpty { meaningful.append(v) }
    }
    if meaningful.isEmpty { return false }

    let rootLabel = root.label ?? ""
    let rootMatchesSimulator = rootLabel.range(
        of: "^(iPhone|iPad).*--",
        options: [.regularExpression, .caseInsensitive]
    ) != nil
    let anyChromeLabel = nodes.contains(where: { node in
        guard let l = node.label else { return false }
        return chromeLabels.contains(l)
    })
    if !rootMatchesSimulator && !anyChromeLabel { return false }

    return meaningful.allSatisfy { value in
        chromeLabels.contains(value) || isChromeValueString(value)
    }
}

// MARK: - Output Helpers

func outputJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
}

func outputError(_ message: String, code: String = "AX_ERROR") {
    outputJSON(ErrorJSON(error: message, code: code))
}

// MARK: - CLI

func parseArgs() -> [String: String] {
    var args: [String: String] = [:]
    var i = 1
    let argv = CommandLine.arguments
    if argv.count > 1 {
        args["command"] = argv[1]
        i = 2
    }
    while i < argv.count {
        let arg = argv[i]
        if arg.hasPrefix("--") {
            let key = String(arg.dropFirst(2))
            // Issue #660: support bare flags like `--debug`. A bare flag
            // is one whose next argv entry is either absent or itself
            // begins with `--`. The value of a bare flag is normalised to
            // "true" so the caller can use `args["debug"] != nil` or
            // `args["debug"] == "true"` interchangeably.
            let isBareFlag = (i + 1 >= argv.count) || argv[i + 1].hasPrefix("--")
            if isBareFlag {
                args[key] = "true"
                i += 1
            } else {
                args[key] = argv[i + 1]
                i += 2
            }
        } else {
            i += 1
        }
    }
    return args
}

// MARK: - Debug Instrumentation (Issue #660)
//
// When the bridge is invoked with `--debug` (or `--verbose`), milestone
// events are emitted on stderr as one JSON object per line. This makes the
// stderr stream machine-readable so the TypeScript wrapper in
// `src/native/accessibility-bridge.ts` can surface a structured failure
// signal instead of the truncated tail it sees today (issue #651 → #660).
//
// The format is intentionally minimal: `{"event":"...","ts":"ISO8601",
// ...fields}`. Times are wall-clock; durations are in milliseconds.
// All keys are lower_snake_case for grep-ability.
//
// Stdout — the JSON dump / query / inspect / press payload — is NOT
// touched. Existing parsers that read stdout continue to work unchanged.

var debugEnabled: Bool = false

private let debugIsoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func debugLog(_ event: String, _ fields: [String: Any] = [:]) {
    guard debugEnabled else { return }
    var dict: [String: Any] = [
        "event": event,
        "ts": debugIsoFormatter.string(from: Date()),
    ]
    for (k, v) in fields {
        dict[k] = v
    }
    guard let data = try? JSONSerialization.data(
        withJSONObject: dict,
        options: [.sortedKeys]
    ) else { return }
    if var line = String(data: data, encoding: .utf8) {
        line.append("\n")
        if let bytes = line.data(using: .utf8) {
            FileHandle.standardError.write(bytes)
        }
    }
}

func nowMs() -> Double {
    return Date().timeIntervalSince1970 * 1000.0
}

func main() {
    let args = parseArgs()
    let command = args["command"] ?? "dump"
    let requestedDevice = args["device"] ?? "any"
    let maxDepth = Int(args["max-depth"] ?? "10") ?? 10
    // Issue #660: --debug or --verbose enables JSON-line stderr events
    // for every milestone in the dump pipeline. Stdout (the dump payload)
    // is unchanged.
    debugEnabled = (args["debug"] == "true") || (args["verbose"] == "true")
    debugLog("invocation", [
        "command": command,
        "device": requestedDevice,
        "maxDepth": maxDepth,
    ])

    // Check accessibility permissions
    debugLog("ax_permission_check_start")
    let trusted = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
    )
    debugLog("ax_permission_check_done", ["trusted": trusted])
    if !trusted {
        outputError("Accessibility permission not granted. Enable in System Settings > Privacy & Security > Accessibility.", code: "AX_PERMISSION_DENIED")
        exit(1)
    }

    // Find Simulator.app
    guard let pid = findSimulatorPID() else {
        debugLog("simulator_pid_not_found")
        outputError("Simulator.app is not running. Boot a device first.", code: "SIMULATOR_NOT_RUNNING")
        exit(1)
    }
    debugLog("simulator_pid_resolved", ["pid": Int(pid)])

    let app = AXUIElementCreateApplication(pid)
    // Issue #660: bound every attribute read against the Simulator
    // application root at 1.5 s so a degraded AX server can't hang the
    // bridge silently for the 6 s framework default. Every child
    // discovered through `getChildren()` inherits the same bound.
    setAxMessagingTimeoutSafe(app)
    debugLog("ax_app_created")

    // Wake up the AX server on the target process.
    //
    // Empirically, after Simulator.app spends ~1s as a non-frontmost macOS
    // process, its AX server degrades and subsequent
    // `AXUIElementCopyAttributeValue` calls return `kAXErrorCannotComplete`
    // (-25204) for every attribute — `kAXChildren`, `kAXWindows`,
    // `kAXFocusedWindow`, `kAXMainWindow`. This is the foreground dependency
    // issue #573 surfaced. Setting `AXManualAccessibility = true` once
    // forces the target app to keep its AX tree live even while backgrounded;
    // the SET call itself can return `-25204` in the degraded state, but
    // the side effect is applied and the following reads succeed. Public AX
    // API only, no private frameworks involved — same mechanism Electron /
    // other Chromium hosts use for the inverse direction (opt-in to AX).
    let manualAxStart = nowMs()
    let manualAxStatus = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    debugLog("ax_manual_accessibility_set", [
        "axErrorCode": manualAxStatus.rawValue,
        "elapsedMs": nowMs() - manualAxStart,
    ])

    let resolveStart = nowMs()
    let resolution = resolveRequestedDevice(requestedDevice)
    debugLog("device_resolve_done", [
        "elapsedMs": nowMs() - resolveStart,
        "matched": resolution.target?.udid ?? "<none>",
        "hasError": resolution.error != nil,
    ])
    if let error = resolution.error {
        outputJSON(error)
        exit(1)
    }
    let resolvedTarget = resolution.target

    let windowStart = nowMs()
    let windowMatch = findMatchingWindow(app, requested: requestedDevice, target: resolvedTarget)
    debugLog("window_match_done", [
        "elapsedMs": nowMs() - windowStart,
        "matched": windowMatch.window != nil,
        "hasError": windowMatch.error != nil,
    ])
    if let error = windowMatch.error {
        outputJSON(error)
        exit(1)
    }
    guard let matchedWindow = windowMatch.window else {
        outputError("Could not resolve a Simulator window for requested device: \(requestedDevice)", code: "DEVICE_WINDOW_NOT_FOUND")
        exit(1)
    }

    // Find the device content area inside the matched window.
    let contentStart = nowMs()
    guard let (content, originX, originY) = findDeviceContentRecursively(matchedWindow) else {
        debugLog("content_root_empty", [
            "elapsedMs": nowMs() - contentStart,
        ])
        outputError(
            "Matched simulator window for \(requestedDevice), but no descendant exposes app-level accessibility semantics. The simulator window is showing only chrome or an empty content group; ensure the target app is foreground and its AX tree is bootstrapped.",
            code: "DEVICE_CONTENT_ROOT_EMPTY"
        )
        exit(1)
    }
    debugLog("content_root_resolved", [
        "elapsedMs": nowMs() - contentStart,
        "originX": originX,
        "originY": originY,
    ])

    switch command {
    case "dump":
        let buildStart = nowMs()
        var tree = buildNode(content, path: "", maxDepth: maxDepth, currentDepth: 0,
                             originX: originX, originY: originY)
        debugLog("tree_built", [
            "elapsedMs": nowMs() - buildStart,
            "rootRole": tree.role,
            "rootChildren": tree.children?.count ?? 0,
        ])
        // Issue #41: emit `chromeOnly` on the dump root so the wrapper can
        // promote chrome-only trees in a single snapshot — no second native
        // call required.
        tree.chromeOnly = isChromeOnlyContent(tree)
        debugLog("dump_emit", ["chromeOnly": tree.chromeOnly ?? false])
        outputJSON(tree)

    case "query":
        let tree = buildNode(content, path: "", maxDepth: maxDepth, currentDepth: 0,
                             originX: originX, originY: originY)
        let maxResults = Int(args["max-results"] ?? "50") ?? 50
        var matches: [AXNodeJSON] = []
        collectMatches(tree,
                       identifier: args["id"],
                       label: args["label"],
                       text: args["text"],
                       role: args["role"],
                       results: &matches,
                       maxResults: maxResults)
        let queryInfo = QueryJSON(
            identifier: args["id"],
            label: args["label"],
            text: args["text"],
            role: args["role"],
            traits: nil
        )
        // Issue #41: compute chromeOnly against the same content tree the
        // query was evaluated against, eliminating the depth-mismatch and
        // race-window failure modes of the previous double-dump probe.
        let result = QueryResultJSON(
            matches: matches,
            total: matches.count,
            query: queryInfo,
            ambiguous: matches.count > 1 && args["id"] != nil,
            chromeOnly: isChromeOnlyContent(tree)
        )
        outputJSON(result)

    case "inspect":
        guard let path = args["path"] else {
            outputError("--path is required for inspect command", code: "MISSING_PARAM")
            exit(1)
        }
        // Build full tree to navigate to element
        let tree = buildNode(content, path: "", maxDepth: maxDepth, currentDepth: 0,
                             originX: originX, originY: originY)
        guard var node = navigateToPath(tree, path: path) else {
            // Issue #41: include chromeOnly on ELEMENT_NOT_FOUND so the
            // wrapper can decide whether the missing path is symptomatic of
            // a chrome-only tree (promote to APP_CONTENT_NOT_EXPOSED) or a
            // legitimate not-found on a populated app (pass through).
            outputJSON(InspectNotFoundJSON(
                error: "Element not found at path: \(path)",
                code: "ELEMENT_NOT_FOUND",
                path: path,
                found: false,
                chromeOnly: isChromeOnlyContent(tree)
            ))
            exit(1)
        }
        // Re-dump with full children for this node
        node.chromeOnly = isChromeOnlyContent(tree)
        outputJSON(node)

    case "press":
        guard let pressPath = args["path"] else {
            outputError("--path is required for press command", code: "MISSING_PARAM")
            exit(1)
        }
        guard let element = resolveLiveElement(content, path: pressPath) else {
            outputError("Element not found at path: \(pressPath)", code: "ELEMENT_NOT_FOUND")
            exit(1)
        }
        let actions = getActionNames(element)
        let role = getStringAttr(element, kAXRoleAttribute as String)
        let title = getStringAttr(element, kAXTitleAttribute as String)
        let desc = getStringAttr(element, kAXDescriptionAttribute as String)
        let label = title ?? desc
        let identifier = getStringAttr(element, kAXIdentifierAttribute as String)

        if !actions.contains(kAXPressAction as String) {
            // Element exists but does not advertise AXPress. Report in-band
            // with ok:false so the TS caller can transparently fall back to
            // a coordinate tap; exit 0 keeps the response inside stdout
            // even on Node execFile implementations that strip `stdout`
            // from rejected promises.
            outputJSON(PressResponseJSON(
                ok: false,
                code: "PRESS_NOT_ACTIONABLE",
                path: pressPath,
                actions: actions,
                role: role,
                identifier: identifier,
                label: label,
                message: "Element does not support AXPress",
                axErrorCode: nil
            ))
            return
        }
        let pressResult = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if pressResult != .success {
            outputJSON(PressResponseJSON(
                ok: false,
                code: "PRESS_FAILED",
                path: pressPath,
                actions: actions,
                role: role,
                identifier: identifier,
                label: label,
                message: "AXUIElementPerformAction(kAXPressAction) returned non-success",
                axErrorCode: pressResult.rawValue
            ))
            return
        }
        outputJSON(PressResponseJSON(
            ok: true,
            code: "OK",
            path: pressPath,
            actions: actions,
            role: role,
            identifier: identifier,
            label: label,
            message: nil,
            axErrorCode: nil
        ))

    default:
        outputError("Unknown command: \(command). Use dump, query, inspect, press, or context.", code: "UNKNOWN_COMMAND")
        exit(1)
    }
}

main()
