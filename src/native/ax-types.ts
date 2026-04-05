/**
 * Native Accessibility Types
 *
 * Structured types for the iOS Simulator accessibility tree,
 * queried via the macOS AXUIElement API.
 */

/** A single node in the native accessibility tree */
export interface AXNode {
  /** Accessibility role (e.g. "AXButton", "AXStaticText", "AXTextField") */
  role: string;
  /** Accessibility label (AXTitle or AXDescription) */
  label?: string;
  /** Current value (AXValue) */
  value?: string;
  /** Accessibility identifier (developer-assigned stable ID) */
  identifier?: string;
  /** Subroles and trait information */
  traits: string[];
  /** Frame in simulator-normalized coordinates */
  frame: AXFrame;
  /** Whether the element is visible (has non-zero size) */
  visible: boolean;
  /** Whether the element is enabled (not disabled/busy) */
  enabled: boolean;
  /** Whether the element is focused */
  focused: boolean;
  /** Child elements (omitted at max depth) */
  children?: AXNode[];
  /** Index path for unique element identification (e.g. "0/2/1") */
  path: string;
}

/** Bounding frame in simulator coordinates */
export interface AXFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Query parameters for element search */
export interface AXQuery {
  /** Match by accessibility identifier (exact) */
  identifier?: string;
  /** Match by accessibility label (substring, case-insensitive) */
  label?: string;
  /** Match by text content in value (substring, case-insensitive) */
  text?: string;
  /** Match by accessibility role (exact) */
  role?: string;
  /** Match elements having all specified traits */
  traits?: string[];
}

/** Result of an accessibility query */
export interface AXQueryResult {
  /** Matching elements */
  matches: AXNode[];
  /** Total matches found */
  total: number;
  /** The query that was executed */
  query: AXQuery;
  /** Whether the query was ambiguous (multiple matches when one expected) */
  ambiguous: boolean;
}

/** Options for tree dump */
export interface AXDumpOptions {
  /** Maximum tree depth to traverse (default: 10) */
  maxDepth?: number;
  /** Device UDID (falls back to active device) */
  deviceId?: string;
}

/** Options for element query */
export interface AXQueryOptions {
  /** Device UDID (falls back to active device) */
  deviceId?: string;
  /** Maximum results to return (default: 50) */
  maxResults?: number;
}
