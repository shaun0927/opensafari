/**
 * Tool tier drift prevention.
 *
 * Every registered tool must have an explicit TOOL_TIERS entry. The
 * getToolTier() fallback is tier 3, so a missing entry hides a tool from the
 * default surface instead of exposing it — but relying on the fallback is
 * still a bug: tier assignment is a deliberate, reviewed decision.
 */
import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';
import { TOOL_TIERS, getToolTier } from '../../src/config/tool-tiers';

describe('Tool tier drift prevention', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerAllTools(server);
  });

  test('every registered tool has an explicit TOOL_TIERS entry', () => {
    const missing = server
      .getRegisteredTools()
      .filter((name) => !(name in TOOL_TIERS));
    // If this fails, add an explicit tier for each listed tool in
    // src/config/tool-tiers.ts — new tools must opt in to a surface.
    expect(missing).toEqual([]);
  });

  test('default tier is 1 (minimal tools/list surface)', () => {
    expect(new MCPServer().getTier()).toBe(1);
  });

  test('unassigned tools fall back to tier 3, not the default surface', () => {
    expect(getToolTier('some_future_unassigned_tool')).toBe(3);
  });
});
