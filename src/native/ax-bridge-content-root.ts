/**
 * TypeScript reference implementation of the ax-bridge recursive scored
 * content-root search. The production path is the Swift function
 * `findDeviceContentRecursively` in `src/native/ax-bridge.swift`; this file
 * mirrors the same rubric so the algorithm is unit-testable from Jest.
 *
 * The two implementations MUST stay in lock-step. Any change to the rubric,
 * chrome denylist, geometry formula, or fallback policy must land in both
 * files together.
 */

import type { AXFrame, AXNode } from './ax-types';

/** Typed error surfaced when no subtree carries any app-semantics role. */
export const DEVICE_CONTENT_ROOT_EMPTY = 'DEVICE_CONTENT_ROOT_EMPTY' as const;
export type DeviceContentRootEmptyCode = typeof DEVICE_CONTENT_ROOT_EMPTY;

/** Exact case-sensitive labels that belong to the Simulator chrome. */
export const SIMULATOR_CHROME_DENYLIST_EXACT: ReadonlySet<string> = new Set([
  'Action',
  'Home',
  'Save Screen',
  'Rotate',
  'Volume Up',
  'Volume Down',
  'Sleep/Wake',
  'AXCloseButton',
  'AXFullScreenButton',
  'AXMinimizeButton',
]);

/**
 * Matches the simulator window-title shape
 * ("iPhone 16 Verify 77-80 – iOS 26.4"). The separator is a literal em dash.
 */
export function isSimulatorWindowTitleLabel(label: string): boolean {
  return label.startsWith('iPhone ') && label.includes(' – iOS ');
}

export function isChromeLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  if (SIMULATOR_CHROME_DENYLIST_EXACT.has(label)) return true;
  if (isSimulatorWindowTitleLabel(label)) return true;
  return false;
}

/** AX roles that expose app-level semantics. */
export const APP_SEMANTICS_ROLES: ReadonlySet<string> = new Set([
  'AXTextField',
  'AXStaticText',
  'AXButton',
  'AXCell',
  'AXImage',
  'AXLink',
]);

export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Expected device-content rectangle inside a Simulator window. The insets
 * are empirical (matched against the iOSContentGroup frame observed on
 * Xcode 26.4); the per-edge tolerance in `fitsExpectedRect` absorbs
 * per-device variance.
 */
export function expectedContentRect(window: AXNode): ContentRect | null {
  const wf = window.frame;
  if (!wf) return null;
  const bezelInsetX = 25;
  const bezelInsetY = 102;
  const bezelInsetBot = 16;
  return {
    x: wf.x + bezelInsetX,
    y: wf.y + bezelInsetY,
    width: wf.width - 2 * bezelInsetX,
    height: wf.height - bezelInsetY - bezelInsetBot,
  };
}

export function fitsExpectedRect(
  candidate: AXFrame,
  expected: ContentRect,
  tolerance = 15,
): boolean {
  const leftDelta = Math.abs(candidate.x - expected.x);
  const topDelta = Math.abs(candidate.y - expected.y);
  const rightDelta = Math.abs(candidate.x + candidate.width - (expected.x + expected.width));
  const bottomDelta = Math.abs(candidate.y + candidate.height - (expected.y + expected.height));
  return (
    leftDelta <= tolerance
    && topDelta <= tolerance
    && rightDelta <= tolerance
    && bottomDelta <= tolerance
  );
}

export function hasContentGroupTrait(node: AXNode): boolean {
  return node.traits?.includes('iOSContentGroup') ?? false;
}

/**
 * Count app-semantics descendants up to `cap`. Chrome-labelled AXButton
 * nodes do not contribute.
 */
export function countAppSemanticsDescendants(node: AXNode, cap = 5): number {
  let count = 0;
  const stack: AXNode[] = [...(node.children ?? [])];
  while (stack.length > 0 && count < cap) {
    const current = stack.pop() as AXNode;
    if (APP_SEMANTICS_ROLES.has(current.role)) {
      if (current.role === 'AXButton') {
        if (!isChromeLabel(current.label ?? null)) {
          count += 1;
        }
      } else {
        count += 1;
      }
      if (count >= cap) break;
    }
    if (current.children) stack.push(...current.children);
  }
  return Math.min(count, cap);
}

export interface ScoreBreakdown {
  score: number;
  appSemanticsCount: number;
}

export function scoreContentCandidate(
  node: AXNode,
  expected: ContentRect | null,
): ScoreBreakdown {
  let score = 0;
  const { role } = node;

  if ((role === 'AXGroup' || role === 'AXScrollArea') && hasContentGroupTrait(node)) {
    score += 10;
  }

  if (expected && node.frame && fitsExpectedRect(node.frame, expected)) {
    score += 8;
  }

  const descendants = countAppSemanticsDescendants(node, 5);
  score += descendants * 5;

  if (role === 'AXToolbar' || role === 'AXMenuBar') {
    score -= 10;
  }

  if (!node.children || node.children.length === 0) {
    score -= 5;
  }

  return { score, appSemanticsCount: descendants };
}

export interface ContentRootSuccess {
  ok: true;
  node: AXNode;
  score: number;
}

export interface ContentRootFailure {
  ok: false;
  code: DeviceContentRootEmptyCode;
}

export type ContentRootResult = ContentRootSuccess | ContentRootFailure;

/**
 * Recursive, scored content-root search. Mirrors the Swift implementation
 * in src/native/ax-bridge.swift. Returns the best descendant (score-wise)
 * or DEVICE_CONTENT_ROOT_EMPTY when no subtree contains any app-semantics
 * role.
 */
export function findDeviceContentRecursively(
  window: AXNode,
  options: { maxDepth?: number } = {},
): ContentRootResult {
  const maxDepth = options.maxDepth ?? 8;
  const expected = expectedContentRect(window);
  let best: { node: AXNode; score: number; appSemanticsCount: number } | null = null;
  let earlyExit = false;

  const visit = (node: AXNode, depth: number): void => {
    if (earlyExit) return;

    const label = node.label ?? undefined;

    if (depth > 0) {
      if (node.role === 'AXMenuBar' || node.role === 'AXWindow') return;
      if (isChromeLabel(label)) return;
    }

    if (depth > 0) {
      const scored = scoreContentCandidate(node, expected);
      if (!best || scored.score > best.score) {
        best = { node, score: scored.score, appSemanticsCount: scored.appSemanticsCount };
      }
      if (scored.score >= 25 && scored.appSemanticsCount > 0) {
        earlyExit = true;
        return;
      }
    }

    if (depth < maxDepth && node.children) {
      for (const child of node.children) {
        visit(child, depth + 1);
        if (earlyExit) return;
      }
    }
  };

  visit(window, 0);

  if (!best) return { ok: false, code: DEVICE_CONTENT_ROOT_EMPTY };
  const winner = best as { node: AXNode; score: number; appSemanticsCount: number };
  if (winner.appSemanticsCount === 0) {
    return { ok: false, code: DEVICE_CONTENT_ROOT_EMPTY };
  }
  return { ok: true, node: winner.node, score: winner.score };
}
