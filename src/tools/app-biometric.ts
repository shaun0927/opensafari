/**
 * `app_biometric` — drive the iOS Simulator's biometric sensor non-interactively
 * via `xcrun simctl ui <device> biometric ...`.
 *
 * Without this tool, any Flutter app that protects a token via `local_auth`
 * or `flutter_secure_storage(useBiometricAuthentication: true)` blocks
 * automation at the first Face ID / Touch ID prompt. The simulator can be
 * told to satisfy or fail an in-flight prompt and to enroll/un-enroll the
 * sensor itself, but those simctl verbs live under `simctl ui` and aren't
 * surfaced anywhere else in OpenSafari yet.
 *
 * Supported actions
 *   enroll       — turn on the simulated sensor (so subsequent prompts can match)
 *   unenroll     — turn the sensor off (forces the app's "no biometric" fallback)
 *   match        — satisfy the next pending prompt (Face/Touch matched)
 *   nonmatch     — fail the next pending prompt
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { getSessionManager } from '../session-manager';

const execFileAsync = promisify(execFile);

const ACTIONS = ['enroll', 'unenroll', 'match', 'nonmatch'] as const;
type BiometricAction = (typeof ACTIONS)[number];

async function resolveDeviceId(params: Record<string, unknown>): Promise<string | null> {
  const explicit = params.deviceId as string | undefined;
  if (explicit) return explicit;
  const sm = getSessionManager();
  const sole = sm.getSoleDeviceId();
  if (sole) return sole;
  try {
    const booted = await new SimulatorManager().listBooted();
    if (booted.length === 1) return booted[0].udid;
  } catch {
    // simctl unavailable
  }
  return null;
}

async function runBiometric(deviceId: string, action: BiometricAction): Promise<void> {
  // simctl ui biometric subcommands:
  //   enrollment [--enroll=<true|false>]     — set/clear enrollment
  //   match                                  — satisfy pending prompt
  //   nonmatch                               — fail pending prompt
  switch (action) {
    case 'enroll':
      await execFileAsync('xcrun', ['simctl', 'ui', deviceId, 'biometric', 'enrollment', '--enroll=true']);
      return;
    case 'unenroll':
      await execFileAsync('xcrun', ['simctl', 'ui', deviceId, 'biometric', 'enrollment', '--enroll=false']);
      return;
    case 'match':
      await execFileAsync('xcrun', ['simctl', 'ui', deviceId, 'biometric', 'match']);
      return;
    case 'nonmatch':
      await execFileAsync('xcrun', ['simctl', 'ui', deviceId, 'biometric', 'nonmatch']);
      return;
  }
}

export function registerAppBiometricTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_biometric',
      description:
        'Drive the simulator\'s biometric sensor. Use `enroll` once per session to arm Face/Touch ID, then `match`/`nonmatch` to satisfy or fail each pending in-app prompt without manual taps.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'enroll | unenroll | match | nonmatch',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (defaults to the sole booted device)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const action = params.action as BiometricAction | undefined;
      if (!action || !ACTIONS.includes(action)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'INVALID_ACTION',
              message: `action must be one of: ${ACTIONS.join(', ')}`,
            }),
          }],
          isError: true,
        };
      }

      const deviceId = await resolveDeviceId(params);
      if (!deviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'DEVICE_NOT_BOOTED',
              message: 'No booted simulator found. Call device_boot first.',
            }),
          }],
          isError: true,
        };
      }

      try {
        await runBiometric(deviceId, action);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, action, deviceId }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'BIOMETRIC_FAILED',
              action,
              deviceId,
              message,
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
