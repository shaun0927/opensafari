/**
 * Unit coverage for the ax-bridge recursive scored content-root search
 * (issue #40). Exercises the TypeScript reference implementation in
 * src/native/ax-bridge-content-root.ts, which mirrors the Swift
 * `findDeviceContentRecursively` rubric exactly.
 *
 * Fixtures cover the 6 tree shapes enumerated in the issue:
 *   (a) empty iOSContentGroup between chrome children
 *   (b) populated Flutter tree with iOSContentGroup + app-semantics
 *   (c) SpringBoard-only (no app foreground)
 *   (d) nested content two levels below window
 *   (e) two candidate groups, only one with app-semantics
 *   (f) Settings-app shape (AXTable at top level, no iOSContentGroup trait)
 */

import type { AXFrame, AXNode } from '../../src/native/ax-types';
import {
  DEVICE_CONTENT_ROOT_EMPTY,
  findDeviceContentRecursively,
} from '../../src/native/ax-bridge-content-root';

// Simulator window frame used across fixtures. Picked so the expected
// content rect is (425,202,670,782) — comfortably inside the tolerance
// window for iOSContentGroup frames observed on iPhone 16 / iOS 26.4.
const WINDOW_FRAME: AXFrame = { x: 400, y: 100, width: 720, height: 900 };

// Expected content rect (derived from WINDOW_FRAME + the insets in
// expectedContentRect): x=425, y=202, w=670, h=782.
const CONTENT_FRAME: AXFrame = { x: 425, y: 202, width: 670, height: 782 };

function mkNode(partial: Partial<AXNode> & { role: string; path: string }): AXNode {
  return {
    role: partial.role,
    label: partial.label,
    value: partial.value,
    identifier: partial.identifier,
    traits: partial.traits ?? [],
    frame: partial.frame ?? { x: 0, y: 0, width: 0, height: 0 },
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    focused: partial.focused ?? false,
    children: partial.children,
    path: partial.path,
  };
}

function mkChrome(role: string, label: string, path: string): AXNode {
  return mkNode({ role, label, path });
}

