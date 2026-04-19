#!/usr/bin/env swift
//
// sim-hid-bridge.swift — SimulatorKit HID event bridge.
//
// Swift helper for SimulatorKitHIDInputBackend (issue #483).
// Compiled to `dist/sim-hid-bridge` and spawned from Node.js via `execFile`.
//
// Usage:
//   sim-hid-bridge <udid> tap    <x> <y> [duration]
//   sim-hid-bridge <udid> tap-ps <x> <y> [duration] — experimental iOS 26 path
//   sim-hid-bridge <udid> tap-digitizer <x> <y> [duration] — IOHIDEvent digitizer probe
//   sim-hid-bridge <udid> swipe  <x1> <y1> <x2> <y2> [duration]
//   sim-hid-bridge <udid> key    <hidUsage> [duration]
//   sim-hid-bridge <udid> key-mod <hidUsage> <modUsage> [duration]
//                                 — holds <modUsage> (e.g. 225 = LeftShift)
//                                   around the key press so shifted ASCII
//                                   chars like '@', '!', uppercase letters
//                                   compose correctly.
//   sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]
//   sim-hid-bridge diag [udid]   — framework + symbol probe (see runDiag)
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
    // tap-ps: experimental path for iOS 26+ — wraps the mouse-down/up
    // messages with IndigoHIDMessageToCreatePointerService /
    // IndigoHIDMessageToRemovePointerService. See #491 for the hypothesis
    // that the screen-lock symptom is caused by iOS 26 no longer routing
    // mouse NSEvents into UIKit touches unless a pointer HID service has
    // been registered first.
    case tapPS(x: Double, y: Double, duration: Double?)
    case tapDigitizer(x: Double, y: Double, duration: Double?)
    case swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double?)
    case key(hidUsage: Int, duration: Double?)
    case keyMod(hidUsage: Int, modUsage: Int, duration: Double?)
    case button(name: String, duration: Double?)
}
enum ParseError: Error { case usage(String) }

