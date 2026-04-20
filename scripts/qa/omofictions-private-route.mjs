#!/usr/bin/env node
//
// omofictions-private-route.mjs
//
// Scripted QA lane that drives every Omofictions-App private-route scenario
// that historically failed under #34. Runs against a booted simulator that
// already has the build installed (see scripts/qa/omofictions-setup.sh) and
// an opensafari MCP server reachable over HTTP (Streamable HTTP transport,
// `POST /mcp`). See docs/qa/omofictions-app.md for the environment contract.
//
// Usage:
//   node scripts/qa/omofictions-private-route.mjs \
//     --device-id <UDID> \
//     --deeplinks <PATH_TO_omofictions_deeplinks_qa.json> \
//     [--no-act] \
//     [--bridge-url http://127.0.0.1:57337]
//
// Mode flags:
//   --no-act
//     Dry-run: only runs the preflight + AX-identifier enumeration for each
//     screen. Every "act" step (taps, typing, deeplink navigation) logs
//     { ok: true, skipped: "no-act" } without touching the device. Use this
//     to fill in docs/qa/omofictions-app.md §6 selectors table before the
//     Omofictions-App PR adds stable identifiers.
//
// Exit codes:
//   0   every step logged `ok: true`.
//   64  bad args.
//   72  stuck permission overlay — see #43.
//   73  DEEPLINKS_STALE (manifest expired or build_sha mismatch).
//   74  at least one step logged `ok: false`.
//   75  bridge unreachable or returned a non-JSON-RPC response.
//
// Logging contract:
//   One structured JSON object per line on stdout:
//     { step, ok, evidence, elapsedMs, skipped? }
//   A final summary line with `step: "__summary__"` carries the overall
//   verdict. stderr is used for human-readable progress only.

import { readFileSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';

// ──────────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────────

const args = { deviceId: '', deeplinks: '', noAct: false, bridgeUrl: '' };

function parseArgs() {
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    switch (v) {
      case '--device-id':
        args.deviceId = a[++i] ?? '';
        break;
      case '--deeplinks':
        args.deeplinks = a[++i] ?? '';
        break;
      case '--bridge-url':
        args.bridgeUrl = a[++i] ?? '';
        break;
      case '--no-act':
        args.noAct = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        exit(0);
        break;
      default:
        printUsage();
        die(64, `unknown argument: ${v}`);
    }
  }

  args.deviceId ||= env.OMOFICTIONS_QA_DEVICE_ID ?? '';
  args.deeplinks ||= env.OMOFICTIONS_QA_DEEPLINKS_PATH ?? '';
  args.bridgeUrl ||= env.OMOFICTIONS_BRIDGE_URL ?? 'http://127.0.0.1:57337';

  if (!args.deviceId) die(64, '--device-id (or OMOFICTIONS_QA_DEVICE_ID) is required');
  if (!args.deeplinks) die(64, '--deeplinks (or OMOFICTIONS_QA_DEEPLINKS_PATH) is required');
}

function printUsage() {
  stderr.write(
    [
      'Usage: omofictions-private-route.mjs --device-id <UDID> --deeplinks <PATH>',
      '                                      [--no-act] [--bridge-url URL]',
      '',
      'Exit codes:',
      '  0 success | 64 bad args | 72 stuck modal (#43) | 73 DEEPLINKS_STALE',
      '  74 step failed | 75 bridge unreachable',
      '',
    ].join('\n'),
  );
}

function die(code, msg) {
  stderr.write(`[omofictions-qa] ERROR (${code}): ${msg}\n`);
  exit(code);
}

// ──────────────────────────────────────────────────────────────────────────
// Deeplink manifest
// ──────────────────────────────────────────────────────────────────────────

