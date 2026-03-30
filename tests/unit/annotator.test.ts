import { PNG } from 'pngjs';
import { annotateScreenshot, detectorResultToAnnotations, formatLegend } from '../../src/comparison/annotator';

function createTestPNG(w: number, h: number, color = { r: 200, g: 200, b: 200, a: 255 }): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; png.data[i] = color.r; png.data[i+1] = color.g; png.data[i+2] = color.b; png.data[i+3] = color.a; }
  return PNG.sync.write(png).toString('base64');
}
function decodePNG(b: string): PNG { return PNG.sync.read(Buffer.from(b, 'base64')); }
function getPixel(png: PNG, x: number, y: number) { const i = (y * png.width + x) * 4; return { r: png.data[i], g: png.data[i+1], b: png.data[i+2], a: png.data[i+3] }; }

describe('annotateScreenshot', () => {
  const img = createTestPNG(200, 200);
  it('returns valid PNG', () => { const r = annotateScreenshot(img, [{ boundingBox: { x: 10, y: 10, width: 50, height: 30 }, severity: 'high', label: 't' }]); expect(r.width).toBe(200); expect(decodePNG(r.annotatedImage).width).toBe(200); });
  it('draws severity colors', () => {
    const e: Record<string, {r:number;g:number;b:number}> = { critical:{r:255,g:0,b:0}, high:{r:255,g:51,b:51}, medium:{r:255,g:136,b:0}, low:{r:255,g:215,b:0} };
    for (const s of ['critical','high','medium','low'] as const) { const r = annotateScreenshot(img, [{ boundingBox:{x:50,y:80,width:60,height:40}, severity:s, label:'t' }], { showLabels:false }); const p = getPixel(decodePNG(r.annotatedImage), 50, 80); expect(p.r).toBe(e[s].r); expect(p.g).toBe(e[s].g); }
  });
  it('returns legend', () => { const r = annotateScreenshot(img, [{ boundingBox:{x:10,y:10,width:30,height:20}, severity:'critical', label:'a', description:'d1' }, { boundingBox:{x:80,y:80,width:40,height:40}, severity:'medium', label:'b' }]); expect(r.legend).toHaveLength(2); expect(r.legend[0].index).toBe(1); expect(r.legend[0].severity).toBe('critical'); });
  it('handles empty issues', () => { const r = annotateScreenshot(img, []); expect(r.legend).toHaveLength(0); });
  it('clamps out-of-bounds', () => { expect(annotateScreenshot(img, [{ boundingBox:{x:-10,y:-5,width:300,height:250}, severity:'high', label:'o' }]).legend).toHaveLength(1); });
  it('handles fractional coords', () => { expect(annotateScreenshot(img, [{ boundingBox:{x:10.7,y:20.3,width:50.5,height:30.9}, severity:'medium', label:'t' }]).annotatedImage).toBeTruthy(); });
  it('draws safe area', () => { const r = annotateScreenshot(img, [], { safeArea:{top:44,bottom:34,left:0,right:0} }); const p = getPixel(decodePNG(r.annotatedImage), 100, 10); expect(p.r !== 200 || p.g !== 200 || p.b !== 200).toBe(true); });
  it('respects lineWidth', () => {
    const t = decodePNG(annotateScreenshot(img, [{ boundingBox:{x:50,y:50,width:40,height:40}, severity:'high', label:'t' }], { showLabels:false, lineWidth:1 }).annotatedImage);
    const k = decodePNG(annotateScreenshot(img, [{ boundingBox:{x:50,y:50,width:40,height:40}, severity:'high', label:'t' }], { showLabels:false, lineWidth:5 }).annotatedImage);
    let tc=0, kc=0; for (let i=0;i<t.data.length;i+=4) { if(t.data[i]===255&&t.data[i+1]===51) tc++; if(k.data[i]===255&&k.data[i+1]===51) kc++; }
    expect(kc).toBeGreaterThan(tc);
  });
  it('works with different sizes', () => { expect(annotateScreenshot(createTestPNG(50,50), [{ boundingBox:{x:5,y:5,width:20,height:20}, severity:'high', label:'t' }]).width).toBe(50); });
});

describe('detectorResultToAnnotations', () => {
  it('extracts boundingBox', () => { const a = detectorResultToAnnotations('t', 'high', [{ selector:'#b', problem:'p', boundingBox:{x:10,y:20,width:30,height:40} }]); expect(a).toHaveLength(1); expect(a[0].boundingBox).toEqual({x:10,y:20,width:30,height:40}); });
  it('extracts rect', () => { const a = detectorResultToAnnotations('t', 'medium', [{ selector:'.w', problem:'p', rect:{x:0,y:100,width:500,height:50} }]); expect(a[0].boundingBox).toEqual({x:0,y:100,width:500,height:50}); });
  it('extracts size+position', () => { const a = detectorResultToAnnotations('t', 'high', [{ selector:'#s', problem:'p', size:{width:32,height:28}, x:100, y:200 }]); expect(a[0].boundingBox).toEqual({x:100,y:200,width:32,height:28}); });
  it('skips without bbox', () => { expect(detectorResultToAnnotations('t', 'low', [{ selector:'#a', problem:'p' }, { selector:'#b', problem:'p', boundingBox:{x:0,y:0,width:10,height:10} }])).toHaveLength(1); });
  it('handles empty', () => { expect(detectorResultToAnnotations('t', 'high', [])).toEqual([]); });
});

describe('formatLegend', () => {
  it('formats markdown', () => { const m = formatLegend([{ index:1, label:'touch', severity:'high', description:'small', color:'#F33' }]); expect(m).toContain('Annotation Legend'); expect(m).toContain('`touch`'); });
  it('empty message', () => { expect(formatLegend([])).toBe('No issues annotated.'); });
});
