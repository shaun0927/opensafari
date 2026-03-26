import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectFixedStacking(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var fixedEls = Array.from(document.querySelectorAll('*')).filter(function(el) {
        var s = window.getComputedStyle(el);
        return s.position === 'fixed' || s.position === 'sticky';
      }).map(function(el) {
        return {
          selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : ''),
          rect: el.getBoundingClientRect(),
          zIndex: parseInt(window.getComputedStyle(el).zIndex) || 0,
        };
      });
      var issues = [];
      for (var i = 0; i < fixedEls.length; i++) {
        for (var j = i + 1; j < fixedEls.length; j++) {
          var a = fixedEls[i], b = fixedEls[j];
          var overlap = !(a.rect.right < b.rect.left || a.rect.left > b.rect.right || a.rect.bottom < b.rect.top || a.rect.top > b.rect.bottom);
          if (overlap && a.zIndex === b.zIndex) {
            issues.push({
              selector: a.selector + ' <-> ' + b.selector,
              problem: 'Overlapping fixed elements with same z-index (' + a.zIndex + ')',
              fix: 'Set distinct z-index values',
            });
          }
        }
      }
      return { detector: 'fixed_stacking', severity: issues.length > 0 ? 'medium' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: fixedEls.length, issueCount: issues.length };
    })()
  `);
}
