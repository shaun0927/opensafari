#!/usr/bin/env swift
//
// sim-hid-bridge.swift — SimulatorKit HID event bridge (PoC stub).
//
// This helper is the Swift side of the SimulatorKitHIDInputBackend described
// in issue #483. It is intended to be compiled to `dist/sim-hid-bridge` and
// spawned from Node.js via `execFile`.
//
// Usage:
//   sim-hid-bridge <udid> tap    <x> <y> [duration]
//   sim-hid-bridge <udid> swipe  <x1> <y1> <x2> <y2> [duration]
//   sim-hid-bridge <udid> key    <hidUsage> [duration]
//   sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]
//
// Output (stdout, newline-terminated JSON):
//   success: { "ok": true,  "kind": "tap", "udid": "...", "elapsed_ms": N }
//   failure: { "ok": false, "error": "...", "code": "..." }
//
// Exit codes:
//   0  — success
//   64 — argument / usage error (EX_USAGE)
//   69 — SimDevice not found / not booted (EX_UNAVAILABLE)
//   78 — SimulatorKit framework could not be loaded (EX_CONFIG)
//   99 — PoC stub: HID injection not yet implemented (see issue #483)
//
// Status: PoC stub.
// This stub intentionally does NOT inject real HID events yet. The purpose of
// the PoC PR (#483) is to prove:
//   1. The Swift+Node bridge spawn model compiles and runs on the dev machine.
//   2. SimulatorKit.framework can be dlopen'd on Xcode 26 hosts.
//   3. The JSON protocol between this binary and the Node wrapper is stable.
//
// Follow-up work (tracked in #483):
//   - Resolve the booted SimDevice for <udid> via CoreSimulator
//     (`SimServiceContext.sharedServiceContextForDeveloperDir` →
//      `defaultDeviceSetWithError` → `devices` filtered by UDID).
//   - Instantiate `FBSimulatorHID` (or equivalent) for that SimDevice.
//   - Translate the parsed command into the appropriate HID event:
//       tap    → digitizer down → up (optionally with hold duration)
//       swipe  → digitizer down → N interpolated moves → up
//       key    → keyboard event (HID usage page 0x07)
//       button → hardware button event (home, lock, volume up/down)
//   - Honour Apple BC-break risk: wrap every private symbol in a nil check and
//     return a structured error code the Node wrapper can surface verbatim.
//
// License note:
//   Behaviour modelled after Facebook's `idb` (MIT) but this file is
//   independently written from public documentation and symbol inspection.

import Foundation

// MARK: - JSON output helpers

struct SuccessJSON: Codable {
    let ok: Bool
    let kind: String
    let udid: String
    let elapsed_ms: Int
}

struct ErrorJSON: Codable {
    let ok: Bool
    let error: String
    let code: String
}

func emitJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
}

func emitError(_ message: String, code: String) {
    emitJSON(ErrorJSON(ok: false, error: message, code: code))
}

// MARK: - Framework loading

/// Attempt to dlopen SimulatorKit.framework. Returns the handle on success,
/// nil on failure. We keep this non-fatal so the stub can still report a
/// structured error instead of segfaulting.
func loadSimulatorKit() -> UnsafeMutableRawPointer? {
    // Xcode installs SimulatorKit under PrivateFrameworks inside the developer
    // directory. The exact path has been stable from Xcode 11 through Xcode 26.
    let candidates = [
        "/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        "/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
    ]
    for path in candidates {
        if FileManager.default.fileExists(atPath: path) {
            if let handle = dlopen(path, RTLD_NOW) {
                return handle
            }
        }
    }
    return nil
}

/// Attempt to dlopen CoreSimulator.framework — needed to resolve SimDevice
/// instances from UDIDs.
func loadCoreSimulator() -> UnsafeMutableRawPointer? {
    let candidates = [
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    ]
    for path in candidates {
        if FileManager.default.fileExists(atPath: path) {
            if let handle = dlopen(path, RTLD_NOW) {
                return handle
            }
        }
    }
    return nil
}

// MARK: - Command parsing

enum Command {
    case tap(x: Double, y: Double, duration: Double?)
    case swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double?)
    case key(hidUsage: Int, duration: Double?)
    case button(name: String, duration: Double?)
}

enum ParseError: Error {
    case usage(String)
}