describe('findDeviceContentRecursively', () => {
  // ──────────────────────────────────────────────────────────────────────
  // (a) Empty iOSContentGroup between chrome children → ROOT_EMPTY
  //
  // Concretely the shape observed on Xcode 26.4 / iOS 26.4 for a cold
  // Simulator: chrome buttons, an empty AXGroup[iOSContentGroup], toolbar,
  // close/minimize/fullscreen controls, static title. The pre-refactor
  // finder picked the empty AXGroup and returned a chrome-only tree; the
  // new rubric refuses because no subtree has any AppSemanticsRoles match.
  // ──────────────────────────────────────────────────────────────────────
  it('(a) returns DEVICE_CONTENT_ROOT_EMPTY for empty iOSContentGroup between chrome', () => {
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [
        mkChrome('AXButton', 'Action', '0'),
        mkChrome('AXButton', 'Volume Up', '1'),
        mkChrome('AXButton', 'Volume Down', '2'),
        mkChrome('AXButton', 'Sleep/Wake', '3'),
        mkNode({
          role: 'AXGroup',
          path: '4',
          traits: ['iOSContentGroup'],
          frame: CONTENT_FRAME,
          children: [],
        }),
        mkNode({
          role: 'AXToolbar',
          path: '5',
          children: [
            mkChrome('AXButton', 'Home', '5/0'),
            mkChrome('AXButton', 'Save Screen', '5/1'),
            mkChrome('AXButton', 'Rotate', '5/2'),
          ],
        }),
        mkChrome('AXButton', 'AXCloseButton', '6'),
        mkChrome('AXButton', 'AXFullScreenButton', '7'),
        mkChrome('AXButton', 'AXMinimizeButton', '8'),
        mkNode({
          role: 'AXStaticText',
          label: 'iPhone 16 Verify 77-80 – iOS 26.4',
          path: '9',
        }),
      ],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(DEVICE_CONTENT_ROOT_EMPTY);
  });

  // ──────────────────────────────────────────────────────────────────────
  // (b) Populated Flutter tree with iOSContentGroup + ≥ 3 app-semantics
  //     descendants → returns the iOSContentGroup node.
  // ──────────────────────────────────────────────────────────────────────
  it('(b) selects populated iOSContentGroup with app-semantics descendants', () => {
    const contentGroup = mkNode({
      role: 'AXGroup',
      path: '1',
      traits: ['iOSContentGroup'],
      frame: CONTENT_FRAME,
      children: [
        mkNode({ role: 'AXTextField', label: 'email', path: '1/0' }),
        mkNode({ role: 'AXTextField', label: 'password', path: '1/1' }),
        mkNode({ role: 'AXButton', label: 'Log in', path: '1/2' }),
        mkNode({ role: 'AXStaticText', label: 'Welcome', path: '1/3' }),
      ],
    });
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [
        mkChrome('AXButton', 'Action', '0'),
        contentGroup,
        mkNode({ role: 'AXToolbar', path: '2', children: [] }),
      ],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node.path).toBe('1');
  });

  // ──────────────────────────────────────────────────────────────────────
  // (c) SpringBoard-only: icons under a deeper group → returns that group
  //     (not DEVICE_CONTENT_ROOT_EMPTY). SpringBoard exposes app-semantics
  //     via AXImage + AXStaticText + AXButton labels.
  // ──────────────────────────────────────────────────────────────────────
  it('(c) returns SpringBoard icon group when foreground is SpringBoard', () => {
    const icons = Array.from({ length: 6 }, (_, i) =>
      mkNode({ role: 'AXImage', label: `App ${i}`, path: `1/${i}` }),
    );
    const iconGroup = mkNode({
      role: 'AXGroup',
      path: '1',
      traits: ['iOSContentGroup'],
      frame: CONTENT_FRAME,
      children: icons,
    });
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [
        mkChrome('AXButton', 'Action', '0'),
        iconGroup,
        mkChrome('AXButton', 'AXCloseButton', '2'),
      ],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node.path).toBe('1');
  });

  // ──────────────────────────────────────────────────────────────────────
  // (d) Nested content two levels below window:
  //     window → AXGroup (non-content wrapper) → iOSContentGroup (content).
  //     Return inner node, not the wrapper.
  // ──────────────────────────────────────────────────────────────────────
  it('(d) selects inner iOSContentGroup when nested below a non-content wrapper', () => {
    const innerContent = mkNode({
      role: 'AXGroup',
      path: '0/0',
      traits: ['iOSContentGroup'],
      frame: CONTENT_FRAME,
      children: [
        mkNode({ role: 'AXTextField', path: '0/0/0' }),
        mkNode({ role: 'AXStaticText', label: 'Hello', path: '0/0/1' }),
        mkNode({ role: 'AXButton', label: 'Tap', path: '0/0/2' }),
      ],
    });
    const wrapper = mkNode({
      role: 'AXGroup',
      path: '0',
      frame: WINDOW_FRAME,
      children: [innerContent],
    });
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [wrapper],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node.path).toBe('0/0');
  });

  // ──────────────────────────────────────────────────────────────────────
  // (e) Two candidate groups; only one has app-semantics descendants.
  //     The populated one wins regardless of DOM order.
  // ──────────────────────────────────────────────────────────────────────
  it('(e) prefers the populated content group over an empty one, regardless of DOM order', () => {
    const emptyGroup = mkNode({
      role: 'AXGroup',
      path: '0',
      traits: ['iOSContentGroup'],
      frame: CONTENT_FRAME,
      children: [],
    });
    const populatedGroup = mkNode({
      role: 'AXGroup',
      path: '1',
      traits: ['iOSContentGroup'],
      frame: CONTENT_FRAME,
      children: [
        mkNode({ role: 'AXTextField', path: '1/0' }),
        mkNode({ role: 'AXStaticText', label: 'Content', path: '1/1' }),
      ],
    });
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [emptyGroup, populatedGroup],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node.path).toBe('1');

    // Reversed DOM order — populated still wins.
    const reversed: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [populatedGroup, emptyGroup],
    });
    const reversedResult = findDeviceContentRecursively(reversed);
    expect(reversedResult.ok).toBe(true);
    if (reversedResult.ok) expect(reversedResult.node.path).toBe('1');
  });

  // ──────────────────────────────────────────────────────────────────────
  // (f) Settings-app shape: AXTable at the top level, no iOSContentGroup
  //     trait. The frame-geometry signal + cell descendants push it over
  //     the winning threshold.
  // ──────────────────────────────────────────────────────────────────────
  it('(f) selects an AXTable at top level via frame-geometry + cells', () => {
    const cells = Array.from({ length: 5 }, (_, i) =>
      mkNode({ role: 'AXCell', label: `Setting ${i}`, path: `1/${i}` }),
    );
    const table = mkNode({
      role: 'AXTable',
      path: '1',
      frame: CONTENT_FRAME,
      children: cells,
    });
    const window: AXNode = mkNode({
      role: 'AXWindow',
      path: '',
      frame: WINDOW_FRAME,
      children: [
        mkChrome('AXButton', 'Home', '0'),
        table,
      ],
    });
    const result = findDeviceContentRecursively(window);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node.path).toBe('1');
  });
});
