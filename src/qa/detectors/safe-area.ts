import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectSafeArea(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var issues = [];
      var viewport = document.querySelector('meta[name="viewport"]');
      var hasViewportFitCover = viewport && viewport.content && viewport.content.indexOf('viewport-fit=cover') !== -1;
      if (!hasViewportFitCover) {
        return { detector: 'safe_area', severity: 'pass', issues: [], passed: true, totalScanned: 0, issueCount: 0, metadata: { note: 'viewport-fit=cover not set' } };
      }
      var all = document.querySelectorAll('*');
      all.forEach(function(el) {
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          var top = parseFloat(style.top);
          var bottom = parseFloat(style.bottom);
          if (top === 0 || bottom === 0) {
            issues.push({
              selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : ''),
              problem: 'Fixed element at ' + (top === 0 ? 'top' : 'bottom') + ' edge without safe-area-inset padding',
              fix: 'Add padding: env(safe-area-inset-' + (top === 0 ? 'top' : 'bottom') + ')',
            });
          }
        }
      });
      return { detector: 'safe_area', severity: issues.length > 0 ? 'high' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: 1, issueCount: issues.length };
    })()
  `);
}