func parseCommand(_ argv: [String]) throws -> (udid: String, command: Command) {
    // argv[0] is the binary path; we expect at minimum <udid> <kind>.
    guard argv.count >= 3 else {
        throw ParseError.usage(
            "usage: sim-hid-bridge <udid> <tap|swipe|key|button> <args...>"
        )
    }
    let udid = argv[1]
    let kind = argv[2]
    let rest = Array(argv.dropFirst(3))

    switch kind {
    case "tap":
        guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> tap <x> <y> [duration]")
        }
        let duration = rest.count >= 3 ? Double(rest[2]) : nil
        return (udid, .tap(x: x, y: y, duration: duration))

    case "swipe":
        guard rest.count >= 4,
              let x1 = Double(rest[0]), let y1 = Double(rest[1]),
              let x2 = Double(rest[2]), let y2 = Double(rest[3]) else {
            throw ParseError.usage(
                "usage: sim-hid-bridge <udid> swipe <x1> <y1> <x2> <y2> [duration]"
            )
        }
        let duration = rest.count >= 5 ? Double(rest[4]) : nil
        return (udid, .swipe(x1: x1, y1: y1, x2: x2, y2: y2, duration: duration))

    case "key":
        guard rest.count >= 1, let hid = Int(rest[0]) else {
            throw ParseError.usage("usage: sim-hid-bridge <udid> key <hidUsage> [duration]")
        }
        let duration = rest.count >= 2 ? Double(rest[1]) : nil
        return (udid, .key(hidUsage: hid, duration: duration))

    case "button":
        guard rest.count >= 1 else {
            throw ParseError.usage(
                "usage: sim-hid-bridge <udid> button <home|lock|sound-up|sound-down> [duration]"
            )
        }
        let allowed = ["home", "lock", "sound-up", "sound-down"]
        guard allowed.contains(rest[0]) else {
            let list = allowed.joined(separator: ", ")
            throw ParseError.usage(
                "unknown button '\(rest[0])'. Allowed: \(list)"
            )
        }
        let duration = rest.count >= 2 ? Double(rest[1]) : nil
        return (udid, .button(name: rest[0], duration: duration))

    default:
        throw ParseError.usage(
            "unknown command '\(kind)'. Allowed: tap, swipe, key, button"
        )
    }
}

func kindString(_ cmd: Command) -> String {
    switch cmd {
    case .tap:    return "tap"
    case .swipe:  return "swipe"
    case .key:    return "key"
    case .button: return "button"
    }
}

// MARK: - Entrypoint

func run() -> Int32 {
    let argv = CommandLine.arguments
    let start = Date()

    // 1) Parse arguments
    let parsed: (udid: String, command: Command)
    do {
        parsed = try parseCommand(argv)
    } catch let ParseError.usage(message) {
        emitError(message, code: "USAGE")
        return 64
    } catch {
        emitError("unexpected parse error: \(error)", code: "USAGE")
        return 64
    }

    // 2) Load private frameworks — proves the symbol path resolves on this Mac.
    guard let _ = loadSimulatorKit() else {
        emitError(
            "SimulatorKit.framework could not be loaded. Expected at " +
            "/Library/Developer/PrivateFrameworks/SimulatorKit.framework. " +
            "Is Xcode installed?",
            code: "SIMULATORKIT_MISSING"
        )
        return 78
    }
    guard let _ = loadCoreSimulator() else {
        emitError(
            "CoreSimulator.framework could not be loaded. Expected at " +
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework.",
            code: "CORESIMULATOR_MISSING"
        )
        return 78
    }

    // 3) PoC stub: the rest of the pipeline is intentionally unimplemented.
    //    Real HID injection lands in a follow-up PR (see file header).
    //
    //    We still want callers to be able to differentiate "private API
    //    unreachable" (exit 78) from "implementation stub" (exit 99), so the
    //    stub path surfaces a distinct code even though both are currently
    //    terminal for end users.
    _ = parsed
    emitError(
        "sim-hid-bridge is a PoC stub: HID injection is not yet implemented. " +
        "See issue #483. Parsed command kind='\(kindString(parsed.command))' " +
        "udid='\(parsed.udid)'. Framework dlopen succeeded.",
        code: "NOT_IMPLEMENTED"
    )
    _ = start  // reserved for when we emit elapsed_ms on the success path
    return 99
}

exit(run())
