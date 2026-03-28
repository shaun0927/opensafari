/**
 * Simulator availability check for integration tests.
 * Provides utilities to conditionally skip tests that require Xcode/Simulator.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let simulatorAvailable: boolean | null = null;

/**
 * Check whether Xcode Simulator tooling is available on this machine.
 * Result is cached after the first call.
 */
export async function isSimulatorAvailable(): Promise<boolean> {
  if (simulatorAvailable !== null) return simulatorAvailable;
  try {
    await execFileAsync('xcrun', ['simctl', 'list', 'devices']);
    simulatorAvailable = true;
  } catch {
    simulatorAvailable = false;
  }
  return simulatorAvailable;
}

/**
 * Conditional describe block that skips when running in CI
 * or when no simulator is available.
 */
export const describeWithSimulator: jest.Describe =
  process.env.CI ? describe.skip : describe;
