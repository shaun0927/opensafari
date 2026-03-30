import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';

describe('Event Monitoring Tools — Integration', () => {
  let server: MCPServer;
  beforeEach(() => { server = new MCPServer(); registerAllTools(server); server.setTier(3); });

  test('error_log tool is registered', () => {
    expect(server.getRegisteredTools()).toContain('error_log');
  });
  test('error_log is accessible at Tier 2', () => {
    server.setTier(2);
    expect(server.getRegisteredTools()).toContain('error_log');
  });
});
