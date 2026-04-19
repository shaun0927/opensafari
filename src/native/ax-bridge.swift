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
    return (value as? [AXUIElement]) ?? []
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
    task.waitUntilExit()
    guard task.terminationStatus == 0 else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
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

    let nameMatches = booted.filter { $0.name == requested }
    if nameMatches.count == 1 { return (nameMatches[0], nil) }
    if nameMatches.count > 1 {
        return (nil, ErrorJSON(
            error: "Requested device name '\(requested)' matched multiple booted simulators: \(nameMatches.map { $0.udid })",
            code: "DEVICE_RESOLUTION_AMBIGUOUS"
        ))
    }

    return (nil, ErrorJSON(
        error: "Could not resolve requested device '\(requested)' to a booted simulator via simctl list devices -j.",
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
    // ambiguous regardless of whether the titles are identical or different.
    // Two windows with the same score *and* the same title are equally suspect —
    // e.g. duplicate device names or identical window titles in multi-simulator
    // setups — so we must not silently pick one arbitrarily.
    let topScorePeers = sorted.filter { $0.score == best.score }
    if topScorePeers.count > 1 && best.score < 1000 {
        let peerTitles = topScorePeers.map { $0.title }
        return (nil, ErrorJSON(
            error: "Requested device \(requested) matched multiple Simulator windows with the same confidence: \(peerTitles)",
            code: "DEVICE_WINDOW_AMBIGUOUS"
        ))
    }

    return (best.window, nil)
}

/// Navigate AX tree to find the device content area inside a matched window.
/// Traverses: matched Simulator window → likely device frame → content.
func findDeviceContentInWindow(_ window: AXUIElement) -> (element: AXUIElement, originX: Double, originY: Double)? {
    let pos = getPosition(window) ?? (0, 0)
    let children = getChildren(window)

    for child in children {
        let childRole = getStringAttr(child, kAXRoleAttribute as String) ?? ""
        if childRole == "AXGroup" || childRole == "AXScrollArea" {
            let childPos = getPosition(child) ?? pos
            let grandchildren = getChildren(child)
            if !grandchildren.isEmpty {
                return (child, childPos.0, childPos.1)
            }
        }
    }

    return (window, pos.0, pos.1)
}

// MARK: - Query Matching

func matchesQuery(_ node: AXNodeJSON, identifier: String?, label: String?, text: String?, role: String?) -> Bool {
    if let id = identifier {
        guard node.identifier == id else { return false }
    }
    if let lbl = label {
        guard let nodeLabel = node.label,
              nodeLabel.localizedCaseInsensitiveContains(lbl) else { return false }
    }
    if let txt = text {
        let hasText = (node.value?.localizedCaseInsensitiveContains(txt) ?? false)
            || (node.label?.localizedCaseInsensitiveContains(txt) ?? false)
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
        if arg.hasPrefix("--") && i + 1 < argv.count {
            let key = String(arg.dropFirst(2))
            args[key] = argv[i + 1]
            i += 2
        } else {
            i += 1
        }
    }
    return args
}

func main() {
    let args = parseArgs()
    let command = args["command"] ?? "dump"
    let requestedDevice = args["device"] ?? "any"
    let maxDepth = Int(args["max-depth"] ?? "10") ?? 10

    // Check accessibility permissions
    let trusted = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
    )
    if !trusted {
        outputError("Accessibility permission not granted. Enable in System Settings > Privacy & Security > Accessibility.", code: "AX_PERMISSION_DENIED")
        exit(1)
    }

    // Find Simulator.app
    guard let pid = findSimulatorPID() else {
        outputError("Simulator.app is not running. Boot a device first.", code: "SIMULATOR_NOT_RUNNING")
        exit(1)
    }

    let app = AXUIElementCreateApplication(pid)

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
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    let resolution = resolveRequestedDevice(requestedDevice)
    if let error = resolution.error {
        outputJSON(error)
        exit(1)
    }
    let resolvedTarget = resolution.target

    let windowMatch = findMatchingWindow(app, requested: requestedDevice, target: resolvedTarget)
    if let error = windowMatch.error {
        outputJSON(error)
        exit(1)
    }
    guard let matchedWindow = windowMatch.window else {
        outputError("Could not resolve a Simulator window for requested device: \(requestedDevice)", code: "DEVICE_WINDOW_NOT_FOUND")
        exit(1)
    }

    // Find the device content area inside the matched window.
    guard let (content, originX, originY) = findDeviceContentInWindow(matchedWindow) else {
        outputError("Could not find device content area for requested device: \(requestedDevice)", code: "DEVICE_CONTENT_NOT_FOUND")
        exit(1)
    }

    switch command {
    case "dump":
        let tree = buildNode(content, path: "", maxDepth: maxDepth, currentDepth: 0,
                             originX: originX, originY: originY)
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
        let result = QueryResultJSON(
            matches: matches,
            total: matches.count,
            query: queryInfo,
            ambiguous: matches.count > 1 && args["id"] != nil
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
        guard let node = navigateToPath(tree, path: path) else {
            outputError("Element not found at path: \(path)", code: "ELEMENT_NOT_FOUND")
            exit(1)
        }
        // Re-dump with full children for this node
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
        outputError("Unknown command: \(command). Use dump, query, inspect, or press.", code: "UNKNOWN_COMMAND")
        exit(1)
    }
}

main()
