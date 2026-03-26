import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detect100vh(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var temp = document.createElement('div');
      temp.style.cssText = 'position:fixed;top:0;height:100vh;width:1px;pointer-events:none;visibility:hidden';
      document.body.appendChild(temp);
      var vh100 = temp.offsetHeight;
      document.body.removeChild(temp);
      var innerH = window.innerHeight;
      var diff = vh100 - innerH;
      if (Math.abs(diff) < 10) {
        return { detector: '100vh', severity: 'pass', issues: [], passed: true, totalScanned: 1, issueCount: 0, metadata: { vh100: vh100, innerHeight: innerH, difference: diff } };
      }
      var issues = [];
      issues.push({
        selector: 'viewport',
        problem: '100vh = ' + vh100 + 'px but visible viewport = ' + innerH + 'px (diff: ' + diff + 'px)',
        fix: 'Use 100dvh or calc(var(--vh, 1vh) * 100) with JS viewport listener',
      });
      return { detector: '100vh', severity: issues.length > 0 ? 'medium' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: 1, issueCount: issues.length, metadata: { vh100: vh100, innerHeight: innerH, difference: diff } };
    })()
  `);
}
