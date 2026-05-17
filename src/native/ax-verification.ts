/**
 * Shared AX tree helpers used by both app_tap and app_tap_element.
 *
 * Extracted to avoid duplication between the coordinate-tap and element-tap
 * paths, ensuring both always produce identical fingerprints for the same tree.
 */

import type { AXNode } from './ax-types';

export function walkTree(node: AXNode, visit: (n: AXNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walkTree(child, visit);
  }
}

export function fingerprintTree(root: AXNode): string {
  const parts: string[] = [];
  walkTree(root, (current) => {
    if (!current.visible) return;
    parts.push(
      [
        current.path,
        current.role,
        current.label ?? '',
        current.value ?? '',
        current.enabled ? '1' : '0',
        current.focused ? '1' : '0',
        Math.round(current.frame.x),
        Math.round(current.frame.y),
        Math.round(current.frame.width),
        Math.round(current.frame.height),
      ].join('|'),
    );
  });
  return parts.join('\n');
}
