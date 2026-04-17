#!/usr/bin/env node
// Assert that the opensafari audit log does not reference the AppleScript
// fallback backend. Called from `.github/workflows/headless-smoke.yml` after
// every live-test job so we fail the CI run the moment a regression smuggles
// AppleScript back into a headless code path.
//
// Resolution order for the log path:
//   1. `$OPENSAFARI_AUDIT_LOG` env override (for tests / alternate homedirs)
//   2. `$HOME/.opensafari/audit.log`
//
// Exit codes:
//   0 — log absent (HEADLESS_ONLY=1 blocks construction) OR log has no
//       `applescript` reference.
//   1 — log contains a line referencing `applescript` (case-insensitive).
//       The first 20 offending lines are printed to stderr with line numbers
//       for quick triage.
//   2 — unexpected IO error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const logPath =
  process.env.OPENSAFARI_AUDIT_LOG ||
  path.join(os.homedir(), '.opensafari', 'audit.log');

let raw;
try {
  raw = fs.readFileSync(logPath, 'utf8');
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(
      `[assert-no-applescript] ${logPath} not present — HEADLESS_ONLY=1 blocks ` +
        'the AppleScript backend at construction time.'
    );
    process.exit(0);
  }
  console.error(
    `[assert-no-applescript] failed to read ${logPath}: ${err.message}`
  );
  process.exit(2);
}

const needle = /applescript/i;
const offenders = [];
const lines = raw.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (needle.test(lines[i])) {
    offenders.push({ lineNumber: i + 1, text: lines[i] });
    if (offenders.length >= 20) break;
  }
}

if (offenders.length === 0) {
  console.error(
    `[assert-no-applescript] ${logPath} free of applescript references`
  );
  process.exit(0);
}

console.error(
  `::error::audit.log references applescript — headless posture violated.`
);
for (const hit of offenders) {
  console.error(`${logPath}:${hit.lineNumber}: ${hit.text}`);
}
process.exit(1);
