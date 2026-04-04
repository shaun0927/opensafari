#!/usr/bin/env swift
//
// ax-bridge.swift — Accessibility tree bridge for iOS Simulator
//
// Reads the native accessibility tree from a running iOS Simulator
// via the macOS AXUIElement API. Outputs structured JSON to stdout.
//
// Usage:
//   ax-bridge dump   --device <UDID> [--max-depth N]
//   ax-bridge query  --device <UDID> [--id X] [--label X] [--text X] [--role X]
//   ax-bridge inspect --device <UDID> --path <index-path>
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

func findSimulatorPID() -> pid_t? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    task.arguments = ["-x", "Simulator"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try? task.run()
    task.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          let pid = Int32(output.components(separatedBy: "\n").first ?? "") else {
        return nil
    }
    return pid
}

/// Navigate AX tree to find the device content area for a given UDID.
/// Traverses: Simulator app → window → device frame → content.
func findDeviceContent(_ app: AXUIElement, deviceUDID: String) -> (element: AXUIElement, originX: Double, originY: Double)? {
    let windows = getChildren(app)

    for window in windows {
        let windowTitle = getStringAttr(window, kAXTitleAttribute as String) ?? ""
        let windowId = getStringAttr(window, kAXIdentifierAttribute as String) ?? ""

        // Match by UDID in window title/identifier, or use first window
        let isMatch = windowTitle.contains(deviceUDID) || windowId.contains(deviceUDID)
            || deviceUDID == "any"

        if isMatch || windows.count == 1 {
            // Try to find the deepest content group (the actual device screen area)
            let pos = getPosition(window) ?? (0, 0)
            let children = getChildren(window)

            // Look for the device content area (typically a group containing the app UI)
            for child in children {
                let childRole = getStringAttr(child, kAXRoleAttribute as String) ?? ""
                if childRole == "AXGroup" || childRole == "AXScrollArea" {
                    let childPos = getPosition(child) ?? pos
                    let grandchildren = getChildren(child)
                    // If this group has children, it's likely the content area
                    if !grandchildren.isEmpty {
                        return (child, childPos.0, childPos.1)
                    }
                }
            }

            // Fallback: use the window itself
            return (window, pos.0, pos.1)
        }
    }

    // Last resort: use first window
    if let first = windows.first {
        let pos = getPosition(first) ?? (0, 0)
        return (first, pos.0, pos.1)
    }

    return nil
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
    let deviceUDID = args["device"] ?? "any"
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

    // Find the device content area
    guard let (content, originX, originY) = findDeviceContent(app, deviceUDID: deviceUDID) else {
        outputError("Could not find device window for UDID: \(deviceUDID)", code: "DEVICE_NOT_FOUND")
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

    default:
        outputError("Unknown command: \(command). Use dump, query, or inspect.", code: "UNKNOWN_COMMAND")
        exit(1)
    }
}

main()
