#!/usr/bin/env node
/**
 * Fake ax-bridge-native stand-in for the issue #842 `--debug` topology
 * re-capture test.
 *
 * Behaviour is driven by env vars (inherited from the test process):
 *
 *   - FAKE_MODE=success  → emit a valid minimal AXNode dump, exit 0.
 *   - FAKE_MODE unset    → emit the real binary's failure contract:
 *                          structured `{ error, code }` ErrorJSON on
 *                          STDOUT (see `outputError()` in ax-bridge.swift)
 *                          and exit 1. When `--debug` is present, also
 *                          emit `walker_*` JSON-line events on STDERR,
 *                          mirroring the #660 PR C / #691 diagnostics.
 *
 * Every invocation appends `debug` or `plain` to `$FAKE_AX_LOG` (when set)
 * so the test can assert exactly when the wrapper re-invokes with
 * `--debug` and confirm the success path never does.
 *
 * All CLI args are accepted and (mostly) ignored so the test can pass
 * `dump --device … --max-depth …` unchanged.
 */

const fs = require('fs');

const argv = process.argv.slice(2);
const hasDebug = argv.includes('--debug');

const logPath = process.env.FAKE_AX_LOG;
if (logPath) {
  try {
    fs.appendFileSync(logPath, `${hasDebug ? 'debug' : 'plain'}\n`);
  } catch {
    // best-effort
  }
}

if (process.env.FAKE_MODE === 'success') {
  process.stdout.write(
    JSON.stringify({
      role: 'AXApplication',
      label: 'FakeApp',
      traits: [],
      frame: { x: 0, y: 0, width: 100, height: 100 },
      visible: true,
      enabled: true,
      focused: true,
      path: '',
      children: [],
    }),
  );
  process.exit(0);
}

// Failure path. Under --debug, emit the walker topology on stderr first.
if (hasDebug) {
  const lines = [
    {
      event: 'walker_app_windows_enumerated',
      ts: '2026-06-04T00:00:00.000Z',
      count: 2,
      windows: [
        {
          role: 'AXWindow',
          subrole: 'AXStandardWindow',
          title: 'iPhone 17 Pro – iOS 26.4',
          identifier: '',
        },
        { role: 'AXMenuBar', subrole: '', title: '', identifier: '_NS:1311' },
      ],
    },
    { event: 'walker_overlay_roles_seen', ts: '2026-06-04T00:00:00.001Z', count: 0, samples: [] },
    {
      event: 'walker_winner',
      ts: '2026-06-04T00:00:00.002Z',
      depth: 1,
      role: 'AXGroup',
      label: null,
      score: 5,
      appSemanticsCount: 0,
    },
  ];
  process.stderr.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// Structured error on stdout + non-zero exit (real binary contract).
process.stdout.write(
  JSON.stringify({
    error: 'No descendant subtree contains any app-semantics role',
    code: process.env.FAKE_ERROR_CODE || 'DEVICE_CONTENT_ROOT_EMPTY',
  }),
);
process.exit(1);
