import Ajv, { type AnySchema } from 'ajv';
import { MCPServer } from '../../src/mcp-server';
import { registerScenarioTools } from '../../src/tools/scenario-tools';

function schemaValidator() {
  const server = new MCPServer();
  registerScenarioTools(server);
  const tools = (server as unknown as { tools: Map<string, { definition: { inputSchema: unknown } }> }).tools;
  const schema = tools.get('run_scenario')!.definition.inputSchema;
  return new Ajv({ strict: false }).compile(schema as AnySchema);
}

describe('run_scenario v2 schema SSOT', () => {
  const invalidCases = [
    ['launchApp requires bundleId', { action: 'launchApp' }],
    ['tapElement requires query', { action: 'tapElement', settle: { query: { identifier: 'done' } } }],
    ['tapElement requires settle.query postcondition', { action: 'tapElement', query: { identifier: 'button' } }],
    ['typeElement requires query', { action: 'typeElement', value: 'hello', settle: { query: { identifier: 'done' } } }],
    ['typeElement requires value', { action: 'typeElement', query: { identifier: 'email' }, settle: { query: { identifier: 'done' } } }],
    ['typeElement requires settle.query postcondition', { action: 'typeElement', query: { identifier: 'email' }, value: 'hello' }],
    ['waitFor requires query or settle.query', { action: 'waitFor' }],
    ['assertElement requires query or settle.query', { action: 'assertElement' }],
    ['gotoScreen requires postcondition query', { action: 'gotoScreen', value: 'myapp://settings' }],
  ] as const;

  it.each(invalidCases)('rejects %s', (_name, step) => {
    const validate = schemaValidator();
    expect(validate({ name: 'mobile', version: 2, steps: [step] })).toBe(false);
  });

  it('accepts runtime-valid mobile semantic v2 actions', () => {
    const validate = schemaValidator();
    expect(validate({
      name: 'mobile',
      version: 2,
      steps: [
        { action: 'launchApp', bundleId: 'com.example.app' },
        { action: 'tapElement', query: { identifier: 'settings' }, settle: { query: { identifier: 'settings_open' } } },
        { action: 'typeElement', query: { identifier: 'email' }, value: 'agent@example.com', settle: { query: { text: 'agent@example.com' } } },
        { action: 'waitFor', settle: { query: { label: 'Home' } } },
        { action: 'assertElement', query: { text: 'Done' } },
        { action: 'gotoScreen', value: 'myapp://settings', query: { identifier: 'settings' } },
      ],
    })).toBe(true);
  });
});
