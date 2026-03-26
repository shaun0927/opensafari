import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectInputType(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var issues = [];
      var inputs = document.querySelectorAll('input');
      inputs.forEach(function(el) {
        var type = el.getAttribute('type') || 'text';
        var inputMode = el.getAttribute('inputmode');
        var name = (el.name || el.id || '').toLowerCase();
        if (type === 'text' && !inputMode) {
          if (name.match(/phone|tel|zip|postal|code|pin|otp|cvv|cvc/)) {
            issues.push({ selector: el.id ? '#' + el.id : 'input[name="' + el.name + '"]', problem: 'Likely numeric field using type="text" without inputmode', fix: 'Add inputmode="numeric" or inputmode="tel"' });
          }
          if (name.match(/email/) && type !== 'email') {
            issues.push({ selector: el.id ? '#' + el.id : 'input[name="' + el.name + '"]', problem: 'Email field using type="text"', fix: 'Use type="email" for email keyboard' });
          }
        }
      });
      return { detector: 'input_type', severity: issues.length > 0 ? 'medium' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: inputs.length, issueCount: issues.length };
    })()
  `);
}
