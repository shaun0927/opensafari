/**
 * E2E Verification for Issue #268: Validate QA Report Output Correctness
 * Tests Markdown, JUnit XML, and JSON report formatters with real audit data.
 */
const { DOMParser } = require('@xmldom/xmldom');
const { generateAuditMarkdown } = require('../src/qa/report-markdown');
const { generateAuditJUnit } = require('../src/qa/report-junit');
const { generateAuditJSON } = require('../src/qa/report-json');
const { annotateScreenshot, detectorResultToAnnotations, formatLegend } = require('../src/comparison/annotator');
const { PNG } = require('pngjs');

// ──────────────────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function createTestScreenshot(w = 100, h = 100) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      png.data[idx] = 200; png.data[idx+1] = 200;
      png.data[idx+2] = 200; png.data[idx+3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

// ──────────────────────────────────────────────────────────
// Realistic Audit Report (simulates real QA audit output)
// ──────────────────────────────────────────────────────────
function createRealisticAuditReport(issueCount = 'normal') {
  const detectors = [];

  if (issueCount === 'empty') {
    // 0 issues — all pass
    const names = ['auto-zoom','touch-targets','hover-only','input-type','safe-area',
      'keyboard-overlap','horizontal-overflow','vh100','fixed-stacking','scroll-lock',
      'dark-mode','orientation','pwa-meta'];
    for (const name of names) {
      detectors.push({
        detector: name, severity: 'pass', passed: true,
        totalScanned: 10, issueCount: 0, issues: [],
      });
    }
  } else if (issueCount === 'large') {
    // 50+ issues
    const issues = [];
    for (let i = 0; i < 55; i++) {
      issues.push({
        selector: `div.item-${i}`,
        element: `<div class="item-${i}">Content ${i}</div>`,
        problem: `Touch target too small (${20+i}x${20+i}px < 44x44px)`,
        fix: `Increase touch target size to at least 44x44px`,
        boundingBox: { x: (i%10)*50, y: Math.floor(i/10)*50, width: 20+i, height: 20+i },
      });
    }
    detectors.push({
      detector: 'touch-targets', severity: 'critical', passed: false,
      totalScanned: 100, issueCount: 55, issues,
    });
    detectors.push({
      detector: 'auto-zoom', severity: 'high', passed: false,
      totalScanned: 20, issueCount: 3,
      issues: [
        { selector: 'input.email', element: '<input class="email">', problem: 'Font size 14px < 16px causes auto-zoom', fix: 'Set font-size to at least 16px', boundingBox: {x:10,y:200,width:200,height:30} },
        { selector: 'input.password', element: '<input class="password">', problem: 'Font size 12px < 16px causes auto-zoom', fix: 'Set font-size to at least 16px', boundingBox: {x:10,y:240,width:200,height:30} },
        { selector: 'textarea.comment', element: '<textarea class="comment">', problem: 'Font size 10px < 16px causes auto-zoom', fix: 'Set font-size to at least 16px', boundingBox: {x:10,y:280,width:200,height:60} },
      ],
    });
    // Add some passing detectors
    for (const name of ['hover-only','input-type','safe-area','dark-mode','pwa-meta']) {
      detectors.push({
        detector: name, severity: 'pass', passed: true,
        totalScanned: 15, issueCount: 0, issues: [],
      });
    }
  } else {
    // Normal — mix of pass/fail
    detectors.push({
      detector: 'auto-zoom', severity: 'high', passed: false,
      totalScanned: 15, issueCount: 2,
      issues: [
        { selector: 'input.search', element: '<input class="search" style="font-size:14px">', problem: 'Font size 14px < 16px causes auto-zoom on iOS', fix: 'Set font-size to at least 16px', boundingBox: {x:20,y:100,width:300,height:40} },
        { selector: 'select.filter', element: '<select class="filter">', problem: 'Font size 12px triggers auto-zoom', fix: 'Set font-size to at least 16px', boundingBox: {x:20,y:160,width:150,height:35} },
      ],
    });
    detectors.push({
      detector: 'touch-targets', severity: 'medium', passed: false,
      totalScanned: 30, issueCount: 3,
      issues: [
        { selector: 'a.nav-link', element: '<a class="nav-link">Home</a>', problem: 'Touch target 30x30px below 44x44px minimum', fix: 'Add padding to increase touch target', boundingBox: {x:10,y:10,width:30,height:30} },
        { selector: 'button.close', element: '<button class="close">X</button>', problem: 'Touch target 20x20px below 44x44px minimum', fix: 'Increase button size to 44x44px', boundingBox: {x:350,y:10,width:20,height:20} },
        { selector: 'a.footer-link', problem: 'Touch target 25x25px below 44x44px minimum', fix: 'Add padding to increase touch target' },
      ],
    });
    detectors.push({
      detector: 'hover-only', severity: 'low', passed: false,
      totalScanned: 10, issueCount: 1,
      issues: [
        { selector: '.dropdown-menu', element: '<div class="dropdown-menu">', problem: 'Hover-only interaction, no touch alternative', fix: 'Add click/tap handler alongside hover' },
      ],
    });
    for (const name of ['input-type','safe-area','keyboard-overlap','horizontal-overflow',
      'vh100','fixed-stacking','scroll-lock','dark-mode','orientation','pwa-meta']) {
      detectors.push({
        detector: name, severity: 'pass', passed: true,
        totalScanned: 10 + Math.floor(Math.random()*20), issueCount: 0, issues: [],
      });
    }
  }

  const summary = {
    totalIssues: detectors.reduce((s,d) => s+d.issueCount, 0),
    critical: detectors.filter(d=>d.severity==='critical').reduce((s,d)=>s+d.issueCount, 0),
    high: detectors.filter(d=>d.severity==='high').reduce((s,d)=>s+d.issueCount, 0),
    medium: detectors.filter(d=>d.severity==='medium').reduce((s,d)=>s+d.issueCount, 0),
    low: detectors.filter(d=>d.severity==='low').reduce((s,d)=>s+d.issueCount, 0),
    passed: detectors.filter(d=>d.passed).length,
    failed: detectors.filter(d=>!d.passed).length,
    errors: 0,
  };

  const score = Math.max(0, 100 - detectors.reduce((p, d) => {
    const weights = { critical:10, high:5, medium:2, low:1 };
    return p + (weights[d.severity]||0) * d.issueCount;
  }, 0));

  return {
    url: 'https://example.com',
    device: 'iPhone 17 Pro',
    viewport: { w: 393, h: 852 },
    timestamp: new Date().toISOString(),
    duration: 4523,
    score,
    summary,
    detectors,
  };
}

// ──────────────────────────────────────────────────────────
// 1. MARKDOWN VALIDATION
// ──────────────────────────────────────────────────────────
function verifyMarkdown(report) {
  console.log('\n📝 [1/5] Markdown Report Validation');
  const md = generateAuditMarkdown(report);

  // Basic structure
  assert(typeof md === 'string' && md.length > 0, 'Markdown output is non-empty string');
  assert(md.includes('## '), 'Has H2 header');
  assert(md.includes('iOS QA Audit Report'), 'Has report title');

  // Score and metadata
  assert(md.includes(`Score: ${report.score}/100`), `Score (${report.score}/100) present`);
  assert(md.includes(report.device), `Device name (${report.device}) present`);
  assert(md.includes(`${report.viewport.w}x${report.viewport.h}`), 'Viewport dimensions present');
  assert(md.includes(report.url), 'URL present');
  assert(md.includes(`${report.duration}ms`), 'Duration present');

  // Severity table (GitHub-compatible markdown table)
  assert(md.includes('| Severity | Count |'), 'Has severity table header');
  assert(md.includes('|----------|-------|'), 'Has table separator (GitHub rendering)');
  assert(md.includes(`| Critical | ${report.summary.critical} |`), 'Critical count correct');
  assert(md.includes(`| High | ${report.summary.high} |`), 'High count correct');
  assert(md.includes(`| Medium | ${report.summary.medium} |`), 'Medium count correct');
  assert(md.includes(`| Low | ${report.summary.low} |`), 'Low count correct');
  assert(md.includes(`| Passed | ${report.summary.passed}/13 detectors |`), 'Passed count correct');

  // Failed detectors
  const failedDetectors = report.detectors.filter(d => !d.passed);
  if (failedDetectors.length > 0) {
    assert(md.includes('### Issues Found'), 'Has Issues Found section');
    for (const det of failedDetectors) {
      assert(md.includes(`[${det.severity.toUpperCase()}] ${det.detector}`), `Detector ${det.detector} listed with severity`);
      assert(md.includes(`(${det.issueCount} issues)`), `Issue count for ${det.detector}`);
    }

    // Verify selector formatting (backtick-wrapped)
    const firstIssue = failedDetectors[0].issues[0];
    if (firstIssue) {
      assert(md.includes(`\`${firstIssue.selector}\``), 'Selectors are backtick-wrapped');
      assert(md.includes(firstIssue.problem), 'Problem description present');
      assert(md.includes(`**Fix:**`), 'Fix recommendation present');
    }
  }

  // GitHub rendering compatibility
  assert(!md.includes('<script'), 'No script tags (safe for GitHub)');
  assert(!md.includes('javascript:'), 'No javascript: URIs');

  // Verify lines are properly joined with newlines
  const lines = md.split('\n');
  assert(lines.length > 5, `Report has ${lines.length} lines (substantial content)`);

  return md;
}

// ──────────────────────────────────────────────────────────
// 2. JUNIT XML VALIDATION
// ──────────────────────────────────────────────────────────
function verifyJUnit(report) {
  console.log('\n🧪 [2/5] JUnit XML Report Validation');
  const xml = generateAuditJUnit(report);

  // Basic XML structure
  assert(typeof xml === 'string' && xml.length > 0, 'JUnit XML output is non-empty string');
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'Has XML declaration');

  // Parse with DOMParser (standard XML parser)
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const parseErrors = doc.getElementsByTagName('parsererror');
  assert(parseErrors.length === 0, 'XML parses without errors');

  // Schema compliance: <testsuites>
  const testsuites = doc.getElementsByTagName('testsuites');
  assert(testsuites.length === 1, 'Has exactly one <testsuites> root');
  const root = testsuites[0];
  assert(root.getAttribute('name') === 'opensafari-qa', 'Suite name is opensafari-qa');
  assert(root.getAttribute('tests') === String(report.detectors.length), `tests="${report.detectors.length}" correct`);

  // Schema compliance: <testsuite>
  const testsuite = doc.getElementsByTagName('testsuite');
  assert(testsuite.length === 1, 'Has exactly one <testsuite>');
  assert(testsuite[0].getAttribute('name') === report.device, `testsuite name matches device`);
  assert(testsuite[0].getAttribute('timestamp') !== null, 'testsuite has timestamp');
  const time = parseFloat(testsuite[0].getAttribute('time'));
  assert(!isNaN(time) && time >= 0, `time attribute is valid number (${time})`);

  // Properties
  const properties = doc.getElementsByTagName('property');
  const propMap = {};
  for (let i = 0; i < properties.length; i++) {
    propMap[properties[i].getAttribute('name')] = properties[i].getAttribute('value');
  }
  assert(propMap.url === report.url, 'URL property correct');
  assert(propMap.device === report.device, 'Device property correct');
  assert(propMap.viewport === `${report.viewport.w}x${report.viewport.h}`, 'Viewport property correct');
  assert(propMap.score === String(report.score), 'Score property correct');

  // Testcases
  const testcases = doc.getElementsByTagName('testcase');
  assert(testcases.length === report.detectors.length, `${testcases.length} testcases match ${report.detectors.length} detectors`);

  // Verify each testcase has name and classname
  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    assert(tc.getAttribute('name') !== null && tc.getAttribute('name').length > 0, `testcase[${i}] has name`);
    assert(tc.getAttribute('classname') === 'qa.detectors', `testcase[${i}] classname is qa.detectors`);
  }

  // Verify failure elements for failed critical/high detectors
  const failures = doc.getElementsByTagName('failure');
  const failedHighCritical = report.detectors.filter(d => !d.passed && ['critical','high'].includes(d.severity));
  assert(failures.length === failedHighCritical.length, `${failures.length} <failure> elements match ${failedHighCritical.length} critical/high failures`);

  // Verify skipped elements for low-severity
  const skipped = doc.getElementsByTagName('skipped');
  const skippedLow = report.detectors.filter(d => !d.passed && d.severity === 'low');
  assert(skipped.length === skippedLow.length, `${skipped.length} <skipped> elements match ${skippedLow.length} low-severity issues`);

  // XML escaping
  assert(!xml.includes('& ') || xml.includes('&amp;'), 'Ampersands are properly escaped');

  // Verify failures count attribute
  assert(root.getAttribute('failures') === String(failedHighCritical.length), 'failures count attribute correct');

  return xml;
}