function loadDeeplinks() {
  let raw;
  try {
    raw = readFileSync(args.deeplinks, 'utf8');
  } catch (err) {
    die(64, `cannot read deeplinks manifest at ${args.deeplinks}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(64, `deeplinks manifest is not valid JSON: ${err.message}`);
  }

  const expiresAt = Date.parse(parsed.expires_at ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    die(73, `DEEPLINKS_STALE: expires_at=${parsed.expires_at} is missing or in the past`);
  }

  const expectedBuildSha = env.OMOFICTIONS_QA_BUILD_SHA;
  if (expectedBuildSha && parsed.build_sha && parsed.build_sha !== expectedBuildSha) {
    die(
      73,
      `DEEPLINKS_STALE: manifest build_sha=${parsed.build_sha} does not match OMOFICTIONS_QA_BUILD_SHA=${expectedBuildSha}`,
    );
  }

  const d = parsed.deeplinks ?? {};
  for (const key of ['detail_paid', 'wallet_root']) {
    if (!d[key]) die(73, `DEEPLINKS_STALE: manifest missing deeplinks.${key}`);
  }
  return d;
}

// ──────────────────────────────────────────────────────────────────────────
// JSON-RPC client against the opensafari MCP HTTP transport
// ──────────────────────────────────────────────────────────────────────────

let rpcSeq = 0;

async function callTool(name, toolArgs) {
  const body = {
    jsonrpc: '2.0',
    id: ++rpcSeq,
    method: 'tools/call',
    params: { name, arguments: toolArgs ?? {} },
  };
  let res;
  try {
    res = await fetch(`${args.bridgeUrl.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(75, `bridge unreachable at ${args.bridgeUrl}: ${err.message}`);
  }
  if (!res.ok) die(75, `bridge returned HTTP ${res.status} for tools/call ${name}`);
  const payload = await res.json().catch(() => null);
  if (!payload || payload.jsonrpc !== '2.0') {
    die(75, `bridge returned non-JSON-RPC payload for tools/call ${name}`);
  }
  if (payload.error) {
    return { ok: false, error: payload.error };
  }
  return { ok: true, result: payload.result };
}

// ──────────────────────────────────────────────────────────────────────────
// Step runner
// ──────────────────────────────────────────────────────────────────────────

const steps = [];
let anyFailed = false;

function emit(entry) {
  stdout.write(`${JSON.stringify(entry)}\n`);
  steps.push(entry);
  if (entry.ok === false) anyFailed = true;
}

async function runStep(name, fn, { actOnly = false } = {}) {
  const started = Date.now();
  if (actOnly && args.noAct) {
    emit({ step: name, ok: true, skipped: 'no-act', evidence: {}, elapsedMs: 0 });
    return;
  }
  stderr.write(`▶ ${name}\n`);
  try {
    const evidence = (await fn()) ?? {};
    emit({ step: name, ok: true, evidence, elapsedMs: Date.now() - started });
  } catch (err) {
    const fatal = err?.fatal ?? null;
    emit({
      step: name,
      ok: false,
      evidence: { error: err?.message ?? String(err), ...(err?.evidence ?? {}) },
      elapsedMs: Date.now() - started,
    });
    if (fatal) {
      emitSummary();
      exit(fatal);
    }
  }
}

function emitSummary() {
  emit({
    step: '__summary__',
    ok: !anyFailed,
    evidence: {
      total: steps.filter((s) => s.step !== '__summary__').length,
      failed: steps.filter((s) => s.ok === false).length,
      skipped: steps.filter((s) => s.skipped).length,
      noAct: args.noAct,
    },
    elapsedMs: 0,
  });
}

function raise(message, { fatal, evidence } = {}) {
  const err = new Error(message);
  err.fatal = fatal;
  err.evidence = evidence;
  throw err;
}

// ──────────────────────────────────────────────────────────────────────────
// Scenario steps
// ──────────────────────────────────────────────────────────────────────────

async function stepPreflight() {
  const r = await callTool('app_context', { device_id: args.deviceId });
  if (!r.ok) raise(`app_context failed: ${r.error?.message ?? 'unknown error'}`, { fatal: 72, evidence: { rpcError: r.error } });
  const surface = r.result?.structuredContent?.surface ?? r.result?.surface;
  if (surface !== 'app_content') {
    raise(`preflight expected surface=app_content, got ${surface}`, { fatal: 72, evidence: { surface } });
  }
  return { surface };
}

async function enumerateAxIdentifiers(description) {
  const r = await callTool('app_tree', { device_id: args.deviceId });
  if (!r.ok) return { description, identifiers: [], error: r.error };
  const tree = r.result?.structuredContent?.tree ?? r.result?.tree ?? [];
  const ids = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.identifier) ids.push(n.identifier);
    (n.children ?? []).forEach(walk);
  };
  (Array.isArray(tree) ? tree : [tree]).forEach(walk);
  return { description, identifiers: Array.from(new Set(ids)).slice(0, 100) };
}

async function stepSignupDiscovery() {
  return enumerateAxIdentifiers('signup screen identifiers');
}

async function stepSignup() {
  const typeField = async (identifier, value) => {
    const r = await callTool('app_type_element', { device_id: args.deviceId, identifier, text: value });
    if (!r.ok) raise(`type ${identifier} failed: ${r.error?.message}`);
  };
  await typeField('signup-email-input', env.OMOFICTIONS_QA_EMAIL ?? '');
  await typeField('signup-password-input', env.OMOFICTIONS_QA_PASSWORD ?? '');
  await typeField('signup-confirm-password-input', env.OMOFICTIONS_QA_PASSWORD ?? '');
  const tap = await callTool('app_tap_element', { device_id: args.deviceId, identifier: 'signup-create-account-cta' });
  if (!tap.ok) raise(`tap signup-create-account-cta failed: ${tap.error?.message}`);
  const wait = await callTool('app_wait_for', {
    device_id: args.deviceId,
    identifier: 'landing-tab-home',
    timeout_ms: 15000,
  });
  if (!wait.ok) raise(`landing-tab-home never appeared: ${wait.error?.message}`);
  return { landed: 'landing-tab-home' };
}

