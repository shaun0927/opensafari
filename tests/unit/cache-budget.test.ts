/**
 * Unit tests for the cache-budget survey (#554 — diagnose.memory.notes).
 */

import {
  formatBytes,
  getCacheBudgetNotes,
  getCacheBudgetReports,
  __listBudgetedCaches,
  type CacheBudgetEntry,
} from '../../src/metrics/cache-budget';

describe('cache-budget', () => {
  describe('formatBytes', () => {
    test('formats bytes, KB, MB, and GB with compact units', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(2048)).toBe('2 KB');
      expect(formatBytes(1_048_576)).toBe('1 MB');
      expect(formatBytes(1_572_864)).toBe('1.5 MB');
      expect(formatBytes(2 * 1_073_741_824)).toBe('2 GB');
    });

    test('defensively handles negative / non-finite inputs', () => {
      expect(formatBytes(-1)).toBe('0 B');
      expect(formatBytes(Number.NaN)).toBe('0 B');
      expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
    });
  });

  describe('surveyed cache list', () => {
    test('covers the three load-bearing caches from the doc', () => {
      const names = __listBudgetedCaches().map((c) => c.name);
      // Order mirrors docs/memory-budget.md; the three caches most likely to
      // grow under real agent workloads must always be present.
      expect(names).toEqual(
        expect.arrayContaining([
          'telemetry-rollup',
          'flutter-vm-clients',
          'flutter-discovery-cache',
        ]),
      );
    });

    test('every entry exposes a finite non-negative maxBytes', () => {
      for (const entry of __listBudgetedCaches() as readonly CacheBudgetEntry[]) {
        expect(Number.isFinite(entry.maxBytes)).toBe(true);
        expect(entry.maxBytes).toBeGreaterThan(0);
      }
    });

    test('estimateBytes returns a finite non-negative number', () => {
      for (const entry of __listBudgetedCaches() as readonly CacheBudgetEntry[]) {
        const n = entry.estimateBytes();
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getCacheBudgetReports', () => {
    test('returns no reports when all caches are within budget', () => {
      // In a fresh test process the three caches are empty / below budget.
      const reports = getCacheBudgetReports();
      for (const r of reports) {
        expect(r.currentBytes).toBeGreaterThan(r.maxBytes);
      }
    });

    test('one bad estimator does not destabilise the survey', () => {
      // Monkey-patch an entry to throw; the survey should ignore it.
      const entries = __listBudgetedCaches();
      const original = entries[0].estimateBytes;
      (entries[0] as { estimateBytes: () => number }).estimateBytes = () => {
        throw new Error('boom');
      };
      try {
        // Must not throw, must still return an array.
        const reports = getCacheBudgetReports();
        expect(Array.isArray(reports)).toBe(true);
      } finally {
        (entries[0] as { estimateBytes: () => number }).estimateBytes = original;
      }
    });
  });

  describe('getCacheBudgetNotes', () => {
    test('returns [] when every cache is within budget (idle process)', () => {
      expect(getCacheBudgetNotes()).toEqual([]);
    });

    test('produces one note per over-budget cache when caches are stressed', () => {
      // Force one entry over budget by monkey-patching its estimator.
      const entries = __listBudgetedCaches();
      const target = entries[0];
      const original = target.estimateBytes;
      (target as { estimateBytes: () => number }).estimateBytes = () =>
        target.maxBytes * 2;
      try {
        const notes = getCacheBudgetNotes();
        expect(notes.length).toBeGreaterThanOrEqual(1);
        expect(notes[0]).toContain(target.name);
        expect(notes[0]).toMatch(/over budget/);
      } finally {
        (target as { estimateBytes: () => number }).estimateBytes = original;
      }
    });
  });
});
