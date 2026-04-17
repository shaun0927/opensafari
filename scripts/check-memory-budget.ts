#!/usr/bin/env ts-node
/**
 * check-memory-budget — Advisory static scan for undocumented module-level caches.
 *
 * Scans all src/**\/*.ts files for patterns that indicate a module-level Map or
 * Set declaration, then warns (without failing) about any that do not appear in
 * docs/memory-budget.md.
 *
 * This script is advisory: it exits 0 even when it finds undocumented caches.
 * Use it in CI as an informational check only — add a `|| true` suffix if you
 * want to ensure it never blocks a build.
 *
 * Usage:
 *   npx ts-node scripts/check-memory-budget.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'memory-budget.md');
const SRC_DIR = path.join(ROOT, 'src');

// Patterns that indicate a module-level (top-of-file, outside class/function)
// cache variable.  We look for:
//   - `new Map<`      — typed Map constructor
//   - `= new Map(`    — untyped Map constructor
//   - `new Set<`      — typed Set constructor
//   - `= new Set(`    — untyped Set constructor
//   - `cached`        — variables with the word "cached" in their name
const CACHE_PATTERNS = [
  /^\s*(?:const|let|var)\s+\w*[Cc]ach(?:e|ed)\w*\s*[=:]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+Map[<(]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*:\s*Map\s*<[^>]+>\s*=\s*new\s+Map/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+Set[<(]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*:\s*Set\s*<[^>]+>\s*=\s*new\s+Set/,
];

interface CacheOccurrence {
  file: string;
  line: number;
  text: string;
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Determine whether a line is inside a class body, function body, or
 * interface block. We use a simple brace-depth heuristic: if the
 * cumulative brace depth at the line's position is > 0 we consider it
 * "inside a block" and skip it (module-level declarations have depth 0).
 */
function findModuleLevelCaches(filePath: string): CacheOccurrence[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const results: CacheOccurrence[] = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Update brace depth BEFORE testing the pattern so that lines at depth 0
    // are module-level declarations.
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    const isModuleLevel = braceDepth === 0;
    braceDepth += opens - closes;
    if (braceDepth < 0) braceDepth = 0;

    if (!isModuleLevel) continue;

    for (const re of CACHE_PATTERNS) {
      if (re.test(line)) {
        results.push({
          file: filePath.replace(ROOT + '/', ''),
          line: i + 1,
          text: line.trim(),
        });
        break;
      }
    }
  }

  return results;
}

function readDoc(): string {
  if (!fs.existsSync(DOC_PATH)) return '';
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function main(): void {
  const doc = readDoc();

  if (!doc) {
    process.stderr.write(
      '[check-memory-budget] WARNING: docs/memory-budget.md not found. ' +
        'Create it to enable cache documentation coverage.\n',
    );
    process.exit(0);
  }

  const tsFiles = collectTsFiles(SRC_DIR);
  const allOccurrences: CacheOccurrence[] = [];

  for (const file of tsFiles) {
    allOccurrences.push(...findModuleLevelCaches(file));
  }

  const undocumented: CacheOccurrence[] = allOccurrences.filter((occ) => {
    // Consider an occurrence documented if its source file path (without
    // leading "src/") appears somewhere in the doc.
    const relPath = occ.file.replace(/^src\//, '');
    return !doc.includes(relPath);
  });

  if (undocumented.length === 0) {
    process.stderr.write(
      '[check-memory-budget] All detected module-level caches appear in docs/memory-budget.md.\n',
    );
    process.exit(0);
  }

  process.stderr.write(
    `[check-memory-budget] WARNING: ${undocumented.length} module-level cache(s) ` +
      'may be undocumented in docs/memory-budget.md:\n',
  );
  for (const occ of undocumented) {
    process.stderr.write(`  ${occ.file}:${occ.line}  ${occ.text}\n`);
  }
  process.stderr.write(
    '\nThis is advisory only. Add a row to docs/memory-budget.md for each entry above.\n',
  );

  // Advisory exit — always 0 so CI is not blocked.
  process.exit(0);
}

main();
