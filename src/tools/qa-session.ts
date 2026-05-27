/**
 * qa_session_* — Multi-tab QA session tools.
 *
 * Expose the TabManager so a single simulator can host N parallel QA
 * sessions, one per Safari tab. Each session is addressable by a stable
 * sessionId so subsequent tool calls can route to the correct tab.
 *
 * This is Phase 2A of issue #408: parallel QA without the memory cost of
 * multiple simulators.
 */

import { MCPServer, getWebKitClient } from '../mcp-server';
import { WebKitClient } from '../webkit/client';
import { resolveDeviceId } from './native-input-utils';
import { openSession, closeSession, listSessions } from './tab-manager';
import { ErrorCode, respondWithStructuredError } from '../errors';

export function registerQaSessionCreateTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_session_create',
      description:
        'Open a new Safari tab and register it as an isolated QA session. Each session has its own WebKit connection so multiple sessions on the same simulator can run QA in parallel without cross-contamination.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'Initial URL to load in the new tab',
          },
          deviceId: {
            type: 'string',
            description: 'Simulator UDID (uses active device if omitted)',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = resolveDeviceId(params);
        const url = params.url as string;

        if (typeof url !== 'string' || url.length === 0) {
          return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'url must be a non-empty string');
        }

        const client = getWebKitClient(deviceId);
        if (!client) {
          return respondWithStructuredError(
            ErrorCode.BACKEND_NOT_CONNECTED,
            `No WebKit connection for device ${deviceId}. Call device_boot first.`,
          );
        }

        const info = await openSession(deviceId, url, client as WebKitClient);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: info.sessionId,
              deviceId: info.deviceId,
              targetId: info.targetId,
              url: info.url,
              createdAt: info.createdAt,
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_session_create] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}

export function registerQaSessionDestroyTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_session_destroy',
      description:
        'Close a QA session and its underlying Safari tab. Idempotent — closing a nonexistent session returns found=false.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'QA session ID returned by qa_session_create',
          },
        },
        required: ['sessionId'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const qaSessionId = params.sessionId as string;
        if (typeof qaSessionId !== 'string' || qaSessionId.length === 0) {
          return respondWithStructuredError(ErrorCode.INVALID_INPUT, 'sessionId must be a non-empty string');
        }

        const closed = await closeSession(qaSessionId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: qaSessionId,
              found: closed,
              status: closed ? 'destroyed' : 'not_found',
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_session_destroy] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}

export function registerQaSessionListTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'qa_session_list',
      description:
        'List all active QA sessions, optionally filtered by device. Each entry includes sessionId, deviceId, targetId, and the URL the session was opened with.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Filter by Simulator UDID (lists all sessions if omitted)',
          },
        },
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      try {
        const deviceId = params.deviceId as string | undefined;
        const sessions = listSessions(deviceId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: sessions.length,
              sessions: sessions.map((s) => ({
                sessionId: s.sessionId,
                deviceId: s.deviceId,
                targetId: s.targetId,
                url: s.url,
                createdAt: s.createdAt,
              })),
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[qa_session_list] ${message}`);
        return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, message);
      }
    },
  );
}
