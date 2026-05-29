import { getSessionManager } from '../session-manager';
import { ErrorCode, StructuredErrorException } from '../errors';

/**
 * Native iOS Accessibility Tree — Query Engine & Utilities
 *
 * Provides types, tree traversal, filtering, predicate evaluation, and
 * formatting helpers for AccessibilityNode trees.
 *
 * The actual accessibility tree capture is handled by AccessibilityBridge
 * (ax-bridge) in accessibility-bridge.ts.
 */

export interface AccessibilityNode {
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  traits: string[];
  frame: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isEnabled: boolean;
  children: AccessibilityNode[];
}

export interface TreeOptions {
  deviceId?: string;
  bundleId?: string;
  format?: 'json' | 'markdown' | 'flat';
  maxDepth?: number;
}

export interface QueryOptions {
  strategy: 'accessibilityId' | 'label' | 'text' | 'role' | 'predicate';
  value: string;
  deviceId?: string;
}

export interface QueryMatch {
  node: AccessibilityNode;
  path: string;
  depth: number;
}

/**
 * Resolve the device ID from an explicit value or the active session.
 */
export function resolveDeviceId(explicit?: string): string {
  if (explicit) return explicit;
  const active = getSessionManager().getSoleDeviceId();
  if (!active) {
    throw StructuredErrorException.fromCode(ErrorCode.DEVICE_NOT_BOOTED, 'No device specified and no active device found. Boot a simulator first with device_boot.');
  }
  return active;
}

/**
 * Filter nodes from an already-loaded tree.
 */
export function filterTree(
  root: AccessibilityNode,
  options: QueryOptions,
): QueryMatch[] {
  const matches: QueryMatch[] = [];
  walkTree(root, '', 0, (node, path, depth) => {
    if (matchesQuery(node, options)) {
      matches.push({ node, path, depth });
    }
  });
  return matches;
}

function walkTree(
  node: AccessibilityNode,
  path: string,
  depth: number,
  visitor: (node: AccessibilityNode, path: string, depth: number) => void,
): void {
  const currentPath = path ? `${path} > ${node.role}${node.label ? `[${node.label}]` : ''}` : node.role;
  visitor(node, currentPath, depth);
  for (let i = 0; i < node.children.length; i++) {
    walkTree(node.children[i], currentPath, depth + 1, visitor);
  }
}

function matchesQuery(node: AccessibilityNode, options: QueryOptions): boolean {
  const { strategy, value } = options;
  const normalizedValue = normalizeQueryText(value);

  switch (strategy) {
    case 'accessibilityId':
      return node.identifier?.toLowerCase() === value.toLowerCase();

    case 'label':
      return normalizedContains(node.label, normalizedValue);

    case 'text':
      return (
        normalizedContains(node.label, normalizedValue) ||
        normalizedContains(node.value, normalizedValue)
      );

    case 'role':
      return node.role.toLowerCase() === value.toLowerCase();

    case 'predicate':
      return evaluatePredicate(node, value);

    default:
      return false;
  }
}

function normalizeQueryText(value: string): string {
  // Two-step normalize is intentional: NFKD decomposes characters so diacritic
  // marks (U+0300–U+036F) can be stripped (café → cafe), then NFKC re-composes
  // and folds fullwidth/halfwidth variants (ａｂｃ → abc) while collapsing
  // whitespace for multiline labels.
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function normalizedContains(haystack: string | undefined, normalizedNeedle: string): boolean {
  if (!haystack) return false;
  if (!normalizedNeedle) return false;
  return normalizeQueryText(haystack).includes(normalizedNeedle);
}

/**
 * Evaluate a simple predicate expression against a node.
 * Supports: role=Button AND label=Submit, role=Cell OR label=Item
 */
export function evaluatePredicate(node: AccessibilityNode, predicate: string): boolean {
  // Split by AND/OR (case-insensitive)
  const orParts = predicate.split(/\s+OR\s+/i);

  for (const orPart of orParts) {
    const andParts = orPart.split(/\s+AND\s+/i);
    const allMatch = andParts.every(part => evaluateSingleCondition(node, part.trim()));
    if (allMatch) return true;
  }

  return false;
}

function evaluateSingleCondition(node: AccessibilityNode, condition: string): boolean {
  const match = condition.match(/^(\w+)\s*(=|!=|~=)\s*(.+)$/);
  if (!match) return false;

  const [, field, operator, expected] = match;
  const expectedLower = expected.trim().toLowerCase();

  const fieldValue = getNodeField(node, field.toLowerCase());
  if (fieldValue === undefined || fieldValue === null) {
    return operator === '!=';
  }

  const actualLower = String(fieldValue).toLowerCase();

  switch (operator) {
    case '=':
      return actualLower === expectedLower;
    case '!=':
      return actualLower !== expectedLower;
    case '~=': {
      // Apply the same diacritic/width folding as the label strategy so that
      // predicate matching is consistent with normalizeQueryText used elsewhere.
      const fieldName = field.toLowerCase();
      if (fieldName === 'label' || fieldName === 'value') {
        return normalizeQueryText(String(fieldValue)).includes(normalizeQueryText(expected.trim()));
      }
      return actualLower.includes(expectedLower);
    }
    default:
      return false;
  }
}

function getNodeField(node: AccessibilityNode, field: string): string | boolean | undefined {
  switch (field) {
    case 'role':
      return node.role;
    case 'label':
      return node.label;
    case 'value':
      return node.value;
    case 'identifier':
    case 'accessibilityid':
    case 'id':
      return node.identifier;
    case 'visible':
    case 'isvisible':
      return node.isVisible;
    case 'enabled':
    case 'isenabled':
      return node.isEnabled;
    default:
      return undefined;
  }
}

/**
 * Format the tree as indented markdown.
 */
export function formatTreeMarkdown(node: AccessibilityNode, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  const label = node.label ? ` "${node.label}"` : '';
  const value = node.value ? ` (value: "${node.value}")` : '';
  const id = node.identifier ? ` [id: ${node.identifier}]` : '';
  const traits = node.traits.length > 0 ? ` {${node.traits.join(', ')}}` : '';
  const visibility = !node.isVisible ? ' [hidden]' : '';
  const enabled = !node.isEnabled ? ' [disabled]' : '';

  let result = `${indent}- **${node.role}**${label}${value}${id}${traits}${visibility}${enabled}\n`;

  for (const child of node.children) {
    result += formatTreeMarkdown(child, depth + 1);
  }

  return result;
}

/**
 * Format the tree as a flat list of elements with paths.
 */
export function formatTreeFlat(node: AccessibilityNode, path: string = ''): string {
  const currentPath = path ? `${path} > ${node.role}` : node.role;
  const label = node.label ? ` "${node.label}"` : '';
  const value = node.value ? ` (${node.value})` : '';
  const id = node.identifier ? ` [${node.identifier}]` : '';

  let result = `${currentPath}${label}${value}${id}\n`;

  for (const child of node.children) {
    result += formatTreeFlat(child, currentPath);
  }

  return result;
}
