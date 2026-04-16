// cursor-monitor — spawns a child command and fails if the OS cursor moves.
//
// Acceptance criterion for epic #540 and #484: integration tests must never
// reposition the host cursor. This helper wraps a command, polls
// CGEventGetLocation on a background thread while the child runs, and exits
// non-zero if the cursor deviated from its starting position by more than a
// configurable threshold (default 0.5px).
//
// Usage:
//   cursor-monitor -- <command> [args...]
//
// Env:
//   CURSOR_MOVE_THRESHOLD_PX   max allowed delta in pixels (default: 0.5)
//   CURSOR_MONITOR_INTERVAL_MS poll interval in ms        (default: 50)
//
// Exit codes:
//   * child's exit code when cursor stayed within threshold
//   * 42 when cursor moved beyond threshold (overrides child code)
//   * 2  on argument / spawn errors

import Foundation
import CoreGraphics

func die(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data("cursor-monitor: \(message)\n".utf8))
    exit(code)
}

func currentCursor() -> (Double, Double) {
    guard let event = CGEvent(source: nil) else { return (.nan, .nan) }
    let p = event.location
    return (p.x, p.y)
}

let args = CommandLine.arguments
guard let dashIdx = args.firstIndex(of: "--") else {
    die("missing '--' separator before child command")
}
guard dashIdx + 1 < args.count else {
    die("no child command supplied after '--'")
}
let childCmd = args[dashIdx + 1]
let childArgs = Array(args[(dashIdx + 2)...])

let envThreshold = ProcessInfo.processInfo.environment["CURSOR_MOVE_THRESHOLD_PX"]
let threshold = Double(envThreshold ?? "") ?? 0.5
let envInterval = ProcessInfo.processInfo.environment["CURSOR_MONITOR_INTERVAL_MS"]
let intervalMs = max(1, Int(envInterval ?? "") ?? 50)
let intervalSec = Double(intervalMs) / 1000.0

let (x0, y0) = currentCursor()
var monitorActive = !(x0.isNaN || y0.isNaN)
if !monitorActive {
    FileHandle.standardError.write(
        Data("[cursor-monitor] WARN: no cursor reading available — skipping monitor, child will run unguarded\n".utf8)
    )
}

let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
process.arguments = [childCmd] + childArgs
process.environment = ProcessInfo.processInfo.environment
process.standardInput = FileHandle.standardInput
process.standardOutput = FileHandle.standardOutput
process.standardError = FileHandle.standardError

let deltaQueue = DispatchQueue(label: "cursor-monitor.sampler")
let lock = NSLock()
var maxDeltaSq: Double = 0
var samples: Int = 0
var stop = false

if monitorActive {
    deltaQueue.async {
        while true {
            lock.lock()
            let shouldStop = stop
            lock.unlock()
            if shouldStop { break }
            let (x, y) = currentCursor()
            if !x.isNaN && !y.isNaN {
                let dx = x - x0
                let dy = y - y0
                let d2 = dx * dx + dy * dy
                lock.lock()
                if d2 > maxDeltaSq { maxDeltaSq = d2 }
                samples += 1
                lock.unlock()
            }
            Thread.sleep(forTimeInterval: intervalSec)
        }
    }
}

do {
    try process.run()
} catch {
    die("failed to spawn child '\(childCmd)': \(error.localizedDescription)")
}

// Forward SIGINT / SIGTERM to the child so Ctrl-C propagates cleanly.
let forwarder: @convention(c) (Int32) -> Void = { sig in
    // Can't access Swift variables from a C handler; kill(0, sig) reaches
    // the whole process group.
    _ = kill(0, sig)
}
signal(SIGINT, forwarder)
signal(SIGTERM, forwarder)

process.waitUntilExit()

lock.lock()
stop = true
let maxDelta = maxDeltaSq.squareRoot()
let sampleCount = samples
lock.unlock()

// Small grace period for the sampler goroutine to see the stop flag.
Thread.sleep(forTimeInterval: intervalSec)

let report: [String: Any] = [
    "initial": ["x": x0, "y": y0],
    "max_delta_px": maxDelta,
    "samples": sampleCount,
    "threshold_px": threshold,
    "child_exit": Int(process.terminationStatus),
]
if let json = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
    FileHandle.standardError.write(Data("[cursor-monitor] ".utf8))
    FileHandle.standardError.write(json)
    FileHandle.standardError.write(Data("\n".utf8))
}

if monitorActive && maxDelta > threshold {
    FileHandle.standardError.write(
        Data("[cursor-monitor] VIOLATION: cursor moved by \(maxDelta)px (threshold \(threshold)px)\n".utf8)
    )
    exit(42)
}

exit(process.terminationStatus)
