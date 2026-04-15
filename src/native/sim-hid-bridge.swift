#!/usr/bin/env swift
//
// sim-hid-bridge.swift — SimulatorKit HID event bridge.
//
// Swift helper for SimulatorKitHIDInputBackend (issue #483).
// Compiled to `dist/sim-hid-bridge` and spawned from Node.js via `execFile`.
//
// Usage:
//   sim-hid-bridge <udid> tap    <x> <y> [duration]
//   sim-hid-bridge <udid> swipe  <x1> <y1> <x2> <y2> [duration]
//   sim-hid-bridge <udid> key    <hidUsage> [duration]
//   sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]
//
// Exit codes:
//   0  — success
//   64 — argument / usage error (EX_USAGE)
//   69 — SimDevice not found / not booted (EX_UNAVAILABLE)
//   78 — SimulatorKit or private API missing (EX_CONFIG)
//
// Architecture:
//   Uses SimDeviceLegacyHIDClient + IndigoHIDMessage C functions from
//   SimulatorKit.framework, resolved via dlopen/dlsym at runtime.
//   Every private symbol is nil-checked; missing symbols exit 78.
//
// License: Behaviour modelled after Facebook's idb (MIT), independently written.

import Foundation
import ObjectiveC
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// MARK: - JSON helpers
struct SuccessJSON: Codable { let ok: Bool; let kind: String; let udid: String; let elapsed_ms: Int }
struct ErrorJSON: Codable { let ok: Bool; let error: String; let code: String }
func emitJSON<T: Encodable>(_ v: T) {
    let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
    if let d = try? enc.encode(v), let j = String(data: d, encoding: .utf8) { print(j) }
}
func emitError(_ msg: String, code: String) { emitJSON(ErrorJSON(ok: false, error: msg, code: code)) }

// MARK: - Framework loading
func loadFramework(_ candidates: [String]) -> UnsafeMutableRawPointer? {
    for p in candidates {
        if FileManager.default.fileExists(atPath: p), let h = dlopen(p, RTLD_NOW) { return h }
    }
    return nil
}
func loadSimulatorKit() -> UnsafeMutableRawPointer? {
    loadFramework([
        "/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit",
    ])
}
func loadCoreSimulator() -> UnsafeMutableRawPointer? {
    loadFramework([
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    ])
}

// MARK: - Command parsing
enum Command {
    case tap(x: Double, y: Double, duration: Double?)
    case swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double?)
    case key(hidUsage: Int, duration: Double?)
    case button(name: String, duration: Double?)
}
enum ParseError: Error { case usage(String) }

