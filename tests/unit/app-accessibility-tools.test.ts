import {
  parseAccessibilityOutput,
  filterTree,
  evaluatePredicate,
  formatTreeMarkdown,
  formatTreeFlat,
  resolveDeviceId,
  AccessibilityNode,
} from '../../src/native/accessibility';

// Mock session manager
jest.mock('../../src/session-manager', () => {
  let activeDeviceId: string | null = 'MOCK-DEVICE-UUID';
  return {
    getSessionManager: () => ({
      getActiveDeviceId: () => activeDeviceId,
      _setActiveDeviceId: (id: string | null) => { activeDeviceId = id; },
    }),
  };
});

// Mock simctl
jest.mock('../../src/simulator/simctl', () => ({
  SimctlExecutor: jest.fn(),
  SimctlError: class SimctlError extends Error {
    args: string[];
    exitCode?: number;
    constructor(message: string, args: string[], exitCode?: number) {
      super(message);
      this.name = 'SimctlError';
      this.args = args;
      this.exitCode = exitCode;
    }
  },
}));

describe('Native Accessibility Tools', () => {
  describe('resolveDeviceId', () => {
    test('returns explicit device ID when provided', () => {
      expect(resolveDeviceId('EXPLICIT-ID')).toBe('EXPLICIT-ID');
    });

    test('returns active device ID when no explicit ID', () => {
      expect(resolveDeviceId()).toBe('MOCK-DEVICE-UUID');
    });

    test('throws when no explicit ID and no active device', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getSessionManager } = require('../../src/session-manager');
      getSessionManager()._setActiveDeviceId(null);

      expect(() => resolveDeviceId()).toThrow('No device specified');

      // Restore
      getSessionManager()._setActiveDeviceId('MOCK-DEVICE-UUID');
    });
  });

  describe('parseAccessibilityOutput', () => {
    test('returns root node for empty output', () => {
      const tree = parseAccessibilityOutput('');
      expect(tree.role).toBe('Application');
      expect(tree.children).toHaveLength(0);
    });

    test('parses single element', () => {
      const raw = 'Button - Submit';
      const tree = parseAccessibilityOutput(raw);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].role).toBe('Button');
      expect(tree.children[0].label).toBe('Submit');
    });

    test('parses element with "Element:" prefix', () => {
      const raw = 'Element: StaticText - Hello World';
      const tree = parseAccessibilityOutput(raw);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].role).toBe('StaticText');
      expect(tree.children[0].label).toBe('Hello World');
    });

    test('parses nested hierarchy by indentation', () => {
      const raw = [
        'Window - Main',
        '  Button - OK',
        '  TextField - Email',
        '    StaticText - placeholder',
      ].join('\n');

      const tree = parseAccessibilityOutput(raw);
      expect(tree.children).toHaveLength(1);

      const window = tree.children[0];
      expect(window.role).toBe('Window');
      expect(window.children).toHaveLength(2);
      expect(window.children[0].role).toBe('Button');
      expect(window.children[0].label).toBe('OK');
      expect(window.children[1].role).toBe('TextField');
      expect(window.children[1].children).toHaveLength(1);
      expect(window.children[1].children[0].role).toBe('StaticText');
    });

    test('parses properties like traits, frame, value', () => {
      const raw = [
        'Button - Submit',
        '  Traits: ButtonTrait, PlaysSound',
        '  Frame: {{10, 20}, {100, 44}}',
        '  Value: active',
        '  Identifier: submit-btn',
        '  Enabled: true',
        '  Visible: false',
      ].join('\n');

      const tree = parseAccessibilityOutput(raw);
      const btn = tree.children[0];
      expect(btn.traits).toEqual(['ButtonTrait', 'PlaysSound']);
      expect(btn.frame).toEqual({ x: 10, y: 20, width: 100, height: 44 });
      expect(btn.value).toBe('active');
      expect(btn.identifier).toBe('submit-btn');
      expect(btn.isEnabled).toBe(true);
      expect(btn.isVisible).toBe(false);
    });

    test('skips audit metadata lines', () => {
      const raw = [
        'Audit: Running accessibility checks...',
        'Pass: VoiceOver enabled',
        '---',
        'Button - OK',
        'Result: 0 issues found',
      ].join('\n');

      const tree = parseAccessibilityOutput(raw);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].role).toBe('Button');
    });

    test('parses Label property when not on element line', () => {
      const raw = [
        'Button',
        '  Label: Submit Form',
      ].join('\n');

      const tree = parseAccessibilityOutput(raw);
      expect(tree.children[0].label).toBe('Submit Form');
    });
  });

  describe('filterTree', () => {
    const sampleTree: AccessibilityNode = {
      role: 'Application',
      label: 'Root',
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      isVisible: true,
      isEnabled: true,
      children: [
        {
          role: 'Window',
          label: 'Main Window',
          traits: [],
          frame: { x: 0, y: 0, width: 390, height: 844 },
          isVisible: true,
          isEnabled: true,
          children: [
            {
              role: 'Button',
              label: 'Submit',
              identifier: 'submit-btn',
              traits: ['ButtonTrait'],
              frame: { x: 10, y: 100, width: 100, height: 44 },
              isVisible: true,
              isEnabled: true,
              children: [],
            },
            {
              role: 'TextField',
              label: 'Email Address',
              value: 'user@test.com',
              identifier: 'email-field',
              traits: ['TextFieldTrait'],
              frame: { x: 10, y: 50, width: 370, height: 44 },
              isVisible: true,
              isEnabled: true,
              children: [],
            },
            {
              role: 'StaticText',
              label: 'Welcome to the app',
              traits: ['StaticTextTrait'],
              frame: { x: 10, y: 10, width: 370, height: 30 },
              isVisible: true,
              isEnabled: true,
              children: [],
            },
            {
              role: 'Button',
              label: 'Cancel',
              identifier: 'cancel-btn',
              traits: ['ButtonTrait'],
              frame: { x: 200, y: 100, width: 100, height: 44 },
              isVisible: false,
              isEnabled: false,
              children: [],
            },
          ],
        },
      ],
    };

    test('query by accessibilityId', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'accessibilityId',
        value: 'submit-btn',
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].node.role).toBe('Button');
      expect(matches[0].node.label).toBe('Submit');
    });

    test('query by label (case-insensitive contains)', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'label',
        value: 'email',
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].node.role).toBe('TextField');
    });

    test('query by text matches label and value', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'text',
        value: 'test.com',
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].node.role).toBe('TextField');
    });

    test('query by role', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'role',
        value: 'Button',
      });
      expect(matches).toHaveLength(2);
    });

    test('query returns empty array when no matches', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'label',
        value: 'nonexistent-element',
      });
      expect(matches).toHaveLength(0);
    });

    test('query results include path information', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'accessibilityId',
        value: 'submit-btn',
      });
      expect(matches[0].path).toContain('Button');
      expect(matches[0].path).toContain('Window');
      expect(matches[0].depth).toBeGreaterThan(0);
    });
  });

  describe('evaluatePredicate', () => {
    const node: AccessibilityNode = {
      role: 'Button',
      label: 'Submit',
      value: 'active',
      identifier: 'submit-btn',
      traits: ['ButtonTrait'],
      frame: { x: 10, y: 20, width: 100, height: 44 },
      isVisible: true,
      isEnabled: true,
      children: [],
    };

    test('simple equality', () => {
      expect(evaluatePredicate(node, 'role=Button')).toBe(true);
      expect(evaluatePredicate(node, 'role=TextField')).toBe(false);
    });

    test('inequality', () => {
      expect(evaluatePredicate(node, 'role!=TextField')).toBe(true);
      expect(evaluatePredicate(node, 'role!=Button')).toBe(false);
    });

    test('contains operator (~=)', () => {
      expect(evaluatePredicate(node, 'label~=sub')).toBe(true);
      expect(evaluatePredicate(node, 'label~=xyz')).toBe(false);
    });

    test('AND expression', () => {
      expect(evaluatePredicate(node, 'role=Button AND label=Submit')).toBe(true);
      expect(evaluatePredicate(node, 'role=Button AND label=Cancel')).toBe(false);
    });

    test('OR expression', () => {
      expect(evaluatePredicate(node, 'role=TextField OR label=Submit')).toBe(true);
      expect(evaluatePredicate(node, 'role=TextField OR label=Cancel')).toBe(false);
    });

    test('case-insensitive matching', () => {
      expect(evaluatePredicate(node, 'role=button')).toBe(true);
      expect(evaluatePredicate(node, 'label=SUBMIT')).toBe(true);
    });

    test('field aliases (id, accessibilityid)', () => {
      expect(evaluatePredicate(node, 'id=submit-btn')).toBe(true);
      expect(evaluatePredicate(node, 'identifier=submit-btn')).toBe(true);
    });

    test('returns false for invalid condition format', () => {
      expect(evaluatePredicate(node, 'not a valid predicate')).toBe(false);
    });
  });

  describe('formatTreeMarkdown', () => {
    const tree: AccessibilityNode = {
      role: 'Window',
      label: 'Main',
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      isVisible: true,
      isEnabled: true,
      children: [
        {
          role: 'Button',
          label: 'OK',
          identifier: 'ok-btn',
          traits: ['ButtonTrait'],
          frame: { x: 10, y: 10, width: 100, height: 44 },
          isVisible: true,
          isEnabled: true,
          children: [],
        },
        {
          role: 'StaticText',
          label: 'Hidden Label',
          traits: [],
          frame: { x: 0, y: 0, width: 0, height: 0 },
          isVisible: false,
          isEnabled: false,
          children: [],
        },
      ],
    };

    test('renders indented markdown', () => {
      const md = formatTreeMarkdown(tree);
      expect(md).toContain('- **Window** "Main"');
      expect(md).toContain('  - **Button** "OK" [id: ok-btn] {ButtonTrait}');
      expect(md).toContain('[hidden]');
      expect(md).toContain('[disabled]');
    });

    test('indentation increases with depth', () => {
      const lines = formatTreeMarkdown(tree).split('\n').filter(Boolean);
      // Root is at depth 0
      expect(lines[0]).toMatch(/^- \*\*Window\*\*/);
      // Children are at depth 1
      expect(lines[1]).toMatch(/^  - \*\*Button\*\*/);
    });
  });

  describe('formatTreeFlat', () => {
    const tree: AccessibilityNode = {
      role: 'Window',
      label: 'Main',
      traits: [],
      frame: { x: 0, y: 0, width: 390, height: 844 },
      isVisible: true,
      isEnabled: true,
      children: [
        {
          role: 'Button',
          label: 'Submit',
          value: 'active',
          identifier: 'submit-btn',
          traits: ['ButtonTrait'],
          frame: { x: 10, y: 10, width: 100, height: 44 },
          isVisible: true,
          isEnabled: true,
          children: [],
        },
      ],
    };

    test('renders flat list with paths', () => {
      const flat = formatTreeFlat(tree);
      expect(flat).toContain('Window "Main"');
      expect(flat).toContain('Window > Button "Submit" (active) [submit-btn]');
    });
  });

  describe('tool registration', () => {
    // Simple registration test — verify tools register without errors
    test('app_tree tool registers successfully', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registerAppTreeTool } = require('../../src/tools/app-tree');
      const tools: string[] = [];
      const mockServer = {
        registerTool: (def: { name: string }) => { tools.push(def.name); },
      };
      registerAppTreeTool(mockServer);
      expect(tools).toContain('app_tree');
    });

    test('app_query tool registers successfully', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registerAppQueryTool } = require('../../src/tools/app-query');
      const tools: string[] = [];
      const mockServer = {
        registerTool: (def: { name: string }) => { tools.push(def.name); },
      };
      registerAppQueryTool(mockServer);
      expect(tools).toContain('app_query');
    });
  });
});
