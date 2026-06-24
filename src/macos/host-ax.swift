#!/usr/bin/env swift
import ApplicationServices
import AppKit
import Foundation

struct Frame: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Node: Codable { let role: String; let label: String?; let value: String?; let identifier: String?; let frame: Frame; let visible: Bool; let enabled: Bool; let focused: Bool; let actions: [String]; let path: String; let children: [Node]? }
struct Err: Codable { let error: String; let code: String }
struct Press: Codable { let ok: Bool; let code: String; let path: String; let actions: [String]; let message: String? }

let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
func out<T: Encodable>(_ v: T) { print(String(data: try! encoder.encode(v), encoding: .utf8)!) }
func fail(_ code: String, _ msg: String) -> Never { out(Err(error: msg, code: code)); exit(1) }
func arg(_ name: String) -> String? { guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }; return CommandLine.arguments[i + 1] }
func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func runningApp() -> NSRunningApplication {
  if let bundle = arg("--bundle-id"), let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app }
  if let name = arg("--process-name") {
    let n = name.lowercased()
    if let app = NSWorkspace.shared.runningApplications.first(where: { ($0.localizedName ?? $0.bundleIdentifier ?? "").lowercased().contains(n) }) { return app }
  }
  fail("APP_NOT_RUNNING", "No running app matched --bundle-id or --process-name")
}

func str(_ e: AXUIElement, _ a: String) -> String? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? (v as? String) : nil }
func bool(_ e: AXUIElement, _ a: String, _ d: Bool = false) -> Bool { var v: CFTypeRef?; guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success else { return d }; return (v as? NSNumber)?.boolValue ?? d }
func frame(_ e: AXUIElement) -> Frame {
  var pv: CFTypeRef?; var sv: CFTypeRef?; var p = CGPoint.zero; var s = CGSize.zero
  if AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pv) == .success, let x = pv { AXValueGetValue(x as! AXValue, .cgPoint, &p) }
  if AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &sv) == .success, let x = sv { AXValueGetValue(x as! AXValue, .cgSize, &s) }
  return Frame(x: p.x, y: p.y, width: s.width, height: s.height)
}
func children(_ e: AXUIElement) -> [AXUIElement] { var v: CFTypeRef?; guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success else { return [] }; return (v as? [AXUIElement]) ?? [] }
func actions(_ e: AXUIElement) -> [String] { var v: CFArray?; guard AXUIElementCopyActionNames(e, &v) == .success else { return [] }; return (v as? [String]) ?? [] }

func node(_ e: AXUIElement, _ path: String, _ depth: Int, _ maxDepth: Int) -> Node {
  AXUIElementSetMessagingTimeout(e, 1.5)
  let f = frame(e)
  let kids = depth >= maxDepth ? nil : children(e).enumerated().map { node($0.element, path.isEmpty ? String($0.offset) : "\(path)/\($0.offset)", depth + 1, maxDepth) }
  return Node(role: str(e, kAXRoleAttribute) ?? "AXUnknown", label: str(e, kAXTitleAttribute) ?? str(e, kAXDescriptionAttribute), value: str(e, kAXValueAttribute), identifier: str(e, kAXIdentifierAttribute), frame: f, visible: f.width > 0 && f.height > 0, enabled: bool(e, kAXEnabledAttribute, true), focused: bool(e, kAXFocusedAttribute), actions: actions(e), path: path, children: kids)
}
func find(_ root: AXUIElement, _ wanted: String) -> AXUIElement? {
  if wanted.isEmpty { return root }
  var cur = root
  for part in wanted.split(separator: "/") { guard let i = Int(part) else { return nil }; let kids = children(cur); guard i >= 0 && i < kids.count else { return nil }; cur = kids[i] }
  return cur
}

let cmd = CommandLine.arguments.dropFirst().first ?? ""
switch cmd {
case "dump":
  let app = runningApp(); app.activate(options: [.activateIgnoringOtherApps])
  let root = AXUIElementCreateApplication(app.processIdentifier)
  out(node(root, "", 0, Int(arg("--max-depth") ?? "8") ?? 8))
case "press":
  let app = runningApp(); app.activate(options: [.activateIgnoringOtherApps])
  let root = AXUIElementCreateApplication(app.processIdentifier); let p = arg("--path") ?? ""
  guard let el = find(root, p) else { out(Press(ok: false, code: "ELEMENT_NOT_FOUND", path: p, actions: [], message: "No element at path")); exit(0) }
  let acts = actions(el)
  if acts.contains(kAXPressAction as String) {
    let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
    out(Press(ok: r == .success, code: r == .success ? "OK" : "PRESS_FAILED", path: p, actions: acts, message: r == .success ? nil : "AXPress failed: \(r.rawValue)"))
  } else { out(Press(ok: false, code: "PRESS_NOT_ACTIONABLE", path: p, actions: acts, message: "AXPress not available")) }
case "click":
  guard let x = Double(arg("--x") ?? ""), let y = Double(arg("--y") ?? "") else { fail("BAD_ARGS", "click requires --x and --y") }
  let pt = CGPoint(x: x, y: y)
  let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
  down?.post(tap: .cghidEventTap); usleep(80_000); up?.post(tap: .cghidEventTap); out(["ok": true])
default: fail("BAD_COMMAND", "Usage: host-ax dump|press|click")
}
