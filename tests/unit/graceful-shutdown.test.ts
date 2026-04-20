import { setupGracefulShutdown } from '../../src/reliability/graceful-shutdown';

describe('setupGracefulShutdown', () => {
  const originalExit = process.exit;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  test('registers SIGTERM/SIGINT/uncaughtException/unhandledRejection handlers', async () => {
    const module = await import('../../src/reliability/graceful-shutdown');
    const pool = { shutdownAll: jest.fn().mockResolvedValue(undefined) } as any;

    const counts = {
      sigterm: process.listeners('SIGTERM').length,
      sigint: process.listeners('SIGINT').length,
      uncaughtException: process.listeners('uncaughtException').length,
      unhandledRejection: process.listeners('unhandledRejection').length,
    };

    module.setupGracefulShutdown(pool);

    expect(process.listeners('SIGTERM').length).toBeGreaterThan(counts.sigterm);
    expect(process.listeners('SIGINT').length).toBeGreaterThan(counts.sigint);
    expect(process.listeners('uncaughtException').length).toBeGreaterThan(counts.uncaughtException);
    expect(process.listeners('unhandledRejection').length).toBeGreaterThan(counts.unhandledRejection);
  });

  test('logs structured shutdown reason and exits 1 for unhandled rejections', async () => {
    const module = await import('../../src/reliability/graceful-shutdown');
    const pool = { shutdownAll: jest.fn().mockResolvedValue(undefined) } as any;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    module.setupGracefulShutdown(pool);
    const handler = process.listeners('unhandledRejection').at(-1) as (reason: unknown) => void;
    handler(new Error('boom'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.shutdownAll).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"UNHANDLED_REJECTION"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"detail":"boom"'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
