import { DOMDiffEngine, DOMSnapshot, DOMElementSnapshot } from '../../src/comparison/dom-diff';

function makeElement(overrides: Partial<DOMElementSnapshot> = {}): DOMElementSnapshot {
  return {
    tag: 'div',
    selector: 'div#main',
    rect: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    childCount: 0,
    ...overrides,
  };
}

function makeSnapshot(device: string, elements: DOMElementSnapshot[], viewport?: { w: number; h: number }): DOMSnapshot {
  return {
    device,
    viewport: viewport ?? { w: 375, h: 812 },
    elements,
  };
}

describe('DOMDiffEngine', () => {
  let engine: DOMDiffEngine;

  beforeEach(() => {
    engine = new DOMDiffEngine();
  });

  describe('compare', () => {
    it('should report no differences for identical snapshots', () => {
      const el = makeElement({ selector: 'h1#title' });
      const snapA = makeSnapshot('iPhone 15', [el]);
      const snapB = makeSnapshot('iPhone 15 Pro', [el]);

      const result = engine.compare(snapA, snapB);

      expect(result.differences).toHaveLength(0);
      expect(result.deviceA).toBe('iPhone 15');
      expect(result.deviceB).toBe('iPhone 15 Pro');
      expect(result.totalElementsCompared).toBe(1);
    });

    it('should detect missing elements with high severity', () => {
      const el = makeElement({ selector: 'nav#sidebar' });
      const snapA = makeSnapshot('iPhone 15', [el]);
      const snapB = makeSnapshot('iPad Air', []);

      const result = engine.compare(snapA, snapB);

      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].type).toBe('missing');
      expect(result.differences[0].severity).toBe('high');
      expect(result.differences[0].selector).toBe('nav#sidebar');
    });

    it('should detect visibility differences with medium severity', () => {
      const visibleEl = makeElement({ selector: 'button#submit', visible: true });
      const hiddenEl = makeElement({ selector: 'button#submit', visible: false });
      const snapA = makeSnapshot('iPhone 15', [visibleEl]);
      const snapB = makeSnapshot('iPad Air', [hiddenEl]);

      const result = engine.compare(snapA, snapB);

      const diff = result.differences.find(d => d.type === 'hidden');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('medium');
      expect(diff!.deviceA.value).toBe('visible');
      expect(diff!.deviceB.value).toBe('hidden');
    });

    it('should detect large position shifts', () => {
      const elA = makeElement({ selector: 'div#content', rect: { x: 10, y: 10, width: 100, height: 50 } });
      const elB = makeElement({ selector: 'div#content', rect: { x: 200, y: 300, width: 100, height: 50 } });
      const snapA = makeSnapshot('iPhone SE', [elA], { w: 375, h: 667 });
      const snapB = makeSnapshot('iPad Air', [elB], { w: 375, h: 667 });

      const result = engine.compare(snapA, snapB);

      const diff = result.differences.find(d => d.type === 'position-shift');
      expect(diff).toBeDefined();
      expect(['medium', 'high']).toContain(diff!.severity);
    });

    it('should ignore small position shifts within threshold', () => {
      const elA = makeElement({ selector: 'p.text', rect: { x: 10, y: 10, width: 100, height: 50 } });
      const elB = makeElement({ selector: 'p.text', rect: { x: 12, y: 11, width: 100, height: 50 } });
      const snapA = makeSnapshot('iPhone 15', [elA]);
      const snapB = makeSnapshot('iPhone 15 Pro', [elB]);

      const result = engine.compare(snapA, snapB, { positionThreshold: 50 });

      const positionDiffs = result.differences.filter(d => d.type === 'position-shift');
      expect(positionDiffs).toHaveLength(0);
    });

    it('should detect size changes', () => {
      const elA = makeElement({ selector: 'img#hero', rect: { x: 0, y: 0, width: 300, height: 200 } });
      const elB = makeElement({ selector: 'img#hero', rect: { x: 0, y: 0, width: 150, height: 100 } });
      const snapA = makeSnapshot('iPad Air', [elA]);
      const snapB = makeSnapshot('iPhone SE', [elB]);

      const result = engine.compare(snapA, snapB);

      const diff = result.differences.find(d => d.type === 'size-change');
      expect(diff).toBeDefined();
      expect(diff!.selector).toBe('img#hero');
    });

    it('should detect text truncation', () => {
      const elA = makeElement({
        selector: 'h1#title',
        textContent: 'Welcome to Our Amazing Website',
      });
      const elB = makeElement({
        selector: 'h1#title',
        textContent: 'Welcome to Our Amazing Website and More Content Here',
      });
      const snapA = makeSnapshot('iPhone SE', [elA]);
      const snapB = makeSnapshot('iPad Air', [elB]);

      const result = engine.compare(snapA, snapB);

      const diff = result.differences.find(d => d.type === 'text-truncation');
      expect(diff).toBeDefined();
      expect(diff!.severity).toBe('medium');
    });

    it('should exclude selectors specified in options', () => {
      const elA = makeElement({ selector: 'nav#sidebar' });
      const snapA = makeSnapshot('iPhone 15', [elA]);
      const snapB = makeSnapshot('iPad Air', []);

      const result = engine.compare(snapA, snapB, { excludeSelectors: ['nav#sidebar'] });

      expect(result.differences).toHaveLength(0);
    });

    it('should sort differences by severity (high first)', () => {
      const elements: DOMElementSnapshot[] = [
        makeElement({ selector: 'p.info', visible: true }),       // will have medium (visibility)
        makeElement({ selector: 'nav#main' }),                    // will be missing (high)
        makeElement({ selector: 'img#hero', rect: { x: 0, y: 0, width: 300, height: 200 } }), // size change (low)
      ];

      const snapA = makeSnapshot('DeviceA', elements);
      const snapB = makeSnapshot('DeviceB', [
        makeElement({ selector: 'p.info', visible: false }),      // visibility diff
        // nav#main missing
        makeElement({ selector: 'img#hero', rect: { x: 0, y: 0, width: 150, height: 100 } }), // size change
      ]);

      const result = engine.compare(snapA, snapB);

      expect(result.differences.length).toBeGreaterThan(0);
      // Verify high severity comes first
      const severities = result.differences.map(d => d.severity);
      const highIdx = severities.indexOf('high');
      const medIdx = severities.indexOf('medium');
      const lowIdx = severities.indexOf('low');

      if (highIdx >= 0 && medIdx >= 0) expect(highIdx).toBeLessThan(medIdx);
      if (medIdx >= 0 && lowIdx >= 0) expect(medIdx).toBeLessThan(lowIdx);
    });

    it('should include device names in summary', () => {
      const snapA = makeSnapshot('iPhone SE', [makeElement()]);
      const snapB = makeSnapshot('iPad Air', [makeElement()]);

      const result = engine.compare(snapA, snapB);

      expect(result.summary).toContain('iPhone SE');
      expect(result.summary).toContain('iPad Air');
    });
  });

  describe('compareAll', () => {
    it('should generate 3 pairs for 3 snapshots', () => {
      const el = makeElement({ selector: 'div#app' });
      const snapshots = [
        makeSnapshot('iPhone SE', [el]),
        makeSnapshot('iPhone 15', [el]),
        makeSnapshot('iPad Air', [el]),
      ];

      const results = engine.compareAll(snapshots);

      expect(results).toHaveLength(3); // C(3,2) = 3
    });
  });
});
