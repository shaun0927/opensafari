import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectPwaMeta(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var checks = [
        { name: 'viewport', selector: 'meta[name="viewport"]', required: true, fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">' },
        { name: 'theme-color', selector: 'meta[name="theme-color"]', required: false, fix: 'Add <meta name="theme-color" content="#yourColor">' },
        { name: 'color-scheme', selector: 'meta[name="color-scheme"]', required: false, fix: 'Add <meta name="color-scheme" content="light only">' },
        { name: 'apple-touch-icon', selector: 'link[rel="apple-touch-icon"]', required: false, fix: 'Add <link rel="apple-touch-icon" href="/icon-180.png">' },
        { name: 'manifest', selector: 'link[rel="manifest"]', required: false, fix: 'Add <link rel="manifest" href="/manifest.json">' },
      ];
      var issues = [];
      checks.forEach(function(check) {
        if (!document.querySelector(check.selector)) {
          issues.push({ selector: 'head', problem: 'Missing ' + check.name + (check.required ? ' (required)' : ' (recommended)'), fix: check.fix });
        }
      });
      return { detector: 'pwa_meta', severity: issues.some(function(i) { return i.problem.indexOf('required') !== -1; }) ? 'high' : issues.length > 0 ? 'low' : 'pass', issues: issues, passed: issues.length === 0, totalScanned: checks.length, issueCount: issues.length };
    })()
  `);
}
