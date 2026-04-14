/**
 * Version utility - uses build-time constant injected by webpack DefinePlugin,
 * falls back to reading package.json for non-bundled contexts (tests, ts-node).
 */

declare const __OPENSAFARI_VERSION__: string | undefined;

let _version: string | null = null;

export function getVersion(): string {
  if (!_version) {
    if (typeof __OPENSAFARI_VERSION__ !== 'undefined') {
      _version = __OPENSAFARI_VERSION__;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require('../package.json');
        _version = pkg.version;
      } catch {
        _version = 'unknown';
      }
    }
  }
  return _version!;
}