func parseCommand(_ argv: [String]) throws -> (udid: String, command: Command) {
    guard argv.count >= 3 else { throw ParseError.usage("usage: sim-hid-bridge <udid> <tap|tap-ps|tap-digitizer|swipe|key|key-mod|button> <args...>\n       sim-hid-bridge diag [udid]") }
    let udid = argv[1], kind = argv[2], rest = Array(argv.dropFirst(3))
    switch kind {
    case "tap":
        guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> tap <x> <y> [duration]") }
        return (udid, .tap(x: x, y: y, duration: rest.count >= 3 ? Double(rest[2]) : nil))
    case "tap-ps":
        guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> tap-ps <x> <y> [duration]") }
        return (udid, .tapPS(x: x, y: y, duration: rest.count >= 3 ? Double(rest[2]) : nil))
    case "tap-digitizer":
        guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> tap-digitizer <x> <y> [duration]") }
        return (udid, .tapDigitizer(x: x, y: y, duration: rest.count >= 3 ? Double(rest[2]) : nil))
    case "swipe":
        guard rest.count >= 4, let x1 = Double(rest[0]), let y1 = Double(rest[1]),
              let x2 = Double(rest[2]), let y2 = Double(rest[3]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> swipe <x1> <y1> <x2> <y2> [duration]") }
        return (udid, .swipe(x1: x1, y1: y1, x2: x2, y2: y2, duration: rest.count >= 5 ? Double(rest[4]) : nil))
    case "key":
        guard rest.count >= 1, let h = Int(rest[0]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> key <hidUsage> [duration]") }
        return (udid, .key(hidUsage: h, duration: rest.count >= 2 ? Double(rest[1]) : nil))
    case "key-mod":
        guard rest.count >= 2, let h = Int(rest[0]), let m = Int(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> key-mod <hidUsage> <modUsage> [duration]") }
        return (udid, .keyMod(hidUsage: h, modUsage: m, duration: rest.count >= 3 ? Double(rest[2]) : nil))
    case "button":
        guard rest.count >= 1 else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]") }
        let ok = ["home", "lock", "sound-up", "sound-down"]
        guard ok.contains(rest[0]) else { throw ParseError.usage("unknown button '\(rest[0])'. Allowed: \(ok.joined(separator: ", "))") }
        return (udid, .button(name: rest[0], duration: rest.count >= 2 ? Double(rest[1]) : nil))
    default: throw ParseError.usage("unknown command '\(kind)'. Allowed: tap, tap-ps, tap-digitizer, swipe, key, key-mod, button")
    }
}
func kindString(_ c: Command) -> String {
    switch c {
    case .tap: return "tap"
    case .tapPS: return "tap-ps"
    case .tapDigitizer: return "tap-digitizer"
    case .swipe: return "swipe"
    case .key: return "key"
    case .keyMod: return "key-mod"
    case .button: return "button"
    }
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

// MARK: - tap-ps: experimental pointer-service-bracketed tap (#491)
//
// Hypothesis: iOS 26 stopped synthesising UITouches from bare mouse HID
// messages unless a pointer service is first registered against the
// SimDeviceLegacyHIDClient. `IndigoHIDMessageToCreatePointerService` and
// `IndigoHIDMessageToRemovePointerService` exist in SimulatorKit's
// exported C surface (confirmed via `sim-hid-bridge diag`) but are not
// called by the current production bridge.
//
// This function best-effort brackets the existing mouse-down/up pair with
// the pointer-service create/remove messages. Signatures of the C
// functions are not in any public header; we try the most common shape
// — `() -> UnsafeMutableRawPointer?` — which matches every other
// IndigoHIDMessage*For* helper we already resolve. If the real signature
// differs, the worst case is a benign no-op message and we fall through
// to the existing mouse path, which is what the unmodified `tap` does
// anyway.
typealias NoArgMsgFn = @convention(c) () -> UnsafeMutableRawPointer?

func resolveNoArg(_ handle: UnsafeMutableRawPointer, _ name: String) -> NoArgMsgFn? {
    guard let sym = dlsym(handle, name) else { return nil }
    return unsafeBitCast(sym, to: NoArgMsgFn.self)
}

func execTapPS(_ h: HID, x: Double, y: Double, dur: Double?, sz: CGSize,
               skHandle: UnsafeMutableRawPointer) -> Bool {
    let createPS = resolveNoArg(skHandle, "IndigoHIDMessageToCreatePointerService")
    let removePS = resolveNoArg(skHandle, "IndigoHIDMessageToRemovePointerService")
    if createPS == nil || removePS == nil {
        fputs("[sim-hid] tap-ps: pointer-service symbols missing, falling back to bare tap\n", stderr)
        return execTap(h, x: x, y: y, dur: dur, sz: sz)
    }
    if let msg = createPS?() { send(h, msg) }
    // Give the simulator a moment to wire up the freshly-registered service
    // before we hand it the first touch. 20ms matches idb's default.
    Thread.sleep(forTimeInterval: 0.02)
    let tapped = execTap(h, x: x, y: y, dur: dur, sz: sz)
    if let msg = removePS?() { send(h, msg) }
    return tapped
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

// Holds `modUsage` (e.g. 0xE1 LeftShift) around a single key press so shifted
// ASCII characters compose correctly on the simulator's keyboard. Event order
// is mod-down → key-down → (sleep) → key-up → mod-up.
func execKeyMod(_ h: HID, usage: Int, modUsage: Int, dur: Double?) -> Bool {
    guard let modDn = h.keyMsg(UInt32(modUsage), kOpDown) else { return false }
    send(h, modDn)
    guard let dn = h.keyMsg(UInt32(usage), kOpDown) else { return false }
    send(h, dn); Thread.sleep(forTimeInterval: dur ?? 0.05)
    guard let up = h.keyMsg(UInt32(usage), kOpUp) else { return false }
    send(h, up)
    guard let modUp = h.keyMsg(UInt32(modUsage), kOpUp) else { return false }
    send(h, modUp); return true
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
    // `mainScreenSize` is in pixels on Xcode 26+ (e.g. iPhone 16 reports
    // 1179x2556) but `IndigoHIDMessageForMouseNSEvent` expects the screen
    // size in the same unit as the point coords opensafari hands in.
    // Divide by `mainScreenScale` (3.0 on recent iPhones) when present so
    // the function sees point-in-point coords on all Xcode versions.
    // See #491 for the pixel-unit regression investigation.
    guard let dt = d.perform(NSSelectorFromString("deviceType"))?.takeUnretainedValue() as? NSObject,
          let sz = dt.value(forKey: "mainScreenSize") as? CGSize else {
        return CGSize(width: 393, height: 852)
    }
    let scale = (dt.value(forKey: "mainScreenScale") as? Double) ?? 1.0
    guard scale > 1.0 else { return sz }
    return CGSize(width: sz.width / scale, height: sz.height / scale)
}


// MARK: - tap-digitizer: IOHIDEvent digitizer probe (#491 second-gen)
//
// Synthesises a kIOHIDEventTypeDigitizer IOHIDEventRef via
// IOHIDEventCreateDigitizerEvent (dlsym'd out of IOKit.framework) and
// wraps it with SimulatorKit's
// IndigoHIDMessageForPointerEventFromHIDEventRef helper. Designed so the
// wrap helper's return value is the experimental signal: a non-nil
// Indigo message is forwarded to the HID client and the tap proceeds;
// nil indicates the wrap helper rejects digitizer-type events.
//
// Empirical result at time of writing (Xcode 26 / iOS 26.4 / iPhone 16):
//   IOHIDEventCreateDigitizerEvent returns a non-nil event with
//   transducerType=Finger, mask=(Range|Touch|Position), touch=true,
//   range=true, but IndigoHIDMessageForPointerEventFromHIDEventRef
//   returns nil — the wrapper appears to be pointer/mouse-only. Next
//   candidate is probably `IndigoHIDMessageForHIDArbitrary` with a raw
//   HID report payload. Kept as a subcommand so future investigators
//   can A/B without rebuilding.
typealias IOHIDCreateDigFn = @convention(c) (
    CFAllocator?, UInt64,
    UInt32, UInt32, UInt32,
    UInt32, UInt32,
    Double, Double, Double,
    Double, Double,
    UInt8, UInt8,
    UInt32
) -> Unmanaged<AnyObject>?

typealias PointerEventMsgFn = @convention(c) (AnyObject) -> UnsafeMutableRawPointer?

// Cache the IOKit handle. On Darwin 25+ the framework binary on disk is
// a symlink to a path inside the dyld shared cache, so `fileExists`
// reports missing even though `dlopen` resolves it fine.
var cachedIOKitHandle: UnsafeMutableRawPointer? = nil
func loadIOKit() -> UnsafeMutableRawPointer? {
    if let h = cachedIOKitHandle { return h }
    cachedIOKitHandle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW)
    return cachedIOKitHandle
}

func execTapDigitizer(_ h: HID, x: Double, y: Double, dur: Double?, sz: CGSize,
                      skHandle: UnsafeMutableRawPointer) -> Bool {
    guard let iokitH = loadIOKit() else {
        fputs("[tap-digitizer] IOKit load failed\n", stderr); return false
    }
    guard let digSym = dlsym(iokitH, "IOHIDEventCreateDigitizerEvent") else {
        fputs("[tap-digitizer] IOHIDEventCreateDigitizerEvent missing\n", stderr); return false
    }
    guard let ptrSym = dlsym(skHandle, "IndigoHIDMessageForPointerEventFromHIDEventRef") else {
        fputs("[tap-digitizer] IndigoHIDMessageForPointerEventFromHIDEventRef missing\n", stderr); return false
    }
    let createDig = unsafeBitCast(digSym, to: IOHIDCreateDigFn.self)
    let ptrMsg = unsafeBitCast(ptrSym, to: PointerEventMsgFn.self)

    // sz is point-denominated (post-#551). Digitizer coords are 0..1.
    let xNorm = x / Double(sz.width)
    let yNorm = y / Double(sz.height)

    // IOKit IOHIDEventTypes.h constants:
    //   kIOHIDDigitizerTransducerTypeFinger = 2
    //   kIOHIDDigitizerEventRange    = 1 << 0
    //   kIOHIDDigitizerEventTouch    = 1 << 1
    //   kIOHIDDigitizerEventPosition = 1 << 2
    let finger: UInt32 = 2
    let mask: UInt32 = 1 | 2 | 4

    func sendPhase(touch: Bool, range: Bool, tipPressure: Double) -> Bool {
        guard let ev = createDig(
            nil, 0,
            finger, 0, 0,
            mask, 0,
            xNorm, yNorm, 0,
            tipPressure, 0,
            range ? 1 : 0, touch ? 1 : 0,
            0
        ) else {
            fputs("[tap-digitizer] IOHIDEventCreateDigitizerEvent returned nil\n", stderr)
            return false
        }
        let obj = ev.takeRetainedValue()
        guard let msg = ptrMsg(obj) else {
            fputs("[tap-digitizer] wrapper nil (touch=\(touch) range=\(range))\n", stderr)
            return false
        }
        send(h, msg)
        return true
    }

    let ok1 = sendPhase(touch: true, range: true, tipPressure: 1.0)
    if !ok1 { return false }
    Thread.sleep(forTimeInterval: dur ?? 0.05)
    return sendPhase(touch: false, range: false, tipPressure: 0)
}

// MARK: - Diagnostics (`diag` subcommand, for issue #491 investigation)
//
// Emits a structured JSON report describing which private-framework pieces
// resolved on this host. No HID injection is attempted — `diag` exists so
// operators can verify the symbol contract without risking the iOS 26+
// screen-lock side-effect tracked in #491.
//
// Usage:
//   sim-hid-bridge diag           — framework + symbol probe only
//   sim-hid-bridge diag <udid>    — also reports device state
//
// The `indigoSymbols` list mirrors the C functions used by the production
// bridge plus candidates worth investigating for the #491 remediation
// (pointer-service registration, raw HID arbitrary payloads).
struct DiagJSON: Encodable {
    let ok: Bool
    let kind: String
    let simulatorKit: FrameworkReport
    let coreSimulator: FrameworkReport
    let indigoSymbols: [String: Bool]
    let classes: [String: Bool]
    let device: DeviceReport?
    let xcodePath: String
    let elapsed_ms: Int
}
struct FrameworkReport: Encodable { let loaded: Bool; let path: String? }
struct DeviceReport: Encodable {
    let udid: String
    let resolved: Bool
    let booted: Bool
    let screenWidth: Double?
    let screenHeight: Double?
    let mainScreenScale: Double?
}

func firstExistingPath(_ candidates: [String]) -> String? {
    for p in candidates { if FileManager.default.fileExists(atPath: p) { return p } }
    return nil
}

func probeFramework(_ candidates: [String], _ handle: UnsafeMutableRawPointer?) -> FrameworkReport {
    FrameworkReport(loaded: handle != nil, path: firstExistingPath(candidates))
}

func runDiag(udid: String?) -> Int32 {
    let start = Date()
    let skPaths = [
        "/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit",
    ]
    let csPaths = [
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    ]
    let skH = loadFramework(skPaths)
    let csH = loadFramework(csPaths)

    let symbolNames = [
        "IndigoHIDMessageForMouseNSEvent",
        "IndigoHIDMessageForKeyboardArbitrary",
        "IndigoHIDMessageForButton",
        "IndigoHIDMessageForPointerEventFromHIDEventRef",
        "IndigoHIDMessageToCreatePointerService",
        "IndigoHIDMessageToRemovePointerService",
        "IndigoHIDMessageToCreateMouseService",
        "IndigoHIDMessageToRemoveMouseService",
        "IndigoHIDMessageForHIDArbitrary",
        "IndigoHIDMessageForPressureEvent",
        "IndigoHIDMessageForScrollEvent",
        "IndigoHIDMessageForTrackpadMoveEvent",
        "IndigoHIDTargetForScreen",
        "IndigoHIDGetKeyboardType",
    ]
    var symbols: [String: Bool] = [:]
    for name in symbolNames {
        symbols[name] = skH.flatMap { dlsym($0, name) } != nil
    }

    let classNames = [
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient",
        "_TtC12SimulatorKit21SimDigitizerInputView",
        "SimDeviceSet",
        "SimServiceContext",
    ]
    var classes: [String: Bool] = [:]
    for name in classNames {
        classes[name] = NSClassFromString(name) != nil
    }

    var deviceReport: DeviceReport? = nil
    if let u = udid {
        if let dev = resolveDevice(udid: u) {
            let sz = getScreenSize(dev)
            let scale = (dev.perform(NSSelectorFromString("deviceType"))?
                .takeUnretainedValue() as? NSObject)?
                .value(forKey: "mainScreenScale") as? Double
            deviceReport = DeviceReport(
                udid: u, resolved: true, booted: isDeviceBooted(dev),
                screenWidth: Double(sz.width), screenHeight: Double(sz.height),
                mainScreenScale: scale
            )
        } else {
            deviceReport = DeviceReport(
                udid: u, resolved: false, booted: false,
                screenWidth: nil, screenHeight: nil, mainScreenScale: nil
            )
        }
    }

    let ms = Int(Date().timeIntervalSince(start) * 1000)
    emitJSON(DiagJSON(
        ok: skH != nil && csH != nil, kind: "diag",
        simulatorKit: probeFramework(skPaths, skH),
        coreSimulator: probeFramework(csPaths, csH),
        indigoSymbols: symbols, classes: classes,
        device: deviceReport, xcodePath: getDevDir(), elapsed_ms: ms
    ))
    // `diag` is advisory — exit 0 on framework miss too, so callers can
    // parse the JSON instead of decoding argv vs. exit-code semantics.
    return 0
}

// MARK: - Entrypoint
func run() -> Int32 {
    let argv = CommandLine.arguments; let start = Date()
    // `diag` bypasses normal command parsing because it does not require a
    // UDID. See runDiag() above.
    if argv.count >= 2 && argv[1] == "diag" {
        let udid = argv.count >= 3 ? argv[2] : nil
        return runDiag(udid: udid)
    }
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
    case .tapPS(let x, let y, let d):     ok = execTapPS(hid, x: x, y: y, dur: d, sz: sz, skHandle: skH)
    case .tapDigitizer(let x, let y, let d): ok = execTapDigitizer(hid, x: x, y: y, dur: d, sz: sz, skHandle: skH)
    case .swipe(let a, let b, let c, let d, let e): ok = execSwipe(hid, x1: a, y1: b, x2: c, y2: d, dur: e, sz: sz)
    case .key(let u, let d):              ok = execKey(hid, usage: u, dur: d)
    case .keyMod(let u, let m, let d):    ok = execKeyMod(hid, usage: u, modUsage: m, dur: d)
    case .button(let n, let d):           ok = execButton(hid, name: n, dur: d)
    }
    guard ok else { emitError("HID injection failed. Check stderr.", code: "HID_INJECTION_FAILED"); return 78 }
    let ms = Int(Date().timeIntervalSince(start) * 1000)
    emitJSON(SuccessJSON(ok: true, kind: kindString(parsed.command), udid: parsed.udid, elapsed_ms: ms))
    return 0
}
exit(run())
