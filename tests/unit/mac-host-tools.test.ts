import { MCPServer } from '../../src/mcp-server';
import { registerMacHostTools } from '../../src/tools/mac-host-tools';

jest.mock('../../src/macos/host-ax', () => ({
  launchHostApp: jest.fn().mockResolvedValue({ launched: true }),
  dumpHostTree: jest.fn().mockResolvedValue({ role: 'AXApplication', frame: { x: 0, y: 0, width: 1, height: 1 }, visible: true, enabled: true, focused: false, actions: [], path: '', children: [] }),
  hostScreenshot: jest.fn().mockResolvedValue('/tmp/s.png'),
  queryHostTree: jest.fn().mockReturnValue([{ role: 'AXButton', label: 'Open', frame: { x: 10, y: 20, width: 30, height: 40 }, visible: true, enabled: true, focused: false, actions: ['AXPress'], path: '0' }]),
  pressHostElement: jest.fn().mockResolvedValue({ ok: true, code: 'OK' }),
  clickHostPoint: jest.fn().mockResolvedValue({ ok: true }),
  collectHostBundle: jest.fn().mockResolvedValue({ artifactDir: '/tmp/a', screenshotPath: '/tmp/a/s.png', treePath: '/tmp/a/t.json' }),
}));

describe('mac host tools', () => {
  it('registers host mac tools without simulator deviceId', async () => {
    const server = new MCPServer();
    registerMacHostTools(server);
    expect(server.getRegisteredTools()).toEqual(expect.arrayContaining(['mac_app_launch', 'mac_app_tree', 'mac_app_tap_element', 'mac_testflight_snapshot']));
    const result = await server.getToolHandler('mac_app_launch')!('s', { bundleId: 'com.apple.TestFlight' });
    expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toMatchObject({ launched: true });
  });
});
