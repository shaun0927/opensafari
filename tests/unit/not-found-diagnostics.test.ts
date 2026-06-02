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

  it('never emits node value and redacts credential patterns in label (#795 #12)', async () => {
    const token = 'ghp_abcdef0123456789abcdef0123456789abcd'; // 36 chars after ghp_
    const root = node({ role: 'AXWindow', path: '0', children: [
      // value holds user-entered secret — must never be emitted.
      node({ role: 'AXTextField', label: 'API token', value: token, path: '0/0' }),
      // a credential that leaks into a label must be redacted on emit.
      node({ role: 'AXButton', label: `token ${token}`, identifier: 'submit', path: '0/1' }),
    ] });
    const bridge = dumperReturning(root);
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'nope' });

    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain(token); // no raw secret anywhere
    expect(diag!.nodes.every((n) => !('value' in n))).toBe(true); // no value field at all
    const submit = diag!.nodes.find((n) => n.identifier === 'submit');
    expect(submit?.label).toContain('[REDACTED_GH_TOKEN]');
    expect(diag!.redactionPolicy).toBeTruthy();
  });

  it('counts and finds candidates across a deeply nested tree', async () => {
    const deep = node({ role: 'AXWindow', path: '0', children: [
      node({ role: 'AXGroup', path: '0/0', children: [
        node({ role: 'AXScrollArea', path: '0/0/0', children: [
          node({ role: 'AXButton', label: 'Deep Checkout', path: '0/0/0/0' }),
        ] }),
      ] }),
    ] });
    const bridge = dumperReturning(deep);
    const diag = await buildNotFoundDiagnostics(bridge, 'udid', { label: 'checkout' });
    expect(diag!.searchedNodeCount).toBe(4); // all 4 levels counted
    expect(diag!.candidates.map((c) => c.label)).toContain('Deep Checkout');
  });
});