func parseCommand(_ argv: [String]) throws -> (udid: String, command: Command) {
    guard argv.count >= 3 else { throw ParseError.usage("usage: sim-hid-bridge <udid> <tap|swipe|key|button> <args...>") }
    let udid = argv[1], kind = argv[2], rest = Array(argv.dropFirst(3))
    switch kind {
    case "tap":
        guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> tap <x> <y> [duration]") }
        return (udid, .tap(x: x, y: y, duration: rest.count >= 3 ? Double(rest[2]) : nil))
    case "swipe":
        guard rest.count >= 4, let x1 = Double(rest[0]), let y1 = Double(rest[1]),
              let x2 = Double(rest[2]), let y2 = Double(rest[3]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> swipe <x1> <y1> <x2> <y2> [duration]") }
        return (udid, .swipe(x1: x1, y1: y1, x2: x2, y2: y2, duration: rest.count >= 5 ? Double(rest[4]) : nil))
    case "key":
        guard rest.count >= 1, let h = Int(rest[0]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> key <hidUsage> [duration]") }
        return (udid, .key(hidUsage: h, duration: rest.count >= 2 ? Double(rest[1]) : nil))
    case "button":
        guard rest.count >= 1 else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]") }
        let ok = ["home", "lock", "sound-up", "sound-down"]
        guard ok.contains(rest[0]) else { throw ParseError.usage("unknown button '\(rest[0])'. Allowed: \(ok.joined(separator: ", "))") }
        return (udid, .button(name: rest[0], duration: rest.count >= 2 ? Double(rest[1]) : nil))
    default: throw ParseError.usage("unknown command '\(kind)'. Allowed: tap, swipe, key, button")
    }
}
func kindString(_ c: Command) -> String {
    switch c { case .tap: return "tap"; case .swipe: return "swipe"; case .key: return "key"; case .button: return "button" }
}

// MARK: - Device Resolution (CoreSimulator private API)
func getDevDir() -> String {
    let p = Pipe(); let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    proc.arguments = ["-p"]; proc.standardOutput = p; proc.standardError = FileHandle.nullDevice
    do { try proc.run(); proc.waitUntilExit()
        if let r = String(data: p.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty { return r }
    } catch {}
    return "/Applications/Xcode.app/Contents/Developer"
}

func resolveDevice(udid: String) -> NSObject? {
    if let ds = getDefaultDeviceSet(), let d = findDevice(ds, udid) { return d }
    if let SC = NSClassFromString("SimDeviceSet") {
        let sel = NSSelectorFromString("defaultSet")
        if (SC as AnyObject).responds(to: sel),
           let ds = (SC as AnyObject).perform(sel)?.takeUnretainedValue() as? NSObject,
           let d = findDevice(ds, udid) { return d }
    }
    return nil
}

func getDefaultDeviceSet() -> NSObject? {
    guard let C = NSClassFromString("SimServiceContext") else { return nil }
    let sel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard (C as AnyObject).responds(to: sel), let m = class_getClassMethod(C, sel) else { return nil }
    typealias F = @convention(c) (AnyClass, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>?) -> AnyObject?
    guard let ctx = unsafeBitCast(method_getImplementation(m), to: F.self)(C, sel, NSString(string: getDevDir()), nil) as? NSObject else { return nil }
    let dsSel = NSSelectorFromString("defaultDeviceSetWithError:")
    guard ctx.responds(to: dsSel), let dsM = class_getInstanceMethod(type(of: ctx), dsSel) else { return nil }
    typealias DsF = @convention(c) (NSObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?) -> AnyObject?
    return unsafeBitCast(method_getImplementation(dsM), to: DsF.self)(ctx, dsSel, nil) as? NSObject
}

func findDevice(_ ds: NSObject, _ udid: String) -> NSObject? {
    let target = udid.uppercased()
    for selN in ["availableDevices", "devices"] {
        let sel = NSSelectorFromString(selN)
        guard ds.responds(to: sel), let devs = ds.perform(sel)?.takeUnretainedValue() as? [NSObject] else { continue }
        for d in devs {
            if let u = d.perform(NSSelectorFromString("UDID"))?.takeUnretainedValue() as? NSUUID,
               u.uuidString.uppercased() == target { return d }
        }
    }
    return nil
}

func isDeviceBooted(_ d: NSObject) -> Bool { (d.value(forKey: "state") as? Int) == 3 }

// MARK: - HID Client (SimulatorKit private API)
func createHIDClient(device: NSObject) -> NSObject? {
    guard let HC = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
        fputs("[sim-hid] SimDeviceLegacyHIDClient not found\n", stderr); return nil }
    let iSel = NSSelectorFromString("initWithDevice:error:")
    guard let iM = class_getInstanceMethod(HC, iSel) else {
        fputs("[sim-hid] initWithDevice:error: not found\n", stderr); return nil }
    guard let raw = (HC as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject else { return nil }
    typealias F = @convention(c) (NSObject, Selector, NSObject, AutoreleasingUnsafeMutablePointer<NSError?>?) -> NSObject?
    var err: NSError?
    guard let c = unsafeBitCast(method_getImplementation(iM), to: F.self)(raw, iSel, device, &err) else {
        fputs("[sim-hid] HIDClient init failed: \(err?.localizedDescription ?? "?")\n", stderr); return nil }
    return c
}

// MARK: - IndigoHIDMessage functions via dlsym
typealias MouseMsgFn = @convention(c) (UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>, UInt32, UInt, CGSize, UInt32) -> UnsafeMutableRawPointer?
typealias KeyMsgFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
typealias ButtonMsgFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

let kMouseDown: UInt = 1; let kMouseUp: UInt = 2; let kMouseDragged: UInt = 6
let kOpDown: UInt32 = 1; let kOpUp: UInt32 = 2
let kBtnHome: UInt32 = 1; let kBtnLock: UInt32 = 2; let kBtnVolUp: UInt32 = 3; let kBtnVolDn: UInt32 = 4

struct HID {
    let mouseMsg: MouseMsgFn; let keyMsg: KeyMsgFn; let btnMsg: ButtonMsgFn
    let sendFn: @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendSel: Selector; let client: NSObject
}

func resolveHID(handle: UnsafeMutableRawPointer, client: NSObject) -> HID? {
    guard let ms = dlsym(handle, "IndigoHIDMessageForMouseNSEvent") else { fputs("[sim-hid] No mouse fn\n", stderr); return nil }
    guard let ks = dlsym(handle, "IndigoHIDMessageForKeyboardArbitrary") else { fputs("[sim-hid] No key fn\n", stderr); return nil }
    guard let bs = dlsym(handle, "IndigoHIDMessageForButton") else { fputs("[sim-hid] No button fn\n", stderr); return nil }
    let sSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
    guard client.responds(to: sSel), let sM = class_getInstanceMethod(type(of: client), sSel) else {
        fputs("[sim-hid] No send method\n", stderr); return nil }
    typealias SF = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    return HID(mouseMsg: unsafeBitCast(ms, to: MouseMsgFn.self), keyMsg: unsafeBitCast(ks, to: KeyMsgFn.self),
               btnMsg: unsafeBitCast(bs, to: ButtonMsgFn.self),
               sendFn: unsafeBitCast(method_getImplementation(sM), to: SF.self), sendSel: sSel, client: client)
}

func send(_ h: HID, _ msg: UnsafeMutableRawPointer) { h.sendFn(h.client, h.sendSel, msg, false, nil, nil) }

// MARK: - Command Execution
func execTap(_ h: HID, x: Double, y: Double, dur: Double?, sz: CGSize) -> Bool {
    var sp1 = CGPoint(x: x, y: y); var wp1 = CGPoint(x: x, y: y)
    guard let dn = h.mouseMsg(&sp1, &wp1, 0, kMouseDown, sz, 0) else { return false }
    send(h, dn); Thread.sleep(forTimeInterval: dur ?? 0.05)
    var sp2 = CGPoint(x: x, y: y); var wp2 = CGPoint(x: x, y: y)
    guard let up = h.mouseMsg(&sp2, &wp2, 0, kMouseUp, sz, 0) else { return false }
    send(h, up); return true
}

func execSwipe(_ h: HID, x1: Double, y1: Double, x2: Double, y2: Double, dur: Double?, sz: CGSize) -> Bool {
    let total = dur ?? 0.3; let steps = 10; let delay = total / Double(steps + 2)
    var ss = CGPoint(x: x1, y: y1); var ws = CGPoint(x: x1, y: y1)
    guard let dn = h.mouseMsg(&ss, &ws, 0, kMouseDown, sz, 0) else { return false }
    send(h, dn); Thread.sleep(forTimeInterval: delay)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let mx = x1 + (x2 - x1) * t, my = y1 + (y2 - y1) * t
        var sm = CGPoint(x: mx, y: my); var wm = CGPoint(x: mx, y: my)
        guard let mv = h.mouseMsg(&sm, &wm, 0, kMouseDragged, sz, 0) else { return false }
        send(h, mv); Thread.sleep(forTimeInterval: delay)
    }
    var se = CGPoint(x: x2, y: y2); var we = CGPoint(x: x2, y: y2)
    guard let up = h.mouseMsg(&se, &we, 0, kMouseUp, sz, 0) else { return false }
    send(h, up); return true
}

func execKey(_ h: HID, usage: Int, dur: Double?) -> Bool {
    guard let dn = h.keyMsg(UInt32(usage), kOpDown) else { return false }
    send(h, dn); Thread.sleep(forTimeInterval: dur ?? 0.05)
    guard let up = h.keyMsg(UInt32(usage), kOpUp) else { return false }
    send(h, up); return true
}

func execButton(_ h: HID, name: String, dur: Double?) -> Bool {
    let code: UInt32
    switch name { case "home": code = kBtnHome; case "lock": code = kBtnLock
    case "sound-up": code = kBtnVolUp; case "sound-down": code = kBtnVolDn; default: return false }
    guard let dn = h.btnMsg(code, kOpDown, 0) else { return false }
    send(h, dn); Thread.sleep(forTimeInterval: dur ?? 0.1)
    guard let up = h.btnMsg(code, kOpUp, 0) else { return false }
    send(h, up); return true
}

func getScreenSize(_ d: NSObject) -> CGSize {
    if let dt = d.perform(NSSelectorFromString("deviceType"))?.takeUnretainedValue() as? NSObject,
       let sz = dt.value(forKey: "mainScreenSize") as? CGSize { return sz }
    return CGSize(width: 393, height: 852)
}

// MARK: - Entrypoint
func run() -> Int32 {
    let argv = CommandLine.arguments; let start = Date()
    let parsed: (udid: String, command: Command)
    do { parsed = try parseCommand(argv) }
    catch let ParseError.usage(m) { emitError(m, code: "USAGE"); return 64 }
    catch { emitError("parse error: \(error)", code: "USAGE"); return 64 }

    guard let skH = loadSimulatorKit() else {
        emitError("SimulatorKit.framework not found. Is Xcode installed?", code: "SIMULATORKIT_MISSING"); return 78 }
    guard let _ = loadCoreSimulator() else {
        emitError("CoreSimulator.framework not found.", code: "CORESIMULATOR_MISSING"); return 78 }
    guard let device = resolveDevice(udid: parsed.udid) else {
        emitError("SimDevice not found: '\(parsed.udid)'.", code: "DEVICE_NOT_FOUND"); return 69 }
    guard isDeviceBooted(device) else {
        emitError("SimDevice '\(parsed.udid)' is not booted.", code: "DEVICE_NOT_BOOTED"); return 69 }
    guard let client = createHIDClient(device: device) else {
        emitError("SimDeviceLegacyHIDClient creation failed.", code: "HID_CLIENT_FAILED"); return 78 }
    guard let hid = resolveHID(handle: skH, client: client) else {
        emitError("IndigoHIDMessage functions not found.", code: "HID_FUNCTIONS_MISSING"); return 78 }

    let sz = getScreenSize(device)
    let ok: Bool
    switch parsed.command {
    case .tap(let x, let y, let d):       ok = execTap(hid, x: x, y: y, dur: d, sz: sz)
    case .swipe(let a, let b, let c, let d, let e): ok = execSwipe(hid, x1: a, y1: b, x2: c, y2: d, dur: e, sz: sz)
    case .key(let u, let d):              ok = execKey(hid, usage: u, dur: d)
    case .button(let n, let d):           ok = execButton(hid, name: n, dur: d)
    }
    guard ok else { emitError("HID injection failed. Check stderr.", code: "HID_INJECTION_FAILED"); return 78 }
    let ms = Int(Date().timeIntervalSince(start) * 1000)
    emitJSON(SuccessJSON(ok: true, kind: kindString(parsed.command), udid: parsed.udid, elapsed_ms: ms))
    return 0
}
exit(run())
