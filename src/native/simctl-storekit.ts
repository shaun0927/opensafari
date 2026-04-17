/**
 * simctl StoreKit helpers — thin wrappers around `xcrun simctl storekit` subcommands.
 *
 * Requires Xcode 14+ (simctl storekit was introduced in Xcode 14).
 * Controlled by OPENSAFARI_DISABLE_STOREKIT=1 to allow opt-out in environments
 * where StoreKit simulation is not available or not desired.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export const STOREKIT_DISABLE_ENV = 'OPENSAFARI_DISABLE_STOREKIT';

/**
 * Thrown when OPENSAFARI_DISABLE_STOREKIT=1.
 */
export class StorekitDisabledError extends Error {
  readonly code = 'STOREKIT_DISABLED';
  constructor() {
    super('StoreKit automation is disabled (OPENSAFARI_DISABLE_STOREKIT=1)');
    this.name = 'StorekitDisabledError';
  }
}

/**
 * Thrown when Xcode < 14 (simctl storekit subcommand not found).
 */
export class StorekitUnsupportedError extends Error {
  readonly code = 'XCODE_TOO_OLD';
  constructor() {
    super('simctl storekit requires Xcode 14 or later. Please update Xcode.');
    this.name = 'StorekitUnsupportedError';
  }
}

/** Verify that StoreKit automation is not disabled. Throws StorekitDisabledError if so. */
export function assertStorekitEnabled(): void {
  const val = process.env[STOREKIT_DISABLE_ENV];
  if (val === '1' || val === 'true') {
    throw new StorekitDisabledError();
  }
}

/** Run xcrun simctl storekit <subArgs>. Wraps the Xcode < 14 detection. */
export async function runStorekit(subArgs: string[], timeout = 30000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'storekit', ...subArgs], { timeout });
    return stdout;
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string; code?: number | string };
    const msg = error.stderr ?? error.message ?? '';
    // simctl exits with "unknown command" or similar when Xcode < 14
    if (
      msg.includes('Unknown subcommand') ||
      msg.includes('unknown command') ||
      msg.includes('is not a recognized') ||
      (error.code === 1 && msg.includes('storekit'))
    ) {
      throw new StorekitUnsupportedError();
    }
    throw new Error(`simctl storekit ${subArgs.join(' ')} failed: ${msg}`);
  }
}

/** Shape of a product entry inside a .storekit configuration file. */
export interface StorekitProduct {
  productID?: string;
  // The actual field name varies by Xcode version
  identifier?: string;
  [key: string]: unknown;
}

/** Parse product IDs from a .storekit JSON file. */
export async function parseStorekitProductIds(configPath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`StoreKit config file not found: ${configPath}`);
  }

  let parsed: { products?: StorekitProduct[]; [key: string]: unknown };
  try {
    parsed = JSON.parse(raw) as { products?: StorekitProduct[] };
  } catch {
    throw new Error(`StoreKit config file is not valid JSON: ${configPath}`);
  }

  const products = parsed.products ?? [];
  const ids: string[] = [];
  for (const p of products) {
    const id = (p.productID ?? p.identifier ?? '') as string;
    if (id) ids.push(id);
  }
  return ids;
}

/** Shape of a StoreKit test-session transaction entry returned by `simctl storekit test-session list`. */
export interface StorekitTransaction {
  id: string;
  state: string;
  productId: string;
  [key: string]: unknown;
}

/**
 * Parse transactions from the JSON output of `simctl storekit test-session list`.
 * The command outputs a JSON array or an object with a `transactions` key.
 */
export function parseTransactionList(raw: string): StorekitTransaction[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as StorekitTransaction[];
    }
    const obj = parsed as { transactions?: StorekitTransaction[] };
    return obj.transactions ?? [];
  } catch {
    return [];
  }
}