async function stepAgeGate() {
  const probe = await callTool('app_query', { device_id: args.deviceId, identifier: 'age-19-plus' });
  if (probe.ok && probe.result?.structuredContent?.matches?.length) {
    const tap = await callTool('app_tap_element', { device_id: args.deviceId, identifier: 'age-19-plus' });
    if (!tap.ok) raise(`tap age-19-plus failed: ${tap.error?.message}`);
    return { dismissed: true };
  }
  return { dismissed: false, note: 'age-gate not present' };
}

async function stepDeeplink(deeplinks) {
  const url = deeplinks.detail_paid;
  const r = await callTool('app_deeplink', { device_id: args.deviceId, url });
  if (!r.ok) raise(`app_deeplink ${url} failed: ${r.error?.message}`);
  const wait = await callTool('app_wait_for', {
    device_id: args.deviceId,
    identifier: 'detail-tab-info',
    timeout_ms: 15000,
  });
  if (!wait.ok) raise(`detail screen did not render for ${url}: ${wait.error?.message}`);
  return { url };
}

async function stepWalletRestore(deeplinks) {
  const nav = await callTool('app_deeplink', { device_id: args.deviceId, url: deeplinks.wallet_root });
  if (!nav.ok) raise(`wallet deeplink failed: ${nav.error?.message}`);
  const tap = await callTool('app_tap_element', { device_id: args.deviceId, identifier: 'wallet-restore-purchases' });
  if (!tap.ok) raise(`wallet-restore-purchases tap failed: ${tap.error?.message}`);
  const wait = await callTool('app_wait_for', {
    device_id: args.deviceId,
    identifier: 'wallet-restore-toast',
    timeout_ms: 10000,
  });
  if (!wait.ok) raise(`restore toast never appeared within 10s`);
  const existing = Number(env.OMOFICTIONS_QA_EXISTING_PURCHASES ?? '0');
  return { restoredAtLeast: existing };
}

async function stepDetailTabs(deeplinks) {
  await callTool('app_deeplink', { device_id: args.deviceId, url: deeplinks.detail_paid });
  const tabs = ['detail-tab-info', 'detail-tab-chapters', 'detail-tab-comments'];
  const rendered = [];
  for (const id of tabs) {
    const tap = await callTool('app_tap_element', { device_id: args.deviceId, identifier: id });
    if (!tap.ok) raise(`tap ${id} failed: ${tap.error?.message}`);
    const q = await callTool('app_query', { device_id: args.deviceId, identifier: `${id}-content` });
    if (!q.ok || !(q.result?.structuredContent?.matches ?? []).length) {
      raise(`${id}-content did not render`);
    }
    rendered.push(id);
  }
  return { rendered };
}

async function stepBookmark() {
  const before = await callTool('app_query', { device_id: args.deviceId, identifier: 'detail-bookmark-toggle' });
  const wasOn = Boolean(before.result?.structuredContent?.matches?.[0]?.selected);
  await callTool('app_tap_element', { device_id: args.deviceId, identifier: 'detail-bookmark-toggle' });
  const after = await callTool('app_query', { device_id: args.deviceId, identifier: 'detail-bookmark-toggle' });
  const isOn = Boolean(after.result?.structuredContent?.matches?.[0]?.selected);
  if (isOn === wasOn) raise(`bookmark AX state did not flip (before=${wasOn}, after=${isOn})`);
  return { before: wasOn, after: isOn };
}

async function stepPurchase() {
  const tap = await callTool('app_tap_element', { device_id: args.deviceId, identifier: 'detail-purchase-cta' });
  if (!tap.ok) raise(`purchase CTA tap failed: ${tap.error?.message}`);
  const alert = await callTool('app_wait_for', {
    device_id: args.deviceId,
    identifier: 'StoreKit.SandboxConfirmation',
    timeout_ms: 15000,
  });
  if (!alert.ok) raise(`StoreKit sandbox sheet did not appear: ${alert.error?.message}`);
  return { sheet: 'StoreKit.SandboxConfirmation' };
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  parseArgs();
  const deeplinks = loadDeeplinks();

  await runStep('preflight', stepPreflight);
  await runStep('signup_discovery', stepSignupDiscovery);
  await runStep('signup', stepSignup, { actOnly: true });
  await runStep('age_gate', stepAgeGate, { actOnly: true });
  await runStep('deeplink', () => stepDeeplink(deeplinks), { actOnly: true });
  await runStep('wallet_restore', () => stepWalletRestore(deeplinks), { actOnly: true });
  await runStep('detail_tabs', () => stepDetailTabs(deeplinks), { actOnly: true });
  await runStep('bookmark', stepBookmark, { actOnly: true });
  await runStep('purchase', stepPurchase, { actOnly: true });

  emitSummary();
  exit(anyFailed ? 74 : 0);
}

main().catch((err) => {
  stderr.write(`[omofictions-qa] fatal: ${err?.stack ?? err}\n`);
  exit(1);
});
