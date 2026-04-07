import {
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
