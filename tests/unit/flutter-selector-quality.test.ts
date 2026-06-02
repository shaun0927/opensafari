import { analyzeSelectorQuality } from '../../src/tools/qa-flutter-semantics';
import type { AXNode } from '../../src/native';

function node(partial: Partial<AXNode>): AXNode {
  return {
    role: 'AXGroup',
    label: undefined,
    identifier: undefined,
    value: undefined,
    frame: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    enabled: true,
    focused: false,
    traits: [],
    path: '/0',
    children: [],
    ...partial,
  };
}

describe('Flutter selector quality audit', () => {
  it('flags label-only and duplicate selectors', () => {
    const tree = node({ children: [
      node({ role: 'AXButton', label: 'Save', path: '/0/0' }),
      node({ role: 'AXButton', label: 'Save', identifier: 'save', path: '/0/1' }),
      node({ role: 'AXButton', label: 'Other Save', identifier: 'save', path: '/0/2' }),
    ] });

    const report = analyzeSelectorQuality(tree);
    expect(report.summary.interactiveNodes).toBe(3);
    expect(report.summary.nodesWithIdentifier).toBe(2);
    expect(report.summary.duplicateIdentifiers).toBe(1);
    expect(report.summary.duplicateLabels).toBe(1);
    expect(report.findings.map((f) => f.category)).toEqual(expect.arrayContaining(['label_only_selector', 'duplicate_identifier', 'duplicate_label']));
  });
});
