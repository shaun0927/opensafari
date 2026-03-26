import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectScrollLock(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var issues = [];
      var bodyOverflow = document.body.style.overflow;
      var htmlOverflow = document.documentElement.style.overflow;
      var hasVisibleModal = document.querySelector('[role="dialog"]:not([aria-hidden="true"]), .modal:not(.hidden), [data-modal]:not([hidden])');
      if ((bodyOverflow === 'hidden' || htmlOverflow === 'hidden') && !hasVisibleModal) {
        issues.push({ selector: bodyOverflow === 'hidden' ? 'document.body' : 'document.documentElement', problem: 'overflow: hidden set but no visible modal found', fix: 'Ensure modal close handlers restore overflow' });
      }
      if (bodyOverflow === 'unset') {
        issues.push({ selector: 'document.body', problem: 'overflow set to "unset" — not a proper reset', fix: 'Use document.body.style.overflow = "" (empty string)' });
      }
      return { detector: 'scroll_lock', severity: issues.length > 0 ? 'high' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: 2, issueCount: issues.length };
    })()
  `);
}
