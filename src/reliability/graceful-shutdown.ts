import { SimulatorPool } from '../simulator/pool';

export function setupGracefulShutdown(pool: SimulatorPool): void {
  const shutdown = async (signal: string) => {
    console.error(`[OpenSafari] Received ${signal}, shutting down gracefully...`);
    try {
      await pool.shutdownAll();
    } catch (err) {
      console.error(`[OpenSafari] Error during shutdown: ${err}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
