import { AXNode } from '../native/ax-types';
import { AlertAction, AlertLocale, matchLabel, normalizeLabel } from './app-handle-alert-labels';

export interface DialogDetectionContext {
  tree: AXNode;        // full AX tree root
  deviceWidth: number; // logical points; used for full-width test
}

export interface AlertCandidate {
  node: AXNode;         // AXButton node to press
  label: string;        // exact label matched
  locale: AlertLocale;
  siblingStaticTexts: string[]; // static-text context visible above the button inside the same dialog
  reason: 'ancestor_is_dialog' | 'geometry_bounded' | 'corpus_no_conflict';
}

// Roles that indicate a system-modal dialog scope
const DIALOG_ROLES = new Set(['AXSheet', 'AXDialog']);

// Roles considered "generic" containers that do not count as dialog ancestors
const GENERIC_ROLES = new Set([
  'AXApplication',
  'AXWindow',
  'AXGroup',
  'AXScrollArea',
  'AXList',
  'AXLayoutArea',
]);

/**
 * Walk up toward the root looking for the closest non-generic ancestor.
 * Returns that ancestor node if its role is a dialog role.
 */
function findNonGenericAncestor(
  node: AXNode,
  parentMap: Map<string, AXNode>,
): AXNode | null {
  let current: AXNode | undefined = parentMap.get(node.path);
  while (current !== undefined) {
    if (!GENERIC_ROLES.has(current.role)) {
      return current;
    }
    current = parentMap.get(current.path);
  }
  return null;
}

/**
 * Horizontal overlap: two segments [ax, ax+aw) and [bx, bx+bw) overlap.
 */
function horizontalOverlap(
  ax: number, aw: number,
  bx: number, bw: number,
): boolean {
  return ax < bx + bw && bx < ax + aw;
}

/**
 * Collect all AXStaticText siblings of `node` that:
 *  - appear above the button (sibling.y + sibling.height <= node.y)
 *  - share horizontal column (overlap within 40px tolerance)
 */
function getSiblingStaticTextsAbove(node: AXNode, parent: AXNode): string[] {
  const siblings = parent.children ?? [];
  const result: string[] = [];
  for (const sib of siblings) {
    if (sib.role !== 'AXStaticText') continue;
    if (!sib.visible) continue;
    const sibBottom = sib.frame.y + sib.frame.height;
    if (sibBottom > node.frame.y) continue;
    // horizontal column overlap (allow 40px tolerance either side)
    if (!horizontalOverlap(
      node.frame.x - 40, node.frame.width + 80,
      sib.frame.x, sib.frame.width,
    )) continue;
    if (sib.label && sib.label.trim().length > 0) {
      result.push(sib.label.trim());
    }
  }
  return result;
}

/**
 * Clause 2 (geometry_bounded): checks whether the button has at least one
 * AXStaticText sibling whose frame sits above it in the same horizontal
 * column AND the union frame width is less than deviceWidth - 32.
 */
function isGeometryBounded(
  node: AXNode,
  parent: AXNode,
  deviceWidth: number,
): boolean {
  const siblings = parent.children ?? [];

  // Compute union frame of node + siblings
  let unionX = node.frame.x;
  let unionRight = node.frame.x + node.frame.width;
  let foundStaticTextAbove = false;

  for (const sib of siblings) {
    if (sib.role !== 'AXStaticText') continue;
    if (!sib.visible) continue;
    const sibBottom = sib.frame.y + sib.frame.height;
    if (sibBottom > node.frame.y) continue;
    if (!horizontalOverlap(
      node.frame.x - 40, node.frame.width + 80,
      sib.frame.x, sib.frame.width,
    )) continue;
    foundStaticTextAbove = true;
    unionX = Math.min(unionX, sib.frame.x);
    unionRight = Math.max(unionRight, sib.frame.x + sib.frame.width);
  }

  if (!foundStaticTextAbove) return false;
  const unionWidth = unionRight - unionX;
  return unionWidth < deviceWidth - 32;
}

/**
 * Clause 3: The label is in the corpus AND no other button in the entire
 * tree has the same label AND a non-empty identifier (in-app stable ID).
 */
function hasNoIdentifierConflict(label: string, tree: AXNode): boolean {
  const target = normalizeLabel(label);
  return !dfsFind(tree, (n) => {
    return (
      n.role === 'AXButton' &&
      typeof n.identifier === 'string' &&
      n.identifier.length > 0 &&
      typeof n.label === 'string' &&
      normalizeLabel(n.label) === target
    );
  });
}

/** Generic DFS predicate search; returns true if any node satisfies pred. */
function dfsFind(node: AXNode, pred: (n: AXNode) => boolean): boolean {
  if (pred(node)) return true;
  for (const child of node.children ?? []) {
    if (dfsFind(child, pred)) return true;
  }
  return false;
}

/**
 * Build a parent map: path → parent node, for all nodes in the tree.
 */
