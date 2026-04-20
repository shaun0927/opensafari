describe('setupGracefulShutdown', () => {
  const originalExit = process.exit;
  const events = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
  let baselineListeners: Record<string, Function[]>;

  beforeEach(() => {
    jest.resetModules();
    baselineListeners = {
      SIGTERM: [...process.listeners('SIGTERM')],
      SIGINT: [...process.listeners('SIGINT')],
      uncaughtException: [...process.listeners('uncaughtException')],
      unhandledRejection: [...process.listeners('unhandledRejection')],
    };
  });

  afterEach(() => {
    process.exit = originalExit;
    for (const event of events) {
      const current = (process as any).listeners(event) as Function[];
      for (const listener of current) {
        if (!baselineListeners[event].includes(listener)) {
          (process as any).removeListener(event, listener);
        }
      }
    }
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

  test('normalizes non-Error uncaught exceptions before logging', async () => {
    const module = await import('../../src/reliability/graceful-shutdown');
    const pool = { shutdownAll: jest.fn().mockResolvedValue(undefined) } as any;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    module.setupGracefulShutdown(pool);
    const handler = process.listeners('uncaughtException').at(-1) as (error: unknown) => void;
    handler(undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.shutdownAll).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"UNCAUGHT_EXCEPTION"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"detail":"undefined"'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
