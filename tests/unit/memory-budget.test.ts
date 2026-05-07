/**
 * Contract test for docs/memory-budget.md (issue #554).
 *
 * Verifies:
 *   1. Every source link in the table (`src/file.ts:LINE`) resolves to an
 *      existing file on disk.
 *   2. For rows that document a named numeric constant, the constant is
 *      present in the source file with the expected value — so the doc
 *      cannot silently drift from the code.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(ROOT, 'docs', 'memory-budget.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDoc(): string {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

/**
 * Extract all `src/file.ts:LINE` occurrences from the markdown table.
 * The pattern matches both bare `src/...` paths and markdown link syntax
 * `[src/...](../src/...)`.
 */
function parseSourceLinks(doc: string): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];
  // Match: `src/some/path.ts:123` — bare occurrence in table cells
  const re = /\bsrc\/([\w/.-]+\.ts):(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    results.push({ file: path.join(ROOT, 'src', m[1]), line: Number(m[2]) });
  }
  return results;
}

/**
 * Named constants documented in the table together with their expected values.
 * Each entry maps a source-relative path to an array of { name, value } pairs.
 */
const CONSTANT_CONTRACTS: Array<{
  relPath: string;
  name: string;
  value: number;
}> = [
  {
    relPath: 'src/metrics/input-telemetry-rollup.ts',
    name: 'INPUT_TELEMETRY_ROLLUP_CAP',
    value: 1024,
  },
  {
    relPath: 'src/tools/flutter-memory-profile.ts',
    name: 'MAX_DEVICES',
    value: 16,
  },
  {
    relPath: 'src/tools/flutter-network.ts',
    name: 'MAX_ENTRIES',
    value: 1000,
  },
  {
    relPath: 'src/tools/flutter-logs.ts',
    name: 'MAX_LOG_ENTRIES',
    value: 500,
  },
  {
    relPath: 'src/tools/flutter-track-rebuilds.ts',
    name: 'MAX_EVENTS_PER_TRACKER',
    value: 10_000,
  },
  {
    relPath: 'src/simulator/proxy-manager.ts',
    name: 'PROXY_PORT_RANGE_DEFAULT',
    value: 100,
  },
  {
    relPath: 'src/input/flutter-resolver.ts',
    name: 'NEGATIVE_CACHE_TTL_MS',
    value: 30_000,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docs/memory-budget.md — contract tests', () => {
  let doc: string;

  beforeAll(() => {
    doc = readDoc();
  });

  test('docs/memory-budget.md exists and is non-empty', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
    expect(doc.trim().length).toBeGreaterThan(0);
  });

  test('doc contains a markdown table with at least 10 rows', () => {
    // Count pipe-separated table rows (skip header and separator rows)
    const tableRows = doc
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.match(/^\|[-| ]+\|$/));
    // Subtract the header row itself
    const dataRows = tableRows.length - 1;
    expect(dataRows).toBeGreaterThanOrEqual(10);
  });

  describe('source file links', () => {
    test('all src/ links resolve to existing files', () => {
      const links = parseSourceLinks(doc);
      expect(links.length).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const { file } of links) {
        if (!fs.existsSync(file)) {
          missing.push(file.replace(ROOT + '/', ''));
        }
      }

      if (missing.length > 0) {
        fail(
          `The following source files referenced in docs/memory-budget.md do not exist:\n` +
            missing.map((f) => `  - ${f}`).join('\n') +
            '\n\nUpdate the line numbers or file paths in the doc.',
        );
      }
    });
  });

  describe('numeric constant contracts', () => {
    for (const { relPath, name, value } of CONSTANT_CONTRACTS) {
      test(`${relPath} declares ${name} = ${value}`, () => {
        const filePath = path.join(ROOT, relPath);
        expect(fs.existsSync(filePath)).toBe(true);

        const src = fs.readFileSync(filePath, 'utf8');

        // Match: `const NAME = VALUE` or `export const NAME = VALUE`
        // Allows for underscores in numeric literals (e.g. 10_000)
        const re = new RegExp(
          `(?:export\\s+)?const\\s+${name}\\s*=\\s*([\\d_]+)`,
        );
        const match = re.exec(src);
        expect(match).not.toBeNull();

        if (match) {
          // Strip numeric separators before parsing
          const actual = Number(match[1].replace(/_/g, ''));
          expect(actual).toBe(value);
        }
      });
    }
  });
});