// ──────────────────────────────────────────────────────────
// 3. JSON VALIDATION
// ──────────────────────────────────────────────────────────
function verifyJSON(report) {
  console.log('\n📦 [3/5] JSON Report Validation');
  const jsonReport = generateAuditJSON(report);

  // Parseable as JSON
  const jsonStr = JSON.stringify(jsonReport);
  assert(typeof jsonStr === 'string' && jsonStr.length > 0, 'JSON output is serializable');
  const parsed = JSON.parse(jsonStr);
  assert(typeof parsed === 'object', 'JSON is parseable back to object');

  // Schema fields
  assert(parsed.version === '1.0.0', 'version is 1.0.0');
  assert(typeof parsed.timestamp === 'string', 'timestamp is string');
  assert(parsed.url === report.url, 'url matches');
  assert(typeof parsed.device === 'object', 'device is object');
  assert(parsed.device.name === report.device, 'device.name matches');
  assert(parsed.device.viewport.width === report.viewport.w, 'device.viewport.width matches');
  assert(parsed.device.viewport.height === report.viewport.h, 'device.viewport.height matches');
  assert(typeof parsed.duration === 'number', 'duration is number');
  assert(typeof parsed.score === 'number', 'score is number');
  assert(parsed.score === report.score, `score value (${parsed.score}) matches input (${report.score})`);

  // Detectors array
  assert(Array.isArray(parsed.detectors), 'detectors is array');
  assert(parsed.detectors.length === report.detectors.length, `${parsed.detectors.length} detectors match input`);

  // Detector schema
  for (const det of parsed.detectors) {
    assert(typeof det.name === 'string', `detector ${det.name} has name`);
    assert(['pass','fail','error'].includes(det.status), `detector ${det.name} status is valid (${det.status})`);
    assert(typeof det.severity === 'string', `detector ${det.name} has severity`);
    assert(typeof det.scanned === 'number', `detector ${det.name} has scanned count`);
    assert(typeof det.issueCount === 'number', `detector ${det.name} has issueCount`);
    assert(Array.isArray(det.issues), `detector ${det.name} has issues array`);

    // Issue schema
    for (const issue of det.issues) {
      assert(typeof issue.selector === 'string', `issue has selector`);
      assert(typeof issue.problem === 'string', `issue has problem`);
      assert(typeof issue.fix === 'string', `issue has fix`);
      // element is optional
      if (issue.element) assert(typeof issue.element === 'string', 'issue.element is string when present');
    }
  }

  // Summary schema
  assert(typeof parsed.summary === 'object', 'summary is object');
  assert(typeof parsed.summary.total === 'number', 'summary.total is number');
  assert(typeof parsed.summary.pass === 'number', 'summary.pass is number');
  assert(typeof parsed.summary.fail === 'number', 'summary.fail is number');
  assert(typeof parsed.summary.error === 'number', 'summary.error is number');
  assert(typeof parsed.summary.issues === 'object', 'summary.issues is object');
  assert(parsed.summary.issues.critical === report.summary.critical, 'summary.issues.critical matches');
  assert(parsed.summary.issues.high === report.summary.high, 'summary.issues.high matches');
  assert(parsed.summary.issues.medium === report.summary.medium, 'summary.issues.medium matches');
  assert(parsed.summary.issues.low === report.summary.low, 'summary.issues.low matches');

  // Round-trip: generate → serialize → parse → compare
  const roundTrip = JSON.parse(JSON.stringify(generateAuditJSON(report)));
  assert(roundTrip.score === parsed.score, 'Round-trip: score preserved');
  assert(roundTrip.detectors.length === parsed.detectors.length, 'Round-trip: detectors preserved');
  assert(JSON.stringify(roundTrip) === JSON.stringify(parsed), 'Round-trip: full data integrity');

  return jsonReport;
}

