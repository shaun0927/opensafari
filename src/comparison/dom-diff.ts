export interface DOMElementSnapshot {
  tag: string;
  id?: string;
  className?: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  textContent?: string;
  childCount: number;
}

export interface DOMSnapshot {
  device: string;
  viewport: { w: number; h: number };
  elements: DOMElementSnapshot[];
}

export interface DOMDifference {
  type: 'missing' | 'hidden' | 'position-shift' | 'size-change' | 'text-truncation';
  selector: string;
  description: string;
  deviceA: { device: string; value: string };
  deviceB: { device: string; value: string };
  severity: 'low' | 'medium' | 'high';
}

export interface DOMDiffResult {
  differences: DOMDifference[];
  deviceA: string;
  deviceB: string;
  summary: string;
  totalElementsCompared: number;
}

export interface DOMDiffOptions {
  /** position shift threshold in pixels (default 50) */
  positionThreshold?: number;
  /** size change threshold as ratio (default 0.3 = 30%) */
  sizeThreshold?: number;
  /** selectors to exclude from comparison */
  excludeSelectors?: string[];
}

/** JavaScript to execute in browser to capture DOM snapshot */
export const DOM_SNAPSHOT_SCRIPT = `(function() {
  var selectors = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'button', 'input', 'img',
    'nav', 'header', 'footer', 'main', 'section', 'article',
    'form', 'table', 'div[id]', 'div[class]'
  ];
  var seen = new Set();
  var elements = [];
  for (var s = 0; s < selectors.length; s++) {
    var nodes = document.querySelectorAll(selectors[s]);
    for (var i = 0; i < nodes.length && elements.length < 200; i++) {
      var el = nodes[i];
      var id = el.id || '';
      var cn = el.className || '';
      var tag = el.tagName.toLowerCase();
      var selector = tag;
      if (id) selector += '#' + id;
      else if (cn && typeof cn === 'string') selector += '.' + cn.split(/\\s+/)[0];
      if (seen.has(selector)) continue;
      seen.add(selector);
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      elements.push({
        tag: tag,
        id: id || undefined,
        className: (typeof cn === 'string' ? cn : '') || undefined,
        selector: selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        textContent: (el.textContent || '').trim().substring(0, 100) || undefined,
        childCount: el.children.length
      });
    }
    if (elements.length >= 200) break;
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    elements: elements
  };
})()`;

const SEVERITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export class DOMDiffEngine {
  /**
   * Compare two DOM snapshots and detect structural differences.
   */
  compare(
    snapshotA: DOMSnapshot,
    snapshotB: DOMSnapshot,
    options?: DOMDiffOptions,
  ): DOMDiffResult {
    const positionThreshold = options?.positionThreshold ?? 50;
    const sizeThreshold = options?.sizeThreshold ?? 0.3;
    const excludeSelectors = new Set(options?.excludeSelectors ?? []);

    const differences: DOMDifference[] = [];

    // Index elements by selector
    const indexA = new Map<string, DOMElementSnapshot>();
    const indexB = new Map<string, DOMElementSnapshot>();

    for (const el of snapshotA.elements) {
      if (!excludeSelectors.has(el.selector)) {
        indexA.set(el.selector, el);
      }
    }
    for (const el of snapshotB.elements) {
      if (!excludeSelectors.has(el.selector)) {
        indexB.set(el.selector, el);
      }
    }

    const allSelectors = new Set([...indexA.keys(), ...indexB.keys()]);
    let totalElementsCompared = 0;

    for (const selector of allSelectors) {
      const elA = indexA.get(selector);
      const elB = indexB.get(selector);
      totalElementsCompared++;

      // Missing element detection
      if (elA && !elB) {
        differences.push({
          type: 'missing',
          selector,
          description: `Element "${selector}" exists in ${snapshotA.device} but missing in ${snapshotB.device}`,
          deviceA: { device: snapshotA.device, value: 'present' },
          deviceB: { device: snapshotB.device, value: 'missing' },
          severity: 'high',
        });
        continue;
      }

      if (!elA && elB) {
        differences.push({
          type: 'missing',
          selector,
          description: `Element "${selector}" exists in ${snapshotB.device} but missing in ${snapshotA.device}`,
          deviceA: { device: snapshotA.device, value: 'missing' },
          deviceB: { device: snapshotB.device, value: 'present' },
          severity: 'high',
        });
        continue;
      }

      // Both elements exist - compare properties
      if (!elA || !elB) continue;

      // Visibility difference
      if (elA.visible !== elB.visible) {
        differences.push({
          type: 'hidden',
          selector,
          description: `Element "${selector}" visibility differs: ${elA.visible ? 'visible' : 'hidden'} in ${snapshotA.device}, ${elB.visible ? 'visible' : 'hidden'} in ${snapshotB.device}`,
          deviceA: { device: snapshotA.device, value: elA.visible ? 'visible' : 'hidden' },
          deviceB: { device: snapshotB.device, value: elB.visible ? 'visible' : 'hidden' },
          severity: 'medium',
        });
      }

      // Position shift detection (normalized by viewport width)
      const normalizedXA = snapshotA.viewport.w > 0 ? elA.rect.x / snapshotA.viewport.w : 0;
      const normalizedXB = snapshotB.viewport.w > 0 ? elB.rect.x / snapshotB.viewport.w : 0;
      const normalizedYA = snapshotA.viewport.h > 0 ? elA.rect.y / snapshotA.viewport.h : 0;
      const normalizedYB = snapshotB.viewport.h > 0 ? elB.rect.y / snapshotB.viewport.h : 0;

      // Convert normalized difference back to pixels using average viewport for threshold comparison
      const avgViewportW = (snapshotA.viewport.w + snapshotB.viewport.w) / 2;
      const avgViewportH = (snapshotA.viewport.h + snapshotB.viewport.h) / 2;
      const pixelShiftX = Math.abs(normalizedXA - normalizedXB) * avgViewportW;
      const pixelShiftY = Math.abs(normalizedYA - normalizedYB) * avgViewportH;
      const totalShift = Math.sqrt(pixelShiftX ** 2 + pixelShiftY ** 2);

      if (totalShift > positionThreshold) {
        const severity = totalShift > positionThreshold * 3 ? 'high' : 'medium';
        differences.push({
          type: 'position-shift',
          selector,
          description: `Element "${selector}" shifted by ${Math.round(totalShift)}px (normalized) between ${snapshotA.device} and ${snapshotB.device}`,
          deviceA: {
            device: snapshotA.device,
            value: `(${Math.round(elA.rect.x)}, ${Math.round(elA.rect.y)})`,
          },
          deviceB: {
            device: snapshotB.device,
            value: `(${Math.round(elB.rect.x)}, ${Math.round(elB.rect.y)})`,
          },
          severity,
        });
      }

      // Size change detection
      if (elA.rect.width > 0 && elB.rect.width > 0) {
        const widthRatio = Math.abs(elA.rect.width - elB.rect.width) / Math.max(elA.rect.width, elB.rect.width);
        const heightRatio =
          elA.rect.height > 0 && elB.rect.height > 0
            ? Math.abs(elA.rect.height - elB.rect.height) / Math.max(elA.rect.height, elB.rect.height)
            : 0;

        if (widthRatio > sizeThreshold || heightRatio > sizeThreshold) {
          const severity = widthRatio > sizeThreshold * 2 || heightRatio > sizeThreshold * 2 ? 'high' : 'low';
          differences.push({
            type: 'size-change',
            selector,
            description: `Element "${selector}" size changed: ${Math.round(elA.rect.width)}x${Math.round(elA.rect.height)} in ${snapshotA.device} vs ${Math.round(elB.rect.width)}x${Math.round(elB.rect.height)} in ${snapshotB.device}`,
            deviceA: {
              device: snapshotA.device,
              value: `${Math.round(elA.rect.width)}x${Math.round(elA.rect.height)}`,
            },
            deviceB: {
              device: snapshotB.device,
              value: `${Math.round(elB.rect.width)}x${Math.round(elB.rect.height)}`,
            },
            severity,
          });
        }
      }

      // Text truncation detection
      if (elA.textContent && elB.textContent) {
        const textA = elA.textContent;
        const textB = elB.textContent;
        if (textA !== textB && (textA.startsWith(textB) || textB.startsWith(textA))) {
          const shorter = textA.length < textB.length ? textA : textB;
          const longer = textA.length < textB.length ? textB : textA;
          differences.push({
            type: 'text-truncation',
            selector,
            description: `Text in "${selector}" appears truncated: "${shorter.substring(0, 50)}..." vs "${longer.substring(0, 50)}..."`,
            deviceA: { device: snapshotA.device, value: textA.substring(0, 80) },
            deviceB: { device: snapshotB.device, value: textB.substring(0, 80) },
            severity: 'medium',
          });
        }
      }
    }

    // Sort by severity (high first)
    differences.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const highCount = differences.filter(d => d.severity === 'high').length;
    const mediumCount = differences.filter(d => d.severity === 'medium').length;
    const lowCount = differences.filter(d => d.severity === 'low').length;

    const summary = `Compared ${snapshotA.device} vs ${snapshotB.device}: ${differences.length} differences found (${highCount} high, ${mediumCount} medium, ${lowCount} low) across ${totalElementsCompared} elements`;

    return {
      differences,
      deviceA: snapshotA.device,
      deviceB: snapshotB.device,
      summary,
      totalElementsCompared,
    };
  }

  /**
   * Compare all pairs of DOM snapshots.
   */
  compareAll(snapshots: DOMSnapshot[], options?: DOMDiffOptions): DOMDiffResult[] {
    const results: DOMDiffResult[] = [];

    for (let i = 0; i < snapshots.length; i++) {
      for (let j = i + 1; j < snapshots.length; j++) {
        results.push(this.compare(snapshots[i], snapshots[j], options));
      }
    }

    return results;
  }
}
