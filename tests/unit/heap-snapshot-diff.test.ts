/**
 * Unit tests for the heap-snapshot class-histogram parser (#554 soak diff).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readHeapSnapshotClassHistogram,
  diffClassHistograms,
  diffHeapSnapshotFiles,
} from '../../src/metrics/heap-snapshot-diff';

describe('heap-snapshot-diff', () => {
  describe('diffClassHistograms', () => {
    test('reports only positive deltas sorted descending', () => {
      const before = new Map<string, number>([
        ['Foo', 10],
        ['Bar', 5],
        ['Baz', 100],
      ]);
      const after = new Map<string, number>([
        ['Foo', 15],       // +5
        ['Bar', 5],        // +0 (filtered out)
        ['Baz', 50],       // -50 (filtered out)
        ['Quux', 2000],    // +2000 (new)
      ]);
      const diff = diffClassHistograms(before, after);
      expect(diff.map((r) => r.className)).toEqual(['Quux', 'Foo']);
      expect(diff[0]).toMatchObject({ className: 'Quux', before: 0, after: 2000, delta: 2000 });
      expect(diff[1]).toMatchObject({ className: 'Foo', before: 10, after: 15, delta: 5 });
    });

    test('returns [] when no class grew', () => {
      const before = new Map<string, number>([['Foo', 10]]);
      const after = new Map<string, number>([['Foo', 10]]);
      expect(diffClassHistograms(before, after)).toEqual([]);
    });
  });

  describe('readHeapSnapshotClassHistogram', () => {
    test('parses a synthetic v8-shaped snapshot', () => {
      // node_fields: [type, name, id, self_size, edge_count, trace_node_id, detachedness]
      // node_types[0]: ['hidden', 'array', 'string', 'object', 'code', ...]
      //   → object index = 3
      // Three nodes:
      //   [3, 1, ...] — object, name="Foo"
      //   [3, 1, ...] — object, name="Foo"
      //   [3, 2, ...] — object, name="Bar"
      //   [2, 3, ...] — string, name="ignore" (skipped)
      const snapshot = {
        snapshot: {
          meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
            node_types: [
              ['hidden', 'array', 'string', 'object', 'code'],
              'string',
              'number',
              'number',
              'number',
              'number',
              'number',
            ],
          },
          node_count: 4,
        },
        nodes: [
          3, 1, 1, 0, 0, 0, 0, // object "Foo"
          3, 1, 2, 0, 0, 0, 0, // object "Foo"
          3, 2, 3, 0, 0, 0, 0, // object "Bar"
          2, 3, 4, 0, 0, 0, 0, // string "ignore"
        ],
        strings: ['', 'Foo', 'Bar', 'ignore'],
      };
      const tmp = path.join(os.tmpdir(), `heap-test-${Date.now()}.heapsnapshot`);
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      try {
        const hist = readHeapSnapshotClassHistogram(tmp);
        expect(hist.get('Foo')).toBe(2);
        expect(hist.get('Bar')).toBe(1);
        expect(hist.get('ignore')).toBeUndefined();
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    test('throws a clear error on malformed meta', () => {
      const bad = {
        snapshot: { meta: { node_fields: [], node_types: [] } },
        nodes: [],
        strings: [],
      };
      const tmp = path.join(os.tmpdir(), `heap-bad-${Date.now()}.heapsnapshot`);
      fs.writeFileSync(tmp, JSON.stringify(bad));
      try {
        expect(() => readHeapSnapshotClassHistogram(tmp)).toThrow(/node_fields/);
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('diffHeapSnapshotFiles against synthetic v8 output', () => {
    test('end-to-end diff: before has 10 Foos, after has 15 Foos + new Bar', () => {
      // Compose two minimal v8-shaped snapshots — no real `v8.writeHeapSnapshot`
      // call because parsing a jest process's actual heap snapshot is multi-MB
      // and slows the suite by an order of magnitude. The real-V8 integration
      // is exercised by the 60-minute soak test (gated via OPENSAFARI_RUN_SOAK).
      const make = (foos: number, bars: number) => {
        const nodes: number[] = [];
        const strings = ['', 'Foo', 'Bar'];
        for (let i = 0; i < foos; i++) nodes.push(3, 1, i, 0, 0, 0, 0);
        for (let i = 0; i < bars; i++) nodes.push(3, 2, 1000 + i, 0, 0, 0, 0);
        return {
          snapshot: {
            meta: {
              node_fields: [
                'type',
                'name',
                'id',
                'self_size',
                'edge_count',
                'trace_node_id',
                'detachedness',
              ],
              node_types: [
                ['hidden', 'array', 'string', 'object', 'code'],
                'string',
                'number',
                'number',
                'number',
                'number',
                'number',
              ],
            },
          },
          nodes,
          strings,
        };
      };
      const before = path.join(os.tmpdir(), `heap-before-${Date.now()}.heapsnapshot`);
      const after = path.join(os.tmpdir(), `heap-after-${Date.now()}.heapsnapshot`);
      fs.writeFileSync(before, JSON.stringify(make(10, 0)));
      fs.writeFileSync(after, JSON.stringify(make(15, 3)));
      try {
        const rows = diffHeapSnapshotFiles(before, after);
        // Sorted by descending delta: Foo +5, Bar +3.
        expect(rows).toEqual([
          { className: 'Foo', before: 10, after: 15, delta: 5 },
          { className: 'Bar', before: 0, after: 3, delta: 3 },
        ]);
      } finally {
        for (const p of [before, after]) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
    });
  });
});
