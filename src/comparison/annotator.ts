import { PNG } from 'pngjs';

export interface BoundingBox { x: number; y: number; width: number; height: number; }
export interface AnnotationIssue { boundingBox: BoundingBox; severity: 'critical' | 'high' | 'medium' | 'low'; label: string; description?: string; }
export interface AnnotationOptions { lineWidth?: number; showLabels?: boolean; safeArea?: { top: number; bottom: number; left: number; right: number }; opacity?: number; }
export interface LegendEntry { index: number; label: string; severity: string; description?: string; color: string; }
export interface AnnotationResult { annotatedImage: string; legend: LegendEntry[]; width: number; height: number; }

interface RGBA { r: number; g: number; b: number; a: number; }

const SEVERITY_COLORS: Record<string, RGBA> = {
  critical: { r: 255, g: 0, b: 0, a: 255 },
  high: { r: 255, g: 51, b: 51, a: 255 },
  medium: { r: 255, g: 136, b: 0, a: 255 },
  low: { r: 255, g: 215, b: 0, a: 255 },
};

const SEVERITY_COLOR_NAMES: Record<string, string> = {
  critical: '#FF0000', high: '#FF3333', medium: '#FF8800', low: '#FFD700',
};

const SAFE_AREA_COLOR: RGBA = { r: 0, g: 150, b: 255, a: 180 };

const DIGIT_FONT: Record<string, number[]> = {
  '0': [0x7c,0xc6,0xce,0xd6,0xe6,0xc6,0x7c], '1': [0x30,0x70,0x30,0x30,0x30,0x30,0xfc],
  '2': [0x78,0xcc,0x0c,0x38,0x60,0xc0,0xfc], '3': [0x78,0xcc,0x0c,0x38,0x0c,0xcc,0x78],
  '4': [0x1c,0x3c,0x6c,0xcc,0xfe,0x0c,0x0c], '5': [0xfc,0xc0,0xf8,0x0c,0x0c,0xcc,0x78],
  '6': [0x38,0x60,0xc0,0xf8,0xcc,0xcc,0x78], '7': [0xfc,0x0c,0x18,0x30,0x60,0x60,0x60],
  '8': [0x78,0xcc,0xcc,0x78,0xcc,0xcc,0x78], '9': [0x78,0xcc,0xcc,0x7c,0x0c,0x18,0x70],
};

export function annotateScreenshot(screenshotBase64: string, issues: AnnotationIssue[], options?: AnnotationOptions): AnnotationResult {
  const lineWidth = options?.lineWidth ?? 3;
  const showLabels = options?.showLabels ?? true;
  const opacity = options?.opacity ?? 255;
  const png = decodePNG(screenshotBase64);
  const { width, height, data } = png;
  const legend: LegendEntry[] = [];
  if (options?.safeArea) { drawSafeAreaOverlay(data, width, height, options.safeArea); }
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const color = { ...(SEVERITY_COLORS[issue.severity] ?? SEVERITY_COLORS.medium) };
    color.a = opacity;
    const box = clampBox(issue.boundingBox, width, height);
    drawRect(data, width, height, box, color, lineWidth);
    if (showLabels) { drawBadge(data, width, height, box.x, box.y, i + 1, color); }
    legend.push({ index: i + 1, label: issue.label, severity: issue.severity, description: issue.description, color: SEVERITY_COLOR_NAMES[issue.severity] ?? '#FF8800' });
  }
  return { annotatedImage: encodePNG(png), legend, width, height };
}

function setPixel(data: Buffer, width: number, height: number, x: number, y: number, color: RGBA): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const idx = (y * width + x) * 4;
  if (color.a === 255) { data[idx] = color.r; data[idx+1] = color.g; data[idx+2] = color.b; data[idx+3] = 255; }
  else { const a = color.a/255, inv = 1-a; data[idx] = Math.round(color.r*a + data[idx]*inv); data[idx+1] = Math.round(color.g*a + data[idx+1]*inv); data[idx+2] = Math.round(color.b*a + data[idx+2]*inv); data[idx+3] = Math.min(255, data[idx+3]+color.a); }
}

function drawRect(data: Buffer, imgW: number, imgH: number, box: BoundingBox, color: RGBA, lw: number): void {
  for (let l = 0; l < lw; l++) {
    for (let px = box.x-l; px <= box.x+box.width+l; px++) { setPixel(data, imgW, imgH, px, box.y-l, color); setPixel(data, imgW, imgH, px, box.y+box.height+l, color); }
    for (let py = box.y-l; py <= box.y+box.height+l; py++) { setPixel(data, imgW, imgH, box.x-l, py, color); setPixel(data, imgW, imgH, box.x+box.width+l, py, color); }
  }
}

function drawFilledRect(data: Buffer, imgW: number, imgH: number, x: number, y: number, w: number, h: number, color: RGBA): void {
  for (let py = y; py < y+h; py++) for (let px = x; px < x+w; px++) setPixel(data, imgW, imgH, px, py, color);
}

function drawBadge(data: Buffer, imgW: number, imgH: number, boxX: number, boxY: number, num: number, color: RGBA): void {
  const digits = String(num), cw = 7, bw = digits.length*cw+5, bh = 13;
  let bx = boxX, by = boxY-bh-2;
  if (by < 0) by = boxY+2;
  if (bx+bw > imgW) bx = imgW-bw;
  if (bx < 0) bx = 0;
  drawFilledRect(data, imgW, imgH, bx, by, bw, bh, color);
  const white: RGBA = { r:255, g:255, b:255, a:255 };
  let tx = bx+3; const ty = by+2;
  for (const d of digits) { drawDigit(data, imgW, imgH, tx, ty, d, white); tx += cw; }
}

