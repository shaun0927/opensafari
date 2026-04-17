import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  assertStorekitEnabled,
  runStorekit,
  parseTransactionList,
  StorekitDisabledError,
  StorekitUnsupportedError,
} from '../native/simctl-storekit';

type TestSessionAction = 'list' | 'approve' | 'decline' | 'refund' | 'clear' | 'askToBuy';

const TRANSACTION_REQUIRED_ACTIONS: TestSessionAction[] = ['approve', 'decline', 'refund'];

export function registerAppStorekitTestSessionTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_storekit_test_session',
      description:
        'Control StoreKit sandbox test sessions on an iOS Simulator. ' +
        'Supports listing, approving, declining, refunding, and clearing transactions, ' +
        'and toggling Ask to Buy. Requires Xcode 14+. Disabled when OPENSAFARI_DISABLE_STOREKIT=1.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'approve', 'decline', 'refund', 'clear', 'askToBuy'],
            description: 'Action to perform on the test session',
          },
          udid: {
            type: 'string',
            description: 'Simulator UDID. Falls back to the sole booted device if omitted.',
          },
          transactionId: {
            type: 'string',
            description: 'Transaction ID (required for approve, decline, refund)',
          },
          enabled: {
            type: 'boolean',
            description: 'Enable or disable Ask to Buy (required for askToBuy action)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        assertStorekitEnabled();
      } catch (err) {
        if (err instanceof StorekitDisabledError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: err.code, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      const action = params.action as TestSessionAction;
      if (!action) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'MISSING_ACTION', message: 'action is required' }) },
          ],
          isError: true,
        };
      }

      const sm = getSessionManager();
      const udid = (params.udid as string | undefined) ?? sm.getSoleDeviceId();
      if (!udid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'DEVICE_NOT_BOOTED',
                message: 'No device specified and no sole booted simulator found. Boot a simulator first.',
              }),
            },
          ],
          isError: true,
        };
      }

      // Validate transactionId requirement
      if (TRANSACTION_REQUIRED_ACTIONS.includes(action)) {
        const transactionId = params.transactionId as string | undefined;
        if (!transactionId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'MISSING_TRANSACTION_ID',
                  message: `transactionId is required for action '${action}'`,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // Validate enabled requirement for askToBuy
      if (action === 'askToBuy' && params.enabled === undefined) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'MISSING_ENABLED',
                message: "enabled (boolean) is required for action 'askToBuy'",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        let raw: string;
        let result: Record<string, unknown>;

        switch (action) {
          case 'list': {
            raw = await runStorekit(['test-session', 'list', udid]);
            const transactions = parseTransactionList(raw);
            result = {
              ok: true,
              action,
              udid,
              transactions,
              _meta: {
                _telemetry: { backend: 'storekit', op: action, udid },
              },
            };
            break;
          }

          case 'approve':
          case 'decline':
          case 'refund': {
            const transactionId = params.transactionId as string;
            await runStorekit(['test-session', action, udid, transactionId]);
            result = {
              ok: true,
              action,
              udid,
              transactionId,
              _meta: {
                _telemetry: { backend: 'storekit', op: action, udid, transactionId },
              },
            };
            break;
          }

          case 'clear': {
            await runStorekit(['test-session', 'clear', udid]);
            result = {
              ok: true,
              action,
              udid,
              _meta: {
                _telemetry: { backend: 'storekit', op: action, udid },
              },
            };
            break;
          }

          case 'askToBuy': {
            const enabled = params.enabled as boolean;
            await runStorekit(['test-session', 'ask-to-buy', udid, enabled ? 'enable' : 'disable']);
            result = {
              ok: true,
              action,
              udid,
              enabled,
              _meta: {
                _telemetry: { backend: 'storekit', op: action, udid, enabled },
              },
            };
            break;
          }

          default: {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'INVALID_ACTION',
                    message: `Unknown action '${action as string}'. Valid actions: list, approve, decline, refund, clear, askToBuy`,
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof StorekitUnsupportedError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: err.code, message: err.message }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'STOREKIT_ERROR', message: (err as Error).message }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
