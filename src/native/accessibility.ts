import { SimctlExecutor, SimctlError } from '../simulator/simctl';
import { getSessionManager } from '../session-manager';

/**
 * Native iOS Accessibility Tree — Parser & Query Engine
 *
 * Uses `xcrun simctl accessibility_audit` (Xcode 15+ / iOS 17+) to capture
 * the native accessibility hierarchy of the frontmost app in the simulator.
 * Parses the output into a structured tree of AccessibilityNode objects that
 * can be queried, filtered, and formatted.
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
  const active = getSessionManager().getActiveDeviceId();
  if (!active) {
    throw new Error(
      'No device specified and no active device found. Boot a simulator first with device_boot.',
    );
  }
  return active;
}

/**
 * @deprecated This function uses `xcrun simctl accessibility_audit` which does not exist.
 * The active implementation is AccessibilityBridge (ax-bridge) in accessibility-bridge.ts.
 * Do not use this function — it will always throw at runtime.
 */
export async function captureAccessibilityAudit(
  deviceId: string,
  simctl?: SimctlExecutor,
): Promise<string> {
  const executor = simctl ?? new SimctlExecutor();
  try {
    const output = await executor.exec(['accessibility_audit', deviceId], { timeout: 15000 });
    return output;
  } catch (err) {
    if (err instanceof SimctlError) {
      // Check for common issues
      if (err.message.includes('Invalid device') || err.message.includes('not found')) {
        throw new Error(`Device ${deviceId} not found. Run device_list to see available devices.`);
      }
      if (
        err.message.includes('not booted') ||
        err.message.includes('Shutdown')
      ) {
        throw new Error(`Device ${deviceId} is not booted. Boot it first with device_boot.`);
      }
      // accessibility_audit may not be available on older Xcode
      if (
        err.message.includes('Unknown subcommand') ||
        err.message.includes('unrecognized')
      ) {
        throw new Error(
          'accessibility_audit is not available. This feature requires Xcode 15+ with iOS 17+ simulator runtime. ' +
          'Please update Xcode or use a newer simulator runtime.',
        );
      }
    }
    throw err;
  }
}

/**
 * Parse the raw accessibility audit output into a tree of AccessibilityNode objects.
 *
 * The audit output format is line-based with indentation indicating hierarchy:
 *   Element: <role> - <label>
 *     Trait: <trait>
 *     Frame: {{x, y}, {w, h}}
 *     ...
 *     Element: <role> - <child>
 *
 * This parser handles varying formats robustly.
 */
export function parseAccessibilityOutput(raw: string): AccessibilityNode {
  const lines = raw.split('\n').filter(line => line.trim().length > 0);

  if (lines.length === 0) {
    return createRootNode();
  }

  const root = createRootNode();
  const stack: { node: AccessibilityNode; indent: number }[] = [{ node: root, indent: -1 }];

  for (const line of lines) {
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Skip non-element metadata lines (audit warnings, summaries, etc.)
    if (isAuditMetaLine(trimmed)) {
      continue;
    }

    // Parse element lines
    const elementMatch = trimmed.match(
      /^(?:Element:\s*)?(\w[\w\s]*?)(?:\s*[-–]\s*(.+))?$/,
    );
    if (elementMatch) {
      const node = parseElementLine(trimmed, elementMatch);

      // Pop stack until we find a parent at a lower indent level
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].node;
      parent.children.push(node);
      stack.push({ node, indent });
      continue;
    }

    // Parse property lines for the current element
    if (stack.length > 1) {
      const current = stack[stack.length - 1].node;
      applyProperty(current, trimmed);
    }
  }

  return root;
}

function createRootNode(): AccessibilityNode {
  return {
    role: 'Application',
    label: 'Root',
    traits: [],
    frame: { x: 0, y: 0, width: 0, height: 0 },
    isVisible: true,
    isEnabled: true,
    children: [],
  };
}

function isAuditMetaLine(line: string): boolean {
  return (
    line.startsWith('Audit:') ||
    line.startsWith('Pass:') ||
    line.startsWith('Fail:') ||
    line.startsWith('Warning:') ||
    line.startsWith('Result:') ||
    line.startsWith('---') ||
    line.startsWith('===') ||
    /^\d+ (issue|warning|error)/.test(line)
  );
}

