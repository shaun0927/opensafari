/**
 * app_record_video — Start/stop screen recording of the simulator.
 *
 * Uses `simctl io recordVideo` to capture device screen as video.
 * Start spawns a background process; stop sends SIGINT and returns the file path.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import { MCPServer } from '../mcp-server';
import { resolveDeviceId, tempPath } from './native-observability-utils';

interface RecordingSession {
  process: ChildProcess;
  filePath: string;
  startedAt: string;
  deviceId: string;
}

/** Active recording sessions keyed by deviceId */
const activeRecordings = new Map<string, RecordingSession>();

/** Exported for testing — clear all active recordings */
export function _clearRecordings(): void {
  activeRecordings.clear();
}

/** Exported for testing — get active recordings map */
export function _getRecordings(): Map<string, RecordingSession> {
  return activeRecordings;
}

export function registerAppRecordVideoTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'app_record_video',
      description:
        'Start or stop screen recording of the simulator. Start begins background capture; stop finalizes the video file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop'],
            description: 'Start or stop recording',
          },
          deviceId: { type: 'string', description: 'Simulator UDID (uses active device if omitted)' },
          codec: {
            type: 'string',
            enum: ['h264', 'hevc'],
            description: 'Video codec (default: h264)',
          },
        },
        required: ['action'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      let deviceId: string;
      try {
        deviceId = resolveDeviceId(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const action = params.action as 'start' | 'stop';
      const codec = (params.codec as string) || 'h264';

      if (action === 'start') {
        // Check if already recording
        if (activeRecordings.has(deviceId)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Recording already in progress for device ${deviceId}. Stop it first.`,
              },
            ],
            isError: true,
          };
        }

        const filePath = tempPath('mp4');
        const child = spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', `--codec=${codec}`, filePath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: false,
        });

        // Handle process errors
        child.on('error', (err) => {
          console.error(`[app_record_video] Recording process error for ${deviceId}: ${err.message}`);
          activeRecordings.delete(deviceId);
        });

        activeRecordings.set(deviceId, {
          process: child,
          filePath,
          startedAt: new Date().toISOString(),
          deviceId,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'recording',
                deviceId,
                codec,
                filePath,
                startedAt: activeRecordings.get(deviceId)!.startedAt,
              }),
            },
          ],
        };
      }

      // action === 'stop'
      const session = activeRecordings.get(deviceId);
      if (!session) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: No active recording found for device ${deviceId}. Start a recording first.`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Send SIGINT to gracefully stop recording (simctl finishes writing the file)
        const exitPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            session.process.kill('SIGKILL');
            reject(new Error('Recording process did not exit within 10 seconds'));
          }, 10000);

          session.process.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          session.process.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        session.process.kill('SIGINT');
        await exitPromise;

        activeRecordings.delete(deviceId);

        // Check if file was created
        let fileSize = 0;
        try {
          const stat = await fs.stat(session.filePath);
          fileSize = stat.size;
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Recording file was not created at ${session.filePath}`,
              },
            ],
            isError: true,
          };
        }

        const stoppedAt = new Date().toISOString();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'stopped',
                deviceId,
                filePath: session.filePath,
                startedAt: session.startedAt,
                stoppedAt,
                fileSizeBytes: fileSize,
              }),
            },
          ],
        };
      } catch (err) {
        activeRecordings.delete(deviceId);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error stopping recording: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
