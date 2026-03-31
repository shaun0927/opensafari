import { BrowserBackend } from '../../types/browser-backend';
import { DetectorResult } from '../types';

export async function detectAccessibility(client: BrowserBackend): Promise<DetectorResult> {
  return client.evaluate<DetectorResult>(`
    (function() {
      var issues = [];
      var totalScanned = 0;

      // 1. Images without alt text (WCAG 2.1 SC 1.1.1)
      var images = document.querySelectorAll('img');
      totalScanned += images.length;
      images.forEach(function(img) {
        if (!img.hasAttribute('alt')) {
          var src = img.getAttribute('src') || '';
          issues.push({
            selector: img.id ? '#' + img.id : 'img[src="' + src.substring(0, 80) + '"]',
            problem: 'Image missing alt attribute (WCAG 2.1 SC 1.1.1 Non-text Content)',
            fix: 'Add alt="descriptive text" or alt="" for decorative images',
            wcag: '1.1.1'
          });
        }
      });

      // 2. Form inputs without labels (WCAG 2.1 SC 1.3.1)
      var inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
      totalScanned += inputs.length;
      inputs.forEach(function(input) {
        var hasLabel = false;
        var id = input.id;
        if (id && document.querySelector('label[for="' + id + '"]')) hasLabel = true;
        if (!hasLabel && input.closest('label')) hasLabel = true;
        if (!hasLabel && (input.getAttribute('aria-label') || input.getAttribute('aria-labelledby'))) hasLabel = true;
        if (!hasLabel && input.getAttribute('title')) hasLabel = true;
        if (!hasLabel) {
          var sel = input.id ? '#' + input.id : input.tagName.toLowerCase() + '[name="' + (input.getAttribute('name') || '') + '"]';
          issues.push({
            selector: sel,
            problem: 'Form input missing associated label (WCAG 2.1 SC 1.3.1 Info and Relationships)',
            fix: 'Add a <label for="id"> element, wrap in <label>, or add aria-label attribute',
            wcag: '1.3.1'
          });
        }
      });

      // 3. Color contrast check (WCAG 2.1 SC 1.4.3)
      function getLuminance(r, g, b) {
        var sRGB = [r, g, b].map(function(v) {
          v = v / 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
      }
      function parseColor(str) {
        var m = str.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
        return null;
      }
      function getContrastRatio(fg, bg) {
        var l1 = getLuminance(fg.r, fg.g, fg.b);
        var l2 = getLuminance(bg.r, bg.g, bg.b);
        var lighter = Math.max(l1, l2);
        var darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }
      var textEls = document.querySelectorAll('p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, label, button');
      var contrastChecked = 0;
      for (var i = 0; i < textEls.length && contrastChecked < 50; i++) {
        var el = textEls[i];
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        var style = window.getComputedStyle(el);
        var fg = parseColor(style.color);
        var bg = parseColor(style.backgroundColor);
        if (!fg || !bg) continue;
        if (bg.r === 0 && bg.g === 0 && bg.b === 0 && style.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
        contrastChecked++;
        var ratio = getContrastRatio(fg, bg);
        var fontSize = parseFloat(style.fontSize);
        var isBold = parseInt(style.fontWeight) >= 700 || style.fontWeight === 'bold';
        var isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);
        var minRatio = isLargeText ? 3 : 4.5;
        if (ratio < minRatio) {
          var sel = el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
          issues.push({
            selector: sel,
            problem: 'Color contrast ratio ' + ratio.toFixed(2) + ':1 is below ' + minRatio + ':1 minimum (WCAG 2.1 SC 1.4.3 Contrast Minimum)',
            fix: 'Increase contrast between text color (' + style.color + ') and background (' + style.backgroundColor + ')',
            wcag: '1.4.3',
            contrastRatio: Math.round(ratio * 100) / 100
          });
        }
      }
      totalScanned += contrastChecked;

      // 4. Heading hierarchy (WCAG 2.1 SC 1.3.1)
      var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      totalScanned += headings.length;
      var prevLevel = 0;
      headings.forEach(function(h) {
        var level = parseInt(h.tagName.charAt(1));
        if (prevLevel > 0 && level > prevLevel + 1) {
          issues.push({
            selector: h.id ? '#' + h.id : h.tagName.toLowerCase(),
            problem: 'Heading level skipped from h' + prevLevel + ' to h' + level + ' (WCAG 2.1 SC 1.3.1 Info and Relationships)',
            fix: 'Use sequential heading levels (h' + prevLevel + ' should be followed by h' + (prevLevel + 1) + ')',
            wcag: '1.3.1',
            skippedFrom: prevLevel,
            skippedTo: level
          });
        }
        prevLevel = level;
      });

      // 5. Interactive elements without accessible names (WCAG 2.1 SC 4.1.2)
      var interactive = document.querySelectorAll('button, a[href], [role="button"], [role="link"]');
      totalScanned += interactive.length;
      interactive.forEach(function(el) {
        var text = (el.textContent || '').trim();
        var ariaLabel = el.getAttribute('aria-label');
        var ariaLabelledBy = el.getAttribute('aria-labelledby');
        var title = el.getAttribute('title');
        var imgAlt = el.querySelector('img[alt]');
        var hasName = text || ariaLabel || ariaLabelledBy || title || (imgAlt && imgAlt.getAttribute('alt'));
        if (!hasName) {
          var sel = el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
          issues.push({
            selector: sel,
            problem: 'Interactive element has no accessible name (WCAG 2.1 SC 4.1.2 Name, Role, Value)',
            fix: 'Add text content, aria-label, or title attribute',
            wcag: '4.1.2'
          });
        }
      });

      // 6. Missing lang attribute (WCAG 2.1 SC 3.1.1)
      totalScanned += 1;
      var htmlLang = document.documentElement.getAttribute('lang');
      if (!htmlLang || htmlLang.trim() === '') {
        issues.push({
          selector: 'html',
          problem: 'Missing lang attribute on <html> element (WCAG 2.1 SC 3.1.1 Language of Page)',
          fix: 'Add lang attribute, e.g. <html lang="en">',
          wcag: '3.1.1'
        });
      }

      // 7. ARIA roles with missing required attributes (WCAG 2.1 SC 4.1.2)
      var ariaRequired = {
        'checkbox': ['aria-checked'],
        'combobox': ['aria-expanded'],
        'slider': ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'],
        'progressbar': ['aria-valuenow'],
        'scrollbar': ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-orientation'],
        'switch': ['aria-checked'],
        'tab': ['aria-selected'],
        'alert': [],
        'dialog': []
      };
      var ariaEls = document.querySelectorAll('[role]');
      totalScanned += ariaEls.length;
      ariaEls.forEach(function(el) {
        var role = el.getAttribute('role');
        if (role && ariaRequired[role]) {
          var missing = ariaRequired[role].filter(function(attr) {
            return !el.hasAttribute(attr);
          });
          if (missing.length > 0) {
            var sel = el.id ? '#' + el.id : el.tagName.toLowerCase() + '[role="' + role + '"]';
            issues.push({
              selector: sel,
              problem: 'Role "' + role + '" missing required attributes: ' + missing.join(', ') + ' (WCAG 2.1 SC 4.1.2 Name, Role, Value)',
              fix: 'Add the required ARIA attributes: ' + missing.join(', '),
              wcag: '4.1.2',
              role: role,
              missingAttributes: missing
            });
          }
        }
      });

      // 8. Non-descriptive link text (WCAG 2.1 SC 2.4.4)
      var genericLinkTexts = ['click here', 'here', 'read more', 'more', 'link', 'learn more', 'click', 'this'];
      var links = document.querySelectorAll('a[href]');
      totalScanned += links.length;
      links.forEach(function(a) {
        var text = (a.textContent || '').trim().toLowerCase();
        if (text && genericLinkTexts.indexOf(text) !== -1 && !a.getAttribute('aria-label') && !a.getAttribute('aria-labelledby')) {
          issues.push({
            selector: a.id ? '#' + a.id : 'a[href="' + (a.getAttribute('href') || '').substring(0, 60) + '"]',
            problem: 'Non-descriptive link text "' + text + '" (WCAG 2.1 SC 2.4.4 Link Purpose)',
            fix: 'Use descriptive link text that indicates the destination or purpose',
            wcag: '2.4.4'
          });
        }
      });

      // 9. Tabindex > 0 anti-pattern (WCAG 2.1 SC 2.4.3)
      var tabindexEls = document.querySelectorAll('[tabindex]');
      totalScanned += tabindexEls.length;
      tabindexEls.forEach(function(el) {
        var val = parseInt(el.getAttribute('tabindex') || '0', 10);
        if (val > 0) {
          var sel = el.id ? '#' + el.id : el.tagName.toLowerCase() + '[tabindex="' + val + '"]';
          issues.push({
            selector: sel,
            problem: 'Positive tabindex (' + val + ') disrupts natural focus order (WCAG 2.1 SC 2.4.3 Focus Order)',
            fix: 'Use tabindex="0" for focusable elements or tabindex="-1" for programmatic focus; remove positive values',
            wcag: '2.4.3'
          });
        }
      });

      var maxSeverity = 'pass';
      if (issues.length > 0) {
        var hasHigh = issues.some(function(iss) {
          return iss.wcag === '1.1.1' || iss.wcag === '1.4.3' || iss.wcag === '1.3.1' || iss.wcag === '4.1.2';
        });
        var hasMedium = issues.some(function(iss) {
          return iss.wcag === '3.1.1' || iss.wcag === '2.4.3';
        });
        var hasLow = issues.some(function(iss) {
          return iss.wcag === '2.4.4';
        });
        if (hasHigh) maxSeverity = 'high';
        else if (hasMedium) maxSeverity = 'medium';
        else if (hasLow) maxSeverity = 'low';
      }

      return {
        detector: 'accessibility',
        severity: maxSeverity,
        issues: issues,
        passed: issues.length === 0,
        totalScanned: totalScanned,
        issueCount: issues.length,
        metadata: {
          checksPerformed: 9,
          wcagVersion: '2.1',
          conformanceLevel: 'AA'
        }
      };
    })()
  `);
}
