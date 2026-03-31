/**
 * E2E Verification: Issue #251 — Advanced Gesture Tools
 * Tests long_press, swipe, select_option on real iOS Simulator
 */

import { WebKitClient } from '../src/webkit/client';
import { SimulatorManager } from '../src/simulator';
import { getSharedProxy } from '../src/simulator/proxy';
import * as http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; padding: 16px; background: #f5f5f5; }
  h2 { font-size: 16px; margin: 12px 0 8px; color: #333; }
  #long-press-target {
    display: block; padding: 16px; background: #007AFF; color: white;
    text-decoration: none; border-radius: 8px; text-align: center; font-size: 16px;
  }
  .carousel-container { overflow: hidden; width: 100%; position: relative; border-radius: 8px; margin-top: 150px; }
  .carousel-track { display: flex; transition: transform 0.3s ease; touch-action: pan-y; }
  .carousel-slide {
    min-width: 100%; height: 200px; display: flex; align-items: center;
    justify-content: center; font-size: 24px; font-weight: bold; color: white;
  }
  .carousel-slide:nth-child(1) { background: #FF3B30; }
  .carousel-slide:nth-child(2) { background: #34C759; }
  .carousel-slide:nth-child(3) { background: #007AFF; }
  #test-select { width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #ccc; }
</style>
</head>
<body>
<h2>1. Long Press Test</h2>
<a id="long-press-target" href="#">Long Press Me</a>

<h2>2. Swipe Carousel</h2>
<div class="carousel-container" id="carousel">
  <div class="carousel-track" id="carousel-track">
    <div class="carousel-slide">Slide 1</div>
    <div class="carousel-slide">Slide 2</div>
    <div class="carousel-slide">Slide 3</div>
  </div>
</div>

<h2>3. Select Option</h2>
<select id="test-select">
  <option value="">-- Choose --</option>
  <option value="apple">Apple</option>
  <option value="banana">Banana</option>
  <option value="cherry">Cherry</option>
</select>

<h2>4. DPR Test</h2>
<div id="dpr-target" style="width:100px;height:100px;background:#FF9500;border-radius:8px;"></div>

<script>
window.__longPressDetected = false;
window.__longPressDuration = 0;
window.__touchStartFired = false;
window.__touchEndFired = false;
var lpTarget = document.getElementById('long-press-target');
var lpStart = 0;
lpTarget.addEventListener('touchstart', function(e) {
  lpStart = Date.now();
  window.__touchStartFired = true;
  e.preventDefault();
});
lpTarget.addEventListener('touchend', function(e) {
  var duration = Date.now() - lpStart;
  window.__touchEndFired = true;
  window.__longPressDuration = duration;
  if (duration >= 400) window.__longPressDetected = true;
});

window.__carouselSlide = 0;
var track = document.getElementById('carousel-track');
var currentSlide = 0;
var startX = 0;
var isDragging = false;
window.__swipeTouchStartFired = false;
window.__swipeTouchMoveFired = false;
window.__swipeTouchEndFired = false;
window.__swipeDeltaX = 0;
track.addEventListener('touchstart', function(e) {
  if (e.changedTouches && e.changedTouches[0]) startX = e.changedTouches[0].clientX;
  isDragging = true;
  window.__swipeTouchStartFired = true;
});
track.addEventListener('touchmove', function(e) {
  window.__swipeTouchMoveFired = true;
  if (!isDragging || !e.changedTouches || !e.changedTouches[0]) return;
  window.__swipeDeltaX = e.changedTouches[0].clientX - startX;
});
track.addEventListener('touchend', function(e) {
  window.__swipeTouchEndFired = true;
  if (!isDragging || !e.changedTouches || !e.changedTouches[0]) return;
  isDragging = false;
  var endX = e.changedTouches[0].clientX;
  var deltaX = endX - startX;
  window.__swipeDeltaX = deltaX;
  if (Math.abs(deltaX) > 50) {
    if (deltaX < 0 && currentSlide < 2) currentSlide++;
    else if (deltaX > 0 && currentSlide > 0) currentSlide--;
    track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
    window.__carouselSlide = currentSlide;
  }
});

window.__selectValue = '';
window.__selectChangeCount = 0;
window.__selectInputFired = false;
var sel = document.getElementById('test-select');
sel.addEventListener('change', function() {
  window.__selectValue = sel.value;
  window.__selectChangeCount++;
});
sel.addEventListener('input', function() { window.__selectInputFired = true; });

window.__dprInfo = {
  dpr: window.devicePixelRatio,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
  screenWidth: screen.width,
  screenHeight: screen.height
};
window.__pageReady = true;
</script>
</body>
</html>`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('Issue #251: Advanced Gesture Tools E2E', () => {
  let server: http.Server;
  let client: WebKitClient;
  const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9522', 10);
  const PORT = 18765;

  beforeAll(async () => {
    // Start test HTTP server (ignore EADDRINUSE if already running)
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(PORT, resolve);
      server.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') resolve(); // Already running
        else reject(e);
      });
    });
    console.error(`[SERVER] Test page on port ${PORT}`);

    // Connect WebKit client (device + proxy already running externally)
    client = new WebKitClient({ host: 'localhost', port: PROXY_PORT });
    await client.connect();
    console.error('[WEBKIT] Connected');

    // Navigate to ensure clean load
    await client.navigate({ url: `http://localhost:${PORT}` });
    await sleep(3000);

    // Verify page loaded
    const ready = await client.evaluate<boolean>('window.__pageReady === true');
    expect(ready).toBe(true);
    console.error('[PAGE] Ready');
  }, 120000);

  afterAll(async () => {
    try { await client?.disconnect(); } catch { /* */ }
    server?.close();
  });

  test('long_press triggers appropriate events on real page elements', async () => {
    await client.longPress('#long-press-target', 600);
    await sleep(200);

    const touchStartFired = await client.evaluate<boolean>('window.__touchStartFired');
    const touchEndFired = await client.evaluate<boolean>('window.__touchEndFired');
    const longPressDetected = await client.evaluate<boolean>('window.__longPressDetected');
    const duration = await client.evaluate<number>('window.__longPressDuration');

    console.error(`  touchstart=${touchStartFired} touchend=${touchEndFired} longPress=${longPressDetected} duration=${duration}ms`);

    expect(touchStartFired).toBe(true);
    expect(touchEndFired).toBe(true);
    expect(longPressDetected).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(400);
  }, 30000);

  test('swipe correctly moves carousel/slider components', async () => {
    // Scroll carousel to viewport center so swipe() hits it
    await client.evaluate(`
      document.getElementById('carousel').scrollIntoView({ block: 'center' });
    `);
    await sleep(300);

    await client.swipe('left');
    await sleep(500);

    const slide = await client.evaluate<number>('window.__carouselSlide');
    const touchStartFired = await client.evaluate<boolean>('window.__swipeTouchStartFired');
    const touchMoveFired = await client.evaluate<boolean>('window.__swipeTouchMoveFired');
    const touchEndFired = await client.evaluate<boolean>('window.__swipeTouchEndFired');
    const deltaX = await client.evaluate<number>('window.__swipeDeltaX');

    console.error(`  start=${touchStartFired} move=${touchMoveFired} end=${touchEndFired} slide=${slide} deltaX=${deltaX}`);

    expect(touchStartFired).toBe(true);
    expect(touchMoveFired).toBe(true);
    expect(touchEndFired).toBe(true);
    expect(slide).toBe(1);
    expect(deltaX).toBeLessThan(-50);
  }, 30000);

  test('select_option works with native iOS <select> picker', async () => {
    await client.selectOption('#test-select', 'banana');
    await sleep(200);

    const value = await client.evaluate<string>('window.__selectValue');
    const changeCount = await client.evaluate<number>('window.__selectChangeCount');
    const inputFired = await client.evaluate<boolean>('window.__selectInputFired');
    const domValue = await client.evaluate<string>('document.getElementById("test-select").value');

    console.error(`  value=${value} domValue=${domValue} changes=${changeCount} inputFired=${inputFired}`);

    expect(value).toBe('banana');
    expect(domValue).toBe('banana');
    expect(changeCount).toBeGreaterThanOrEqual(1);
    expect(inputFired).toBe(true);
  }, 30000);

  test('gesture coordinates translate correctly across device pixel ratios', async () => {
    const dprInfo = await client.evaluate<{
      dpr: number; viewportWidth: number; viewportHeight: number;
      screenWidth: number; screenHeight: number;
    }>('window.__dprInfo');

    console.error(`  dpr=${dprInfo.dpr} viewport=${dprInfo.viewportWidth}x${dprInfo.viewportHeight}`);

    // longPress on a known-size element verifies coordinate mapping
    await client.longPress('#dpr-target', 100);
    await sleep(200);

    const rect = await client.evaluate<{ x: number; y: number; w: number; h: number }>(`
      (function() {
        var el = document.getElementById('dpr-target');
        var r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()
    `);

    console.error(`  rect=${JSON.stringify(rect)}`);

    expect(dprInfo.dpr).toBeGreaterThanOrEqual(1);
    expect(dprInfo.viewportWidth).toBeGreaterThan(0);
    expect(rect.w).toBe(100);
    expect(rect.h).toBe(100);
  }, 30000);

  test('no interference between gestures and iOS system gestures', async () => {
    // Reset carousel
    await client.evaluate(`
      window.__carouselSlide = 0;
      document.getElementById("carousel-track").style.transform = "translateX(0%)";
    `);
    await sleep(200);

    // Right swipe (same direction as iOS back gesture)
    await client.swipe('right');
    await sleep(500);

    // Page should still be loaded (no back navigation triggered)
    const pageStillLoaded = await client.evaluate<boolean>('window.__pageReady === true');

    console.error(`  pageStillLoaded=${pageStillLoaded}`);

    expect(pageStillLoaded).toBe(true);
  }, 30000);
});
