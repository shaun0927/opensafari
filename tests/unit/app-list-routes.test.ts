/**
 * Unit tests for PR14 — app_list_routes Info.plist parser.
 *
 * The live simctl path is exercised against real apps, but the plist
 * subset parser is critical and worth pinning down here.
 */

import { parseInfoPlist } from '../../src/tools/app-list-routes';

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.example.myapp</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>myapp</string>
        <string>myapp-debug</string>
      </array>
    </dict>
    <dict>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>universal</string>
      </array>
    </dict>
  </array>
  <key>LSApplicationQueriesSchemes</key>
  <array>
    <string>http</string>
    <string>https</string>
    <string>tel</string>
  </array>
</dict>
</plist>`;

describe('parseInfoPlist', () => {
  it('extracts every CFBundleURLTypes entry with name + role + schemes', () => {
    const result = parseInfoPlist(SAMPLE_PLIST);
    expect(result.urlTypes).toHaveLength(2);
    expect(result.urlTypes[0]).toEqual({
      name: 'com.example.myapp',
      role: 'Editor',
      schemes: ['myapp', 'myapp-debug'],
    });
    expect(result.urlTypes[1]).toEqual({
      name: undefined,
      role: undefined,
      schemes: ['universal'],
    });
  });

  it('extracts LSApplicationQueriesSchemes', () => {
    const result = parseInfoPlist(SAMPLE_PLIST);
    expect(result.queriesSchemes).toEqual(['http', 'https', 'tel']);
  });

  it('returns empty arrays for an Info.plist without URL keys', () => {
    const result = parseInfoPlist(
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.foo</string></dict></plist>',
    );
    expect(result.urlTypes).toEqual([]);
    expect(result.queriesSchemes).toEqual([]);
  });

  it('handles a URL type with empty schemes array', () => {
    const plist = `<plist><dict>
      <key>CFBundleURLTypes</key>
      <array>
        <dict>
          <key>CFBundleURLName</key><string>x</string>
          <key>CFBundleURLSchemes</key><array></array>
        </dict>
      </array>
    </dict></plist>`;
    const result = parseInfoPlist(plist);
    expect(result.urlTypes).toHaveLength(1);
    expect(result.urlTypes[0].schemes).toEqual([]);
    expect(result.urlTypes[0].name).toBe('x');
  });
});
