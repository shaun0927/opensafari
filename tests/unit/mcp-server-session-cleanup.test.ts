describe('MCPServer HTTP session cleanup', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('registers network interceptor eviction for transport session deletion', async () => {
    const onSessionDelete = jest.fn();
    const transport = {
      onMessage: jest.fn(),
      onSessionDelete,
      send: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
    };
    const removeNetworkInterceptorForSession = jest.fn();

    jest.doMock('../../src/transports', () => ({
      createTransport: jest.fn(async () => transport),
    }));
    jest.doMock('../../src/tools/network-intercept-cache', () => ({
      removeNetworkInterceptorForSession,
    }));

    const { MCPServer } = await import('../../src/mcp-server');
    const server = new MCPServer();

    await server.start({ transport: 'http' });

    expect(onSessionDelete).toHaveBeenCalledWith(expect.any(Function));
    const handler = onSessionDelete.mock.calls[0][0] as (sessionId: string) => void;
    handler('session-a');
    await new Promise((resolve) => setImmediate(resolve));

    expect(removeNetworkInterceptorForSession).toHaveBeenCalledWith('session-a');
  });
});
