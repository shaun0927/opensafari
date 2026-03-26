import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectHorizontalOverflow(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var docWidth = document.documentElement.scrollWidth;
      var vpWidth = window.innerWidth;
      if (docWidth <= vpWidth) {
        return { detector: 'horizontal_overflow', severity: 'pass', issues: [], passed: true, totalScanned: 1, issueCount: 0 };
      }
      var issues = [];
      function findCulprits(parent) {
        Array.from(parent.children).forEach(function(el) {
          var rect = el.getBoundingClientRect();
          if (rect.right > vpWidth + 1) {
            issues.push({
              selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : ''),
              problem: 'Element extends to ' + Math.round(rect.right) + 'px (viewport: ' + vpWidth + 'px)',
              fix: 'Add overflow-x: hidden or max-width: 100%',
              overflow: Math.round(rect.right - vpWidth) + 'px',
            });
          }
        });
      }
      findCulprits(document.body);
      return { detector: 'horizontal_overflow', severity: 'high', issues: issues.slice(0, 20), passed: false, totalScanned: 1, issueCount: issues.length };
    })()
  `);
}
