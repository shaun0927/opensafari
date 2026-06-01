import { buildAttachTroubleshooting, redactVmServiceUrl } from '../../src/tools/flutter-connect';

describe('flutter_connect diagnostics', () => {
  it('redacts VM service auth tokens from HTTP and WS URLs', () => {
    expect(redactVmServiceUrl('http://127.0.0.1:12345/abc=/')).toBe('http://127.0.0.1:12345/<redacted>/');
    expect(redactVmServiceUrl('ws://127.0.0.1:12345/abc=/ws')).toBe('ws://127.0.0.1:12345/<redacted>/ws');
  });
});


  it('returns actionable troubleshooting for stale cache and fixed-port failures', () => {
    const suggestions = buildAttachTroubleshooting('Could not discover Dart VM Service URL', [
      { source: 'cache', reachable: false, valid: true },
      { source: 'fixed_port', reachable: false, valid: true },
      { source: 'log_scan' },
    ]);
    expect(suggestions.join(' ')).toContain('Cached VM Service URL is stale');
    expect(suggestions.join(' ')).toContain('Fixed VM Service port is not reachable');
    expect(suggestions.join(' ')).toContain('does not own flutter run');
  });
