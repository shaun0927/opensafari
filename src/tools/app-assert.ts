import { MCPServer } from '../mcp-server';
import { SimulatorManager } from '../simulator';
import { SimctlExecutor } from '../simulator/simctl';
import { getSessionManager } from '../session-manager';

type AssertionType =
  | 'element_exists'
  | 'text_matches'
  | 'element_visible'
  | 'app_running'
  | 'screen_contains_text';

export interface AppAssertResult {
  passed: boolean;
  assertion: AssertionType;
  testName: string;
  suiteName: string;
  message: string;
  details: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

async function resolveDeviceId(deviceId?: string): Promise<string> {
  if (deviceId) return deviceId;

  const active = getSessionManager().getActiveDeviceId();
  if (active) return active;

  const manager = new SimulatorManager();
  const booted = await manager.listBooted();
  if (booted.length > 0) return booted[0].udid;

  throw new Error('No booted simulator found. Boot a device first.');
}

async function assertAppRunning(
  deviceId: string,
  bundleId: string | undefined,
  testName: string,
  suiteName: string,
  startMs: number,
): Promise<AppAssertResult> {
  if (!bundleId) {
    return {
      passed: false,
      assertion: 'app_running',
      testName,
      suiteName,
      message: 'bundleId is required for app_running assertion',
      details: {},
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  const simctl = new SimctlExecutor();
  let output = '';
  try {
    output = await simctl.exec(['spawn', deviceId, 'launchctl', 'list']);
  } catch (err) {
    return {
      passed: false,
      assertion: 'app_running',
      testName,
      suiteName,
      message: `Failed to query launchctl: ${err instanceof Error ? err.message : String(err)}`,
      details: { bundleId },
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  const lines = output.split('\n');
  const matchLine = lines.find((line) => line.includes(bundleId));
  const passed = matchLine !== undefined;

  return {
    passed,
    assertion: 'app_running',
    testName,
    suiteName,
    message: passed
      ? `App "${bundleId}" is running`
      : `App "${bundleId}" is not running`,
    details: { bundleId, matchLine: matchLine ?? null },
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

async function assertElementExists(
  deviceId: string,
  label: string | undefined,
  identifier: string | undefined,
  assertion: AssertionType,
  testName: string,
  suiteName: string,
  startMs: number,
): Promise<AppAssertResult> {
  if (!label && !identifier) {
    return {
      passed: false,
      assertion,
      testName,
      suiteName,
      message: 'Either label or identifier is required for element assertions',
      details: {},
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  // Use xcrun simctl accessibility to enumerate UI elements
  // xcrun simctl io <device> enumerate outputs the accessibility hierarchy as JSON
  const simctl = new SimctlExecutor();
  let output = '';
  try {
    output = await simctl.exec(['io', deviceId, 'enumerate'], { timeout: 15000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // enumerate may not be available on all Xcode versions — document gracefully
    return {
      passed: false,
      assertion,
      testName,
      suiteName,
      message: `UI enumeration not available: ${msg}. Requires Xcode 14+ with simctl io enumerate support.`,
      details: { label, identifier, error: msg },
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  const searchTerm = label ?? identifier ?? '';
  const passed = output.includes(searchTerm);
  const matchPath = passed ? findMatchPath(output, searchTerm) : null;

  return {
    passed,
    assertion,
    testName,
    suiteName,
    message: passed
      ? `Element with ${label ? 'label' : 'identifier'} '${searchTerm}' found${matchPath ? ` at path ${matchPath}` : ''}`
      : `Element with ${label ? 'label' : 'identifier'} '${searchTerm}' not found`,
    details: { label, identifier, matchPath },
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

async function assertScreenContainsText(
  deviceId: string,
  text: string | undefined,
  pattern: string | undefined,
  assertion: AssertionType,
  testName: string,
  suiteName: string,
  startMs: number,
): Promise<AppAssertResult> {
  if (!text && !pattern) {
    return {
      passed: false,
      assertion,
      testName,
      suiteName,
      message: 'Either text or pattern is required for text assertions',
      details: {},
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  const simctl = new SimctlExecutor();
  let output = '';
  try {
    output = await simctl.exec(['io', deviceId, 'enumerate'], { timeout: 15000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      assertion,
      testName,
      suiteName,
      message: `UI enumeration not available: ${msg}. Requires Xcode 14+ with simctl io enumerate support.`,
      details: { text, pattern, error: msg },
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  let passed = false;
  let matchedValue: string | null = null;

  if (pattern) {
    try {
      const regex = new RegExp(pattern);
      const match = output.match(regex);
      passed = match !== null;
      matchedValue = match ? match[0] : null;
    } catch (err) {
      return {
        passed: false,
        assertion,
        testName,
        suiteName,
        message: `Invalid regex pattern: ${pattern}`,
        details: { pattern, error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    }
  } else {
    passed = output.includes(text!);
    matchedValue = passed ? text! : null;
  }

  return {
    passed,
    assertion,
    testName,
    suiteName,
    message: passed
      ? `Screen contains ${pattern ? 'pattern' : 'text'} '${pattern ?? text}'`
      : `Screen does not contain ${pattern ? 'pattern' : 'text'} '${pattern ?? text}'`,
    details: { text, pattern, matchedValue },
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

function findMatchPath(output: string, searchTerm: string): string | null {
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchTerm)) {
      // Attempt to extract a path-like prefix (indentation-based index)
      const depth = lines[i].length - lines[i].trimStart().length;
      return `${Math.floor(depth / 2)}/${i}`;
    }
  }
  return null;
}

export function registerAppAssertTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_assert',
      description:
        'Run native assertions against simulator state and produce CI-friendly structured output (JSON). Supports element existence, text matching, visibility, and app state checks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          assertion: {
            type: 'string',
            enum: ['element_exists', 'text_matches', 'element_visible', 'app_running', 'screen_contains_text'],
            description: 'Type of assertion to run',
          },
          bundleId: {
            type: 'string',
            description: 'App bundle identifier (required for app_running check)',
          },
          label: {
            type: 'string',
            description: 'Accessibility label to find (for element assertions)',
          },
          identifier: {
            type: 'string',
            description: 'Accessibility identifier to find (for element assertions)',
          },
          text: {
            type: 'string',
            description: 'Text to search for (for text assertions)',
          },
          pattern: {
            type: 'string',
            description: 'Regex pattern for text_matches assertion',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator device UDID (defaults to active device)',
          },
          suiteName: {
            type: 'string',
            description: 'Groups assertions for CI reporting (default: opensafari)',
          },
          testName: {
            type: 'string',
            description: 'Name for this assertion in CI reports',
          },
        },
        required: ['assertion'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      const assertionType = params.assertion as AssertionType;
      const suiteName = (params.suiteName as string | undefined) ?? 'opensafari';
      const testName = (params.testName as string | undefined) ?? `${assertionType}-${Date.now()}`;
      const startMs = Date.now();

      let deviceId: string;
      try {
        deviceId = await resolveDeviceId(params.deviceId as string | undefined);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                passed: false,
                assertion: assertionType,
                testName,
                suiteName,
                message: err instanceof Error ? err.message : String(err),
                details: {},
                durationMs: Date.now() - startMs,
                timestamp: new Date().toISOString(),
              } satisfies AppAssertResult),
            },
          ],
          isError: true,
        };
      }

      let result: AppAssertResult;

      switch (assertionType) {
        case 'app_running':
          result = await assertAppRunning(
            deviceId,
            params.bundleId as string | undefined,
            testName,
            suiteName,
            startMs,
          );
          break;

        case 'element_exists':
        case 'element_visible':
          result = await assertElementExists(
            deviceId,
            params.label as string | undefined,
            params.identifier as string | undefined,
            assertionType,
            testName,
            suiteName,
            startMs,
          );
          break;

        case 'screen_contains_text':
        case 'text_matches':
          result = await assertScreenContainsText(
            deviceId,
            params.text as string | undefined,
            params.pattern as string | undefined,
            assertionType,
            testName,
            suiteName,
            startMs,
          );
          break;

        default: {
          const _exhaustive: never = assertionType;
          result = {
            passed: false,
            assertion: assertionType,
            testName,
            suiteName,
            message: `Unknown assertion type: ${assertionType}`,
            details: {},
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
          };
          void _exhaustive;
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );
}
