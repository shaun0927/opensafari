import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectKeyboardOverlap(client: BrowserBackend): Promise<DetectorResult> {
  // Get fixed-bottom elements
  const fixedBottom = await client.evaluate<Array<{ selector: string; bottom: number; rect: { y: number; height: number } }>>(`
    (function() {
      return Array.from(document.querySelectorAll('*')).filter(function(el) {
        var s = window.getComputedStyle(el);
        return s.position === 'fixed' && parseFloat(s.bottom) < 50;
      }).map(function(el) {
        return {
          selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : ''),
          bottom: parseFloat(window.getComputedStyle(el).bottom),
          rect: { y: el.getBoundingClientRect().y, height: el.getBoundingClientRect().height }
        };
      });
    })()
  `);

  if (!fixedBottom || fixedBottom.length === 0) {
    return { detector: 'keyboard_overlap', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0 };
  }

  // Get inputs
  const inputs = await client.evaluate<string[]>(`
    Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select')).slice(0, 5).map(function(el) {
      return el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : el.tagName.toLowerCase());
    })
  `);

  const issues: Array<{ selector: string; problem: string; fix: string; triggeredBy?: string }> = [];

  for (const inputSelector of (inputs || [])) {
    try {
      // Save scroll position before clicking input (focus triggers iOS auto-scroll)
      const scrollPos = await client.evaluate<{ x: number; y: number }>('({ x: window.scrollX, y: window.scrollY })');

      await client.click(inputSelector);
      await new Promise(r => setTimeout(r, 500));

      const viewportWithKeyboard = await client.evaluate<number>('window.visualViewport ? window.visualViewport.height : window.innerHeight');

      for (const fixed of fixedBottom) {
        if (fixed.rect.y + fixed.rect.height > viewportWithKeyboard) {
          issues.push({
            selector: fixed.selector,
            problem: `Fixed bottom element hidden behind keyboard (element bottom: ${Math.round(fixed.rect.y + fixed.rect.height)}px, viewport with keyboard: ${Math.round(viewportWithKeyboard)}px)`,
            fix: 'Use visualViewport API to adjust position when keyboard appears',
            triggeredBy: inputSelector,
          });
        }
      }

      await client.dismissKeyboard();
      await new Promise(r => setTimeout(r, 300));
      // Restore scroll position after keyboard dismissed
      await client.evaluate(`window.scrollTo(${scrollPos.x}, ${scrollPos.y})`);
    } catch {
      // Input may not be focusable
    }
  }

  return {
    detector: 'keyboard_overlap',
    severity: issues.length > 0 ? 'critical' : 'pass',
    issues,
    passed: issues.length === 0,
    totalScanned: fixedBottom.length * (inputs?.length ?? 0),
    issueCount: issues.length,
  };
}
