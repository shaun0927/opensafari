import { SimulatorPool } from '../simulator/pool';

let handlersInstalled = false;
let shutdownInFlight = false;

function emitShutdownReason(payload: {
  reason: string;
  exitCode: number;
  detail?: string;
}): void {
  console.error(
    `[OpenSafari] Shutdown reason ${JSON.stringify({
      reason: payload.reason,
      exitCode: payload.exitCode,
      detail: payload.detail ?? null,
    })}`,
  );
}

export function setupGracefulShutdown(pool: SimulatorPool): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const shutdown = async (reason: string, exitCode: number, detail?: string) => {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    emitShutdownReason({ reason, exitCode, detail });
    try {
      await pool.shutdownAll();
    } catch (err) {
      console.error(`[OpenSafari] Error during shutdown: ${err}`);
    }
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('uncaughtException', (error) =>
    void shutdown(
      'UNCAUGHT_EXCEPTION',
      1,
      error instanceof Error ? error.message : String(error),
    ));
  process.on('unhandledRejection', (reason) =>
    void shutdown(
      'UNHANDLED_REJECTION',
      1,
      reason instanceof Error ? reason.message : String(reason),
    ));
}

export function __resetGracefulShutdownForTests(): void {
  handlersInstalled = false;
  shutdownInFlight = false;
}
