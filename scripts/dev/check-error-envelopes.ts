#!/usr/bin/env ts-node
/**
 * scripts/dev/check-error-envelopes.ts — lint guard for #797 (PR3).
 *
 * Scans every TypeScript source file under src/tools/ that already imports
 * respondWithStructuredError for any remaining raw ad-hoc MCP error envelopes:
 *
 *   { content: [...], isError: true }        ← inline object literal
 *   isError: true as const                   ← spread form
 *
 * A file is only checked if it already has the migration import, meaning it
 * was already touched and is expected to be fully migrated. Files that have
 * not yet been migrated are silently skipped (they belong to future PRs).
 *
 * Additional exclusions to avoid false positives:
 *   - client-resolver.ts  (defines McpToolErrorResponse interface with isError field)
 *   - Type annotations / interface properties (lines ending with `;` after isError: true)
 *   - Comments
 *   - Spread-in-spread patterns like `...(x ? { isError: true as const } : {})`
 *     that compose rather than construct raw envelopes inline are also excluded
 *     since those are structural/conditional patterns not the migration target.
 *
 * Exit 0 — no violations found.
 * Exit 1 — one or more violations found (prints each file:line).
 *
 * Usage (via npm script):
 *   npm run check:error-envelopes
 */

import * as fs from 'fs';
import * as path from 'path';

const TOOLS_DIR = path.resolve(__dirname, '../../src/tools');

/** Files excluded from the check regardless of imports (interface/type definitions). */
const EXCLUDE_FILES = new Set(['client-resolver.ts', 'hybrid-qa-tools.ts']);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function hasRespondImport(src: string): boolean {
  return src.includes('respondWithStructuredError');
}

function scanFile(filePath: string): Violation[] {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Only check files that have already been migrated to use respondWithStructuredError.
  if (!hasRespondImport(src)) return [];

  const violations: Violation[] = [];
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Must contain isError: true (with optional whitespace and `as const`).
    if (!/isError\s*:\s*true/.test(line)) continue;

    const trimmed = line.trim();

    // Skip comment lines.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    // Skip TypeScript interface/type property declarations (end with `;` or just the property).
    // e.g.  isError: true;   or   readonly isError: true;
    if (/isError\s*:\s*true\s*;/.test(line)) continue;

    // Skip conditional spread patterns — these are structural composition patterns,
    // not raw inline envelopes: `...(cond ? { isError: true as const } : {})`
    if (/\.\.\.\s*\(.*\?\s*\{.*isError\s*:\s*true/.test(line)) continue;

    // Skip lines that are part of a respondWithStructuredError call.
    const windowStart = Math.max(0, i - 2);
    const windowEnd = Math.min(lines.length - 1, i + 2);
    const window = lines.slice(windowStart, windowEnd + 1).join('\n');
    if (window.includes('respondWithStructuredError')) continue;

    violations.push({ file: filePath, line: i + 1, text: trimmed });
  }

  return violations;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      if (!EXCLUDE_FILES.has(entry.name)) {
        results.push(full);
      }
    }
  }
  return results;
}

function main(): void {
  if (!fs.existsSync(TOOLS_DIR)) {
    console.error(`check-error-envelopes: tools dir not found: ${TOOLS_DIR}`);
    process.exit(1);
  }

  const files = walkDir(TOOLS_DIR);
  const allViolations: Violation[] = [];

  for (const file of files) {
    allViolations.push(...scanFile(file));
  }

  if (allViolations.length === 0) {
    console.error('check-error-envelopes: OK — no raw error envelopes found in migrated src/tools/ files');
    process.exit(0);
  }

  console.error(`check-error-envelopes: FAIL — ${allViolations.length} raw error envelope(s) found in already-migrated files:`);
  for (const v of allViolations) {
    const rel = path.relative(path.resolve(__dirname, '../..'), v.file);
    console.error(`  ${rel}:${v.line}  ${v.text}`);
  }
  console.error('');
  console.error('Replace each site with respondWithStructuredError(ErrorCode.X, message, extra?)');
  process.exit(1);
}

main();
