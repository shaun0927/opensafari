#!/usr/bin/env node
/**
 * Fake ax-bridge-native stand-in for the recovery integration test
 * (issue #643).
 *
 * Consults the counter file at `$FAKE_AX_COUNTER` (default: sibling
 * `counter.txt`), bumps it, and then:
 *
 *   - invocation 1: writes a `DEVICE_CONTENT_ROOT_EMPTY` error JSON to
 *     stderr, exits with status 1.
 *   - invocations >= 2: writes a valid minimal AXNode dump to stdout
 *     and exits 0.
 *
 * This mirrors the real binary's "exit non-zero + stderr JSON" error
 * contract so `AccessibilityBridge.exec()` goes through its
 * recoverable-error path, and also mirrors the "stdout JSON on success"
 * path so `dumpTreeWithRecovery` observes a clean recovery.
 *
 * The fake accepts (and ignores) any CLI args so tests can pass
 * `--device`, `--max-depth`, etc. without modification.
 */

const fs = require('fs');
const path = require('path');

const counterPath = process.env.FAKE_AX_COUNTER
  || path.resolve(__dirname, 'counter.txt');

let count = 0;
try {
  count = parseInt(fs.readFileSync(counterPath, 'utf-8'), 10) || 0;
} catch {
  count = 0;
}
count += 1;
fs.writeFileSync(counterPath, String(count));

if (count === 1) {
  // Simulate the Swift binary's error path: non-zero exit + stderr JSON.
  process.stderr.write(JSON.stringify({
    error: 'No descendant subtree contains any app-semantics role',
    code: 'DEVICE_CONTENT_ROOT_EMPTY',
  }));
  process.exit(1);
}

// Happy path: minimal AXNode dump that satisfies `AXNode` shape.
process.stdout.write(JSON.stringify({
  role: 'AXApplication',
  label: 'FakeApp',
  traits: [],
  frame: { x: 0, y: 0, width: 100, height: 100 },
  visible: true,
  enabled: true,
  focused: true,
  path: '',
  children: [
    {
      role: 'AXButton',
      label: 'Recovered',
      traits: [],
      frame: { x: 0, y: 0, width: 40, height: 40 },
      visible: true,
      enabled: true,
      focused: false,
      path: '0',
    },
  ],
}));
process.exit(0);
