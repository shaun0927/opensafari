/**
 * not-found-diagnostics — attach a bounded snapshot of the searched
 * accessibility tree to "element not found" errors (issue #834).
 *
 * The most frequent inner-loop bottleneck is a query that fails to match,
 * after which the developer manually re-runs `app_tree` to see what was
 * actually on screen. This helper automates exactly that one step: on a
 * terminal miss it performs a single bounded `dumpTree`, returns a capped
 * digest plus the nearest label/identifier candidates, and degrades to
 * `undefined` if the dump fails — so it never makes the failure worse.
 *
 * Deliberately minimal: substring matching only (no fuzzy/ranking), a hard
 * node cap, and exactly one bounded dump. See the issue's over-engineering
 * checklist.
 *
 * Privacy (#795 pillar 6 / checklist #12): the digest is part of the MCP
 * response body, so it must not leak on-screen secrets. The node `value`
 * field — which holds user-entered text (passwords, emails, tokens, OTPs) —
 * is therefore NEVER emitted. Only developer-authored metadata (`role`,
 * `label`, `identifier`, `path`) is surfaced, and `label`/`identifier` are run
 * through the shared credential redactor before emission. `value` is still
 * used internally for candidate matching (it is never returned).
 */

import type { AXNode, AXQuery } from './ax-types';
import { redactText, REDACTION_POLICY_VERSION } from '../observability/redaction';

/** Default ceiling on how many nodes the digest carries. */
export const DEFAULT_MAX_NODES = 40;

/** Bound the dump so a huge tree cannot stall the already-failed path. */
const DUMP_MAX_DEPTH = 8;

/**
 * Compact node shape — just enough to recognise an element, no geometry and
 * deliberately no `value` (see the privacy note above).
 */
export interface CompactAXNode {
  role: string;
  label?: string;
  identifier?: string;
  path: string;
}

export interface NotFoundDiagnostics {
  /** Total nodes in the dumped tree (may exceed `nodes.length`). */
  searchedNodeCount: number;
  /** Whether `nodes` was truncated at the cap. */
  truncated: boolean;
  /** Up to `maxNodes` compacted nodes from the searched tree. */
  nodes: CompactAXNode[];
  /** Up to 5 nodes whose label/identifier/value contains the query term. */
  candidates: CompactAXNode[];
  /** Redaction policy applied to emitted strings, so clients know the posture. */
  redactionPolicy: string;
}

/** Minimal surface this helper needs from the accessibility bridge. */
export interface TreeDumper {
  dumpTree(options?: { deviceId?: string; maxDepth?: number }): Promise<AXNode>;
}

const MAX_CANDIDATES = 5;

function redact(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactText(s, 'ax').text;
}

function compact(node: AXNode): CompactAXNode {
  return {
    role: node.role,
    label: redact(node.label),
    identifier: redact(node.identifier),
    path: node.path,
  };
}

/** The term the query searched for, used for substring candidate matching. */
function queryTerm(query: AXQuery): string {
  return (query.identifier ?? query.label ?? query.text ?? query.role ?? '')
    .trim()
    .toLowerCase();
}

function matchesTerm(node: AXNode, term: string): boolean {
  if (!term) return false;
  const hay = [node.label, node.identifier, node.value]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .toLowerCase();
  return hay.includes(term);
}

/**
 * Build a bounded not-found diagnostic from a single tree dump.
 *
 * Performs exactly one `dumpTree`. Returns `undefined` (no diagnostics) when
 * the dump throws or times out — callers keep their original error untouched.
 */
export async function buildNotFoundDiagnostics(
  bridge: TreeDumper,
  deviceId: string | undefined,
  query: AXQuery,
  opts?: { maxNodes?: number },
): Promise<NotFoundDiagnostics | undefined> {
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;
  let root: AXNode;
  try {
    root = await bridge.dumpTree({ deviceId, maxDepth: DUMP_MAX_DEPTH });
  } catch {
    // Graceful degradation: a failed/slow dump must not worsen the
    // already-failing not-found path.
    return undefined;
  }

  const term = queryTerm(query);
  const nodes: CompactAXNode[] = [];
  const candidates: CompactAXNode[] = [];
  let searchedNodeCount = 0;

  // Single DFS: count every node, collect the capped digest, and gather
  // substring candidates across the whole tree.
  const stack: AXNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AXNode;
    searchedNodeCount += 1;
    if (nodes.length < maxNodes) nodes.push(compact(node));
    if (candidates.length < MAX_CANDIDATES && matchesTerm(node, term)) {
      candidates.push(compact(node));
    }
    // Push in reverse so pop() yields natural reading order (pre-order):
    // the capped digest then keeps the first/top-of-screen elements.
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }

  return {
    searchedNodeCount,
    truncated: searchedNodeCount > nodes.length,
    nodes,
    candidates,
    redactionPolicy: REDACTION_POLICY_VERSION,
  };
}
