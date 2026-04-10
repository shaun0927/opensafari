/**
 * Post-boot optimizations for iOS Simulator.
 *
 * Disables background services that are unnecessary for QA automation,
 * reducing per-simulator RAM usage by ~400–800 MB.
 */

import { SimctlExecutor } from './simctl';

const SERVICES_TO_DISABLE = [
  'com.apple.Spotlight',
  'com.apple.CloudDocs.MobileDocs',
  'com.apple.knowledge-agent',
  'com.apple.routined',
  'com.apple.analyticsd',
  'com.apple.suggestd',
  'com.apple.UsageTrackingAgent',
];

/**
 * Disable background services inside a booted simulator that are unnecessary
 * for web QA. Each service is stopped via `simctl spawn <udid> launchctl
 * disable`. Failures are logged but never thrown — a service that is already
 * stopped or does not exist on this iOS version should not block automation.
 *
 * @returns The list of services that were successfully disabled.
 */
export async function disableBackgroundServices(
  simctl: SimctlExecutor,
  deviceId: string,
): Promise<string[]> {
  const disabled: string[] = [];

  for (const service of SERVICES_TO_DISABLE) {
    try {
      await simctl.exec(
        ['spawn', deviceId, 'launchctl', 'disable', `system/${service}`],
        { timeout: 5000 },
      );
      try {
        await simctl.exec(
          ['spawn', deviceId, 'launchctl', 'stop', service],
          { timeout: 5000 },
        );
      } catch {
        // Service may not be running — that's fine
      }
      disabled.push(service);
    } catch {
      // Service may not exist on this iOS version — skip silently
    }
  }

  if (disabled.length > 0) {
    console.error(
      `[post-boot] Disabled ${disabled.length}/${SERVICES_TO_DISABLE.length} background services for device ${deviceId}`,
    );
  }

  return disabled;
}

export { SERVICES_TO_DISABLE };