function buildParentMap(root: AXNode): Map<string, AXNode> {
  const map = new Map<string, AXNode>();
  function walk(node: AXNode): void {
    for (const child of node.children ?? []) {
      map.set(child.path, node);
      walk(child);
    }
  }
  walk(root);
  return map;
}

/**
 * Returns true if `node` (an AXButton) is likely a system dialog button.
 *
 * Clause 1 — closest non-generic ancestor has role ∈ {AXSheet, AXDialog}.
 * Clause 2 — geometry-bounded: has AXStaticText sibling above in same column
 *             AND union frame width < deviceWidth - 32.
 * Clause 3 — label is in corpus AND no identifier-tagged button in the tree
 *             shares the same label (avoids in-app OK).
 *
 * Any clause passing is sufficient.
 */
export function isLikelyDialogButton(
  node: AXNode,
  ctx: DialogDetectionContext,
): boolean {
  const { tree, deviceWidth } = ctx;
  const label = node.label?.trim() ?? '';
  if (label.length === 0) return false;

  // Hard reject: a non-empty identifier on the button itself indicates
  // a developer-assigned stable ID (in-app UI). System dialog buttons
  // never carry an identifier, so this filter keeps corpus-labelled
  // in-app buttons (e.g. "OK" on a form) from being treated as dialogs.
  if (typeof node.identifier === 'string' && node.identifier.length > 0) {
    return false;
  }

  const parentMap = buildParentMap(tree);
  const parent = parentMap.get(node.path);

  // Clause 1: closest non-generic ancestor is a dialog role
  const nonGenericAncestor = findNonGenericAncestor(node, parentMap);
  if (nonGenericAncestor !== null && DIALOG_ROLES.has(nonGenericAncestor.role)) {
    return true;
  }

  // Clause 2: geometry bounded (requires a parent to check siblings)
  if (parent !== undefined && isGeometryBounded(node, parent, deviceWidth)) {
    return true;
  }

  // Clause 3: label in corpus AND no in-app identifier conflict
  if (hasNoIdentifierConflict(label, tree)) {
    return true;
  }

  return false;
}

/**
 * DFS-collect all AXButton nodes whose label matches the action corpus
 * AND isLikelyDialogButton returns true. Deduplicated by path.
 * Ordered by topmost-y then left-to-right.
 */
export function findAlertCandidates(
  action: AlertAction,
  ctx: DialogDetectionContext,
): AlertCandidate[] {
  const { tree } = ctx;
  const seen = new Set<string>();
  const candidates: AlertCandidate[] = [];
  const parentMap = buildParentMap(tree);

  function walk(node: AXNode): void {
    if (
      node.role === 'AXButton' &&
      node.visible &&
      node.enabled &&
      node.label &&
      node.label.trim().length > 0 &&
      !seen.has(node.path)
    ) {
      const matched = matchLabel(node.label, action);
      if (matched !== null && isLikelyDialogButton(node, ctx)) {
        seen.add(node.path);

        // Determine reason for this candidate
        let reason: AlertCandidate['reason'] = 'corpus_no_conflict';
        const parentNode = parentMap.get(node.path);
        const nonGenericAncestor = findNonGenericAncestor(node, parentMap);
        if (nonGenericAncestor !== null && DIALOG_ROLES.has(nonGenericAncestor.role)) {
          reason = 'ancestor_is_dialog';
        } else if (
          parentNode !== undefined &&
          isGeometryBounded(node, parentNode, ctx.deviceWidth)
        ) {
          reason = 'geometry_bounded';
        }

        const parentForSiblings = parentMap.get(node.path);
        const siblingStaticTexts = parentForSiblings
          ? getSiblingStaticTextsAbove(node, parentForSiblings)
          : [];

        candidates.push({
          node,
          label: matched.label,
          locale: matched.locale,
          siblingStaticTexts,
          reason,
        });
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  }

  walk(tree);

  // Sort: topmost-y first, then left-to-right
  candidates.sort((a, b) => {
    const dy = a.node.frame.y - b.node.frame.y;
    if (dy !== 0) return dy;
    return a.node.frame.x - b.node.frame.x;
  });

  return candidates;
}

/**
 * DFS-collect label strings for all visible+enabled AXButton nodes.
 * Used by PR #3 for diagnostics.
 */
export function collectVisibleButtonLabels(tree: AXNode): string[] {
  const labels: string[] = [];
  function walk(node: AXNode): void {
    if (
      node.role === 'AXButton' &&
      node.visible &&
      node.enabled &&
      node.label &&
      node.label.trim().length > 0
    ) {
      labels.push(node.label.trim());
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  }
  walk(tree);
  return labels;
}

/**
 * DFS-collect label strings for all visible+enabled AXStaticText nodes.
 * Used by PR #3 for diagnostics.
 */
export function collectVisibleStaticTexts(tree: AXNode): string[] {
  const texts: string[] = [];
  function walk(node: AXNode): void {
    if (
      node.role === 'AXStaticText' &&
      node.visible &&
      node.label &&
      node.label.trim().length > 0
    ) {
      texts.push(node.label.trim());
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  }
  walk(tree);
  return texts;
}
