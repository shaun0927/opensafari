import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectHoverOnly(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var issues = [];
      try {
        Array.from(document.styleSheets).forEach(function(sheet) {
          try {
            Array.from(sheet.cssRules || []).forEach(function(rule) {
              if (rule.selectorText && rule.selectorText.indexOf(':hover') !== -1) {
                var style = rule.style;
                if (style.display || style.visibility || style.opacity) {
                  var baseSelector = rule.selectorText.replace(/:hover/g, '').trim();
                  var el = document.querySelector(baseSelector);
                  if (el) {
                    issues.push({
                      selector: baseSelector,
                      problem: ':hover changes visibility — inaccessible on touch devices',
                      fix: 'Add click/touch handler or use :focus-within as alternative',
                      cssRule: rule.selectorText,
                    });
                  }
                }
              }
            });
          } catch(e) {}
        });
      } catch(e) {}
      return { detector: 'hover_only', severity: issues.length > 0 ? 'medium' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: 0, issueCount: issues.length };
    })()
  `);
}