// ──────────────────────────────────────────────────────────
// 4. SCREENSHOT EMBEDDING VALIDATION
// ──────────────────────────────────────────────────────────
function verifyScreenshots(report) {
  console.log('\n📸 [4/5] Screenshot Embedding Validation');
  const screenshotBase64 = createTestScreenshot(393, 852);

  // Collect annotations from failed detectors
  const annotations = [];
  for (const det of report.detectors) {
    if (det.passed || det.severity === 'pass' || det.severity === 'error') continue;
    const severity = det.severity;
    const converted = detectorResultToAnnotations(det.detector, severity, det.issues);
    annotations.push(...converted);
  }

  assert(annotations.length > 0, `Generated ${annotations.length} annotations from audit`);

  // Annotate screenshot
  const result = annotateScreenshot(screenshotBase64, annotations, { showLabels: true });
  assert(typeof result.annotatedImage === 'string', 'annotatedImage is base64 string');
  assert(result.annotatedImage.length > 0, 'annotatedImage is non-empty');
  assert(result.width === 393, 'Width preserved (393)');
  assert(result.height === 852, 'Height preserved (852)');
  assert(Array.isArray(result.legend), 'legend is array');
  assert(result.legend.length > 0, `legend has ${result.legend.length} entries`);

  // Verify annotated image is valid PNG
  try {
    const buf = Buffer.from(result.annotatedImage, 'base64');
    const decoded = PNG.sync.read(buf);
    assert(decoded.width === 393 && decoded.height === 852, 'Annotated PNG decodes with correct dimensions');
  } catch (e) {
    assert(false, `Annotated image is valid PNG: ${e.message}`);
  }

  // Verify legend entries
  for (const entry of result.legend) {
    assert(typeof entry.index === 'number', `legend entry has index`);
    assert(typeof entry.label === 'string', `legend entry has label`);
    assert(typeof entry.severity === 'string', `legend entry has severity`);
    assert(typeof entry.color === 'string' && entry.color.startsWith('#'), `legend entry has hex color`);
  }

  // Format legend for Markdown embedding
  const legendMd = formatLegend(result.legend);
  assert(legendMd.includes('## Annotation Legend'), 'Legend markdown has title');
  assert(legendMd.includes('**[1]**'), 'Legend has numbered entries');

  // Verify base64 can be embedded in markdown (data URI)
  const dataUri = `![Screenshot](data:image/png;base64,${result.annotatedImage})`;
  assert(dataUri.length > 50, 'Data URI is substantial');
  assert(dataUri.startsWith('![Screenshot](data:image/png;base64,'), 'Valid markdown image with data URI');

  // Verify base64 can be embedded in JSON
  const jsonWithScreenshot = JSON.stringify({ screenshot: result.annotatedImage });
  const parsedBack = JSON.parse(jsonWithScreenshot);
  assert(parsedBack.screenshot === result.annotatedImage, 'Screenshot survives JSON round-trip');

  // Verify base64 can be embedded in XML (escaped)
  const xmlSafe = result.annotatedImage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert(xmlSafe.length > 0, 'Screenshot is XML-safe');

  return result;
}

