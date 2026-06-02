import { redactVmServiceUrl } from '../../src/tools/flutter-connect';

describe('flutter_connect diagnostics', () => {
  it('redacts VM service auth tokens from HTTP and WS URLs', () => {
    expect(redactVmServiceUrl('http://127.0.0.1:12345/abc=/')).toBe('http://127.0.0.1:12345/<redacted>/');
    expect(redactVmServiceUrl('ws://127.0.0.1:12345/abc=/ws')).toBe('ws://127.0.0.1:12345/<redacted>/ws');
  });
});
