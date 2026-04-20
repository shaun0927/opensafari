import { HTTPTransport } from '../../src/transports/http';

describe('HTTPTransport logging', () => {
  test('logs structured server_error payloads', async () => {
    const transport = new HTTPTransport(19444);
    transport.onMessage(async () => null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await transport.start();
    const server = (transport as any).server;
    server.emit('error', new Error('boom'));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"server_error"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"message":"boom"'),
    );

    await transport.close();
    errorSpy.mockRestore();
  });

  test('logs structured client_error payloads', async () => {
    const transport = new HTTPTransport(19445);
    transport.onMessage(async () => null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const socket = { writable: true, end: jest.fn() } as any;

    await transport.start();
    const server = (transport as any).server;
    server.emit('clientError', new Error('bad request'), socket);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"client_error"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"message":"bad request"'),
    );
    expect(socket.end).toHaveBeenCalled();

    await transport.close();
    errorSpy.mockRestore();
  });
});
