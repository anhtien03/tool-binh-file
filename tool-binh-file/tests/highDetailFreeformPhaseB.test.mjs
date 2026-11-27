/**
 * Phase B Verification Suite — High Detail Freeform for Raster (bleedContourEngine.js)
 *
 * Verifies:
 *  1. 12-lobe scalloped sticker (Giảm 3%, 300 DPI raster from real Customer PDF):
 *     - Individual depth of all 12 concave valleys (standard vs high vs ground truth)
 *     - Full-curve Hausdorff & mean deviation vs source silhouette
 *     - Abnormal outward bulge check
 *     - Normal BLEED offset accuracy (target 2.0 mm)
 *     - C1 tangent continuity at smooth Bézier joins
 *     - Zero self-intersections on CUT and BLEED
 *  2. Blurred + noisy 12-lobe raster (3x3 box blur + edge jitter)
 *  3. Small-detail sharp-corner starburst (<= 75° tips)
 *  4. Real 13-fish sticker sheet (fish13_rgba.bin) in both standard & high modes
 *  5. Visual before/after overlay SVG (source / CUT / BLEED)
 *  6. SHA-256 integrity of all 16 remaining LOCKED engine files + controlled unlock audit of bleedContourEngine.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  decodePDFRawStream,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import {
  extractStickerContoursFromImage,
} from '../resources/js/engine/bleedContourEngine.js';
import {
  tessellateAndVerifyContourMm,
} from '../resources/js/engine/productionBleedSafetyH22.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'resources', 'js', 'engine');
const CUSTOMER_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607803864_b438afea.pdf';
const FISH_BIN = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/scratch/fish13_rgba.bin';
const FISH_META = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/scratch/fish13_meta.json';
const OVERLAY_SVG_PATH = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/phase_b_high_detail_overlay.svg';
const PT_TO_MM = 25.4 / 72;

// 16 STILL-LOCKED files (bleedContourEngine.js was explicitly unlocked for Phase B detailMode='high')
const LOCKED_16_BASELINES = {
  'pdfProductionValidator.js': 'a12f8b14e6b19ac5b7717973773f3ca50eaae08a67730fd513a65f2be4b5fdb4',
  'resourceStore.js': '7f9eb0963d08488711c07c8d87061dea2cc0055113ca45fc7bf612817c16f487',
  'v1Schema.js': '0081b8fea4273e85af3e8d48216deec47483e30626532098d8e5e82747904ccc',
  'assetAnalyzer.js': '41692079f84bf9d85f2cb372496c4bf766b5788f4475d5f04978d2a670645b93',
  'cutlineV1Adapter.js': '32f6e460d3e1892e5653b4e6be64e29f8b1b80cf272b8e7bfe40fe51236f9894',
  'productionGeometry.js': 'd33364618f3dad8e776afc1d2e51e688ef8665f29376033616e2c9b9a8c48846',
  'batchJobOrchestrator.js': '2399cf9ad6451759cac2db5b55917950c90a5ae342a3c2e8ce615cf787c80988',
  'batchImpositionAdapter.js': '8074d41cdeba5e370040536ce4c32fbf609df6ae4396844a560f3bdaaa709b0e',
  'cutVectorExporter.js': '7506c352a5dcf2a9c8b251b5bdfba56a7269c65bae18454414ba463a4702e0f1',
  'productionOutput.js': '0190ffbce6b683ba8b6db6431a1c01b272fad34623856cabcf339be07c079941',
  'openWithAdapter.js': 'c02b37ffe0234374de6a9cd332042ba9398db634066e1ef980cdeedff5fdb6e7',
  'productionPairValidator.js': '3ded1427b8d7003a714a60ff1eb29dff9f9907b47c30571aff9554c9a715230c',
  'finalProductionValidator.js': '21b1cf7c1e0784cac4c20a9fc19eee83ef9e57456ba7cc54ebb4039a33882e16',
  'impositionEngine.js': 'b457b8b01b711dd72fe25b14341298fd1aa2251ebedefc73985c1885f8f27f01',
  'pdfExporter.js': 'a77d15366d0fa35331046d01f9e1060e237a662d776cb75aff7d7a69f5ce1edd',
  'productionPlanningH1.js': '6e18440012c59908aad8967163d93db1ead2c8460012a8cb3493bb2709e30b27',
};
const BLEED_ENGINE_OLD_SHA = 'b62e30a8922b6f1d03195b0bb87d2bc03e5a79b26cbc8248fbd0d0f362e47338';

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makeMockCanvas(initW = 0, initH = 0, initData = null) {
  return {
    _w: initW,
    _h: initH,
    _data: initData || new Uint8ClampedArray(initW * initH * 4),
    get width() { return this._w; },
    set width(v) { this._w = Math.max(0, v | 0); this._data = new Uint8ClampedArray(this._w * this._h * 4); },
    get height() { return this._h; },
    set height(v) { this._h = Math.max(0, v | 0); this._data = new Uint8ClampedArray(this._w * this._h * 4); },
    getContext() {
      const self = this;
      let pathPts = [];
      let curPt = [0, 0];
      return {
        fillStyle: '#000000',
        clearRect() { self._data.fill(0); },
        beginPath() { pathPts = []; },
        moveTo(x, y) { curPt = [x, y]; pathPts.push([x, y]); },
        lineTo(x, y) { curPt = [x, y]; pathPts.push([x, y]); },
        bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey) {
          const [sx, sy] = curPt;
          const steps = 12;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const mt = 1 - t;
            const px = mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex;
            const py = mt * mt * mt * sy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey;
            pathPts.push([px, py]);
          }
          curPt = [ex, ey];
        },
        closePath() {},
        fill() {
          if (pathPts.length < 3) return;
          const w = self._w, h = self._h, data = self._data;
          for (let y = 0; y < h; y++) {
            const yc = y + 0.5;
            const xs = [];
            for (let i = 0, j = pathPts.length - 1; i < pathPts.length; j = i++) {
              const [x1, y1] = pathPts[j], [x2, y2] = pathPts[i];
              if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const x0 = Math.max(0, Math.floor(xs[k]));
              const x1 = Math.min(w - 1, Math.ceil(xs[k + 1]));
              for (let x = x0; x <= x1; x++) {
                const idx = (y * w + x) * 4;
                data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
              }
            }
          }
        },
        drawImage(src, dx, dy, dw, dh) {
          const sw = src.width, sh = src.height, sdata = src._data;
          for (let y = Math.max(0, Math.floor(dy)); y < Math.min(self._h, Math.ceil(dy + dh)); y++) {
            const sy = Math.min(sh - 1, Math.max(0, Math.floor(((y - dy) / dh) * sh)));
            for (let x = Math.max(0, Math.floor(dx)); x < Math.min(self._w, Math.ceil(dx + dw)); x++) {
              const sx = Math.min(sw - 1, Math.max(0, Math.floor(((x - dx) / dw) * sw)));
              const si = (sy * sw + sx) * 4;
              const di = (y * self._w + x) * 4;
              self._data[di] = sdata[si];
              self._data[di + 1] = sdata[si + 1];
              self._data[di + 2] = sdata[si + 2];
              self._data[di + 3] = sdata[si + 3];
            }
          }
        },
        getImageData(x, y, w, h) {
          return { data: self._data, width: w, height: h };
        },
      };
    },
  };
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeMockCanvas(0, 0) : {}) };

function rasterizePolygonRGBA(polyMm, wMm, hMm, pxPerMm, fgRgb = [242, 234, 211]) {
  const cw = Math.round(wMm * pxPerMm);
  const ch = Math.round(hMm * pxPerMm);
  const data = new Uint8ClampedArray(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < ch; y++) {
    const yMm = (y + 0.5) / pxPerMm;
    const xs = [];
    for (let i = 0, j = polyMm.length - 1; i < polyMm.length; j = i++) {
      const [x1, y1] = polyMm[j];
      const [x2, y2] = polyMm[i];
      if ((y1 > yMm) !== (y2 > yMm)) {
        xs.push(x1 + ((yMm - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] * pxPerMm - 0.5));
      const x1 = Math.min(cw - 1, Math.floor(xs[k + 1] * pxPerMm - 0.5));
      for (let x = x0; x <= x1; x++) {
        const idx = (y * cw + x) * 4;
        data[idx] = fgRgb[0]; data[idx + 1] = fgRgb[1]; data[idx + 2] = fgRgb[2]; data[idx + 3] = 255;
      }
    }
  }
  return { cw, ch, data };
}

function applyBoxBlurAndNoise(data, cw, ch, noiseAmp = 8) {
  const out = new Uint8ClampedArray(data.length);
  // deterministic pseudo-random generator
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(ch - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(cw - 1, Math.max(0, x + dx));
          const si = (yy * cw + xx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; cnt++;
        }
      }
      const di = (y * cw + x) * 4;
      const n = rand() * noiseAmp;
      out[di] = Math.max(0, Math.min(255, Math.round(r / cnt + n)));
      out[di + 1] = Math.max(0, Math.min(255, Math.round(g / cnt + n)));
      out[di + 2] = Math.max(0, Math.min(255, Math.round(b / cnt + n)));
      out[di + 3] = 255;
    }
  }
  return out;
}

function pointToPolyDistMm(px, py, poly) {
  let bestSq = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const dSq = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
    if (dSq < bestSq) bestSq = dSq;
  }
  return Math.sqrt(bestSq);
}

function measureCurveDeviationMm(polyA, polyB) {
  const oneWay = (src, dst) => {
    let maxD = 0, sumD = 0;
    for (const [px, py] of src) {
      const d = pointToPolyDistMm(px, py, dst);
      if (d > maxD) maxD = d;
      sumD += d;
    }
    return { maxD, meanD: sumD / Math.max(1, src.length) };
  };
  const a2b = oneWay(polyA, polyB);
  const b2a = oneWay(polyB, polyA);
  return {
    hausdorffMm: Math.max(a2b.maxD, b2a.maxD),
    meanMm: (a2b.meanD + b2a.meanD) * 0.5,
  };
}

function measure12SectorValleys(poly, cx, cy) {
  // Divide 360° into 12 sectors of 30° each and compute each sector's local peak & valley radius
  const sectors = Array.from({ length: 12 }, () => ({ rMin: Infinity, rMax: -Infinity }));
  for (const [x, y] of poly) {
    const ang = Math.atan2(y - cy, x - cx);
    const norm = ((ang + Math.PI * 2) % (Math.PI * 2));
    const sIdx = Math.min(11, Math.floor((norm / (Math.PI * 2)) * 12));
    const r = Math.hypot(x - cx, y - cy);
    if (r < sectors[sIdx].rMin) sectors[sIdx].rMin = r;
    if (r > sectors[sIdx].rMax) sectors[sIdx].rMax = r;
  }
  const depths = sectors.map((s) => s.rMax - s.rMin);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
  const globalRMin = Math.min(...sectors.map((s) => s.rMin));
  const globalRMax = Math.max(...sectors.map((s) => s.rMax));
  return { sectors, depths, minDepth, maxDepth, avgDepth, globalRMin, globalRMax, globalDepth: globalRMax - globalRMin };
}

function measureBleedNormalOffset(bleedPoly, cutPoly) {
  let minD = Infinity, maxD = -Infinity, sumD = 0;
  for (const [px, py] of bleedPoly) {
    const d = pointToPolyDistMm(px, py, cutPoly);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    sumD += d;
  }
  return { minMm: minD, avgMm: sumD / Math.max(1, bleedPoly.length), maxMm: maxD };
}

function measureMaxSmoothTangentJumpDeg(beziersMm) {
  const segs = beziersMm.filter((c) => c.type === 'C' || c.type === 'L');
  if (segs.length < 2) return 0;
  const mCmd = beziersMm.find((c) => c.type === 'M');
  let cur = mCmd ? mCmd.to : segs[segs.length - 1].to;
  const tangents = [];
  for (const s of segs) {
    const start = cur;
    const end = s.to;
    const tOut = s.type === 'C' ? [s.c1[0] - start[0], s.c1[1] - start[1]] : [end[0] - start[0], end[1] - start[1]];
    const tIn = s.type === 'C' ? [end[0] - s.c2[0], end[1] - s.c2[1]] : [end[0] - start[0], end[1] - start[1]];
    tangents.push({ tOut, tIn });
    cur = end;
  }
  let maxJump = 0;
  let kinksOver15 = 0;
  for (let i = 0; i < tangents.length; i++) {
    const prevIn = tangents[i].tIn;
    const nextOut = tangents[(i + 1) % tangents.length].tOut;
    const l1 = Math.hypot(prevIn[0], prevIn[1]);
    const l2 = Math.hypot(nextOut[0], nextOut[1]);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cos = Math.max(-1, Math.min(1, (prevIn[0] * nextOut[0] + prevIn[1] * nextOut[1]) / (l1 * l2)));
    const deg = (Math.acos(cos) * 180) / Math.PI;
    if (deg > maxJump) maxJump = deg;
    if (deg > 15) kinksOver15++;
  }
  return { maxJumpDeg: maxJump, kinksOver15 };
}

async function loadRealScallopedPolyMm() {
  const doc = await PDFDocument.load(fs.readFileSync(CUSTOMER_PDF));
  const page = doc.getPages()[0];
  const hPt = page.getMediaBox().height;
  const c = page.node.get(PDFName.of('Contents'));
  const dec = (ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString('latin1');
  const stream = c instanceof PDFArray ? [...Array(c.size()).keys()].map((i) => dec(c.get(i))).join('\n') : dec(c);
  let tx = 0, ty = 0, cmds = [], firstOuter = null;
  const toMm = (xPt, yPt) => [(xPt + tx) * PT_TO_MM, (hPt - (yPt + ty)) * PT_TO_MM];
  for (const raw of stream.split(/\r?\n/)) {
    const l = raw.trim();
    const cm = l.match(/1\s+0\s+0\s+1\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm$/);
    if (cm) { tx = parseFloat(cm[1]); ty = parseFloat(cm[2]); cmds = []; continue; }
    const m = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+m$/);
    if (m) { cmds.push({ type: 'M', to: toMm(parseFloat(m[1]), parseFloat(m[2])) }); continue; }
    const ln = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+l$/);
    if (ln) { cmds.push({ type: 'L', to: toMm(parseFloat(ln[1]), parseFloat(ln[2])) }); continue; }
    const cb = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
    if (cb) {
      cmds.push({
        type: 'C',
        c1: toMm(parseFloat(cb[1]), parseFloat(cb[2])),
        c2: toMm(parseFloat(cb[3]), parseFloat(cb[4])),
        to: toMm(parseFloat(cb[5]), parseFloat(cb[6])),
      });
      continue;
    }
    if ((l === 'f' || l === 'f*' || l === 'F') && cmds.length >= 50) {
      firstOuter = { beziersMm: cmds, closed: true };
      break;
    }
  }
  const refTess = tessellateAndVerifyContourMm(firstOuter, { flatnessMm: 0.002 });
  const cx = (refTess.bounds.minX + refTess.bounds.maxX) / 2;
  const cy = (refTess.bounds.minY + refTess.bounds.maxY) / 2;
  return { refPoly: refTess.poly, refCx: cx, refCy: cy };
}

function beziersToSvgPath(beziersMm, offsetX = 0, offsetY = 0, scale = 1) {
  const parts = [];
  for (const c of beziersMm) {
    if (c.type === 'M') {
      parts.push(`M ${(c.to[0] * scale + offsetX).toFixed(2)} ${(c.to[1] * scale + offsetY).toFixed(2)}`);
    } else if (c.type === 'L') {
      parts.push(`L ${(c.to[0] * scale + offsetX).toFixed(2)} ${(c.to[1] * scale + offsetY).toFixed(2)}`);
    } else if (c.type === 'C') {
      parts.push(
        `C ${(c.c1[0] * scale + offsetX).toFixed(2)} ${(c.c1[1] * scale + offsetY).toFixed(2)}, ` +
        `${(c.c2[0] * scale + offsetX).toFixed(2)} ${(c.c2[1] * scale + offsetY).toFixed(2)}, ` +
        `${(c.to[0] * scale + offsetX).toFixed(2)} ${(c.to[1] * scale + offsetY).toFixed(2)}`
      );
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

function polyToSvgPath(poly, offsetX = 0, offsetY = 0, scale = 1) {
  return poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${(x * scale + offsetX).toFixed(2)} ${(y * scale + offsetY).toFixed(2)}`).join(' ') + ' Z';
}

test('PB-01: Giảm 3% 12-lobe raster (300 DPI) — High Detail preserves all 12 valleys, C1 smoothness, accurate BLEED, and generates overlay SVG', async () => {
  const { refPoly, refCx, refCy } = await loadRealScallopedPolyMm();
  const canvasWmm = 30, canvasHmm = 30;
  const pxPerMm = 300 / 25.4;
  const shiftX = canvasWmm / 2 - refCx;
  const shiftY = canvasHmm / 2 - refCy;
  const shiftedRef = refPoly.map(([x, y]) => [x + shiftX, y + shiftY]);
  const truthValleys = measure12SectorValleys(shiftedRef, canvasWmm / 2, canvasHmm / 2);

  const { cw, ch, data } = rasterizePolygonRGBA(shiftedRef, canvasWmm, canvasHmm, pxPerMm);
  const canvas = makeMockCanvas(cw, ch, data);

  const stdRes = extractStickerContoursFromImage(canvas, canvasWmm, canvasHmm, {
    shapeMode: 'auto',
    detailMode: 'standard',
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    smoothLevel: 1,
    simplifyMm: 0.12,
    mergeGapMm: 0,
    ignoreCornerMarks: false,
  });

  const highRes = extractStickerContoursFromImage(canvas, canvasWmm, canvasHmm, {
    shapeMode: 'auto',
    detailMode: 'high',
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    smoothLevel: 1,
    simplifyMm: 0.08,
    mergeGapMm: 0,
    ignoreCornerMarks: false,
  });

  assert.equal(stdRes.length, 1);
  assert.equal(highRes.length, 1);

  const stdCutTess = tessellateAndVerifyContourMm({ beziersMm: stdRes[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const highCutTess = tessellateAndVerifyContourMm({ beziersMm: highRes[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const stdBleedTess = tessellateAndVerifyContourMm({ beziersMm: stdRes.bleedContoursMm[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const highBleedTess = tessellateAndVerifyContourMm({ beziersMm: highRes.bleedContoursMm[0].beziersMm, closed: true }, { flatnessMm: 0.002 });

  assert.equal(highCutTess.valid, true, `High Detail CUT must be valid/non-self-intersecting: ${highCutTess.reason || ''}`);
  assert.equal(highBleedTess.valid, true, `High Detail BLEED must be valid/non-self-intersecting: ${highBleedTess.reason || ''}`);

  const stdValleys = measure12SectorValleys(stdCutTess.poly, canvasWmm / 2, canvasHmm / 2);
  const highValleys = measure12SectorValleys(highCutTess.poly, canvasWmm / 2, canvasHmm / 2);
  const stdDev = measureCurveDeviationMm(stdCutTess.poly, shiftedRef);
  const highDev = measureCurveDeviationMm(highCutTess.poly, shiftedRef);
  const stdBleedErr = measureBleedNormalOffset(stdBleedTess.poly, stdCutTess.poly);
  const highBleedErr = measureBleedNormalOffset(highBleedTess.poly, highCutTess.poly);
  const highTangent = measureMaxSmoothTangentJumpDeg(highRes[0].beziersMm);
  const stdSegs = stdRes[0].beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length;
  const highSegs = highRes[0].beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length;
  const highBleedSegs = highRes.bleedContoursMm[0].beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length;
  const highOutwardBulgeMm = Math.max(0, highValleys.globalRMax - truthValleys.globalRMax);

  console.log('\n[PB-01 Giảm 3% 12-Lobe Raster 300 DPI]');
  console.log(`  Ground Truth: avgValley=${truthValleys.avgDepth.toFixed(4)}mm (min=${truthValleys.minDepth.toFixed(4)}, max=${truthValleys.maxDepth.toFixed(4)})`);
  console.log(`  Standard    : avgValley=${stdValleys.avgDepth.toFixed(4)}mm (min=${stdValleys.minDepth.toFixed(4)}), Hausdorff=${stdDev.hausdorffMm.toFixed(4)}mm, mean=${stdDev.meanMm.toFixed(4)}mm, segs=${stdSegs}`);
  console.log(`  High Detail : avgValley=${highValleys.avgDepth.toFixed(4)}mm (min=${highValleys.minDepth.toFixed(4)}), Hausdorff=${highDev.hausdorffMm.toFixed(4)}mm, mean=${highDev.meanMm.toFixed(4)}mm, segs=${highSegs}, bleedSegs=${highBleedSegs}`);
  console.log(`  High Detail : outwardBulge=${highOutwardBulgeMm.toFixed(4)}mm, maxTangentJump=${highTangent.maxJumpDeg.toFixed(2)}° (kinks>15°: ${highTangent.kinksOver15})`);
  console.log(`  High BLEED  : normalOffset min=${highBleedErr.minMm.toFixed(4)}mm, avg=${highBleedErr.avgMm.toFixed(4)}mm, max=${highBleedErr.maxMm.toFixed(4)}mm (target 2.0000mm)`);
  console.log(`  High 12 Valleys (mm): [${highValleys.depths.map((d) => d.toFixed(3)).join(', ')}]`);

  // Assertions: High Detail MUST preserve valleys dramatically better than Standard and match ground truth tightly
  assert.ok(highValleys.avgDepth >= truthValleys.avgDepth * 0.88, `Avg valley depth too shallow: ${highValleys.avgDepth}`);
  assert.ok(highValleys.minDepth >= truthValleys.minDepth * 0.80, `Min valley depth too shallow: ${highValleys.minDepth}`);
  assert.ok(highValleys.avgDepth > stdValleys.avgDepth + 0.10, `High Detail should significantly beat Standard valley depth`);
  assert.ok(highDev.hausdorffMm <= 0.25, `High Detail Hausdorff deviation too large: ${highDev.hausdorffMm}`);
  assert.ok(highDev.hausdorffMm < stdDev.hausdorffMm, `High Detail Hausdorff (${highDev.hausdorffMm}) should beat Standard (${stdDev.hausdorffMm})`);
  assert.ok(highDev.meanMm < stdDev.meanMm * 0.5, `High Detail mean deviation (${highDev.meanMm}) should be < 50% of Standard (${stdDev.meanMm})`);
  assert.ok(highOutwardBulgeMm <= 0.20, `Abnormal outward bulge detected: ${highOutwardBulgeMm}`);
  assert.ok(highBleedErr.avgMm >= 1.85 && highBleedErr.avgMm <= 2.15, `BLEED normal avg offset out of tolerance: ${highBleedErr.avgMm}`);
  assert.equal(highTangent.kinksOver15, 0, `Smooth scalloped contour should have 0 tangent kinks > 15°, got ${highTangent.kinksOver15}`);

  // Generate side-by-side overlay SVG (Source / CUT / BLEED)
  const scale = 14;
  const svgW = 920, svgH = 500;
  const leftOffX = 20, leftOffY = 45;
  const rightOffX = 480, rightOffY = 45;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="${svgW}" height="${svgH}" fill="#f8fafc"/>
  <text x="20" y="28" font-family="Segoe UI, Arial" font-size="16" font-weight="bold" fill="#0f172a">Phase B — High Detail Freeform Overlay (Giảm 3% 12-Lobe Raster @ 300 DPI)</text>

  <!-- Left panel: Standard -->
  <rect x="20" y="45" width="420" height="420" rx="10" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="35" y="70" font-family="Segoe UI, Arial" font-size="13" font-weight="bold" fill="#b91c1c">BEFORE — Standard (Default)</text>
  <text x="35" y="88" font-family="Consolas, monospace" font-size="11" fill="#475569">avgValley=${stdValleys.avgDepth.toFixed(3)}mm | Hausdorff=${stdDev.hausdorffMm.toFixed(3)}mm | segs=${stdSegs}</text>
  <path d="${polyToSvgPath(shiftedRef, leftOffX, leftOffY, scale)}" fill="#f2ead3" stroke="#94a3b8" stroke-width="1"/>
  <path d="${beziersToSvgPath(stdRes.bleedContoursMm[0].beziersMm, leftOffX, leftOffY, scale)}" fill="none" stroke="#0284c7" stroke-width="1.5" stroke-dasharray="5,4"/>
  <path d="${beziersToSvgPath(stdRes[0].beziersMm, leftOffX, leftOffY, scale)}" fill="none" stroke="#db2777" stroke-width="2.2"/>

  <!-- Right panel: High Detail -->
  <rect x="480" y="45" width="420" height="420" rx="10" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="495" y="70" font-family="Segoe UI, Arial" font-size="13" font-weight="bold" fill="#047857">AFTER — High Detail Freeform</text>
  <text x="495" y="88" font-family="Consolas, monospace" font-size="11" fill="#475569">avgValley=${highValleys.avgDepth.toFixed(3)}mm | Hausdorff=${highDev.hausdorffMm.toFixed(3)}mm | segs=${highSegs}</text>
  <path d="${polyToSvgPath(shiftedRef, rightOffX, rightOffY, scale)}" fill="#f2ead3" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="2,2"/>
  <path d="${beziersToSvgPath(highRes.bleedContoursMm[0].beziersMm, rightOffX, rightOffY, scale)}" fill="none" stroke="#0284c7" stroke-width="1.5" stroke-dasharray="5,4"/>
  <path d="${beziersToSvgPath(highRes[0].beziersMm, rightOffX, rightOffY, scale)}" fill="none" stroke="#db2777" stroke-width="2.2"/>

  <!-- Legend -->
  <rect x="20" y="473" width="14" height="14" fill="#f2ead3" stroke="#16a34a" stroke-dasharray="2,2"/>
  <text x="40" y="484" font-family="Segoe UI, Arial" font-size="11" fill="#334155">Source Silhouette (Cream Ground Truth)</text>
  <line x1="275" y1="480" x2="305" y2="480" stroke="#db2777" stroke-width="2.5"/>
  <text x="312" y="484" font-family="Segoe UI, Arial" font-size="11" fill="#334155">CUT Contour (0 mm)</text>
  <line x1="445" y1="480" x2="475" y2="480" stroke="#0284c7" stroke-width="2" stroke-dasharray="5,4"/>
  <text x="482" y="484" font-family="Segoe UI, Arial" font-size="11" fill="#334155">BLEED Contour (+2.0 mm, avg=${highBleedErr.avgMm.toFixed(3)}mm)</text>
</svg>`;
  fs.writeFileSync(OVERLAY_SVG_PATH, svg, 'utf8');
  assert.ok(fs.existsSync(OVERLAY_SVG_PATH));
});

test('PB-02: Blurred + noisy 12-lobe raster — High Detail stays smooth, preserves valleys, 0 self-intersections', async () => {
  const { refPoly, refCx, refCy } = await loadRealScallopedPolyMm();
  const canvasWmm = 30, canvasHmm = 30;
  const pxPerMm = 300 / 25.4;
  const shiftedRef = refPoly.map(([x, y]) => [x + (canvasWmm / 2 - refCx), y + (canvasHmm / 2 - refCy)]);
  const truthValleys = measure12SectorValleys(shiftedRef, canvasWmm / 2, canvasHmm / 2);

  const { cw, ch, data } = rasterizePolygonRGBA(shiftedRef, canvasWmm, canvasHmm, pxPerMm);
  const noisy = applyBoxBlurAndNoise(data, cw, ch, 10);
  const canvas = makeMockCanvas(cw, ch, noisy);

  const highRes = extractStickerContoursFromImage(canvas, canvasWmm, canvasHmm, {
    shapeMode: 'auto',
    detailMode: 'high',
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    smoothLevel: 2,
    simplifyMm: 0.08,
    mergeGapMm: 0,
    ignoreCornerMarks: false,
  });

  assert.equal(highRes.length, 1);
  const cutTess = tessellateAndVerifyContourMm({ beziersMm: highRes[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const bleedTess = tessellateAndVerifyContourMm({ beziersMm: highRes.bleedContoursMm[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const valleys = measure12SectorValleys(cutTess.poly, canvasWmm / 2, canvasHmm / 2);
  const dev = measureCurveDeviationMm(cutTess.poly, shiftedRef);

  console.log(`\n[PB-02 Blurred+Noisy 12-Lobe] avgValley=${valleys.avgDepth.toFixed(4)}mm, Hausdorff=${dev.hausdorffMm.toFixed(4)}mm, valid=${cutTess.valid}/${bleedTess.valid}`);
  assert.equal(cutTess.valid, true, cutTess.reason || 'CUT invalid');
  assert.equal(bleedTess.valid, true, bleedTess.reason || 'BLEED invalid');
  assert.ok(valleys.avgDepth >= truthValleys.avgDepth * 0.80, `Noisy avg valley too shallow: ${valleys.avgDepth}`);
  assert.ok(dev.hausdorffMm <= 0.30, `Noisy Hausdorff too high: ${dev.hausdorffMm}`);
});

test('PB-03: Small-detail 12-point sharp starburst — High Detail preserves sharp tips, 0 self-intersections', () => {
  const canvasWmm = 30, canvasHmm = 30;
  const pxPerMm = 300 / 25.4;
  const cx = 15, cy = 15, rOuter = 10.0, rInner = 7.2;
  const starPoly = [];
  for (let i = 0; i < 24; i++) {
    const ang = (i * Math.PI) / 12;
    const r = i % 2 === 0 ? rOuter : rInner;
    starPoly.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }

  const { cw, ch, data } = rasterizePolygonRGBA(starPoly, canvasWmm, canvasHmm, pxPerMm, [220, 90, 60]);
  const canvas = makeMockCanvas(cw, ch, data);

  const stdRes = extractStickerContoursFromImage(canvas, canvasWmm, canvasHmm, {
    shapeMode: 'auto', detailMode: 'standard', offsetMm: 0, bleedOffsetMm: 1.5, smoothLevel: 1, simplifyMm: 0.12, mergeGapMm: 0, ignoreCornerMarks: false,
  });
  const highRes = extractStickerContoursFromImage(canvas, canvasWmm, canvasHmm, {
    shapeMode: 'auto', detailMode: 'high', offsetMm: 0, bleedOffsetMm: 1.5, smoothLevel: 1, simplifyMm: 0.08, mergeGapMm: 0, ignoreCornerMarks: false,
  });

  const stdTess = tessellateAndVerifyContourMm({ beziersMm: stdRes[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const highTess = tessellateAndVerifyContourMm({ beziersMm: highRes[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const highBleedTess = tessellateAndVerifyContourMm({ beziersMm: highRes.bleedContoursMm[0].beziersMm, closed: true }, { flatnessMm: 0.002 });
  const stdDev = measureCurveDeviationMm(stdTess.poly, starPoly);
  const highDev = measureCurveDeviationMm(highTess.poly, starPoly);

  console.log(`\n[PB-03 Small-Detail 12-Point Starburst] stdHausdorff=${stdDev.hausdorffMm.toFixed(4)}mm -> highHausdorff=${highDev.hausdorffMm.toFixed(4)}mm, valid=${highTess.valid}/${highBleedTess.valid}`);
  assert.equal(highTess.valid, true, highTess.reason || 'CUT invalid');
  assert.equal(highBleedTess.valid, true, highBleedTess.reason || 'BLEED invalid');
  assert.ok(highDev.hausdorffMm < stdDev.hausdorffMm, 'High Detail must track sharp starburst better than Standard');
  assert.ok(highDev.hausdorffMm <= 0.35, `Starburst Hausdorff too large: ${highDev.hausdorffMm}`);
});

test('PB-04: Real 13-fish sticker sheet (fish13_rgba.bin) — Standard regression & High Detail 13/13 valid, 0 self-intersections', () => {
  assert.ok(fs.existsSync(FISH_BIN) && fs.existsSync(FISH_META), 'fish13 fixture missing');
  const meta = JSON.parse(fs.readFileSync(FISH_META, 'utf8'));
  const raw = fs.readFileSync(FISH_BIN);
  const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
  const canvas = makeMockCanvas(meta.width, meta.height, rgba);
  const sheetWmm = meta.widthMm || 330;
  const sheetHmm = meta.heightMm || 390;

  const stdRes = extractStickerContoursFromImage(canvas, sheetWmm, sheetHmm, {
    shapeMode: 'auto', detailMode: 'standard', offsetMm: 0.5, bleedOffsetMm: 1.5, smoothLevel: 1, simplifyMm: 0.18, mergeGapMm: 0.35, minAreaMm2: 80,
  });
  const highRes = extractStickerContoursFromImage(canvas, sheetWmm, sheetHmm, {
    shapeMode: 'auto', detailMode: 'high', offsetMm: 0.5, bleedOffsetMm: 1.5, smoothLevel: 1, simplifyMm: 0.08, mergeGapMm: 0.35, minAreaMm2: 80,
  });

  assert.equal(stdRes.length, 13, `Standard fish13 expected 13 stickers, got ${stdRes.length}`);
  assert.equal(highRes.length, 13, `High Detail fish13 expected 13 stickers, got ${highRes.length}`);

  let highInvalid = 0;
  for (let i = 0; i < highRes.length; i++) {
    const ct = tessellateAndVerifyContourMm({ beziersMm: highRes[i].beziersMm, closed: true }, { flatnessMm: 0.01 });
    const bt = tessellateAndVerifyContourMm({ beziersMm: highRes.bleedContoursMm[i].beziersMm, closed: true }, { flatnessMm: 0.01 });
    if (!ct.valid || !bt.valid) highInvalid++;
  }
  console.log(`\n[PB-04 Real 13-Fish Sheet] standard=${stdRes.length}/13, high=${highRes.length}/13, highInvalid=${highInvalid}`);
  assert.equal(highInvalid, 0, `Fish13 High Detail had ${highInvalid} invalid/self-intersecting contours`);
});

test('PB-05: SHA-256 Lock Audit — 16 still-locked files 100% unchanged + bleedContourEngine.js controlled unlock recorded', () => {
  for (const [file, expected] of Object.entries(LOCKED_16_BASELINES)) {
    const actual = sha256File(path.join(ENGINE_DIR, file));
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
  }
  const newBleedSha = sha256File(path.join(ENGINE_DIR, 'bleedContourEngine.js'));
  assert.notEqual(newBleedSha, BLEED_ENGINE_OLD_SHA, 'bleedContourEngine.js expected to reflect Phase B high-detail patch');
  console.log(`\n[PB-05 SHA-256 Audit] 16/16 STILL-LOCKED files: UNCHANGED`);
  console.log(`  bleedContourEngine.js (controlled unlock):`);
  console.log(`    OLD: ${BLEED_ENGINE_OLD_SHA}`);
  console.log(`    NEW: ${newBleedSha}`);
});
