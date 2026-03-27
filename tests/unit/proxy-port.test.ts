import { WebInspectorProxy } from '../../src/simulator/proxy';

describe('WebInspectorProxy port derivation', () => {
  let savedProxyPort: string | undefined;
  let savedDeviceListPort: string | undefined;

  beforeEach(() => {
    savedProxyPort = process.env.OPENSAFARI_PROXY_PORT;
    savedDeviceListPort = process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT;
    delete process.env.OPENSAFARI_PROXY_PORT;
    delete process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT;
  });

  afterEach(() => {
    if (savedProxyPort === undefined) {
      delete process.env.OPENSAFARI_PROXY_PORT;
    } else {
      process.env.OPENSAFARI_PROXY_PORT = savedProxyPort;
    }
    if (savedDeviceListPort === undefined) {
      delete process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT;
    } else {
      process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT = savedDeviceListPort;
    }
  });

  it('defaults to port 9322 and deviceListPort 9321', () => {
    const proxy = new WebInspectorProxy();
    expect(proxy.port).toBe(9322);
    expect(proxy.deviceListPort).toBe(9321);
  });

  it('derives deviceListPort as port - 1 when a custom port option is provided', () => {
    const proxy = new WebInspectorProxy({ port: 9500 });
    expect(proxy.port).toBe(9500);
    expect(proxy.deviceListPort).toBe(9499);
  });

  it('derives deviceListPort from OPENSAFARI_PROXY_PORT env var', () => {
    process.env.OPENSAFARI_PROXY_PORT = '9600';
    const proxy = new WebInspectorProxy();
    expect(proxy.port).toBe(9600);
    expect(proxy.deviceListPort).toBe(9599);
  });

  it('OPENSAFARI_PROXY_DEVICE_LIST_PORT env var overrides derived deviceListPort', () => {
    process.env.OPENSAFARI_PROXY_PORT = '9600';
    process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT = '9400';
    const proxy = new WebInspectorProxy();
    expect(proxy.port).toBe(9600);
    expect(proxy.deviceListPort).toBe(9400);
  });

  it('explicit deviceListPort constructor option takes highest precedence', () => {
    process.env.OPENSAFARI_PROXY_PORT = '9600';
    process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT = '9400';
    const proxy = new WebInspectorProxy({ port: 9500, deviceListPort: 9200 });
    expect(proxy.port).toBe(9500);
    expect(proxy.deviceListPort).toBe(9200);
  });

  it('non-numeric OPENSAFARI_PROXY_PORT falls back to default 9322', () => {
    process.env.OPENSAFARI_PROXY_PORT = 'abc';
    const proxy = new WebInspectorProxy();
    expect(proxy.port).toBe(9322);
    expect(proxy.deviceListPort).toBe(9321);
  });

  it('non-numeric OPENSAFARI_PROXY_DEVICE_LIST_PORT falls back to derived port - 1', () => {
    process.env.OPENSAFARI_PROXY_PORT = '9600';
    process.env.OPENSAFARI_PROXY_DEVICE_LIST_PORT = 'abc';
    const proxy = new WebInspectorProxy();
    expect(proxy.port).toBe(9600);
    expect(proxy.deviceListPort).toBe(9599);
  });
});
