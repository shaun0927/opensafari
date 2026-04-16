/**
 * Minimal heap-snapshot class-histogram parser (#554 soak-test diff).
 *
 * V8's `.heapsnapshot` format is a JSON document with a flat `nodes` integer
 * array and a side `strings` table. Each node occupies `node_fields.length`
 * slots; the `type` column is an index into `node_types[0]`, and the `name`
 * column is an index into `strings` (for `object` nodes, `strings[name]`
 * holds the constructor / class name).
 *
 * For the memory-SLO soak test we only need a class-level histogram: how
 * many `object` nodes of each constructor exist. That's cheap to compute
 * and gives us a `{before, after}` delta per class — enough to catch the
 * kind of unbounded growth the soak SLO is written against (> 1000 new
 * retained instances per class between the 30-minute and 60-minute marks).
 *
 * Intentionally NOT a full heap-snapshot parser:
 *   - We ignore edges, retainers, and trace-node metadata.
 *   - We only surface `object`-type nodes; strings, arrays, closures etc.
 *     are invisible.
 *   - We do not stream-parse — a 60-minute V8 snapshot is typically < 50 MB
 *     and fits comfortably in memory on the self-hosted macOS runner.
 */

import * as fs from 'fs';

/** Shape of the V8 heap-snapshot JSON we consume. */
interface RawHeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: unknown[];
    };
  };
  nodes: number[];
  strings: string[];
}

/** One row of the class-growth diff. */
export interface HeapClassDelta {
  className: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Build a `{className → instanceCount}` map from a single snapshot path.
 * Only counts nodes whose `type` column resolves to the `object` enum.
 *
 * @throws when the file is missing or malformed — callers should wrap in
 *         try/catch so a bad snapshot never masks the underlying test signal.
 */
export function readHeapSnapshotClassHistogram(
  snapshotPath: string,
): Map<string, number> {
  const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as RawHeapSnapshot;
  const fields = raw.snapshot.meta.node_fields;
  const typeColumn = fields.indexOf('type');
  const nameColumn = fields.indexOf('name');
  if (typeColumn < 0 || nameColumn < 0) {
    throw new Error(
      `heap snapshot ${snapshotPath} is missing expected node_fields (got ${fields.join(',')})`,
    );
  }
  const stride = fields.length;
  const typeEnum = raw.snapshot.meta.node_types[0];
  if (!Array.isArray(typeEnum)) {
    throw new Error(
      `heap snapshot ${snapshotPath} is missing node_types[0] enum`,
    );
  }
  const objectTypeIndex = (typeEnum as string[]).indexOf('object');
  if (objectTypeIndex < 0) {
    throw new Error(
      `heap snapshot ${snapshotPath} does not declare an 'object' node type`,
    );
  }

  const histogram = new Map<string, number>();
  const nodes = raw.nodes;
  const strings = raw.strings;
  for (let i = 0; i < nodes.length; i += stride) {
    if (nodes[i + typeColumn] !== objectTypeIndex) continue;
    const nameIdx = nodes[i + nameColumn];
    const name = strings[nameIdx] ?? '<unknown>';
    histogram.set(name, (histogram.get(name) ?? 0) + 1);
  }
  return histogram;
}

/**
 * Diff two class histograms and return the rows whose instance count grew.
 * Results are sorted by descending delta so callers can log the top-N
 * growers without an extra sort.
 */
export function diffClassHistograms(
  before: Map<string, number>,
  after: Map<string, number>,
): HeapClassDelta[] {
  const classes = new Set<string>([...before.keys(), ...after.keys()]);
  const rows: HeapClassDelta[] = [];
  for (const className of classes) {
    const b = before.get(className) ?? 0;
    const a = after.get(className) ?? 0;
    const delta = a - b;
    if (delta > 0) {
      rows.push({ className, before: b, after: a, delta });
    }
  }
  rows.sort((x, y) => y.delta - x.delta);
  return rows;
}

/**
 * Convenience wrapper: read both snapshots and return the sorted class-growth
 * diff. Throws on any parse failure; the caller decides whether to swallow.
 */
export function diffHeapSnapshotFiles(
  beforePath: string,
  afterPath: string,
): HeapClassDelta[] {
  return diffClassHistograms(
    readHeapSnapshotClassHistogram(beforePath),
    readHeapSnapshotClassHistogram(afterPath),
  );
}
