import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectAutoZoom(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var inputs = document.querySelectorAll('input, select, textarea');
      var issues = [];
      inputs.forEach(function(el) {
        var style = window.getComputedStyle(el);
        var size = parseFloat(style.fontSize);
        if (size < 16) {
          var rect = el.getBoundingClientRect();
          issues.push({
            selector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : '')),
            problem: 'font-size is ' + size + 'px (< 16px minimum)',
            fix: 'Set font-size to at least 16px to prevent iOS Safari auto-zoom on focus',
          });
        }
      });
      return { detector: 'auto_zoom', severity: issues.length > 0 ? 'high' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: inputs.length, issueCount: issues.length };
    })()
  `);
}
