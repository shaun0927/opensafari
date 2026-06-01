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

it('enriches findings with optional Flutter VM route/widget/source context', () => {
  const tree = node({ children: [
    node({ role: 'AXButton', label: 'Continue', path: '/0/0' }),
  ] });
  const report = analyzeSelectorQuality(tree, {
    flutterVmConnected: true,
    widgetTreeUsed: true,
    routeContext: '/checkout',
    widgetSummaryHint: 'CheckoutButton',
    sourceLocationHint: 'lib/checkout.dart:42:7',
  });
  expect(report.enrichment).toMatchObject({ flutterVmConnected: true, widgetTreeUsed: true, routeContext: '/checkout' });
  expect(report.findings[0].vmContext).toMatchObject({ route: '/checkout', widgetTreeHint: 'CheckoutButton' });
});

it('keeps selector quality AX-first when Flutter VM is unavailable', () => {
  const report = analyzeSelectorQuality(node({ children: [node({ role: 'AXButton', label: 'Only Label' })] }), { flutterVmConnected: false });
  expect(report.enrichment).toMatchObject({ flutterVmConnected: false, widgetTreeUsed: false });
  expect(report.findings.map((f) => f.category)).toContain('label_only_selector');
});
