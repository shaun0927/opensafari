import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectTouchTargets(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var selectors = 'a, button, input, select, textarea, [onclick], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
      var elements = document.querySelectorAll(selectors);
      var threshold = 44;
      var issues = [];
      elements.forEach(function(el) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width < threshold || rect.height < threshold) {
          issues.push({
            selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : ''),
            problem: 'Touch target is ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + 'px (minimum: ' + threshold + 'x' + threshold + 'px)',
            fix: 'Increase element size to at least 44x44px or add padding',
            size: { width: Math.round(rect.width), height: Math.round(rect.height) },
          });
        }
      });
      return { detector: 'touch_targets', severity: issues.length > 0 ? 'high' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: elements.length, issueCount: issues.length };
    })()
  `);
}
