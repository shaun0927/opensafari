/**
 * SimctlInputBackend — uses `xcrun simctl io <device> input` subcommands.
 *
 * Available on Xcode versions that ship the `input` subcommand (typically ≤ 16).
 *
 * Split from `src/tools/native-input-backend.ts` as part of the #707 (a)
 * refactor. Behavior is strictly unchanged.
 */

import { SimctlExecutor } from '../simulator/simctl';
import { timedInput } from '../metrics/input-telemetry';
import type { InputBackend } from './backend';

export class SimctlInputBackend implements InputBackend {
  readonly kind = 'simctl' as const;
  private simctl: SimctlExecutor;

  constructor(simctl?: SimctlExecutor) {
    this.simctl = simctl ?? new SimctlExecutor();
  }

  async tap(deviceId: string, x: number, y: number, duration?: number): Promise<void> {
    await timedInput(this.kind, 'tap', deviceId, async () => {
      if (duration && duration > 0) {
        await this.simctl.exec([
          'io', deviceId, 'input', 'press',
          String(x), String(y), String(duration),
        ]);
      } else {
        await this.simctl.exec(['io', deviceId, 'input', 'tap', String(x), String(y)]);
      }
    });
  }

  async swipe(
    deviceId: string,
    startX: number, startY: number,
    endX: number, endY: number,
    duration?: number,
  ): Promise<void> {
    await timedInput(this.kind, 'swipe', deviceId, async () => {
      try {
        await this.simctl.exec([
          'io', deviceId, 'input', 'swipe',
          String(startX), String(startY), String(endX), String(endY),
        ]);
      } catch {
        // Fallback: `drag` accepts a duration argument
        await this.simctl.exec([
          'io', deviceId, 'input', 'drag',
          String(startX), String(startY), String(endX), String(endY),
          String(duration ?? 0.5),
        ]);
      }
    });
  }

  async typeText(deviceId: string, text: string, _delayMs?: number): Promise<void> {
    await timedInput(this.kind, 'typeText', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'input', 'text', text]);
    });
  }

  async keypress(deviceId: string, keyCode: string): Promise<void> {
    await timedInput(this.kind, 'keypress', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'input', 'keypress', keyCode]);
    });
  }

  async sendKey(deviceId: string, keyName: string): Promise<void> {
    await timedInput(this.kind, 'sendKey', deviceId, async () => {
      await this.simctl.exec(['io', deviceId, 'sendkey', keyName]);
    });
  }

  /**
   * Batching is not supported on SimctlInputBackend. Each `xcrun simctl io
   * input` invocation opens a separate Xcode IPC channel; accumulating calls
   * at the TypeScript level would not reduce that per-call overhead.
   */
  supportsBatching(): boolean {
    return false;
  }
}