function parseElementLine(
  _raw: string,
  match: RegExpMatchArray,
): AccessibilityNode {
  const role = (match[1] || 'Unknown').trim();
  const label = match[2]?.trim();

  return {
    role,
    label: label || undefined,
    traits: [],
    frame: { x: 0, y: 0, width: 0, height: 0 },
    isVisible: true,
    isEnabled: true,
    children: [],
  };
}

function applyProperty(node: AccessibilityNode, line: string): void {
  // Trait: ButtonTrait, StaticTextTrait
  const traitMatch = line.match(/^Traits?:\s*(.+)/i);
  if (traitMatch) {
    node.traits = traitMatch[1].split(',').map(t => t.trim()).filter(Boolean);
    return;
  }

  // Frame: {{x, y}, {w, h}}
  const frameMatch = line.match(
    /Frame:\s*\{\{([\d.]+),\s*([\d.]+)\},\s*\{([\d.]+),\s*([\d.]+)\}\}/i,
  );
  if (frameMatch) {
    node.frame = {
      x: parseFloat(frameMatch[1]),
      y: parseFloat(frameMatch[2]),
      width: parseFloat(frameMatch[3]),
      height: parseFloat(frameMatch[4]),
    };
    return;
  }

  // Value: <text>
  const valueMatch = line.match(/^Value:\s*(.+)/i);
  if (valueMatch) {
    node.value = valueMatch[1].trim();
    return;
  }

  // Identifier: <id>
  const idMatch = line.match(/^(?:Identifier|AccessibilityIdentifier):\s*(.+)/i);
  if (idMatch) {
    node.identifier = idMatch[1].trim();
    return;
  }

  // Enabled: false
  const enabledMatch = line.match(/^Enabled:\s*(true|false|yes|no|0|1)/i);
  if (enabledMatch) {
    node.isEnabled = ['true', 'yes', '1'].includes(enabledMatch[1].toLowerCase());
    return;
  }

  // Visible: false
  const visibleMatch = line.match(/^(?:Visible|IsVisible):\s*(true|false|yes|no|0|1)/i);
  if (visibleMatch) {
    node.isVisible = ['true', 'yes', '1'].includes(visibleMatch[1].toLowerCase());
    return;
  }

  // Label: <text>  (when not on the Element line itself)
  const labelMatch = line.match(/^Label:\s*(.+)/i);
  if (labelMatch && !node.label) {
    node.label = labelMatch[1].trim();
    return;
  }
}

/**
 * Get the full accessibility tree for a device.
 */
export async function getAccessibilityTree(
  options: TreeOptions = {},
  simctl?: SimctlExecutor,
): Promise<AccessibilityNode> {
  const deviceId = resolveDeviceId(options.deviceId);
  const raw = await captureAccessibilityAudit(deviceId, simctl);
  const tree = parseAccessibilityOutput(raw);

  if (options.maxDepth !== undefined) {
    pruneTree(tree, 0, options.maxDepth);
  }

  return tree;
}

/**
 * Prune the tree to a maximum depth.
 */
function pruneTree(node: AccessibilityNode, currentDepth: number, maxDepth: number): void {
  if (currentDepth >= maxDepth) {
    node.children = [];
    return;
  }
  for (const child of node.children) {
    pruneTree(child, currentDepth + 1, maxDepth);
  }
}

/**
 * Query the accessibility tree for nodes matching the given criteria.
 */
export async function queryAccessibilityTree(
  options: QueryOptions,
  simctl?: SimctlExecutor,
): Promise<QueryMatch[]> {
  const tree = await getAccessibilityTree({ deviceId: options.deviceId }, simctl);
  return filterTree(tree, options);
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
  const valueLower = value.toLowerCase();

  switch (strategy) {
    case 'accessibilityId':
      return node.identifier?.toLowerCase() === valueLower;

    case 'label':
      return node.label?.toLowerCase().includes(valueLower) ?? false;

    case 'text':
      return (
        (node.label?.toLowerCase().includes(valueLower) ?? false) ||
        (node.value?.toLowerCase().includes(valueLower) ?? false)
      );

    case 'role':
      return node.role.toLowerCase() === valueLower;

    case 'predicate':
      return evaluatePredicate(node, value);

    default:
      return false;
  }
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
    case '~=':
      return actualLower.includes(expectedLower);
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