function drawDigit(data: Buffer, imgW: number, imgH: number, sx: number, sy: number, digit: string, color: RGBA): void {
  const rows = DIGIT_FONT[digit]; if (!rows) return;
  for (let r = 0; r < 7; r++) { const bits = rows[r]; for (let c = 0; c < 8; c++) { if (bits & (0x80 >> c)) setPixel(data, imgW, imgH, sx+c, sy+r, color); } }
}

function drawSafeAreaOverlay(data: Buffer, w: number, h: number, sa: {top:number;bottom:number;left:number;right:number}): void {
  const dl=6, gl=4, color=SAFE_AREA_COLOR;
  if (sa.top>0) { drawDashedH(data,w,h,0,w,sa.top,color,dl,gl); tint(data,w,h,0,0,w,sa.top,{...color,a:40}); }
  if (sa.bottom>0) { const y=h-sa.bottom; drawDashedH(data,w,h,0,w,y,color,dl,gl); tint(data,w,h,0,y,w,sa.bottom,{...color,a:40}); }
  if (sa.left>0) { drawDashedV(data,w,h,sa.left,0,h,color,dl,gl); tint(data,w,h,0,0,sa.left,h,{...color,a:40}); }
  if (sa.right>0) { const x=w-sa.right; drawDashedV(data,w,h,x,0,h,color,dl,gl); tint(data,w,h,x,0,sa.right,h,{...color,a:40}); }
}

function drawDashedH(data: Buffer, imgW: number, imgH: number, x1: number, x2: number, y: number, color: RGBA, dl: number, gl: number): void {
  let on=true, cnt=0;
  for (let x=x1; x<x2; x++) { if (on) { setPixel(data,imgW,imgH,x,y,color); setPixel(data,imgW,imgH,x,y-1,color); setPixel(data,imgW,imgH,x,y+1,color); } cnt++; if (on&&cnt>=dl) { on=false; cnt=0; } else if (!on&&cnt>=gl) { on=true; cnt=0; } }
}

function drawDashedV(data: Buffer, imgW: number, imgH: number, x: number, y1: number, y2: number, color: RGBA, dl: number, gl: number): void {
  let on=true, cnt=0;
  for (let y=y1; y<y2; y++) { if (on) { setPixel(data,imgW,imgH,x,y,color); setPixel(data,imgW,imgH,x-1,y,color); setPixel(data,imgW,imgH,x+1,y,color); } cnt++; if (on&&cnt>=dl) { on=false; cnt=0; } else if (!on&&cnt>=gl) { on=true; cnt=0; } }
}

function tint(data: Buffer, imgW: number, imgH: number, x: number, y: number, w: number, h: number, color: RGBA): void {
  for (let py=y; py<y+h&&py<imgH; py++) for (let px=x; px<x+w&&px<imgW; px++) setPixel(data,imgW,imgH,px,py,color);
}

function clampBox(box: BoundingBox, imgW: number, imgH: number): BoundingBox {
  const x=Math.max(0,Math.round(box.x)), y=Math.max(0,Math.round(box.y));
  return { x, y, width: Math.max(0, Math.min(Math.round(box.width), imgW-x-1)), height: Math.max(0, Math.min(Math.round(box.height), imgH-y-1)) };
}

function decodePNG(base64: string): PNG { return PNG.sync.read(Buffer.from(base64, 'base64')); }
function encodePNG(png: PNG): string { return PNG.sync.write(png).toString('base64'); }

export function detectorResultToAnnotations(detector: string, severity: 'critical'|'high'|'medium'|'low', issues: Array<{selector:string;problem:string;[k:string]:unknown}>): AnnotationIssue[] {
  const out: AnnotationIssue[] = [];
  for (const issue of issues) { const bb = extractBoundingBox(issue); if (!bb) continue; out.push({ boundingBox: bb, severity, label: detector, description: issue.problem }); }
  return out;
}

function extractBoundingBox(issue: Record<string, unknown>): BoundingBox | null {
  if (issue.boundingBox && typeof issue.boundingBox === 'object') { const bb = issue.boundingBox as Record<string,unknown>; if (typeof bb.x==='number'&&typeof bb.y==='number'&&typeof bb.width==='number'&&typeof bb.height==='number') return {x:bb.x,y:bb.y,width:bb.width,height:bb.height}; }
  if (issue.rect && typeof issue.rect === 'object') { const r = issue.rect as Record<string,unknown>; if (typeof r.x==='number'&&typeof r.y==='number'&&typeof r.width==='number'&&typeof r.height==='number') return {x:r.x,y:r.y,width:r.width,height:r.height}; }
  if (issue.size && typeof issue.size === 'object') { const s = issue.size as Record<string,unknown>; if (typeof s.width==='number'&&typeof s.height==='number') { return {x:typeof issue.x==='number'?issue.x:0, y:typeof issue.y==='number'?issue.y:0, width:s.width, height:s.height}; } }
  return null;
}

export function formatLegend(legend: LegendEntry[]): string {
  if (legend.length === 0) return 'No issues annotated.';
  const lines = ['## Annotation Legend', ''];
  for (const e of legend) { lines.push('**[' + e.index + ']** `' + e.label + '` (' + e.severity + ')' + (e.description ? ' \u2014 ' + e.description : '')); }
  return lines.join('\n');
}
