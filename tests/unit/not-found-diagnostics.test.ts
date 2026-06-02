import {
  buildNotFoundDiagnostics,
  DEFAULT_MAX_NODES,
  type TreeDumper,
} from '../../src/native/not-found-diagnostics';
import type { AXNode } from '../../src/native/ax-types';

function node(partial: Partial<AXNode> & { path: string }): AXNode {
  return {
    role: 'AXGroup',
    traits: [],
    frame: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
    enabled: true,
    focused: false,
    ...partial,
  };
}

/** Build a root whose subtree has `count` leaf children. */
function rootWith(count: number, extra: AXNode[] = []): AXNode {
  const children: AXNode[] = [];
  for (let i = 0; i < count; i++) {
    children.push(node({ role: 'AXStaticText', label: `leaf ${i}`, path: `0/${i}` }));
  }
  return node({ role: 'AXWindow', path: '0', children: [...children, ...extra] });
}

function dumperReturning(root: AXNode): TreeDumper & { dumpTree: jest.Mock } {
  return { dumpTree: jest.fn(async () => root) };
}

describe('buildNotFoundDiagnostics (issue #834)', () => {
  it('returns a digest capped at maxNodes and reports truncation', async () => {
    const root = rootWith(100); // 1 root + 100 leaves = 101 nodes
    const bridge = dumperReturning(root);
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'nope' });
    expect(diag).toBeDefined();
    expect(diag!.searchedNodeCount).toBe(101);
    expect(diag!.nodes.length).toBe(DEFAULT_MAX_NODES);
    expect(diag!.truncated).toBe(true);
    expect(bridge.dumpTree).toHaveBeenCalledTimes(1);
  });

  it('surfaces substring near-matches as candidates', async () => {
    const root = rootWith(3, [
      node({ role: 'AXButton', label: 'Submit Order', path: '0/x' }),
    ]);
    const bridge = dumperReturning(root);
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'submit' });
    expect(diag!.candidates.map((c) => c.label)).toContain('Submit Order');
  });

  it('returns empty candidates when nothing matches (never fabricates)', async () => {
    const bridge = dumperReturning(rootWith(3));
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'Checkout' });
    expect(diag!.candidates).toEqual([]);
  });

  it('matches candidates by identifier and value, not only label', async () => {
    const root = rootWith(1, [
      node({ role: 'AXButton', identifier: 'checkout_cta', path: '0/a' }),
      node({ role: 'AXStaticText', value: 'Total: checkout', path: '0/b' }),
    ]);
    const bridge = dumperReturning(root);
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { identifier: 'checkout' });
    expect(diag!.candidates.length).toBe(2);
  });

  it('degrades to undefined when dumpTree fails (never worsens the failure)', async () => {
    const bridge: TreeDumper & { dumpTree: jest.Mock } = {
      dumpTree: jest.fn(async () => {
        throw new Error('dump timed out');
      }),
    };
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'x' });
    expect(diag).toBeUndefined();
    expect(bridge.dumpTree).toHaveBeenCalledTimes(1);
  });

  it('caps candidates at 5 even with many matches', async () => {
    const matches: AXNode[] = [];
    for (let i = 0; i < 10; i++) {
      matches.push(node({ role: 'AXButton', label: `save ${i}`, path: `0/m${i}` }));
    }
    const bridge = dumperReturning(node({ role: 'AXWindow', path: '0', children: matches }));
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'save' });
    expect(diag!.candidates.length).toBe(5);
  });
});
