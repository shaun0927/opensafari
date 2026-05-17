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
      getSoleDeviceId: () => activeDeviceId,
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

    test('query by label normalizes multiline whitespace', () => {
      const multilineTree: AccessibilityNode = {
        ...sampleTree,
        children: [
          {
            ...sampleTree.children[0],
            children: [
              {
                role: 'Button',
                label: '마이\n탭 4개 중 4번째',
                identifier: 'my-tab',
                traits: ['ButtonTrait'],
                frame: { x: 10, y: 10, width: 100, height: 44 },
                isVisible: true,
                isEnabled: true,
                children: [],
              },
            ],
          },
        ],
      };

      const exactMatches = filterTree(multilineTree, {
        strategy: 'label',
        value: '마이 탭 4개 중 4번째',
      });
      const partialMatches = filterTree(multilineTree, {
        strategy: 'label',
        value: '마이',
      });

      expect(exactMatches).toHaveLength(1);
      expect(partialMatches).toHaveLength(1);
    });

    test('query by text matches label and value', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'text',
        value: 'test.com',
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].node.role).toBe('TextField');
    });

    test('query by text matches visible Korean static text', () => {
      const koreanTree: AccessibilityNode = {
        ...sampleTree,
        children: [
          {
            ...sampleTree.children[0],
            children: [
              {
                role: 'StaticText',
                label: '매일 무료 오픈',
                traits: ['StaticTextTrait'],
                frame: { x: 10, y: 10, width: 200, height: 30 },
                isVisible: true,
                isEnabled: true,
                children: [],
              },
            ],
          },
        ],
      };

      const matches = filterTree(koreanTree, {
        strategy: 'text',
        value: '매일 무료 오픈',
      });

      expect(matches).toHaveLength(1);
      expect(matches[0].node.label).toBe('매일 무료 오픈');
    });

    test('query by role', () => {
      const matches = filterTree(sampleTree, {
        strategy: 'role',
        value: 'Button',
      });
      expect(matches).toHaveLength(2);
    });

    test('query by label matches diacritic and fullwidth variants', () => {
      const accentTree: AccessibilityNode = {
        ...sampleTree,
        children: [
          {
            ...sampleTree.children[0],
            children: [
              {
                role: 'Button',
                label: 'Café',
                identifier: 'cafe-btn',
                traits: ['ButtonTrait'],
                frame: { x: 10, y: 10, width: 100, height: 44 },
                isVisible: true,
                isEnabled: true,
                children: [],
              },
              {
                role: 'StaticText',
                // fullwidth latin characters (ａｂｃ → abc after NFKC folding)
                label: 'ｈｅｌｌｏ ｗｏｒｌｄ',
                traits: ['StaticTextTrait'],
                frame: { x: 10, y: 60, width: 200, height: 30 },
                isVisible: true,
                isEnabled: true,
                children: [],
              },
            ],
          },
        ],
      };

      // Diacritic-insensitive: query "cafe" should match label "Café"
      const cafeMatches = filterTree(accentTree, { strategy: 'label', value: 'cafe' });
      expect(cafeMatches).toHaveLength(1);
      expect(cafeMatches[0].node.identifier).toBe('cafe-btn');

      // Width-insensitive: query "hello world" should match fullwidth label
      const fullwidthMatches = filterTree(accentTree, { strategy: 'label', value: 'hello world' });
      expect(fullwidthMatches).toHaveLength(1);
      expect(fullwidthMatches[0].node.role).toBe('StaticText');
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

    test('AXButton lookup stays within the large-tree performance budget', () => {
      const buttons = Array.from({ length: 4000 }, (_, index) => ({
        role: 'Button',
        label: `Button ${index}`,
        identifier: `button-${index}`,
        traits: ['ButtonTrait'],
        frame: { x: 0, y: index, width: 100, height: 44 },
        isVisible: true,
        isEnabled: true,
        children: [],
      }));
      const tree: AccessibilityNode = {
        ...sampleTree,
        children: [{ ...sampleTree.children[0], children: buttons }],
      };

      const started = Date.now();
      const matches = filterTree(tree, {
        strategy: 'role',
        value: 'Button',
      });
      const elapsedMs = Date.now() - started;

      expect(matches).toHaveLength(4000);
      expect(elapsedMs).toBeLessThan(250);
    });

    test('AXStaticText lookup stays within the large-tree performance budget', () => {
      const texts = Array.from({ length: 4000 }, (_, index) => ({
        role: 'StaticText',
        label: `매일 무료 오픈 ${index}`,
        traits: ['StaticTextTrait'],
        frame: { x: 0, y: index, width: 200, height: 20 },
        isVisible: true,
        isEnabled: true,
        children: [],
      }));
      const tree: AccessibilityNode = {
        ...sampleTree,
        children: [{ ...sampleTree.children[0], children: texts }],
      };

      const started = Date.now();
      const matches = filterTree(tree, {
        strategy: 'text',
        value: '매일 무료 오픈',
      });
      const elapsedMs = Date.now() - started;

      expect(matches).toHaveLength(4000);
      expect(elapsedMs).toBeLessThan(250);
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

    test('predicate ~= applies diacritic folding on label and value fields', () => {
      const accentNode: AccessibilityNode = {
        role: 'Button',
        label: 'Réservér',
        value: 'naïve',
        identifier: 'reserve-btn',
        traits: ['ButtonTrait'],
        frame: { x: 0, y: 0, width: 100, height: 44 },
        isVisible: true,
        isEnabled: true,
        children: [],
      };

      // Diacritic-stripped query should match label "Réservér"
      expect(evaluatePredicate(accentNode, 'label~=reserver')).toBe(true);
      // Diacritic-stripped query should match value "naïve"
      expect(evaluatePredicate(accentNode, 'value~=naive')).toBe(true);
      // Non-matching query should still return false
      expect(evaluatePredicate(accentNode, 'label~=cancel')).toBe(false);
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
