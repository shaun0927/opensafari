#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

interface WrapperFlags {
  expectBundle?: string;
  requireMatch?: boolean;
  settleMs?: number;
}

function outputJSON(payload: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

function resolveNativeBridge(): { cmd: string; prefixArgs: string[] } {
  const nativeBinary = path.resolve(__dirname, 'sim-hid-bridge-native');
  if (fs.existsSync(nativeBinary)) {
    return { cmd: nativeBinary, prefixArgs: [] };
  }

  const swiftSource = path.resolve(__dirname, 'sim-hid-bridge.swift');
  if (fs.existsSync(swiftSource)) {
    return { cmd: 'swift', prefixArgs: [swiftSource] };
  }

  outputJSON({ error: 'Could not locate sim-hid-bridge-native or sim-hid-bridge.swift in dist/.', code: 'BRIDGE_NOT_FOUND' }, 1);
}

function resolveAxBridge(): string {
  const bridge = path.resolve(__dirname, 'ax-bridge');
  if (fs.existsSync(bridge)) return bridge;
  outputJSON({ error: 'Could not locate dist/ax-bridge for raw context probing.', code: 'AX_BRIDGE_NOT_FOUND' }, 1);
}

function parseWrapperFlags(args: string[]): { passthrough: string[]; flags: WrapperFlags } {
  const passthrough: string[] = [];
  const flags: WrapperFlags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--expect-bundle' && i + 1 < args.length) {
      flags.expectBundle = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--require-match' && i + 1 < args.length) {
      flags.requireMatch = args[i + 1] === 'true';
      i += 1;
      continue;
    }
    if (arg === '--settle-ms' && i + 1 < args.length) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed)) flags.settleMs = parsed;
      i += 1;
      continue;
    }
    passthrough.push(arg);
  }
  return { passthrough, flags };
}

async function execNative(rawArgs: string[]): Promise<{ stdout: string; stderr: string }> {
  const native = resolveNativeBridge();
  return execFileAsync(native.cmd, [...native.prefixArgs, ...rawArgs], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });
}

async function probeContext(deviceId: string, flags: WrapperFlags): Promise<Record<string, unknown>> {
  if (flags.settleMs && flags.settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, flags.settleMs));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const axBridge = resolveAxBridge();
  const args = ['context', '--device', deviceId];
  if (flags.expectBundle) {
    args.push('--expect-bundle', flags.expectBundle);
  }
  try {
    const { stdout } = await execFileAsync(axBridge, args, {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } catch (error) {
    const execError = error as Error & { stdout?: string };
    if (execError.stdout) {
      try {
        return JSON.parse(execError.stdout);
      } catch {
        // fall through
      }
    }
    return {
      classification: 'FOREGROUND_CONTEXT_UNAVAILABLE',
      verified: false,
      contextVerified: false,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function handleContextCommand(args: string[]): Promise<never> {
  const deviceId = args[1];
  if (!deviceId) {
    outputJSON({ error: 'Usage: sim-hid-bridge context <udid> [--expect-bundle <bundle>] [--require-match true|false]' , code: 'USAGE' }, 64);
  }
  const { flags } = parseWrapperFlags(args.slice(2));
  const context = await probeContext(deviceId, flags);
  if (flags.requireMatch && context.expectedBundleMatched === false) {
    outputJSON({ error: `Expected bundle ${flags.expectBundle} is not frontmost.`, code: 'EXPECTED_BUNDLE_MISMATCH', ...context }, 1);
  }
  outputJSON(context, 0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'context') {
    await handleContextCommand(argv);
  }

  const { passthrough, flags } = parseWrapperFlags(argv);
  const command = passthrough[0] === 'diag' ? 'diag' : passthrough[1];
  const deviceId = passthrough[0] === 'diag' ? passthrough[1] : passthrough[0];

  let stdout = '';
  let stderr = '';
  try {
    const result = await execNative(passthrough);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    if (execError.stdout) process.stdout.write(execError.stdout);
    if (execError.stderr) process.stderr.write(execError.stderr);
    process.exit(1);
  }

  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.ok && (command === 'tap' || command === 'swipe') && deviceId) {
      const context = await probeContext(deviceId, flags);
      const enriched = {
        ...parsed,
        dispatch: 'ok',
        verified: context.verified ?? false,
        classification: context.classification ?? 'FOREGROUND_CONTEXT_UNAVAILABLE',
        frontmost: context.frontmost,
        contextVerified: context.contextVerified ?? false,
        expectedBundle: flags.expectBundle,
        expectedBundleMatched: context.expectedBundleMatched,
        warnings: context.warnings,
        visibleSummary: context.visibleSummary,
      } as Record<string, unknown>;
      if (flags.requireMatch && context.expectedBundleMatched === false) {
        enriched.ok = false;
        enriched.error = `Expected bundle ${flags.expectBundle} is not frontmost after ${command}.`;
        enriched.code = 'EXPECTED_BUNDLE_MISMATCH';
      }
      outputJSON(enriched, enriched.ok === false ? 1 : 0);
    }
  } catch {
    // fall through: preserve existing stdout contract when native output is non-JSON.
  }

  process.stdout.write(stdout);
}

main().catch((error) => {
  outputJSON({ error: error instanceof Error ? error.message : String(error), code: 'SIM_HID_WRAPPER_FAILED' }, 1);
});