// ──────────────────────────────────────────────────────────
// 5. EDGE CASES
// ──────────────────────────────────────────────────────────
function verifyEdgeCases() {
  console.log('\n🔄 [5/5] Edge Case Validation');

  // Empty report (0 issues)
  console.log('  --- Empty Report (0 issues) ---');
  const emptyReport = createRealisticAuditReport('empty');
  assert(emptyReport.summary.totalIssues === 0, 'Empty report has 0 issues');
  assert(emptyReport.score === 100, 'Empty report score is 100');

  const emptyMd = generateAuditMarkdown(emptyReport);
  assert(typeof emptyMd === 'string' && emptyMd.length > 0, 'Empty: Markdown generated');
  assert(!emptyMd.includes('### Issues Found'), 'Empty: No issues section');

  const emptyXml = generateAuditJUnit(emptyReport);
  const parser = new DOMParser();
  const emptyDoc = parser.parseFromString(emptyXml, 'text/xml');
  assert(emptyDoc.getElementsByTagName('failure').length === 0, 'Empty: No <failure> in XML');
  assert(emptyDoc.getElementsByTagName('testcase').length === emptyReport.detectors.length, 'Empty: All detectors present as testcases');

  const emptyJson = generateAuditJSON(emptyReport);
  assert(emptyJson.summary.fail === 0, 'Empty: JSON summary.fail is 0');
  assert(emptyJson.score === 100, 'Empty: JSON score is 100');

  // Large report (50+ issues)
  console.log('  --- Large Report (50+ issues) ---');
  const largeReport = createRealisticAuditReport('large');
  assert(largeReport.summary.totalIssues >= 50, `Large report has ${largeReport.summary.totalIssues} issues`);

  const largeMd = generateAuditMarkdown(largeReport);
  assert(typeof largeMd === 'string' && largeMd.length > 100, 'Large: Markdown generated');
  assert(largeMd.includes('... and '), 'Large: Markdown truncates >5 issues per detector');

  const largeXml = generateAuditJUnit(largeReport);
  const largeDoc = parser.parseFromString(largeXml, 'text/xml');
  assert(largeDoc.getElementsByTagName('parsererror').length === 0, 'Large: XML parses without errors');
  const largeFailures = largeDoc.getElementsByTagName('failure');
  assert(largeFailures.length > 0, `Large: Has ${largeFailures.length} failure elements`);

  const largeJson = generateAuditJSON(largeReport);
  assert(largeJson.detectors.some(d => d.issues.length >= 50), 'Large: JSON preserves all 50+ issues');
  assert(JSON.stringify(largeJson).length > 1000, 'Large: JSON is substantial');

  // Report with screenshots
  console.log('  --- Report with Screenshots ---');
  const screenshotReport = createRealisticAuditReport('normal');
  const screenshot = createTestScreenshot(393, 852);

  // Annotate with all failing detectors
  const allAnnotations = [];
  for (const det of screenshotReport.detectors) {
    if (det.passed || det.severity === 'pass') continue;
    const converted = detectorResultToAnnotations(det.detector, det.severity, det.issues);
    allAnnotations.push(...converted);
  }

  if (allAnnotations.length > 0) {
    const annotResult = annotateScreenshot(screenshot, allAnnotations, { showLabels: true });
    assert(annotResult.annotatedImage.length > screenshot.length * 0.5, 'Screenshot: Annotated image has data');
    assert(annotResult.legend.length === allAnnotations.length, `Screenshot: Legend has ${allAnnotations.length} entries`);
  }

  // Error detector handling
  console.log('  --- Error Detector ---');
  const errorReport = createRealisticAuditReport('normal');
  errorReport.detectors.push({
    detector: 'broken-detector', severity: 'error', passed: false,
    totalScanned: 0, issueCount: 0, issues: [],
    error: 'Timeout after 30s',
  });
  errorReport.summary.errors = 1;

  const errorXml = generateAuditJUnit(errorReport);
  const errorDoc = parser.parseFromString(errorXml, 'text/xml');
  const errorElements = errorDoc.getElementsByTagName('error');
  assert(errorElements.length === 1, 'Error: Has <error> element for broken detector');

  const errorJson = generateAuditJSON(errorReport);
  const errorDet = errorJson.detectors.find(d => d.name === 'broken-detector');
  assert(errorDet && errorDet.status === 'error', 'Error: JSON status is "error"');
  assert(errorDet && errorDet.error === 'Timeout after 30s', 'Error: JSON preserves error message');

  // Special characters in content
  console.log('  --- Special Characters ---');
  const specialReport = createRealisticAuditReport('normal');
  specialReport.detectors[0].issues[0].problem = 'Font < 16px & zoom > 100% "double" \'single\'';
  specialReport.detectors[0].issues[0].selector = 'input[type="email"]';

  const specialXml = generateAuditJUnit(specialReport);
  const specialDoc = parser.parseFromString(specialXml, 'text/xml');
  assert(specialDoc.getElementsByTagName('parsererror').length === 0, 'Special chars: XML parses correctly');

  const specialJson = generateAuditJSON(specialReport);
  const specialStr = JSON.stringify(specialJson);
  const specialParsed = JSON.parse(specialStr);
  assert(specialParsed.detectors[0].issues[0].problem.includes('< 16px'), 'Special chars: JSON preserves < symbol');
  assert(specialParsed.detectors[0].issues[0].problem.includes('> 100%'), 'Special chars: JSON preserves > symbol');
}

// ──────────────────────────────────────────────────────────
// Main — run all verifications
// ──────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Issue #268: E2E Validate QA Report Output Correctness');
  console.log(' Using opensafari report formatters with realistic data');
  console.log('═══════════════════════════════════════════════════════════');

  const report = createRealisticAuditReport('normal');
  console.log(`\nTest report: score=${report.score}, detectors=${report.detectors.length}, issues=${report.summary.totalIssues}`);

  verifyMarkdown(report);
  verifyJUnit(report);
  verifyJSON(report);
  verifyScreenshots(report);
  verifyEdgeCases();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
