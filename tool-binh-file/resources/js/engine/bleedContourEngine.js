import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  decodePDFRawStream,
  cmyk,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  setLineWidth,
  setLineJoin,
  setLineCap,
  LineCapStyle,
  LineJoinStyle,
  setStrokingColor,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';

export const TARGET_PRINT_DPI = 300;
export const PX_PER_MM_300DPI = TARGET_PRINT_DPI / 25.4; // ~11.8110236 px/mm

// Cutline Engine 3.1.1 — Default resource budget for Precision Offset (verified after Math.ceil)
export const PRECISION_BLEED_BUDGET = {
  maxScalePxPerMm: 12,
  maxPixelsPerSticker: 1_000_000,
  maxCanvasEdgePx: 2048,
  maxTotalPixelsPerRun: 16_000_000,
  maxOffsetMm: 200,
  minStickerSizeMm: 0.5,
  maxStickerSizeMm: 5000,
  defaultOffsetToleranceUnderMm: 0.15,
  defaultOffsetToleranceOverMm: 0.15,
  defaultMaxLocalOverRatio: 0.2, // <=20% total perimeter excess is localized (corner/concave -> WARNING)
  defaultMaxLocalOverRunPercent: 15, // <=15% single continuous over-run is localized (corner/concave -> WARNING)
};

// Smart Grouping 3.0: classify satellites independently of noise threshold.
// Decisions use original component sizes; no cascading growth or chain merges.
function groupStickerComponents(raw, cw, ch, pxPerMm, padPx, minAreaPx, options) {
  const report = { merged: 0, discarded: 0, ambiguous: 0, mergedAboveNoise: 0, decisions: [] };
  const bounded = (v, fallback, lo, hi) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : fallback;
  const gapMm = bounded(options.smartGapMm ?? 3, 3, 0, 5);
  const gap = gapMm * pxPerMm;
  const maxArea = bounded(options.smartSatelliteAreaMm2 ?? 35, 35, 0, 100) * pxPerMm ** 2;
  const ratio = bounded(options.smartAreaRatio ?? 3, 3, 2, 20);
  const labels = new Int32Array(cw * ch);
  raw.forEach((c,i) => { c.groupId=i+1; c.originalArea=c.pixels.length; for(const p of c.pixels) labels[p]=i+1; });
  const plans = new Map();
  const record = (c, status, extra={}) => report.decisions.push({id:c.groupId, areaMm2:c.originalArea/pxPerMm**2, status, ...extra});
  for(const c of raw) {
    if(c.originalArea > maxArea && c.originalArea >= minAreaPx) continue;
    const possible = raw.filter(m => m !== c && m.originalArea >= minAreaPx &&
      m.originalArea >= c.originalArea * (c.originalArea < minAreaPx ? Math.max(4,ratio) : ratio) &&
      Math.hypot(Math.max(0,m.minPX-c.maxPX,c.minPX-m.maxPX),Math.max(0,m.minPY-c.maxPY,c.minPY-m.maxPY)) <= gap);
    if(!possible.length) continue;
    const ids = new Set(possible.map(m=>m.groupId));
    const hits = new Map();
    const r=Math.ceil(gap);
    for(const p of c.pixels) {
      const x=p%cw,y=Math.floor(p/cw);
      if(x>0 && x<cw-1 && y>0 && y<ch-1 && labels[p-1]===c.groupId && labels[p+1]===c.groupId && labels[p-cw]===c.groupId && labels[p+cw]===c.groupId) continue;
      for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++) {
        const d=dx*dx+dy*dy, nx=x+dx,ny=y+dy;
        if(d>gap*gap || nx<0 || nx>=cw || ny<0 || ny>=ch) continue;
        const q=ny*cw+nx,id=labels[q];
        if(!ids.has(id)) continue;
        if(!hits.has(id)||d<hits.get(id).d) hits.set(id,{id,d,p,q});
      }
    }
    const ranked=[...hits.values()].sort((a,b)=>a.d-b.d||a.id-b.id);
    if(!ranked.length) continue;
    const hit=ranked[0];
    if(ranked.length>1 && Math.sqrt(ranked[1].d)-Math.sqrt(hit.d)<0.6*pxPerMm) {
      report.ambiguous++; record(c,'ambiguous'); continue;
    }
    plans.set(c.groupId,hit);
  }
  const removed=new Set();
  for(const c of [...raw].sort((a,b)=>b.originalArea-a.originalArea||a.groupId-b.groupId)) {
    const hit=plans.get(c.groupId); if(!hit) continue;
    // Do not attach through another proposed satellite.
    if(plans.has(hit.id) || removed.has(hit.id)) {report.ambiguous++;record(c,'chain-blocked');continue;}
    const m=raw[hit.id-1];
    const x=hit.p%cw,y=Math.floor(hit.p/cw),X=hit.q%cw,Y=Math.floor(hit.q/cw);
    const steps=Math.max(1,Math.ceil(Math.hypot(X-x,Y-y)*2));
    const bridge=new Set(); let blocked=false;
    for(let k=0;k<=steps;k++) {
      const a=Math.round(x+(X-x)*k/steps),b=Math.round(y+(Y-y)*k/steps);
      for(const [dx,dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx=a+dx,ny=b+dy;if(nx<0||nx>=cw||ny<0||ny>=ch)continue;
        const t=ny*cw+nx;
        if(labels[t] && labels[t]!==m.groupId && labels[t]!==c.groupId) blocked=true;
        bridge.add(t);
      }
    }
    if(blocked){report.ambiguous++;record(c,'blocked');continue;}
    const merged=new Set(m.pixels);
    for(const t of [...c.pixels,...bridge]) {
      merged.add(t);labels[t]=m.groupId;
      const a=t%cw,b=Math.floor(t/cw);
      m.minPX=Math.min(m.minPX,a);m.maxPX=Math.max(m.maxPX,a);m.minPY=Math.min(m.minPY,b);m.maxPY=Math.max(m.maxPY,b);
    }
    m.pixels=[...merged];
    m.rawWmm=(m.maxPX-m.minPX+1)/pxPerMm;m.rawHmm=(m.maxPY-m.minPY+1)/pxPerMm;
    m.rawMinXmm=(m.minPX-padPx)/pxPerMm;m.rawMaxXmm=(m.maxPX-padPx)/pxPerMm;
    m.rawMinYmm=(m.minPY-padPx)/pxPerMm;m.rawMaxYmm=(m.maxPY-padPx)/pxPerMm;
    m.fillRatio=m.pixels.length/((m.maxPX-m.minPX+1)*(m.maxPY-m.minPY+1));
    removed.add(c.groupId);report.merged++;
    if(c.originalArea>=minAreaPx)report.mergedAboveNoise++;
    record(c,'merged',{targetId:m.groupId,gapMm:Math.sqrt(hit.d)/pxPerMm});
  }
  const kept=raw.filter(c=>{
    if(removed.has(c.groupId))return false;
    if(c.originalArea>=minAreaPx)return true;
    report.discarded++;record(c,'discarded');return false;
  });
  return {kept,report};
}

function mulMatPdf(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * Inspect a PDF page's content stream & XObject dictionary (including nested Form XObjects and full CTM stack)
 * to extract exact mm bounding boxes and SMask flags of all embedded /Image XObjects from ANY PDF generator
 * (Illustrator, CorelDRAW, Canva, InDesign, Photoshop, Affinity).
 */
export async function extractPdfImagePlacementsMm(pdfBytes, pageNum = 1) {
  try {
    const doc = await PDFDocument.load(pdfBytes);
    const pages = doc.getPages();
    const pg = pages[Math.max(0, Math.min(pages.length - 1, (pageNum || 1) - 1))];
    if (!pg) return [];

    const mediaBox = pg.getMediaBox();
    const pageH = mediaBox.height;
    const pageW = mediaBox.width;
    const PT_TO_MM = 25.4 / 72;
    const placements = [];

    const getStreamBytes = (obj) => {
      if (!obj) return new Uint8Array(0);
      const resolved = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
      if (!resolved) return new Uint8Array(0);
      if (resolved instanceof PDFArray) {
        const chunks = [];
        let total = 0;
        for (let i = 0; i < resolved.size(); i++) {
          const b = getStreamBytes(resolved.get(i));
          chunks.push(b);
          total += b.length + 1;
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
          merged[off++] = 32;
        }
        return merged;
      }
      try {
        return decodePDFRawStream(resolved).decode();
      } catch {
        return new Uint8Array(0);
      }
    };

    const parseStream = (streamObj, resources, initialCtm, depth = 0) => {
      if (depth > 6 || !streamObj) return;
      const bytes = getStreamBytes(streamObj);
      if (!bytes || bytes.length === 0) return;

      const xoDict = resources instanceof PDFDict ? resources.lookupMaybe(PDFName.of('XObject'), PDFDict) : null;
      const str = new TextDecoder('latin1').decode(bytes);
      const tokenRe = /\/([A-Za-z0-9_.-]+)|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([a-zA-Z*']+)/g;
      const stack = [];
      let ctm = [...initialCtm];
      const args = [];
      let m;

      while ((m = tokenRe.exec(str)) !== null) {
        if (m[1] !== undefined) {
          args.push({ type: 'name', val: m[1] });
        } else if (m[2] !== undefined) {
          args.push({ type: 'num', val: Number(m[2]) });
        } else if (m[3] !== undefined) {
          const op = m[3];
          if (op === 'q') {
            stack.push([...ctm]);
          } else if (op === 'Q') {
            if (stack.length > 0) ctm = stack.pop();
          } else if (op === 'cm') {
            const nums = args.filter((a) => a.type === 'num').map((a) => a.val);
            if (nums.length >= 6) {
              ctm = mulMatPdf(nums.slice(-6), ctm);
            }
          } else if (op === 'Do' && xoDict) {
            const last = args[args.length - 1];
            if (last && last.type === 'name') {
              const ref = xoDict.get(PDFName.of(last.val));
              const xo = ref ? doc.context.lookup(ref) : null;
              const subType = xo?.dict?.lookup(PDFName.of('Subtype'));
              const subName = subType instanceof PDFName ? subType.decodeText() : '';

              if (subName === 'Image') {
                const hasSMask = Boolean(xo.dict.lookup(PDFName.of('SMask')) || xo.dict.lookup(PDFName.of('Mask')));
                const [A, B, C, D, E, F] = ctm;
                const cornersMm = [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                ].map(([u, v]) => [
                  (A * u + C * v + E - mediaBox.x) * PT_TO_MM,
                  (mediaBox.y + pageH - (B * u + D * v + F)) * PT_TO_MM,
                ]);
                const xs = cornersMm.map((p) => p[0]);
                const ys = cornersMm.map((p) => p[1]);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);
                const w = maxX - minX;
                const h = maxY - minY;
                // Ignore full-page background image XObjects covering >= 96% of page
                if (w < pageW * PT_TO_MM * 0.96 || h < pageH * PT_TO_MM * 0.96) {
                  const isAxisAligned = Math.abs(B) < 0.5 && Math.abs(C) < 0.5;
                  placements.push({
                    name: last.val,
                    hasSMask,
                    isAxisAligned,
                    minX,
                    maxX,
                    minY,
                    maxY,
                    w,
                    h,
                    cornersMm,
                  });
                }
              } else if (subName === 'Form') {
                let formCtm = [...ctm];
                const matArr = xo.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
                if (matArr && matArr.size() >= 6) {
                  const fm = [];
                  for (let i = 0; i < 6; i++) fm.push(matArr.get(i).asNumber());
                  formCtm = mulMatPdf(fm, ctm);
                }
                const formRes = xo.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || resources;
                parseStream(xo, formRes, formCtm, depth + 1);
              }
            }
          }
          args.length = 0;
        }
      }
    };

    const contents = pg.node.get(PDFName.of('Contents'));
    const resources = pg.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    parseStream(contents, resources, [1, 0, 0, 1, 0, 0], 0);
    return placements;
  } catch {
    return [];
  }
}

/**
 * 2-Pass Squared Euclidean Distance Transform (Meijster / Felzenszwalb-Huttenlocher 1D->2D)
 * Exact O(W * H) Euclidean distance in pixels from foreground mask.
 */
function computeDistanceField(binaryMask, w, h) {
  const INF = 1e9;
  const g = new Float32Array(w * h);

  for (let x = 0; x < w; x++) {
    g[x] = binaryMask[x] ? 0 : INF;
    for (let y = 1; y < h; y++) {
      const idx = y * w + x;
      g[idx] = binaryMask[idx] ? 0 : g[(y - 1) * w + x] + 1;
    }
    for (let y = h - 2; y >= 0; y--) {
      const idx = y * w + x;
      const down = g[(y + 1) * w + x] + 1;
      if (down < g[idx]) g[idx] = down;
    }
  }

  const dist = new Float32Array(w * h);
  const v = new Int32Array(w);
  const z = new Float32Array(w + 1);

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for (let q = 1; q < w; q++) {
      const gq = g[rowOff + q];
      const gq2 = gq >= INF ? INF : gq * gq;
      let s = 0;
      while (true) {
        const r = v[k];
        const gr = g[rowOff + r];
        const gr2 = gr >= INF ? INF : gr * gr;
        s = (gq2 + q * q - (gr2 + r * r)) / (2 * q - 2 * r);
        if (s > z[k] || k === 0) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < w; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      const gr = g[rowOff + r];
      const d2 = (q - r) * (q - r) + (gr >= INF ? INF : gr * gr);
      dist[rowOff + q] = Math.sqrt(d2);
    }
  }

  return dist;
}

/**
 * Fill all interior holes inside foreground objects by flood-filling exterior background from (0,0).
 * Ensures 1 sticker = 1 solid outer boundary without internal holes or MORPH_CLOSE bridging concave slots.
 */
function fillInteriorHoles(mask, w, h) {
  const extBg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;

  // Seed border pixels that are background
  for (let x = 0; x < w; x++) {
    if (!mask[x]) {
      extBg[x] = 1;
      stack[top++] = x;
    }
    const bIdx = (h - 1) * w + x;
    if (!mask[bIdx] && !extBg[bIdx]) {
      extBg[bIdx] = 1;
      stack[top++] = bIdx;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    const lIdx = y * w;
    if (!mask[lIdx] && !extBg[lIdx]) {
      extBg[lIdx] = 1;
      stack[top++] = lIdx;
    }
    const rIdx = y * w + (w - 1);
    if (!mask[rIdx] && !extBg[rIdx]) {
      extBg[rIdx] = 1;
      stack[top++] = rIdx;
    }
  }

  while (top > 0) {
    const cur = stack[--top];
    const cx = cur % w;
    const cy = (cur / w) | 0;

    if (cx > 0) {
      const n = cur - 1;
      if (!mask[n] && !extBg[n]) {
        extBg[n] = 1;
        stack[top++] = n;
      }
    }
    if (cx < w - 1) {
      const n = cur + 1;
      if (!mask[n] && !extBg[n]) {
        extBg[n] = 1;
        stack[top++] = n;
      }
    }
    if (cy > 0) {
      const n = cur - w;
      if (!mask[n] && !extBg[n]) {
        extBg[n] = 1;
        stack[top++] = n;
      }
    }
    if (cy < h - 1) {
      const n = cur + w;
      if (!mask[n] && !extBg[n]) {
        extBg[n] = 1;
        stack[top++] = n;
      }
    }
  }

  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    solid[i] = extBg[i] ? 0 : 1;
  }
  return solid;
}

/**
 * Ramer-Douglas-Peucker open polyline simplification
 */
function rdpSimplifyOpen(points, eps) {
  if (points.length < 3) return points;
  let maxD = 0;
  let idx = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    let d = 0;
    if (lenSq === 0) {
      d = Math.hypot(px - x1, py - y1);
    } else {
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }

  if (maxD > eps) {
    const left = rdpSimplifyOpen(points.slice(0, idx + 1), eps);
    const right = rdpSimplifyOpen(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

/**
 * Closed-loop RDP simplification that splits at the two farthest antipodal vertices
 * so start/end seam artifacts never happen.
 */
function rdpSimplifyClosed(pts, eps) {
  if (!pts || pts.length <= 4) return pts || [];
  let maxDistSq = -1;
  let splitIdx = Math.floor(pts.length / 2);
  const [x0, y0] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d2 = (pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2;
    if (d2 > maxDistSq) {
      maxDistSq = d2;
      splitIdx = i;
    }
  }
  const half1 = rdpSimplifyOpen(pts.slice(0, splitIdx + 1), eps);
  const half2 = rdpSimplifyOpen([...pts.slice(splitIdx), pts[0]], eps);
  return half1.slice(0, -1).concat(half2.slice(0, -1));
}

/**
 * Compute interior angle in degrees (0..180) at vertex curr between prev and next.
 * 180 deg = straight line; < 130 deg = sharp corner / fin tip.
 */
function computeVertexAngleDeg(prev, curr, next) {
  const ux = prev[0] - curr[0];
  const uy = prev[1] - curr[1];
  const vx = next[0] - curr[0];
  const vy = next[1] - curr[1];
  const lenU = Math.hypot(ux, uy);
  const lenV = Math.hypot(vx, vy);
  if (lenU < 1e-6 || lenV < 1e-6) return 180;
  const cosA = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lenU * lenV)));
  return (Math.acos(cosA) * 180) / Math.PI;
}

/**
 * Dense 1px closed-loop Gaussian pre-fairing to convert integer pixel staircases
 * into sub-pixel smooth curves BEFORE RDP anchor selection.
 */
function smoothDenseLoopSubpixel(pts, passes = 3) {
  if (!pts || pts.length < 6) return pts || [];
  let cur = pts.map(([x, y]) => [x, y]);
  const n = cur.length;
  for (let p = 0; p < passes; p++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      const p2 = cur[(i - 2 + n) % n];
      const p1 = cur[(i - 1 + n) % n];
      const p0 = cur[i];
      const n1 = cur[(i + 1) % n];
      const n2 = cur[(i + 2) % n];
      next[i] = [
        p2[0] * 0.1 + p1[0] * 0.225 + p0[0] * 0.35 + n1[0] * 0.225 + n2[0] * 0.1,
        p2[1] * 0.1 + p1[1] * 0.225 + p0[1] * 0.35 + n1[1] * 0.225 + n2[1] * 0.1,
      ];
    }
    cur = next;
  }
  return cur;
}

/**
 * STEP 2: Corner-Preserving Vector Cleaning & Monotone C1 Cubic Bézier Fitting
 * - Pre-fairs integer pixel staircase into sub-pixel smooth curve
 * - Removes short micro-segments (< 0.45mm) so short-long chord transitions never kink or hook
 * - Only pins TRUE sharp tips (angle <= effectiveCornerDeg with long arms), keeping concave transitions 100% C1 smooth
 * - Clamps Bézier control handles monotonically along each chord so spikes/hooks can never occur
 */
function taubinSmoothDenseLoop(pts, passes = 2, lambda = 0.33, mu = -0.33) {
  let cur = pts.map(([x, y]) => [x, y]);
  const n = cur.length;
  if (n < 5) return cur;
  const step = (arr, w) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = arr[(i - 1 + n) % n];
      const c = arr[i];
      const q = arr[(i + 1) % n];
      const lx = (p[0] + q[0]) * 0.5 - c[0];
      const ly = (p[1] + q[1]) * 0.5 - c[1];
      out[i] = [c[0] + w * lx, c[1] + w * ly];
    }
    return out;
  };
  for (let pass = 0; pass < passes; pass++) {
    cur = step(cur, lambda);
    cur = step(cur, mu);
  }
  return cur;
}

export function fitCornerPreservingBezier(rawPtsMm, options = {}) {
  const {
    simplifyTolMm = 0.22,
    cornerAngleDeg = 130,
    smoothPasses = 2,
    tension = 0.3,
    skipDensePreFair = false,
    preserveOffset = false, // BLEED-only mode: avoids inward Laplacian/Gaussian shrinkage without affecting CUT
    detailMode = 'standard', // 'standard' (default, unchanged) | 'high' (opt-in High Detail Freeform)
  } = options;

  if (!rawPtsMm || rawPtsMm.length < 3) {
    return { ptsMm: rawPtsMm || [], beziersMm: [], svgPathMm: '', cornerCount: 0 };
  }

  const isHighDetail = detailMode === 'high' && !preserveOffset;

  // 1. Sub-pixel fairing on dense 1px pixel loops:
  //    - standard: unchanged Gaussian fairing
  //    - high: non-shrinking Taubin (lambda/mu) fairing removes 1px pixel noise WITHOUT flattening concave scalloped valleys
  const preFaired = skipDensePreFair
    ? rawPtsMm.map(([x, y]) => [x, y])
    : isHighDetail
    ? taubinSmoothDenseLoop(rawPtsMm, Math.max(1, Math.min(3, smoothPasses + 1)))
    : smoothDenseLoopSubpixel(rawPtsMm, preserveOffset ? 1 : Math.max(2, smoothPasses + 2));

  // 2. Closed-loop RDP simplification (curvature-adaptive tolerance in high detail mode)
  const rdpTol = isHighDetail
    ? Math.max(0.04, Math.min(0.08, simplifyTolMm))
    : Math.max(preserveOffset ? 0.05 : 0.12, simplifyTolMm);
  let pts = rdpSimplifyClosed(preFaired, rdpTol);
  if (pts.length < 3) pts = preFaired;

  // 3. Merge/filter vertices that are too close so short-long segment transitions never create hooks
  const minEdgeMm = preserveOffset ? 0.22 : isHighDetail ? 0.22 : 0.45;
  const cleaned = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = cleaned[cleaned.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= minEdgeMm) {
      cleaned.push([p[0], p[1]]);
    }
  }
  while (
    cleaned.length > 3 &&
    Math.hypot(cleaned[0][0] - cleaned[cleaned.length - 1][0], cleaned[0][1] - cleaned[cleaned.length - 1][1]) < minEdgeMm
  ) {
    cleaned.pop();
  }
  pts = cleaned.length >= 3 ? cleaned : pts;
  const n = pts.length;
  if (n < 3) return { ptsMm: pts, beziersMm: [], svgPathMm: '', cornerCount: 0 };

  // 4. Identify TRUE sharp corners AND endpoints of long straight horizontal/vertical edges
  const strictCornerLimit = Math.min(95, Math.max(60, cornerAngleDeg - 35));
  const isCorner = new Uint8Array(n);
  const isStraightSpan = new Uint8Array(n);
  let cornerCount = 0;

  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const dx = Math.abs(next[0] - curr[0]);
    const dy = Math.abs(next[1] - curr[1]);
    const len = Math.hypot(dx, dy);
    // Long axis-aligned edge (e.g. rectangular photo border >= 10mm within ~2.3 deg of horizontal/vertical)
    if (len >= 10 && (dy / Math.max(1e-4, dx) < 0.04 || dx / Math.max(1e-4, dy) < 0.04)) {
      isStraightSpan[i] = 1;
    }
  }

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const arm1 = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const arm2 = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const deg = computeVertexAngleDeg(prev, curr, next);
    if ((deg <= strictCornerLimit && arm1 >= 1.1 && arm2 >= 1.1) || isStraightSpan[i] || isStraightSpan[(i - 1 + n) % n]) {
      isCorner[i] = 1;
      if (deg <= strictCornerLimit) cornerCount++;
    }
  }

  // 5. Corner-locked Laplacian fairing on anchor vertices (skipped when preserveOffset or high detail Taubin mode is active)
  let faired = pts.map(([x, y]) => [x, y]);
  const anchorPasses = preserveOffset || isHighDetail ? 0 : Math.max(1, smoothPasses);
  for (let pass = 0; pass < anchorPasses; pass++) {
    const nextPts = new Array(n);
    for (let i = 0; i < n; i++) {
      if (isCorner[i]) {
        nextPts[i] = [faired[i][0], faired[i][1]];
      } else {
        const prev = faired[(i - 1 + n) % n];
        const curr = faired[i];
        const next = faired[(i + 1) % n];
        nextPts[i] = [
          prev[0] * 0.22 + curr[0] * 0.56 + next[0] * 0.22,
          prev[1] * 0.22 + curr[1] * 0.56 + next[1] * 0.22,
        ];
      }
    }
    faired = nextPts;
  }

  // 6. Compute chord-length weighted Bessel C1 tangents (hugs shorter segments to prevent any hook/overshoot)
  const outTangents = new Array(n);
  const inTangents = new Array(n);
  const chordLengths = new Array(n);
  for (let i = 0; i < n; i++) {
    const curr = faired[i];
    const next = faired[(i + 1) % n];
    chordLengths[i] = Math.hypot(next[0] - curr[0], next[1] - curr[1]) || 1e-3;
  }

  for (let i = 0; i < n; i++) {
    const prev = faired[(i - 1 + n) % n];
    const curr = faired[i];
    const next = faired[(i + 1) % n];

    const lenIn = chordLengths[(i - 1 + n) % n];
    const lenOut = chordLengths[i];
    const dxIn = (curr[0] - prev[0]) / lenIn;
    const dyIn = (curr[1] - prev[1]) / lenIn;
    const dxOut = (next[0] - curr[0]) / lenOut;
    const dyOut = (next[1] - curr[1]) / lenOut;

    if (isCorner[i]) {
      inTangents[i] = [dxIn, dyIn];
      outTangents[i] = [dxOut, dyOut];
    } else {
      // Bessel chord-weighted tangent: weight incoming unit vector by lenOut, outgoing by lenIn
      let tx = dxIn * lenOut + dxOut * lenIn;
      let ty = dyIn * lenOut + dyOut * lenIn;
      const tLen = Math.hypot(tx, ty);
      if (tLen < 1e-5) {
        inTangents[i] = [dxIn, dyIn];
        outTangents[i] = [dxOut, dyOut];
      } else {
        tx /= tLen;
        ty /= tLen;
        inTangents[i] = [tx, ty];
        outTangents[i] = [tx, ty];
      }
    }
  }

  // 7. Build closed Cubic Bézier path commands with monotone chord projection & clamped handles (zero hooks!)
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const beziersMm = [{ type: 'M', to: [round3(faired[0][0]), round3(faired[0][1])] }];
  const sampledPts = [];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = faired[i];
    const p3 = faired[j];
    const chord = chordLengths[i];
    const prevChord = chordLengths[(i - 1 + n) % n];
    const nextChord = chordLengths[j];

    const cx = (p3[0] - p0[0]) / chord;
    const cy = (p3[1] - p0[1]) / chord;

    let [tOutX, tOutY] = outTangents[i];
    let [tInX, tInY] = inTangents[j];

    // Ensure outgoing & incoming tangents project positively onto the chord (monotone guard against hooks)
    if (tOutX * cx + tOutY * cy < 0.35) {
      tOutX = tOutX * 0.4 + cx * 0.6;
      tOutY = tOutY * 0.4 + cy * 0.6;
      const l = Math.hypot(tOutX, tOutY) || 1;
      tOutX /= l;
      tOutY /= l;
    }
    if (tInX * cx + tInY * cy < 0.35) {
      tInX = tInX * 0.4 + cx * 0.6;
      tInY = tInY * 0.4 + cy * 0.6;
      const l = Math.hypot(tInX, tInY) || 1;
      tInX /= l;
      tInY /= l;
    }

    // Clamp handle lengths by adjacent chords so short-long transitions never overshoot
    const hOut = Math.min(chord * tension, prevChord * 0.42);
    const hIn = Math.min(chord * tension, nextChord * 0.42);

    const c1 = [round3(p0[0] + tOutX * hOut), round3(p0[1] + tOutY * hOut)];
    const c2 = [round3(p3[0] - tInX * hIn), round3(p3[1] - tInY * hIn)];
    const to = [round3(p3[0]), round3(p3[1])];

    beziersMm.push({ type: 'C', c1, c2, to });

    const steps = Math.max(3, Math.min(8, Math.ceil(chord / 1.4)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0];
      const y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1];
      sampledPts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    }
  }

  const svgParts = beziersMm.map((cmd) => {
    if (cmd.type === 'M') return `M ${cmd.to[0]} ${cmd.to[1]}`;
    if (cmd.type === 'L') return `L ${cmd.to[0]} ${cmd.to[1]}`;
    return `C ${cmd.c1[0]} ${cmd.c1[1]}, ${cmd.c2[0]} ${cmd.c2[1]}, ${cmd.to[0]} ${cmd.to[1]}`;
  });
  svgParts.push('Z');

  return {
    ptsMm: sampledPts,
    anchorsMm: faired,
    beziersMm,
    svgPathMm: svgParts.join(' '),
    cornerCount,
    closed: true,
  };
}

/**
 * Sample a perfect mathematical Circle / Ellipse / Rect closed Cubic Bézier path (in mm)
 */
function buildGeometricContourObj(ptsMm, shapeMode, outwardMm = 0) {
  // Expand the actual geometric path, not merely its display bounds.
  // A positive outwardMm represents a physical outward bleed in millimetres.
  if (!Number.isFinite(outwardMm) || outwardMm < 0) {
    throw new RangeError('outwardMm must be a finite non-negative number');
  }
  if (!Array.isArray(ptsMm) || ptsMm.length < 3) {
    throw new RangeError('A geometric contour requires at least three points');
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ptsMm) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  if (shapeMode === 'circle' || shapeMode === 'oval') {
    const useRx = (shapeMode === 'circle' ? Math.max(rx, ry) : rx) + outwardMm;
    const useRy = (shapeMode === 'circle' ? Math.max(rx, ry) : ry) + outwardMm;
    const k = 0.5522847498; // exact 4-segment cubic Bézier circle constant
    const kx = useRx * k;
    const ky = useRy * k;

    const beziersMm = [
      { type: 'M', to: [r3(cx + useRx), r3(cy)] },
      { type: 'C', c1: [r3(cx + useRx), r3(cy + ky)], c2: [r3(cx + kx), r3(cy + useRy)], to: [r3(cx), r3(cy + useRy)] },
      { type: 'C', c1: [r3(cx - kx), r3(cy + useRy)], c2: [r3(cx - useRx), r3(cy + ky)], to: [r3(cx - useRx), r3(cy)] },
      { type: 'C', c1: [r3(cx - useRx), r3(cy - ky)], c2: [r3(cx - kx), r3(cy - useRy)], to: [r3(cx), r3(cy - useRy)] },
      { type: 'C', c1: [r3(cx + kx), r3(cy - useRy)], c2: [r3(cx + useRx), r3(cy - ky)], to: [r3(cx + useRx), r3(cy)] },
    ];
    const segs = 72;
    const out = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      out.push([Math.round((cx + useRx * Math.cos(a)) * 100) / 100, Math.round((cy + useRy * Math.sin(a)) * 100) / 100]);
    }
    Object.assign(out, { beziersMm, closed: true, cornerCount: 0 });
    return out;
  }

  if (shapeMode === 'rect') {
    const out = [
      [r3(minX - outwardMm), r3(minY - outwardMm)],
      [r3(maxX + outwardMm), r3(minY - outwardMm)],
      [r3(maxX + outwardMm), r3(maxY + outwardMm)],
      [r3(minX - outwardMm), r3(maxY + outwardMm)],
    ];
    const beziersMm = [
      { type: 'M', to: out[0] },
      { type: 'L', to: out[1] },
      { type: 'L', to: out[2] },
      { type: 'L', to: out[3] },
      { type: 'L', to: out[0] },
    ];
    Object.assign(out, { beziersMm, closed: true, cornerCount: 4 });
    return out;
  }

  return ptsMm;
}

/**
 * STEP 1: Trace outer contours at 1px granularity (CHAIN_APPROX_NONE equivalent)
 */
function traceConnectedContoursChainNone(mask, w, h, minAreaPx) {
  const visited = new Uint8Array(w * h);
  const contours = [];

  // 8-neighborhood clockwise starting from West
  const dirs = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  const floodMark = (sx, sy) => {
    const stack = [sy * w + sx];
    visited[sy * w + sx] = 1;
    let area = 0;
    while (stack.length > 0) {
      const cur = stack.pop();
      area++;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nIdx = ny * w + nx;
          if (mask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }
    return area;
  };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (mask[idx] && !visited[idx] && !mask[idx - 1]) {
        const area = floodMark(x, y);
        if (area < minAreaPx) continue;

        const poly = [];
        let cx = x, cy = y;
        let backDir = 0;
        const maxSteps = Math.min(25000, (w + h) * 10);
        let steps = 0;

        do {
          poly.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (backDir + i) % 8;
            const nx = cx + dirs[d][0];
            const ny = cy + dirs[d][1];
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) {
              cx = nx;
              cy = ny;
              backDir = (d + 4) % 8;
              found = true;
              break;
            }
          }
          if (!found) break;
          steps++;
        } while ((cx !== x || cy !== y) && steps < maxSteps);

        if (poly.length >= 6) {
          contours.push(poly);
          if (contours.length >= 120) return contours;
        }
      }
    }
  }

  return contours;
}

/**
 * Signed polygon area (positive = clockwise in screen Y-down coords)
 */
function signedPolygonArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * STEP 3: Offset a closed polygon in real mm (Miter-Clipped + Arc-Bevel Normal Offset)
 * followed by Corner-Preserving Cubic Bézier re-fitting.
 */
export function offsetPolygonAndFitBezierMm(ptsMm, deltaMm, fitOptions = {}) {
  if (!ptsMm || ptsMm.length < 3 || Math.abs(deltaMm) < 1e-4) {
    const fitted = fitCornerPreservingBezier(ptsMm || [], fitOptions);
    const arr = [...fitted.ptsMm];
    Object.assign(arr, fitted);
    return arr;
  }

  const anchors = ptsMm.anchorsMm || ptsMm;
  const n = anchors.length;
  // Determine winding sign so outward normal always points outside the polygon
  const area = signedPolygonArea(anchors);
  const sign = area >= 0 ? 1 : -1;
  const offsetPts = [];
  const miterLimit = 2.2;

  for (let i = 0; i < n; i++) {
    const prev = anchors[(i - 1 + n) % n];
    const curr = anchors[i];
    const next = anchors[(i + 1) % n];

    let dx1 = curr[0] - prev[0];
    let dy1 = curr[1] - prev[1];
    const l1 = Math.hypot(dx1, dy1) || 1;
    dx1 /= l1;
    dy1 /= l1;

    let dx2 = next[0] - curr[0];
    let dy2 = next[1] - curr[1];
    const l2 = Math.hypot(dx2, dy2) || 1;
    dx2 /= l2;
    dy2 /= l2;

    // Outward unit normals for edge 1 and edge 2
    const n1x = sign * dy1;
    const n1y = -sign * dx1;
    const n2x = sign * dy2;
    const n2y = -sign * dx2;

    const cross = dx1 * dy2 - dy1 * dx2;
    const isConvexTurn = sign * cross > 0;

    if (deltaMm > 0 && isConvexTurn && n1x * n2x + n1y * n2y < 0.35) {
      // Sharp outer corner: insert arc-bevel points so offset distance stays exact without huge miter spike
      const a1 = Math.atan2(n1y, n1x);
      let a2 = Math.atan2(n2y, n2x);
      let diff = a2 - a1;
      while (diff <= -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      const steps = Math.max(2, Math.min(5, Math.ceil(Math.abs(diff) / (Math.PI / 6))));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (diff * s) / steps;
        offsetPts.push([curr[0] + Math.cos(a) * deltaMm, curr[1] + Math.sin(a) * deltaMm]);
      }
    } else {
      let bx = n1x + n2x;
      let by = n1y + n2y;
      const bLen = Math.hypot(bx, by);
      if (bLen < 1e-4) {
        offsetPts.push([curr[0] + n1x * deltaMm, curr[1] + n1y * deltaMm]);
      } else {
        bx /= bLen;
        by /= bLen;
        const cosHalf = Math.max(0.25, bx * n1x + by * n1y);
        const miterLen = Math.min(miterLimit, 1 / cosHalf) * deltaMm;
        offsetPts.push([curr[0] + bx * miterLen, curr[1] + by * miterLen]);
      }
    }
  }

  const fitted = fitCornerPreservingBezier(offsetPts, { ...fitOptions, skipDensePreFair: true, smoothPasses: 0 });
  const arr = [...fitted.ptsMm];
  Object.assign(arr, fitted);
  return arr;
}

/**
 * STEP 4: Geometric Validation (Closedness, Self-Intersection, Sticker-to-Sticker Collision)
 */
function segmentsIntersect(a,b,c,d) {
  const margin = 1e-8;
  if (Math.max(a[0],b[0])+margin < Math.min(c[0],d[0]) ||
      Math.max(c[0],d[0])+margin < Math.min(a[0],b[0]) ||
      Math.max(a[1],b[1])+margin < Math.min(c[1],d[1]) ||
      Math.max(c[1],d[1])+margin < Math.min(a[1],b[1])) return false;
  const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const e=1e-8;
  const on=(p,q,r)=>Math.abs(cross(p,q,r))<=e && r[0]>=Math.min(p[0],q[0])-e && r[0]<=Math.max(p[0],q[0])+e && r[1]>=Math.min(p[1],q[1])-e && r[1]<=Math.max(p[1],q[1])+e;
  const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
  return (x*y<0&&z*w<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
function flattenValidation(poly) {
  if(!poly?.beziersMm?.length)return poly||[];
  const out=[];let p;
  const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
  const split=(a,b,c,d,depth)=>{
    const excess=Math.hypot(b[0]-a[0],b[1]-a[1])+Math.hypot(c[0]-b[0],c[1]-b[1])+Math.hypot(d[0]-c[0],d[1]-c[1])-Math.hypot(d[0]-a[0],d[1]-a[1]);
    const dist=(q)=>{const x=d[0]-a[0],y=d[1]-a[1],l=x*x+y*y,t=l?Math.max(0,Math.min(1,((q[0]-a[0])*x+(q[1]-a[1])*y)/l)):0;return Math.hypot(q[0]-a[0]-t*x,q[1]-a[1]-t*y);};
    if(depth>=12||(excess<=0.02&&Math.max(dist(b),dist(c))<=0.02)){out.push(d);return;}
    const ab=mid(a,b),bc=mid(b,c),cd=mid(c,d),u=mid(ab,bc),v=mid(bc,cd),m=mid(u,v);split(a,ab,u,m,depth+1);split(m,v,cd,d,depth+1);
  };
  for(const cmd of poly.beziersMm){if(cmd.type==='C'&&p)split(p,cmd.c1,cmd.c2,cmd.to,0);else out.push(cmd.to);p=cmd.to;}
  const clean=out.filter((q,i)=>!i||Math.hypot(q[0]-out[i-1][0],q[1]-out[i-1][1])>1e-8);
  if(clean.length>1&&Math.hypot(clean[0][0]-clean.at(-1)[0],clean[0][1]-clean.at(-1)[1])<1e-8)clean.pop();return clean;
}
function insideValidation(p,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}

function isFinitePoint(pt) {
  return Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]);
}

function hasAllFiniteCoords(poly) {
  if (!poly) return false;
  if (Array.isArray(poly.beziersMm) && poly.beziersMm.length > 0) {
    for (const cmd of poly.beziersMm) {
      if (!cmd || !isFinitePoint(cmd.to)) return false;
      if (cmd.type === 'C' && (!isFinitePoint(cmd.c1) || !isFinitePoint(cmd.c2))) return false;
    }
  }
  if (Array.isArray(poly)) {
    for (const pt of poly) {
      if (!isFinitePoint(pt)) return false;
    }
  }
  return true;
}

function pointToSegmentDistSq(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const qx = a[0] + t * dx;
  const qy = a[1] + t * dy;
  return (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
}

function measureMinCutToBleedDistMm(cutFlat, bleedFlat) {
  if (!cutFlat?.length || !bleedFlat?.length) return 0;
  let minSq = Infinity;
  const bn = bleedFlat.length;
  // Subsample uniformly if extremely dense to keep O(N*M) bounded while preserving accuracy
  const stepA = cutFlat.length > 240 ? Math.ceil(cutFlat.length / 240) : 1;
  for (let i = 0; i < cutFlat.length; i += stepA) {
    const p = cutFlat[i];
    for (let j = 0; j < bn; j++) {
      const d2 = pointToSegmentDistSq(p, bleedFlat[j], bleedFlat[(j + 1) % bn]);
      if (d2 < minSq) minSq = d2;
    }
  }
  return Number.isFinite(minSq) ? Math.sqrt(minSq) : 0;
}

// Cutline Engine 3.1.2 — Explicit BLEED Semantics:
// Case A: Artwork -> (+offsetMm) -> Final CUT -> (+bleedOffsetMm) -> BLEED
// Guaranteed across Freeform (precision/fallback) and Geometric (circle/oval/rect).
export const BLEED_SEMANTICS = 'from_final_cut';

export function measureCutToBleedMetricsMm(cutFlat, bleedFlat, targetMm = null, tolOverMm = 0.15) {
  const n = cutFlat.length;
  const bn = bleedFlat.length;
  if (!n || bn < 2) {
    return {
      minDistMm: 0,
      maxDistMm: 0,
      avgDistMm: 0,
      overSampleCount: 0,
      overRatio: 0,
      overRegionCount: 0,
      maxOverRunMm: 0,
      maxOverRunPercent: 0,
      perimeterMm: 0,
      worstPointMm: null,
      maxPointMm: null,
    };
  }
  let minDist = Infinity;
  let maxDist = 0;
  let sumDist = 0;
  let overSampleCount = 0;
  let totalPerimeterMm = 0;
  let worstPt = null;
  let maxPt = null;
  const overThreshold =
    Number.isFinite(Number(targetMm)) && Number(targetMm) > 0.05
      ? Number(targetMm) + Math.max(0, Number(tolOverMm) || 0) + 1e-6
      : Infinity;
  const isOver = new Uint8Array(n);
  const segLens = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const p = cutFlat[i];
    const next = cutFlat[(i + 1) % n];
    const sLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
    segLens[i] = sLen;
    totalPerimeterMm += sLen;

    let ptMinSq = Infinity;
    for (let j = 0; j < bn; j++) {
      const d2 = pointToSegmentDistSq(p, bleedFlat[j], bleedFlat[(j + 1) % bn]);
      if (d2 < ptMinSq) ptMinSq = d2;
    }
    const d = Number.isFinite(ptMinSq) ? Math.sqrt(ptMinSq) : 0;
    sumDist += d;
    if (d > overThreshold) {
      overSampleCount++;
      isOver[i] = 1;
    }
    if (d < minDist) {
      minDist = d;
      worstPt = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
    }
    if (d > maxDist) {
      maxDist = d;
      maxPt = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
    }
  }

  // Compute continuous over-regions along the closed perimeter (wrapping across index 0)
  let overRegionCount = 0;
  let maxOverRunMm = 0;
  if (overSampleCount === n) {
    overRegionCount = 1;
    maxOverRunMm = totalPerimeterMm;
  } else if (overSampleCount > 0) {
    // Start at the first non-over vertex so any run crossing index 0 is measured contiguously
    let startIdx = 0;
    while (startIdx < n && isOver[startIdx]) startIdx++;
    let inRun = false;
    let curRunMm = 0;
    const edgeCapMm = Number.isFinite(Number(targetMm)) && Number(targetMm) > 0 ? Number(targetMm) : 1.5;
    for (let step = 0; step < n; step++) {
      const idx = (startIdx + step) % n;
      const nextIdx = (idx + 1) % n;
      if (isOver[idx]) {
        if (!inRun) {
          inRun = true;
          overRegionCount++;
          curRunMm = 0;
        }
        // Full edge length when both endpoints exceed threshold; cap transition edge so sparse straight polygons
        // don't attribute an entire long straight side to a single concave corner vertex.
        curRunMm += isOver[nextIdx] ? segLens[idx] : Math.min(segLens[idx], edgeCapMm);
      } else if (inRun) {
        if (curRunMm > maxOverRunMm) maxOverRunMm = curRunMm;
        inRun = false;
      }
    }
    if (inRun && curRunMm > maxOverRunMm) maxOverRunMm = curRunMm;
  }
  const maxOverRunPercent = totalPerimeterMm > 1e-6 ? (maxOverRunMm / totalPerimeterMm) * 100 : 0;

  return {
    minDistMm: Number.isFinite(minDist) ? minDist : 0,
    maxDistMm: maxDist,
    avgDistMm: sumDist / n,
    overSampleCount,
    overRatio: overSampleCount / n,
    overRegionCount,
    maxOverRunMm,
    maxOverRunPercent,
    perimeterMm: totalPerimeterMm,
    worstPointMm: worstPt,
    maxPointMm: maxPt,
  };
}

function countPolySelfIntersections(pts) {
  const m = pts.length;
  if (m < 4) return 0;
  let hits = 0;
  for (let i = 0; i < m; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % m];
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const b1 = pts[j];
      const b2 = pts[(j + 1) % m];
      if (segmentsIntersect(a1, a2, b1, b2)) hits++;
    }
  }
  return hits;
}

function countDuplicateOrDegenerateEdges(pts) {
  const m = pts.length;
  if (m < 2) return 0;
  let dup = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-4) dup++;
  }
  return dup;
}

// 3.1.1: exact analytical cubic Bézier extrema with finite-coordinate safety.
export function contourBoundsMm(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (pt) => {
    if (!isFinitePoint(pt)) return;
    if (pt[0] < minX) minX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] > maxY) maxY = pt[1];
  };
  let p = null;
  for (const cmd of poly?.beziersMm || []) {
    if (!cmd || !isFinitePoint(cmd.to)) continue;
    add(cmd.to);
    if (cmd.type === 'C' && p && isFinitePoint(cmd.c1) && isFinitePoint(cmd.c2)) {
      for (let k = 0; k < 2; k++) {
        const a = -p[k] + 3 * cmd.c1[k] - 3 * cmd.c2[k] + cmd.to[k];
        const b = 2 * (p[k] - 2 * cmd.c1[k] + cmd.c2[k]);
        const c = cmd.c1[k] - p[k];
        const disc = b * b - 4 * a * c;
        const roots =
          Math.abs(a) < 1e-12
            ? Math.abs(b) < 1e-12
              ? []
              : [-c / b]
            : disc < 0
            ? []
            : [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)];
        for (const t of roots) {
          if (t > 0 && t < 1) {
            const u = 1 - t;
            add([
              u ** 3 * p[0] + 3 * u * u * t * cmd.c1[0] + 3 * u * t * t * cmd.c2[0] + t ** 3 * cmd.to[0],
              u ** 3 * p[1] + 3 * u * u * t * cmd.c1[1] + 3 * u * t * t * cmd.c2[1] + t ** 3 * cmd.to[1],
            ]);
          }
        }
      }
    }
    p = cmd.to;
  }
  if (!p && Array.isArray(poly)) {
    for (const q of poly) add(q);
  }
  const valid = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY) && maxX >= minX && maxY >= minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: valid ? maxX - minX : 0,
    height: valid ? maxY - minY : 0,
    valid,
  };
}

function canvasContour(ctx, poly, transform) {
  ctx.beginPath();
  if (poly?.beziersMm?.length) {
    for (const c of poly.beziersMm) {
      if (!c || !isFinitePoint(c.to)) continue;
      if (c.type === 'M') ctx.moveTo(...transform(c.to));
      else if (c.type === 'C' && isFinitePoint(c.c1) && isFinitePoint(c.c2)) {
        ctx.bezierCurveTo(...transform(c.c1), ...transform(c.c2), ...transform(c.to));
      } else {
        ctx.lineTo(...transform(c.to));
      }
    }
  } else if (Array.isArray(poly)) {
    let started = false;
    for (const pt of poly) {
      if (!isFinitePoint(pt)) continue;
      const [tx, ty] = transform(pt);
      if (!started) {
        ctx.moveTo(tx, ty);
        started = true;
      } else {
        ctx.lineTo(tx, ty);
      }
    }
  }
  ctx.closePath();
}

function validateSingleBleedAgainstCut(
  cutPoly,
  bleedPoly,
  targetDeltaMm,
  offsetToleranceUnderMm = PRECISION_BLEED_BUDGET.defaultOffsetToleranceUnderMm
) {
  const reasons = [];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (!bleedPoly || bleedPoly.invalid) {
    return {
      valid: false,
      geometryValid: false,
      withinTolerance: false,
      minDistMm: 0,
      maxDistMm: 0,
      avgDistMm: 0,
      deficitMm: r3(Math.max(0, targetDeltaMm)),
      deviationMm: r3(Math.max(0, targetDeltaMm)),
      worstPointMm: null,
      reasons: ['BLEED không hợp lệ hoặc rỗng'],
    };
  }
  if (!hasAllFiniteCoords(bleedPoly)) {
    return {
      valid: false,
      geometryValid: false,
      withinTolerance: false,
      minDistMm: 0,
      maxDistMm: 0,
      avgDistMm: 0,
      deficitMm: r3(Math.max(0, targetDeltaMm)),
      deviationMm: r3(Math.max(0, targetDeltaMm)),
      worstPointMm: null,
      reasons: ['BLEED chứa tọa độ NaN/Infinity'],
    };
  }
  const bFlat = flattenValidation(bleedPoly);
  const cFlat = flattenValidation(cutPoly);
  if (bFlat.length < 3 || Math.abs(signedPolygonArea(bFlat)) < 0.01) {
    reasons.push('BLEED suy biến hoặc diện tích không hợp lệ');
  }
  const isClosed =
    bleedPoly.closed !== false &&
    (!bleedPoly.beziersMm?.length ||
      (bleedPoly.beziersMm[0]?.type === 'M' &&
        Math.hypot(
          bleedPoly.beziersMm[0].to[0] - bleedPoly.beziersMm.at(-1).to[0],
          bleedPoly.beziersMm[0].to[1] - bleedPoly.beziersMm.at(-1).to[1]
        ) < 0.002));
  if (!isClosed) reasons.push('BLEED không khép kín');
  if (bFlat.length >= 4 && countPolySelfIntersections(bFlat) > 0) {
    reasons.push('BLEED bị tự giao');
  }
  if (targetDeltaMm > 0.05 && cFlat.length >= 3 && bFlat.length >= 3) {
    if (cFlat.some((pt) => !insideValidation(pt, bFlat))) {
      reasons.push('BLEED không bao trọn đường CUT');
    }
    let crosses = false;
    for (let j = 0; j < cFlat.length && !crosses; j++) {
      for (let k = 0; k < bFlat.length; k++) {
        if (segmentsIntersect(cFlat[j], cFlat[(j + 1) % cFlat.length], bFlat[k], bFlat[(k + 1) % bFlat.length])) {
          crosses = true;
          break;
        }
      }
    }
    if (crosses) reasons.push('BLEED cắt chéo đường CUT');
  }
  const metrics =
    cFlat.length >= 3 && bFlat.length >= 3
      ? measureCutToBleedMetricsMm(cFlat, bFlat)
      : { minDistMm: 0, maxDistMm: 0, avgDistMm: 0, worstPointMm: null };
  const minDistMm = r3(metrics.minDistMm);
  const maxDistMm = r3(metrics.maxDistMm);
  const avgDistMm = r3(metrics.avgDistMm);
  const deficitMm = r3(Math.max(0, targetDeltaMm - metrics.minDistMm));
  const deviationMm = r3(Math.abs(metrics.minDistMm - targetDeltaMm));
  const geometryValid = reasons.length === 0;
  const minAllowedMm = Math.max(0, targetDeltaMm - offsetToleranceUnderMm);
  const withinTolerance = geometryValid && (targetDeltaMm <= 0.05 || metrics.minDistMm >= minAllowedMm - 1e-6);
  return {
    valid: geometryValid,
    geometryValid,
    withinTolerance,
    minDistMm,
    maxDistMm,
    avgDistMm,
    deficitMm,
    deviationMm,
    worstPointMm: metrics.worstPointMm,
    reasons,
  };
}

/**
 * Cutline Engine 3.1.1 — Production-Safe Precision Bleed from final CUT Bézier path.
 * Uses bounded local distance field (default <= 12 px/mm, <= 1,000,000 px/sticker, <= 2048px edge)
 * verified AFTER Math.ceil rounding, with strict input validation and deterministic canvas cleanup.
 */
export function precisionBleedFromCut(cut, delta, fitOpts = {}) {
  const numDelta = Number(delta);
  if (!Number.isFinite(numDelta) || numDelta < 0) {
    throw new RangeError('Bleed delta must be a finite non-negative number');
  }
  if (numDelta > PRECISION_BLEED_BUDGET.maxOffsetMm) {
    throw new RangeError(`Bleed delta (${numDelta}mm) exceeds safe limit (${PRECISION_BLEED_BUDGET.maxOffsetMm}mm)`);
  }
  if (!cut || (!Array.isArray(cut) && !Array.isArray(cut.beziersMm))) {
    throw new RangeError('Invalid CUT contour input');
  }
  if (!hasAllFiniteCoords(cut)) {
    throw new RangeError('CUT contour contains NaN or Infinity coordinates');
  }

  const cutFlat = flattenValidation(cut);
  if (cutFlat.length < 3 || Math.abs(signedPolygonArea(cutFlat)) < 1e-3) {
    throw new RangeError('CUT contour is degenerate (fewer than 3 valid points or zero area)');
  }

  if (numDelta === 0) {
    const copy = Array.isArray(cut) ? cut.map((pt) => [pt[0], pt[1]]) : [...cutFlat];
    Object.assign(copy, {
      beziersMm: cut.beziersMm ? cut.beziersMm.map((c) => ({ ...c })) : undefined,
      closed: cut.closed !== false,
      cornerCount: cut.cornerCount || 0,
      bleedMethod: 'zero-offset',
    });
    return copy;
  }

  const b = contourBoundsMm(cut);
  if (!b.valid || b.width < 0.1 || b.height < 0.1) {
    throw new RangeError('CUT contour has invalid bounding box');
  }

  const budget = {
    maxScale: fitOpts.maxScalePxPerMm ?? PRECISION_BLEED_BUDGET.maxScalePxPerMm,
    maxPixels: fitOpts.maxPixelsPerSticker ?? PRECISION_BLEED_BUDGET.maxPixelsPerSticker,
    maxEdge: fitOpts.maxCanvasEdgePx ?? PRECISION_BLEED_BUDGET.maxCanvasEdgePx,
  };

  const margin = numDelta + 1.0;
  const x = b.minX - margin;
  const y = b.minY - margin;
  const wmm = b.width + 2 * margin;
  const hmm = b.height + 2 * margin;
  if (!Number.isFinite(wmm) || !Number.isFinite(hmm) || wmm <= 0 || hmm <= 0) {
    throw new RangeError('Invalid bleed workspace dimensions');
  }

  let scale = Math.min(
    budget.maxScale,
    Math.sqrt(budget.maxPixels / Math.max(1e-3, wmm * hmm)),
    budget.maxEdge / Math.max(wmm, hmm)
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('Cannot compute valid raster scale for precision bleed');
  }

  // Verify pixel & edge budgets AFTER Math.ceil rounding so we never exceed limits
  let w = Math.max(8, Math.ceil(wmm * scale));
  let h = Math.max(8, Math.ceil(hmm * scale));
  while ((w * h > budget.maxPixels || w > budget.maxEdge || h > budget.maxEdge) && scale > 0.5) {
    scale *= 0.94;
    w = Math.max(8, Math.ceil(wmm * scale));
    h = Math.max(8, Math.ceil(hmm * scale));
  }
  if (w * h > budget.maxPixels || w > budget.maxEdge || h > budget.maxEdge) {
    throw new Error(`Precision BLEED exceeded pixel budget (${w}x${h})`);
  }

  const budgetState = fitOpts.budgetState;
  if (budgetState) {
    const maxTotal = budgetState.maxTotalPixels ?? PRECISION_BLEED_BUDGET.maxTotalPixelsPerRun;
    if ((budgetState.usedPixels || 0) + w * h > maxTotal) {
      throw new Error(`Sheet-wide precision BLEED pixel budget exhausted (${budgetState.usedPixels}/${maxTotal})`);
    }
    budgetState.usedPixels = (budgetState.usedPixels || 0) + w * h;
  }

  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('Precision BLEED requires Canvas 2D DOM environment');
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to acquire 2D context for precision BLEED');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    canvasContour(ctx, cut, (p) => [(p[0] - x) * scale, (p[1] - y) * scale]);
    ctx.fill();

    const rgba = ctx.getImageData(0, 0, w, h).data;
    let mask = new Uint8Array(w * h);
    let fgCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (rgba[4 * i + 3] >= 128) {
        mask[i] = 1;
        fgCount++;
      }
    }
    if (fgCount < 4) throw new Error('Precision BLEED: rasterized CUT mask is empty');

    const dist = computeDistanceField(mask, w, h);
    // Half-pixel (+0.5px) accounts for pixel-center quantization between outer CUT edge and traced foreground pixel center
    const threshPx = numDelta * scale + 0.5;
    for (let i = 0; i < mask.length; i++) {
      mask[i] = dist[i] <= threshPx ? 1 : 0;
    }
    mask = fillInteriorHoles(mask, w, h);

    const loops = traceConnectedContoursChainNone(mask, w, h, 3);
    if (!loops.length) throw new Error('Precision BLEED: no contour traced');
    loops.sort((a, b) => Math.abs(signedPolygonArea(b)) - Math.abs(signedPolygonArea(a)));
    const raw = loops[0].map((p) => [x + (p[0] + 0.5) / scale, y + (p[1] + 0.5) / scale]);
    const fitted = fitCornerPreservingBezier(raw, {
      ...fitOpts,
      simplifyTolMm: 0.06,
      smoothPasses: 0,
      tension: 0.2,
      preserveOffset: true,
    });
    const result = Object.assign([...fitted.ptsMm], fitted, {
      bleedMethod: 'precision',
      scalePxPerMm: Math.round(scale * 100) / 100,
      pixelsUsed: w * h,
    });
    return result;
  } finally {
    // Deterministically release backing-store memory
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function validateContoursGeometry(
  cutContoursMm,
  bleedContoursMm = [],
  totalWidthMm = 330,
  totalHeightMm = 390,
  validationOptions = {}
) {
  const targetBleedMm = Number.isFinite(Number(validationOptions.targetBleedMm))
    ? Math.max(0, Number(validationOptions.targetBleedMm))
    : null;
  const offsetToleranceUnderMm = Number.isFinite(Number(validationOptions.offsetToleranceUnderMm))
    ? Math.max(0, Number(validationOptions.offsetToleranceUnderMm))
    : PRECISION_BLEED_BUDGET.defaultOffsetToleranceUnderMm;
  const offsetToleranceOverMm = Number.isFinite(Number(validationOptions.offsetToleranceOverMm))
    ? Math.max(0, Number(validationOptions.offsetToleranceOverMm))
    : PRECISION_BLEED_BUDGET.defaultOffsetToleranceOverMm;
  const maxLocalOverRatio = Number.isFinite(Number(validationOptions.maxLocalOverRatio))
    ? Math.max(0.01, Math.min(1, Number(validationOptions.maxLocalOverRatio)))
    : PRECISION_BLEED_BUDGET.defaultMaxLocalOverRatio;
  const maxLocalOverRunPercent = Number.isFinite(Number(validationOptions.maxLocalOverRunPercent))
    ? Math.max(1, Math.min(100, Number(validationOptions.maxLocalOverRunPercent)))
    : PRECISION_BLEED_BUDGET.defaultMaxLocalOverRunPercent;
  const hardOverLimitMm = Number.isFinite(Number(validationOptions.hardOverLimitMm))
    ? Math.max(offsetToleranceOverMm, Number(validationOptions.hardOverLimitMm))
    : targetBleedMm !== null
    ? Math.max(targetBleedMm * 1.0, 1.5)
    : 1.5;
  const count = Array.isArray(cutContoursMm) ? cutContoursMm.length : 0;
  let closedCount = 0;
  let selfIntersections = 0;
  let bleedSelfIntersections = 0;
  let totalBezierSegments = 0;
  let totalSharpCorners = 0;

  const errors = [];
  const warnings = [];
  const cutIssues = [];
  const bleedIssues = [];
  const bboxes = [];
  const bleedBboxes = [];
  const flattened = new Map();
  const flat = (poly) => {
    if (!poly || poly.invalid) return [];
    if (!flattened.has(poly)) flattened.set(poly, flattenValidation(poly));
    return flattened.get(poly);
  };

  // 1. Validate each CUT contour independently
  for (let idx = 0; idx < count; idx++) {
    const poly = cutContoursMm[idx];
    const stickerNum = idx + 1;
    if (!poly || !hasAllFiniteCoords(poly)) {
      cutIssues.push({ sticker: stickerNum, reason: 'CUT chứa tọa độ không hữu hạn (NaN/Infinity) hoặc rỗng' });
      errors.push(`Tem #${stickerNum}: CUT không hợp lệ (tọa độ NaN/Infinity hoặc rỗng)`);
      continue;
    }
    const anchors = flat(poly);
    const si = anchors.length >= 4 ? countPolySelfIntersections(anchors) : 0;
    if (si > 0) {
      selfIntersections += si;
      cutIssues.push({ sticker: stickerNum, reason: `CUT tự giao (${si} điểm)` });
      errors.push(`Tem #${stickerNum}: Đường CUT bị tự giao (${si})`);
    }
    if (anchors.length < 3 || Math.abs(signedPolygonArea(anchors)) < 0.01) {
      cutIssues.push({ sticker: stickerNum, reason: 'CUT suy biến (< 3 điểm hoặc diện tích bằng 0)' });
      errors.push(`Tem #${stickerNum}: CUT suy biến`);
      continue;
    }

    const isClosed =
      poly.closed !== false &&
      (!poly.beziersMm?.length ||
        (poly.beziersMm[0]?.type === 'M' &&
          Math.hypot(
            poly.beziersMm[0].to[0] - poly.beziersMm.at(-1).to[0],
            poly.beziersMm[0].to[1] - poly.beziersMm.at(-1).to[1]
          ) < 0.002));
    if (isClosed) {
      closedCount++;
    } else {
      cutIssues.push({ sticker: stickerNum, reason: 'CUT không khép kín' });
      errors.push(`Tem #${stickerNum}: Đường CUT không khép kín`);
    }

    totalBezierSegments += poly.beziersMm ? poly.beziersMm.length - 1 : poly.length;
    totalSharpCorners += poly.cornerCount || 0;

    const b = contourBoundsMm(poly);
    bboxes.push({ idx, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, poly });

    const dupEdges = countDuplicateOrDegenerateEdges(anchors);
    if (dupEdges > 0) {
      warnings.push(`Tem #${stickerNum}: Đường CUT có ${dupEdges} đoạn trùng lặp/siêu ngắn`);
    }
  }

  // 2. Check pairwise CUT-to-CUT collisions & nesting
  const collisions = [];
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      const A = bboxes[i];
      const B = bboxes[j];
      if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) continue;
      const pA = flat(A.poly);
      const pB = flat(B.poly);
      let hit = false;
      for (let ia = 0; ia < pA.length && !hit; ia++) {
        const a1 = pA[ia];
        const a2 = pA[(ia + 1) % pA.length];
        for (let ib = 0; ib < pB.length; ib++) {
          const b1 = pB[ib];
          const b2 = pB[(ib + 1) % pB.length];
          if (segmentsIntersect(a1, a2, b1, b2)) {
            hit = true;
            break;
          }
        }
      }
      if (hit || (pA.length && pB.length && (insideValidation(pA[0], pB) || insideValidation(pB[0], pA)))) {
        collisions.push([A.idx + 1, B.idx + 1]);
        errors.push(`Tem #${A.idx + 1} và #${B.idx + 1}: Đường CUT va chạm hoặc lồng nhau`);
      }
    }
  }

  // 3. Validate each BLEED contour independently & against its corresponding CUT (fail-safe per sticker)
  const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
  const bleedCoverageIssues = [];
  const bleedDistancesMm = [];
  const bleedDiagnostics = [];
  const offsetToleranceIssues = [];
  let minCutBleedDistMm = null;
  let maxCutBleedDistMm = null;
  let sumAvgCutBleedDistMm = 0;
  let avgDistCount = 0;
  let maxUnderMmSheet = 0;
  let maxOverMmSheet = 0;
  const minAllowedMm = targetBleedMm !== null && targetBleedMm > 0.05 ? Math.max(0, targetBleedMm - offsetToleranceUnderMm) : 0;

  const makeDiagEntry = ({
    stickerNum,
    tier,
    method,
    targetMm,
    minDistMm,
    avgDistMm,
    maxDistMm,
    underDeviationMm,
    overDeviationMm,
    overRatio = 0,
    maxOverRunMm = 0,
    maxOverRunPercent = 0,
    overRegionCount = 0,
    overClassification = 'NONE',
    geometryValid: gValid,
    offsetWithinTolerance: oValid,
    worstPointMm,
    reasons,
  }) => {
    const cleanReasons = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
    // FAIL: geometry invalid OR offset outside tolerance (under > tolUnder OR sustained/abnormal over)
    // WARNING: geometry valid & within tolerance, but localized corner/concave overshoot OR Tier 2 fallback OR BLEED overlap
    // PASS: geometry valid, within tolerance, no warnings
    const status = !gValid || !oValid ? 'FAIL' : tier === 2 || cleanReasons.length > 0 ? 'WARNING' : 'PASS';
    return {
      index: stickerNum,
      sticker: stickerNum, // backward-compatible alias
      tier,
      method,
      targetMm,
      minDistMm,
      avgDistMm,
      maxDistMm,
      maxUnderMm: underDeviationMm,
      maxOverMm: overDeviationMm,
      underDeviationMm,
      overDeviationMm,
      overRatio: r3(overRatio),
      maxOverRunMm: r3(maxOverRunMm),
      maxOverRunPercent: Math.round(maxOverRunPercent * 10) / 10,
      overRegionCount,
      overClassification,
      deficitMm: underDeviationMm, // backward-compatible alias
      overshootMm: overDeviationMm, // backward-compatible alias
      geometryValid: gValid,
      offsetWithinTolerance: oValid,
      withinTolerance: oValid, // backward-compatible alias
      status,
      reasons: cleanReasons,
      reason: cleanReasons[0] || null, // backward-compatible alias
      worstPointMm,
    };
  };

  if (Array.isArray(bleedContoursMm) && bleedContoursMm.length > 0) {
    if (bleedContoursMm.length !== count) {
      errors.push(`Mất đồng bộ số lượng CUT (${count}) và BLEED (${bleedContoursMm.length})`);
    }
    for (let i = 0; i < count; i++) {
      const stickerNum = i + 1;
      try {
        const cutPoly = cutContoursMm[i];
        const bleedPoly = bleedContoursMm[i];
        if (!bleedPoly || bleedPoly.invalid) {
          const reason = bleedPoly?.error || 'BLEED không hợp lệ';
          bleedCoverageIssues.push(stickerNum);
          bleedIssues.push({ sticker: stickerNum, reason });
          errors.push(`Tem #${stickerNum}: BLEED lỗi (${bleedPoly?.error || 'không thể tạo'})`);
          bleedDiagnostics.push(
            makeDiagEntry({
              stickerNum,
              tier: bleedPoly?.fallbackTier ?? 3,
              method: bleedPoly?.fallbackMethod ?? 'none',
              targetMm: targetBleedMm,
              minDistMm: 0,
              avgDistMm: 0,
              maxDistMm: 0,
              underDeviationMm: targetBleedMm !== null ? r3(targetBleedMm) : 0,
              overDeviationMm: 0,
              geometryValid: false,
              offsetWithinTolerance: false,
              worstPointMm: null,
              reasons: [reason],
            })
          );
          continue;
        }
        if (!hasAllFiniteCoords(bleedPoly)) {
          const reason = 'BLEED chứa tọa độ NaN/Infinity';
          bleedCoverageIssues.push(stickerNum);
          bleedIssues.push({ sticker: stickerNum, reason });
          errors.push(`Tem #${stickerNum}: ${reason}`);
          bleedDiagnostics.push(
            makeDiagEntry({
              stickerNum,
              tier: bleedPoly?.fallbackTier ?? 3,
              method: bleedPoly?.fallbackMethod ?? 'none',
              targetMm: targetBleedMm,
              minDistMm: 0,
              avgDistMm: 0,
              maxDistMm: 0,
              underDeviationMm: targetBleedMm !== null ? r3(targetBleedMm) : 0,
              overDeviationMm: 0,
              geometryValid: false,
              offsetWithinTolerance: false,
              worstPointMm: null,
              reasons: [reason],
            })
          );
          continue;
        }

        const a = flat(cutPoly);
        const b = flat(bleedPoly);
        const bArea = b.length >= 3 ? Math.abs(signedPolygonArea(b)) : 0;
        const bSi = b.length >= 4 ? countPolySelfIntersections(b) : 0;
        bleedSelfIntersections += bSi;

        let bad = b.length < 3 || bArea < 0.01 || bSi > 0 || (a.length >= 3 && a.some((p) => !insideValidation(p, b)));
        for (let j = 0; j < a.length && !bad; j++) {
          for (let k = 0; k < b.length; k++) {
            if (segmentsIntersect(a[j], a[(j + 1) % a.length], b[k], b[(k + 1) % b.length])) {
              bad = true;
              break;
            }
          }
        }
        if (bad) {
          bleedCoverageIssues.push(stickerNum);
          const reason = bSi > 0 ? `BLEED tự giao (${bSi})` : 'BLEED không bao phủ hết CUT hoặc cắt chéo CUT';
          bleedIssues.push({ sticker: stickerNum, reason });
          errors.push(`Tem #${stickerNum}: ${reason}`);
          bleedDiagnostics.push(
            makeDiagEntry({
              stickerNum,
              tier: bleedPoly?.fallbackTier ?? 1,
              method: bleedPoly?.fallbackMethod ?? 'unknown',
              targetMm: targetBleedMm,
              minDistMm: 0,
              avgDistMm: 0,
              maxDistMm: 0,
              underDeviationMm: targetBleedMm !== null ? r3(targetBleedMm) : 0,
              overDeviationMm: 0,
              geometryValid: false,
              offsetWithinTolerance: false,
              worstPointMm: null,
              reasons: [reason],
            })
          );
        } else if (a.length >= 3 && b.length >= 3) {
          const metrics = measureCutToBleedMetricsMm(a, b, targetBleedMm, offsetToleranceOverMm);
          const dMin = r3(metrics.minDistMm);
          const dMax = r3(metrics.maxDistMm);
          const dAvg = r3(metrics.avgDistMm);
          const underDeviationMm = targetBleedMm !== null ? r3(Math.max(0, targetBleedMm - metrics.minDistMm)) : 0;
          const overDeviationMm = targetBleedMm !== null ? r3(Math.max(0, metrics.maxDistMm - targetBleedMm)) : 0;
          const checkTarget = targetBleedMm !== null && targetBleedMm > 0.05;
          const underFail = checkTarget && metrics.minDistMm < minAllowedMm - 1e-6;
          const hasOver = checkTarget && overDeviationMm > offsetToleranceOverMm + 1e-6;
          const sustainedOverFail =
            hasOver &&
            (metrics.avgDistMm > targetBleedMm + offsetToleranceOverMm + 1e-6 ||
              metrics.overRatio > maxLocalOverRatio ||
              metrics.maxOverRunPercent > maxLocalOverRunPercent ||
              overDeviationMm > hardOverLimitMm);
          const localOverWarning = hasOver && !sustainedOverFail;
          const overClassification = !hasOver ? 'NONE' : sustainedOverFail ? 'SUSTAINED_OVER' : 'LOCAL_CORNER_OVER';
          const withinTolerance = !underFail && !sustainedOverFail;
          const tier = bleedPoly?.fallbackTier ?? 1;
          const method = bleedPoly?.fallbackMethod ?? 'unknown';
          const itemReasons = [];
          if (underFail) {
            const msg = `BLEED thiếu ${underDeviationMm}mm so với mục tiêu ${targetBleedMm}mm (vượt dung sai -${offsetToleranceUnderMm}mm)`;
            itemReasons.push(msg);
            offsetToleranceIssues.push({
              sticker: stickerNum,
              issueType: 'under',
              minDistMm: dMin,
              avgDistMm: dAvg,
              maxDistMm: dMax,
              targetMm: targetBleedMm,
              deficitMm: underDeviationMm,
              maxUnderMm: underDeviationMm,
              maxOverMm: overDeviationMm,
              toleranceUnderMm: offsetToleranceUnderMm,
              toleranceOverMm: offsetToleranceOverMm,
            });
            warnings.push(`Tem #${stickerNum}: ${msg}`);
          }
          if (sustainedOverFail) {
            const pct = Math.round(metrics.overRatio * 1000) / 10;
            const runPct = Math.round(metrics.maxOverRunPercent * 10) / 10;
            const msg = `BLEED dư kéo dài/bất thường (+${overDeviationMm}mm, TB ${dAvg}mm, ${pct}% chu vi, vùng dài nhất ${runPct}% / ${r3(metrics.maxOverRunMm)}mm, ${metrics.overRegionCount} vùng)`;
            itemReasons.push(msg);
            offsetToleranceIssues.push({
              sticker: stickerNum,
              issueType: 'sustained_over',
              minDistMm: dMin,
              avgDistMm: dAvg,
              maxDistMm: dMax,
              targetMm: targetBleedMm,
              deficitMm: underDeviationMm,
              maxUnderMm: underDeviationMm,
              maxOverMm: overDeviationMm,
              overRatio: r3(metrics.overRatio),
              maxOverRunMm: r3(metrics.maxOverRunMm),
              maxOverRunPercent: runPct,
              overRegionCount: metrics.overRegionCount,
              toleranceUnderMm: offsetToleranceUnderMm,
              toleranceOverMm: offsetToleranceOverMm,
            });
            warnings.push(`Tem #${stickerNum}: ${msg}`);
          } else if (localOverWarning) {
            const pct = Math.round(metrics.overRatio * 1000) / 10;
            const runPct = Math.round(metrics.maxOverRunPercent * 10) / 10;
            itemReasons.push(
              `LOCAL_CORNER_OVER (+${overDeviationMm}mm, ${pct}% chu vi, vùng dài nhất ${runPct}% / ${r3(metrics.maxOverRunMm)}mm, ${metrics.overRegionCount} vùng)`
            );
          }
          if (tier === 2) {
            itemReasons.push(`Đã dùng Fallback Tầng 2 (${method})`);
          }
          bleedDistancesMm.push({ sticker: stickerNum, minDistMm: dMin, maxDistMm: dMax, avgDistMm: dAvg });
          bleedDiagnostics.push(
            makeDiagEntry({
              stickerNum,
              tier,
              method,
              targetMm: targetBleedMm,
              minDistMm: dMin,
              avgDistMm: dAvg,
              maxDistMm: dMax,
              underDeviationMm,
              overDeviationMm,
              overRatio: metrics.overRatio,
              maxOverRunMm: metrics.maxOverRunMm,
              maxOverRunPercent: metrics.maxOverRunPercent,
              overRegionCount: metrics.overRegionCount,
              overClassification,
              geometryValid: true,
              offsetWithinTolerance: withinTolerance,
              worstPointMm: metrics.worstPointMm,
              reasons: itemReasons,
            })
          );
          if (minCutBleedDistMm === null || dMin < minCutBleedDistMm) minCutBleedDistMm = dMin;
          if (maxCutBleedDistMm === null || dMax > maxCutBleedDistMm) maxCutBleedDistMm = dMax;
          if (underDeviationMm > maxUnderMmSheet) maxUnderMmSheet = underDeviationMm;
          if (overDeviationMm > maxOverMmSheet) maxOverMmSheet = overDeviationMm;
          sumAvgCutBleedDistMm += metrics.avgDistMm;
          avgDistCount++;
        } else {
          const reason = 'CUT hoặc BLEED suy biến (< 3 điểm hợp lệ)';
          bleedCoverageIssues.push(stickerNum);
          bleedIssues.push({ sticker: stickerNum, reason });
          errors.push(`Tem #${stickerNum}: ${reason}`);
          bleedDiagnostics.push(
            makeDiagEntry({
              stickerNum,
              tier: bleedPoly?.fallbackTier ?? 3,
              method: bleedPoly?.fallbackMethod ?? 'none',
              targetMm: targetBleedMm,
              minDistMm: 0,
              avgDistMm: 0,
              maxDistMm: 0,
              underDeviationMm: targetBleedMm !== null ? r3(targetBleedMm) : 0,
              overDeviationMm: 0,
              geometryValid: false,
              offsetWithinTolerance: false,
              worstPointMm: null,
              reasons: [reason],
            })
          );
        }

        const bb = contourBoundsMm(bleedPoly);
        if (bb.valid) bleedBboxes.push({ idx: i, minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY, poly: bleedPoly });
      } catch (diagErr) {
        const reason = `Lỗi chẩn đoán BLEED: ${diagErr?.message || String(diagErr)}`;
        bleedCoverageIssues.push(stickerNum);
        bleedIssues.push({ sticker: stickerNum, reason });
        errors.push(`Tem #${stickerNum}: ${reason}`);
        bleedDiagnostics.push(
          makeDiagEntry({
            stickerNum,
            tier: 3,
            method: 'error',
            targetMm: targetBleedMm,
            minDistMm: 0,
            avgDistMm: 0,
            maxDistMm: 0,
            underDeviationMm: targetBleedMm !== null ? r3(targetBleedMm) : 0,
            overDeviationMm: 0,
            geometryValid: false,
            offsetWithinTolerance: false,
            worstPointMm: null,
            reasons: [reason],
          })
        );
      }
    }
  }

  // 4. Pairwise BLEED overlaps (warning only — common & acceptable when stickers are close on a sheet)
  const bleedOverlaps = [];
  for (let i = 0; i < bleedBboxes.length; i++) {
    for (let j = i + 1; j < bleedBboxes.length; j++) {
      const A = bleedBboxes[i];
      const B = bleedBboxes[j];
      if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) continue;
      const pA = flat(A.poly);
      const pB = flat(B.poly);
      let hit = false;
      for (let ia = 0; ia < pA.length && !hit; ia++) {
        for (let ib = 0; ib < pB.length; ib++) {
          if (segmentsIntersect(pA[ia], pA[(ia + 1) % pA.length], pB[ib], pB[(ib + 1) % pB.length])) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        bleedOverlaps.push([A.idx + 1, B.idx + 1]);
        warnings.push(`Tem #${A.idx + 1} và #${B.idx + 1}: Đường BLEED chạm/chồng lấn nhau`);
        for (const sNum of [A.idx + 1, B.idx + 1]) {
          const diag = bleedDiagnostics[sNum - 1];
          if (diag) {
            const other = sNum === A.idx + 1 ? B.idx + 1 : A.idx + 1;
            const msg = `Đường BLEED chạm/chồng lấn với Tem #${other}`;
            if (!diag.reasons.includes(msg)) diag.reasons.push(msg);
            if (!diag.reason) diag.reason = msg;
            if (diag.status === 'PASS') diag.status = 'WARNING';
          }
        }
      }
    }
  }

  const validBleedCount = Array.isArray(bleedContoursMm)
    ? bleedContoursMm.filter((b) => b && !b.invalid && b.length >= 3).length
    : 0;

  const geometryValid =
    count > 0 &&
    errors.length === 0 &&
    bleedCoverageIssues.length === 0 &&
    closedCount === count &&
    selfIntersections === 0 &&
    bleedSelfIntersections === 0 &&
    collisions.length === 0;
  const offsetWithinTolerance = bleedCoverageIssues.length === 0 && offsetToleranceIssues.length === 0;
  const productionReady = geometryValid && offsetWithinTolerance;
  const avgCutBleedDistMm = avgDistCount > 0 ? r3(sumAvgCutBleedDistMm / avgDistCount) : null;
  const bleedEnabled = targetBleedMm !== null && targetBleedMm > 0.05 && Array.isArray(bleedContoursMm) && bleedContoursMm.length > 0;
  const passedBleedCount = bleedEnabled
    ? bleedDiagnostics.filter((d) => d.geometryValid && d.offsetWithinTolerance).length
    : 0;
  const statusCounts = {
    pass: bleedDiagnostics.filter((d) => d.status === 'PASS').length,
    warning: bleedDiagnostics.filter((d) => d.status === 'WARNING').length,
    fail: bleedDiagnostics.filter((d) => d.status === 'FAIL').length,
  };
  const precisionSummary = {
    bleedSemantics: BLEED_SEMANTICS,
    enabled: bleedEnabled,
    targetMm: targetBleedMm,
    toleranceUnderMm: offsetToleranceUnderMm,
    toleranceOverMm: offsetToleranceOverMm,
    maxLocalOverRatio,
    totalCount: count,
    passedCount: passedBleedCount,
    failedCount: bleedEnabled ? Math.max(0, count - passedBleedCount) : 0,
    statusCounts,
    minDistMm: minCutBleedDistMm,
    maxDistMm: maxCutBleedDistMm,
    avgDistMm: avgCutBleedDistMm,
    maxUnderMm: r3(maxUnderMmSheet),
    maxOverMm: r3(maxOverMmSheet),
    maxDeficitMm: r3(maxUnderMmSheet),
    failedStickers: offsetToleranceIssues,
  };

  return {
    bleedSemantics: BLEED_SEMANTICS,
    bleedCoverageIssues,
    valid: geometryValid, // Backward-compatible flag
    geometryValid,
    offsetWithinTolerance,
    productionReady,
    offsetToleranceUnderMm,
    offsetToleranceOverMm,
    offsetToleranceIssues,
    precisionSummary,
    bleedDiagnostics,
    stickerCount: count,
    closedCount,
    bleedPathCount: validBleedCount,
    totalBezierSegments,
    totalSharpCorners,
    selfIntersections,
    bleedSelfIntersections,
    collisions,
    bleedOverlaps,
    minCutBleedDistMm,
    maxCutBleedDistMm,
    avgCutBleedDistMm,
    maxUnderMm: r3(maxUnderMmSheet),
    maxOverMm: r3(maxOverMmSheet),
    maxDeficitMm: r3(maxUnderMmSheet),
    bleedDistancesMm,
    cutIssues,
    bleedIssues,
    errors,
    warnings,
  };
}

/**
 * Full 5-Step Pipeline:
 * 1. Extract CUT mask from Alpha channel (or opaque foreground) at high resolution without destructive MORPH_CLOSE/OPEN
 * 2. Trace with 1px CHAIN_APPROX_NONE & fit Corner-Preserving Cubic Bézier (simplify ~0.45px, cornerAngleDeg ~130°)
 * 3. Create separate CUT and BLEED Cubic Bézier contours in exact mm (createCutAndBleed)
 * 4. Validate closedness, self-intersections, and pairwise collisions
 */
export function extractStickerContoursFromImage(imgElement, totalWidthMm, totalHeightMm, options = {}) {
  const {
    offsetMm = 2.0, // CutContour offset from artwork edge (mm)
    bleedOffsetMm = 1.5, // Additional outward Bleed offset from CutContour (mm); 0 = no bleed contour
    smoothLevel = 1, // 0..3 corner-locked fairing passes
    simplifyMm = 0.18, // ~0.45px at tracing resolution
    cornerAngleDeg = 130, // Preserve sharp corners <= 130°
    minAreaMm2 = 8.0,
    shapeMode = 'auto', // 'auto' | 'circle' | 'oval' | 'rect'
    ignoreCornerMarks = true,
    cornerIgnoreMm = 14,
    alphaThreshold = 28,
    bgTolerance = 26,
    mergeGapMm = 0.35, // Intra-sticker detail bridge distance (mm) before segmenting isolated stickers
    imagePlacementsMm = [],
    perStickerOverrides = {}, // { [stickerIdx]: { shapeMode: 'auto'|'rect'|'circle'|'oval', offsetDeltaMm: 0, hidden: false } }
    detailMode = 'standard', // 'standard' (default, unchanged) | 'high' (High Detail Freeform preserving concave valleys)
  } = options;

  // High-resolution tracing grid (up to 1280px so 1px ~ 0.25mm on 330x390mm sheet, fast & crisp)
  const maxDim = 1280;
  const aspect = imgElement.width / Math.max(1, imgElement.height);
  const workW = aspect >= 1 ? maxDim : Math.max(96, Math.round(maxDim * aspect));
  const workH = aspect >= 1 ? Math.max(96, Math.round(maxDim / aspect)) : maxDim;

  const pxPerMm = workW / Math.max(1, totalWidthMm);
  const maxOffsetMm = Math.max(0, offsetMm) + Math.max(0, bleedOffsetMm);
  const padPx = Math.ceil(Math.max(8, maxOffsetMm * pxPerMm + 10));
  const cw = workW + padPx * 2;
  const ch = workH + padPx * 2;

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(imgElement, padPx, padPx, workW, workH);

  const imgData = ctx.getImageData(0, 0, cw, ch).data;

  // STEP 1: Robust Alpha vs Opaque Background Detection
  // (Handles PDFs like "VŨ TRỤ SAY HI" where a white background rect covers 99% of the page leaving a 1mm transparent sliver at y=0)
  let transparentSamples = 0;
  let totalSamples = 0;
      const opaqueBorderSamples = [];
      const stepY = Math.max(1, (workH / 24) | 0);
      const stepX = Math.max(1, (workW / 24) | 0);

      for (let sy = padPx + 2; sy < padPx + workH - 2; sy += stepY) {
        for (let sx = padPx + 2; sx < padPx + workW - 2; sx += stepX) {
          totalSamples++;
          const idx4 = (sy * cw + sx) * 4;
          const a = imgData[idx4 + 3];
          if (a < 242) {
            transparentSamples++;
          } else {
            const lx = sx - padPx;
            const ly = sy - padPx;
            if (lx < workW * 0.12 || lx > workW * 0.88 || ly < workH * 0.12 || ly > workH * 0.88) {
              opaqueBorderSamples.push([imgData[idx4], imgData[idx4 + 1], imgData[idx4 + 2]]);
            }
          }
        }
      }

      // Only use pure-alpha mode if at least 15% of the page grid is genuinely transparent
      const useAlpha = transparentSamples > totalSamples * 0.15;

      // Determine true opaque background RGB (pick brightest / near-white sample from border so a transparent (0,0,0,0) corner pixel never sets bg to black!)
      let bgR = 255, bgG = 255, bgB = 255;
      if (!useAlpha && opaqueBorderSamples.length > 0) {
        opaqueBorderSamples.sort((a, b) => b[0] + b[1] + b[2] - (a[0] + a[1] + a[2]));
        const topSample = opaqueBorderSamples[Math.floor(opaqueBorderSamples.length * 0.15)] || opaqueBorderSamples[0];
        bgR = topSample[0];
        bgG = topSample[1];
        bgB = topSample[2];
      }

      let fgMask = new Uint8Array(cw * ch);

      for (let y = padPx; y < padPx + workH; y++) {
        for (let x = padPx; x < padPx + workW; x++) {
          const i4 = (y * cw + x) * 4;
          const a = imgData[i4 + 3];
          // Transparent pixels (a < alphaThreshold) are ALWAYS background (0), even when useAlpha is false!
          if (a < alphaThreshold) continue;
          if (useAlpha) {
            fgMask[y * cw + x] = 1;
          } else {
            const dr = Math.abs(imgData[i4] - bgR);
            const dg = Math.abs(imgData[i4 + 1] - bgG);
            const db = Math.abs(imgData[i4 + 2] - bgB);
              if (dr + dg + db > bgTolerance * 2) {
                fgMask[y * cw + x] = 1;
              }
            }
          }
        }

        // STEP 1A: PDF XObject-Aware Refinement (handles full rectangular photos with white floor highlights like /Im3,
        // dirty off-white JPEG boxes like /Im11-/Im12, and multi-word text banners like /Im0)
        if (Array.isArray(imagePlacementsMm) && imagePlacementsMm.length > 0) {
          for (const im of imagePlacementsMm) {
            if (im.hasSMask) continue;
            const x1 = Math.max(padPx, Math.round(padPx + im.minX * pxPerMm));
            const x2 = Math.min(padPx + workW - 1, Math.round(padPx + im.maxX * pxPerMm));
            const y1 = Math.max(padPx, Math.round(padPx + im.minY * pxPerMm));
            const y2 = Math.min(padPx + workH - 1, Math.round(padPx + im.maxY * pxPerMm));
            if (x2 - x1 < 6 || y2 - y1 < 6) continue;

            // Sample perimeter pixels of this opaque /Image XObject
            let perimTotal = 0;
            let perimFg = 0;
            const inset = 2;
            for (let x = x1 + inset; x <= x2 - inset; x += 2) {
              perimTotal += 2;
              if (fgMask[(y1 + inset) * cw + x]) perimFg++;
              if (fgMask[(y2 - inset) * cw + x]) perimFg++;
            }
            for (let y = y1 + inset; y <= y2 - inset; y += 2) {
              perimTotal += 2;
              if (fgMask[y * cw + (x1 + inset)]) perimFg++;
              if (fgMask[y * cw + (x2 - inset)]) perimFg++;
            }
            const perimRatio = perimFg / Math.max(1, perimTotal);

            if (im.isAxisAligned && perimRatio >= 0.45) {
              // Full-bleed rectangular photo sticker (e.g. /Im3 chibi stage photo):
              // Fill entire rectangle solid so white highlights touching the photo border are NEVER eaten away!
              for (let y = y1; y <= y2; y++) {
                const row = y * cw;
                for (let x = x1; x <= x2; x++) {
                  fgMask[row + x] = 1;
                }
              }
            } else if (perimRatio < 0.22) {
              // Logo / icon / text banner on a white or slightly dirty off-white JPEG rectangle:
              // 1. Clean 3px border of this XObject box so faint JPEG frame artifacts (like on /Im11, /Im12) don't trigger false edges
              for (let y = y1; y <= y2; y++) {
                for (let x = x1; x <= x2; x++) {
                  const distToBoxEdge = Math.min(x - x1, x2 - x, y - y1, y2 - y);
                  if (distToBoxEdge <= 3) {
                    const i4 = (y * cw + x) * 4;
                    const dr = Math.abs(imgData[i4] - bgR);
                    const dg = Math.abs(imgData[i4 + 1] - bgG);
                    const db = Math.abs(imgData[i4 + 2] - bgB);
                    if (dr + dg + db < bgTolerance * 3.6) {
                      fgMask[y * cw + x] = 0;
                    }
                  }
                }
              }
              // 2. If this is an isolated wide text/title banner XObject (e.g. /Im0 "VŨ TRỤ SAY HI - LAS VEGAS 2026"),
              // locally bridge disconnected letters inside this box so the whole title becomes 1 unified sticker!
              const overlapsOther = imagePlacementsMm.some(
                (other) =>
                  other !== im &&
                  !(other.maxX < im.minX + 1 || im.maxX < other.minX + 1 || other.maxY < im.minY + 1 || im.maxY < other.minY + 1)
              );
              if (!overlapsOther && im.w > 45 && im.w / Math.max(1, im.h) > 2.2) {
                const bw = x2 - x1 + 1;
                const bh = y2 - y1 + 1;
                const subMask = new Uint8Array(bw * bh);
                for (let y = 0; y < bh; y++) {
                  for (let x = 0; x < bw; x++) {
                    subMask[y * bw + x] = fgMask[(y1 + y) * cw + (x1 + x)];
                  }
                }
                const bridgePx = Math.max(3, Math.round(2.4 * pxPerMm));
                const dOut = computeDistanceField(subMask, bw, bh);
                const dDil = new Uint8Array(bw * bh);
                for (let i = 0; i < bw * bh; i++) if (dOut[i] <= bridgePx) dDil[i] = 1;
                const dClosed = fillInteriorHoles(dDil, bw, bh);
                const bgSub = new Uint8Array(bw * bh);
                for (let i = 0; i < bw * bh; i++) bgSub[i] = dClosed[i] ? 0 : 1;
                const dBack = computeDistanceField(bgSub, bw, bh);
                for (let y = 0; y < bh; y++) {
                  for (let x = 0; x < bw; x++) {
                    if (dBack[y * bw + x] > bridgePx * 0.85) {
                      fgMask[(y1 + y) * cw + (x1 + x)] = 1;
                    }
                  }
                }
              }
            }
          }
        }

        // Fill internal holes inside each sticker (1 sticker = 1 solid outer contour without MORPH_CLOSE bridging fins)
        fgMask = fillInteriorHoles(fgMask, cw, ch);

        // Optional intra-sticker micro-bridge (mergeGapMm, default 0.35mm; user can raise to e.g. 2.0mm on flat PNG/JPG with detached text)
        const bridgeRadPx = Math.max(0, Number(mergeGapMm) || 0) * 0.5 * pxPerMm;
        if (bridgeRadPx >= 0.6) {
          const dBridge = computeDistanceField(fgMask, cw, ch);
          let bDil = new Uint8Array(cw * ch);
          for (let i = 0; i < cw * ch; i++) {
            if (dBridge[i] <= bridgeRadPx) bDil[i] = 1;
          }
          bDil = fillInteriorHoles(bDil, cw, ch);
          const bgB = new Uint8Array(cw * ch);
          for (let i = 0; i < cw * ch; i++) bgB[i] = bDil[i] ? 0 : 1;
          const dErode = computeDistanceField(bgB, cw, ch);
          const bridged = new Uint8Array(cw * ch);
          for (let i = 0; i < cw * ch; i++) {
            if (fgMask[i] || dErode[i] > bridgeRadPx * 0.92) bridged[i] = 1;
          }
          fgMask = fillInteriorHoles(bridged, cw, ch);
        }

        // STEP 1B: Segment fgMask into individual connected components FIRST (at 0mm) BEFORE dilating by offsetMm or minSmoothBallPx!
        // This guarantees two stickers that are only 2mm apart (like /Im1 and /Im3) NEVER merge into a single contour when dilated!

        // CUTLINE 2.0: Join selected detached artwork components.
        // Coordinates are in page millimeters, origin at top-left.
        // Each bridge joins two foreground regions BEFORE component detection.
        if (Array.isArray(options.componentBridgesMm) && options.componentBridgesMm.length > 0) {
          for (const bridge of options.componentBridgesMm) {
            if (!bridge || !Array.isArray(bridge.from) || !Array.isArray(bridge.to)) continue;

            const [x1mm, y1mm] = bridge.from.map(Number);
            const [x2mm, y2mm] = bridge.to.map(Number);

            if (![x1mm, y1mm, x2mm, y2mm].every(Number.isFinite)) continue;

            if (
              Math.min(x1mm, x2mm) < 0 ||
              Math.min(y1mm, y2mm) < 0 ||
              Math.max(x1mm, x2mm) > totalWidthMm ||
              Math.max(y1mm, y2mm) > totalHeightMm
            ) {
              continue;
            }

            const x1 = Math.round(padPx + x1mm * pxPerMm);
            const y1 = Math.round(padPx + y1mm * pxPerMm);
            const x2 = Math.round(padPx + x2mm * pxPerMm);
            const y2 = Math.round(padPx + y2mm * pxPerMm);

            // Only join existing foreground endpoints.
            if (!fgMask[y1 * cw + x1] || !fgMask[y2 * cw + x2]) continue;

            const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
            const radius = Math.max(1, Math.round((Number(bridge.widthMm) || 0.2) * pxPerMm * 0.5));

            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              const px = Math.round(x1 + (x2 - x1) * t);
              const py = Math.round(y1 + (y2 - y1) * t);

              for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                  if (dx * dx + dy * dy > radius * radius) continue;
                  const nx = px + dx;
                  const ny = py + dy;
                  if (nx >= 0 && nx < cw && ny >= 0 && ny < ch) {
                    fgMask[ny * cw + nx] = 1;
                  }
                }
              }
            }
          }

          fgMask = fillInteriorHoles(fgMask, cw, ch);
        }

        const minAreaPx = Math.max(16, minAreaMm2 * pxPerMm * pxPerMm);
        const compVisited = new Uint8Array(cw * ch);
        const rawComponents = [];

        for (let y = 1; y < ch - 1; y++) {
          for (let x = 1; x < cw - 1; x++) {
            const startIdx = y * cw + x;
            if (!fgMask[startIdx] || compVisited[startIdx]) continue;

            const pixels = [];
            const stack = [startIdx];
            compVisited[startIdx] = 1;
            let minPX = x, maxPX = x, minPY = y, maxPY = y;

            while (stack.length > 0) {
              const cur = stack.pop();
              pixels.push(cur);
              const cx = cur % cw;
              const cy = (cur / cw) | 0;
              if (cx < minPX) minPX = cx;
              if (cx > maxPX) maxPX = cx;
              if (cy < minPY) minPY = cy;
              if (cy > maxPY) maxPY = cy;

              // 8-connected flood fill
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = cx + dx;
                  const ny = cy + dy;
                  if (nx >= 0 && nx < cw && ny >= 0 && ny < ch) {
                    const nIdx = ny * cw + nx;
                    if (fgMask[nIdx] && !compVisited[nIdx]) {
                      compVisited[nIdx] = 1;
                      stack.push(nIdx);
                    }
                  }
                }
              }
            }

            if (pixels.length < (options.smartGrouping === false ? minAreaPx : 3)) continue;

            const rawWmm = (maxPX - minPX + 1) / pxPerMm;
            const rawHmm = (maxPY - minPY + 1) / pxPerMm;
            const rawMinXmm = (minPX - padPx) / pxPerMm;
            const rawMaxXmm = (maxPX - padPx) / pxPerMm;
            const rawMinYmm = (minPY - padPx) / pxPerMm;
            const rawMaxYmm = (maxPY - padPx) / pxPerMm;
            const fillRatio = pixels.length / Math.max(1, (maxPX - minPX + 1) * (maxPY - minPY + 1));

            rawComponents.push({
              pixels,
              minPX,
              maxPX,
              minPY,
              maxPY,
              rawWmm,
              rawHmm,
              rawMinXmm,
              rawMaxXmm,
              rawMinYmm,
              rawMaxYmm,
              fillRatio,
            });
          }
        }

        let groupingReport = { merged: 0, discarded: 0, ambiguous: 0, mergedAboveNoise: 0, decisions: [] };
        if (options.smartGrouping !== false) {
          const grouped = groupStickerComponents(rawComponents, cw, ch, pxPerMm, padPx, minAreaPx, options);
          groupingReport = grouped.report;
          rawComponents.splice(0, rawComponents.length, ...grouped.kept);
        }

        // Filter out corner registration marks (L-marks) and tiny sheet-edge directional ticks (▲ < 7mm) on the un-dilated components
        const filteredComponents =
          ignoreCornerMarks && rawComponents.length > 1
            ? rawComponents.filter((comp) => {
              const cx = (comp.rawMinXmm + comp.rawMaxXmm) / 2;
              const cy = (comp.rawMinYmm + comp.rawMaxYmm) / 2;
              const cornerZoneX = Math.max(24, totalWidthMm * 0.085);
              const cornerZoneY = Math.max(24, totalHeightMm * 0.085);
              const nearLeft = cx < cornerZoneX;
              const nearRight = cx > totalWidthMm - cornerZoneX;
              const nearTop = cy < cornerZoneY;
              const nearBottom = cy > totalHeightMm - cornerZoneY;

              // 1. Corner L-marks / crop marks (hollow L-shape or small mark < 25mm in 4 corners)
              if (
                (nearLeft || nearRight) &&
                (nearTop || nearBottom) &&
                comp.rawWmm < 25 &&
                comp.rawHmm < 25 &&
                (comp.fillRatio < 0.52 || Math.min(totalWidthMm, totalHeightMm) >= 260)
              ) {
                return false;
              }

              // 2. Tiny sheet-edge directional ticks (like the 2.6x2.3mm ▲ triangle at the bottom edge of 330x390mm sheet)
              // Strictly < 7.0mm so 12x14mm star stickers (/Im8, /Im9) near sheet borders are NEVER removed!
              const onSheetBorder =
                comp.rawMinXmm < 10 ||
                comp.rawMaxXmm > totalWidthMm - 10 ||
                comp.rawMinYmm < 10 ||
                comp.rawMaxYmm > totalHeightMm - 10;
              if (onSheetBorder && comp.rawWmm < 7.0 && comp.rawHmm < 7.0) {
                return false;
              }
              return true;
            })
            : rawComponents;

        // STEP 2 & 3: For each isolated sticker component, compute its CUT contour and BLEED contour in its own private local canvas!
        const effSimplifyMm = Math.max(0.08, Math.min(simplifyMm, 0.65 / Math.max(1, pxPerMm) + simplifyMm * 0.5));
        const fitOpts = {
          simplifyTolMm: effSimplifyMm,
          cornerAngleDeg,
          smoothPasses: Math.max(0, Math.min(3, smoothLevel)),
          detailMode,
        };

        const offsetPx = offsetMm * pxPerMm;
        const minSmoothBallPx = detailMode === 'high' ? 0 : Math.max(2.2, 1.25 * pxPerMm);
        const bleedPx = Math.max(0.5, (offsetMm + bleedOffsetMm) * pxPerMm);
        const compPadPx = Math.ceil(Math.max(minSmoothBallPx, Math.abs(offsetPx), bleedPx) + 8);

        const contoursMm = [];
        const bleedContoursMm = [];
        const bleedReport = [];
        const bleedBudgetState = {
          usedPixels: 0,
          maxTotalPixels: options.maxTotalBleedPixels ?? PRECISION_BLEED_BUDGET.maxTotalPixelsPerRun,
        };

          for (let compIdx = 0; compIdx < filteredComponents.length; compIdx++) {
            const comp = filteredComponents[compIdx];
            const override = perStickerOverrides[compIdx] || {};
            if (override.hidden) continue;
            const itemShapeMode = override.shapeMode && override.shapeMode !== 'default' ? override.shapeMode : shapeMode;
            const itemOffsetMm =
              override.offsetMm !== undefined && override.offsetMm !== null && override.offsetMm !== ''
                ? Number(override.offsetMm)
                : offsetMm;
            const itemOffsetPx = itemOffsetMm * pxPerMm;
            const itemBleedPx = Math.max(0.5, (itemOffsetMm + bleedOffsetMm) * pxPerMm);

            const bw = comp.maxPX - comp.minPX + 1;
            const bh = comp.maxPY - comp.minPY + 1;
            const itemPadPx = Math.ceil(Math.max(minSmoothBallPx, Math.abs(itemOffsetPx), itemBleedPx) + 8);
            const lw = bw + itemPadPx * 2;
            const lh = bh + itemPadPx * 2;

            let locFg = new Uint8Array(lw * lh);
            for (const gIdx of comp.pixels) {
              const gx = gIdx % cw;
              const gy = (gIdx / cw) | 0;
              const lx = gx - comp.minPX + itemPadPx;
              const ly = gy - comp.minPY + itemPadPx;
              locFg[ly * lw + lx] = 1;
            }

            // Generalized Rectangular Photo Completion (works even on flat PNG/JPG without PDF XObjects!):
            // If at least 3 sides of the component's bounding box have >68% straight-edge support and fillRatio > 0.78,
            // complete any missing white highlight along the 4th edge so rectangular photos never get indented!
            if (comp.fillRatio >= 0.78 && bw >= 16 && bh >= 16) {
              let topCnt = 0, botCnt = 0, leftCnt = 0, rightCnt = 0;
              for (let x = 0; x < bw; x++) {
                if (locFg[itemPadPx * lw + (itemPadPx + x)] || locFg[(itemPadPx + 1) * lw + (itemPadPx + x)]) topCnt++;
                if (locFg[(itemPadPx + bh - 1) * lw + (itemPadPx + x)] || locFg[(itemPadPx + bh - 2) * lw + (itemPadPx + x)]) botCnt++;
              }
              for (let y = 0; y < bh; y++) {
                if (locFg[(itemPadPx + y) * lw + itemPadPx] || locFg[(itemPadPx + y) * lw + (itemPadPx + 1)]) leftCnt++;
                if (locFg[(itemPadPx + y) * lw + (itemPadPx + bw - 1)] || locFg[(itemPadPx + y) * lw + (itemPadPx + bw - 2)]) rightCnt++;
              }
              const straightSides =
                (topCnt / bw >= 0.68 ? 1 : 0) +
                (botCnt / bw >= 0.68 ? 1 : 0) +
                (leftCnt / bh >= 0.68 ? 1 : 0) +
                (rightCnt / bh >= 0.68 ? 1 : 0);
              if (straightSides >= 3 && comp.fillRatio >= 0.82) {
                for (let y = 0; y < bh; y++) {
                  const row = (itemPadPx + y) * lw + itemPadPx;
                  for (let x = 0; x < bw; x++) locFg[row + x] = 1;
                }
              }
            }

            locFg = fillInteriorHoles(locFg, lw, lh);

            // Compute Euclidean Distance Field once on this isolated component
            const distOut = computeDistanceField(locFg, lw, lh);

            // --- A. Build isolated CUT mask ---
            let locCut = locFg;
              if (detailMode === 'high') {
                if (itemOffsetPx > 0.2) {
                  locCut = new Uint8Array(lw * lh);
                  for (let i = 0; i < lw * lh; i++) {
                    if (distOut[i] <= itemOffsetPx) locCut[i] = 1;
                  }
                  locCut = fillInteriorHoles(locCut, lw, lh);
                } else if (itemOffsetPx < -0.2) {
                  const bgMask = new Uint8Array(lw * lh);
                  for (let i = 0; i < lw * lh; i++) bgMask[i] = locFg[i] ? 0 : 1;
                  const distBg = computeDistanceField(bgMask, lw, lh);
                  locCut = new Uint8Array(lw * lh);
                  const thr = Math.abs(itemOffsetPx);
                  for (let i = 0; i < lw * lh; i++) {
                    if (distBg[i] > thr) locCut[i] = 1;
                  }
                } else {
                  locCut = locFg;
                }
              } else if (itemOffsetPx >= minSmoothBallPx) {
                locCut = new Uint8Array(lw * lh);
                for (let i = 0; i < lw * lh; i++) {
                  if (distOut[i] <= itemOffsetPx) locCut[i] = 1;
                }
                locCut = fillInteriorHoles(locCut, lw, lh);
              } else if (itemOffsetPx >= -0.2) {
                let dilated = new Uint8Array(lw * lh);
                for (let i = 0; i < lw * lh; i++) {
                  if (distOut[i] <= minSmoothBallPx) dilated[i] = 1;
                }
                dilated = fillInteriorHoles(dilated, lw, lh);
                const erodePx = minSmoothBallPx - Math.max(0, itemOffsetPx);
                if (erodePx > 0.25) {
                  const bgMask = new Uint8Array(lw * lh);
                  for (let i = 0; i < lw * lh; i++) bgMask[i] = dilated[i] ? 0 : 1;
                  const distBg = computeDistanceField(bgMask, lw, lh);
                  locCut = new Uint8Array(lw * lh);
                  for (let i = 0; i < lw * lh; i++) {
                    if (distBg[i] > erodePx) locCut[i] = 1;
                  }
                } else {
                  locCut = dilated;
                }
              } else {
                const bgMask = new Uint8Array(lw * lh);
                for (let i = 0; i < lw * lh; i++) bgMask[i] = locFg[i] ? 0 : 1;
                const distBg = computeDistanceField(bgMask, lw, lh);
                locCut = new Uint8Array(lw * lh);
                const thr = Math.abs(itemOffsetPx);
                for (let i = 0; i < lw * lh; i++) {
                  if (distBg[i] > thr) locCut[i] = 1;
                }
              }

              const cutLoops = traceConnectedContoursChainNone(locCut, lw, lh, 10);
              if (cutLoops.length === 0) continue;
              cutLoops.sort((a, b) => b.length - a.length);

              const rawCutPtsMm = cutLoops[0].map(([lx, ly]) => [
                (lx - itemPadPx + comp.minPX - padPx) / pxPerMm,
                (ly - itemPadPx + comp.minPY - padPx) / pxPerMm,
              ]);

              let cutPoly;
                if (itemShapeMode !== 'auto') {
                  cutPoly = buildGeometricContourObj(rawCutPtsMm, itemShapeMode);
                } else {
                  const fitted = fitCornerPreservingBezier(rawCutPtsMm, fitOpts);
                  cutPoly = [...fitted.ptsMm];
                  Object.assign(cutPoly, fitted);
                }
                cutPoly.compIdx = compIdx;
                contoursMm.push(cutPoly);

                // --- B. Build BLEED from final CUT with 3-Tier Per-Sticker Fail-Safe & Fallback ---
                // Preserves 1:1 index alignment between contoursMm[i] and bleedContoursMm[i] at all times.
                if (bleedOffsetMm > 0.05) {
                  const stickerNum = contoursMm.length;
                  const tolUnder = Number.isFinite(Number(options.offsetToleranceUnderMm))
                    ? Math.max(0, Number(options.offsetToleranceUnderMm))
                    : PRECISION_BLEED_BUDGET.defaultOffsetToleranceUnderMm;
                  let acceptedBleed = null;
                  let tierUsed = 0;
                  let methodUsed = 'none';
                  let tierError = '';
                  let bleedMetrics = {
                    minDistMm: 0,
                    maxDistMm: 0,
                    avgDistMm: 0,
                    deficitMm: bleedOffsetMm,
                    deviationMm: bleedOffsetMm,
                    withinTolerance: false,
                    worstPointMm: null,
                  };

                  // Tier 1: Geometric exact expansion OR Precision Offset from final CUT
                  try {
                    if (typeof options.__faultInjector === 'function') {
                      options.__faultInjector({ tier: 1, stickerIndex: stickerNum, compIdx });
                    }
                    const cand1 =
                      itemShapeMode !== 'auto'
                        ? buildGeometricContourObj(
                            cutPoly.map(([x, y]) => [x, y]),
                            itemShapeMode,
                            bleedOffsetMm
                          )
                        : precisionBleedFromCut(cutPoly, bleedOffsetMm, {
                            ...fitOpts,
                            budgetState: bleedBudgetState,
                            maxScalePxPerMm: options.maxScalePxPerMm,
                            maxPixelsPerSticker: options.maxPixelsPerSticker,
                            maxCanvasEdgePx: options.maxCanvasEdgePx,
                          });
                    const check1 = validateSingleBleedAgainstCut(cutPoly, cand1, bleedOffsetMm, tolUnder);
                    if (check1.valid) {
                      acceptedBleed = cand1;
                      tierUsed = 1;
                      methodUsed = itemShapeMode !== 'auto' ? `geometric-${itemShapeMode}` : 'precision';
                      bleedMetrics = {
                        minDistMm: check1.minDistMm,
                        maxDistMm: check1.maxDistMm,
                        avgDistMm: check1.avgDistMm,
                        deficitMm: check1.deficitMm,
                        deviationMm: check1.deviationMm,
                        withinTolerance: check1.withinTolerance,
                        worstPointMm: check1.worstPointMm,
                      };
                    } else {
                      tierError = `Tier 1 không đạt kiểm định: ${check1.reasons.join('; ')}`;
                    }
                  } catch (err1) {
                    tierError = `Tier 1 lỗi: ${err1?.message || String(err1)}`;
                  }

                  // Tier 2: Stable Polygon Normal Offset fallback (for Freeform or failed Tier 1)
                  if (!acceptedBleed) {
                    try {
                      if (typeof options.__faultInjector === 'function') {
                        options.__faultInjector({ tier: 2, stickerIndex: stickerNum, compIdx });
                      }
                      const cand2 = offsetPolygonAndFitBezierMm(cutPoly, bleedOffsetMm, fitOpts);
                      const check2 = validateSingleBleedAgainstCut(cutPoly, cand2, bleedOffsetMm, tolUnder);
                      if (check2.valid) {
                        acceptedBleed = cand2;
                        tierUsed = 2;
                        methodUsed = 'polygon-offset-fallback';
                        bleedMetrics = {
                          minDistMm: check2.minDistMm,
                          maxDistMm: check2.maxDistMm,
                          avgDistMm: check2.avgDistMm,
                          deficitMm: check2.deficitMm,
                          deviationMm: check2.deviationMm,
                          withinTolerance: check2.withinTolerance,
                          worstPointMm: check2.worstPointMm,
                        };
                      } else {
                        tierError = `${tierError} | Tier 2 không đạt: ${check2.reasons.join('; ')}`;
                      }
                    } catch (err2) {
                      tierError = `${tierError} | Tier 2 lỗi: ${err2?.message || String(err2)}`;
                    }
                  }

                  // Tier 3: Preserve CUT & 1:1 index alignment with explicit invalid BLEED sentinel (never silently fake BLEED)
                  if (acceptedBleed) {
                    acceptedBleed.compIdx = compIdx;
                    acceptedBleed.fallbackTier = tierUsed;
                    acceptedBleed.fallbackMethod = methodUsed;
                    bleedContoursMm.push(acceptedBleed);
                    bleedReport.push({
                      stickerIndex: stickerNum,
                      compIdx,
                      bleedSemantics: BLEED_SEMANTICS,
                      targetMm: bleedOffsetMm,
                      tier: tierUsed,
                      method: methodUsed,
                      valid: true,
                      withinTolerance: bleedMetrics.withinTolerance,
                      minDistMm: bleedMetrics.minDistMm,
                      maxDistMm: bleedMetrics.maxDistMm,
                      avgDistMm: bleedMetrics.avgDistMm,
                      deficitMm: bleedMetrics.deficitMm,
                      deviationMm: bleedMetrics.deviationMm,
                      worstPointMm: bleedMetrics.worstPointMm,
                      warning: tierUsed === 2 ? tierError : null,
                      error: null,
                    });
                  } else {
                    const invalidSentinel = Object.assign([], {
                      invalid: true,
                      closed: false,
                      beziersMm: [],
                      compIdx,
                      fallbackTier: 3,
                      fallbackMethod: 'none',
                      error: tierError || 'Không thể tạo đường BLEED hợp lệ',
                    });
                    bleedContoursMm.push(invalidSentinel);
                    bleedReport.push({
                      stickerIndex: stickerNum,
                      compIdx,
                      bleedSemantics: BLEED_SEMANTICS,
                      targetMm: bleedOffsetMm,
                      tier: 3,
                      method: 'none',
                      valid: false,
                      withinTolerance: false,
                      minDistMm: 0,
                      maxDistMm: 0,
                      avgDistMm: 0,
                      deficitMm: bleedOffsetMm,
                      deviationMm: bleedOffsetMm,
                      worstPointMm: null,
                      warning: null,
                      error: invalidSentinel.error,
                    });
                  }
                }
                  }

                  // STEP 4: Geometric Validation (CUT & BLEED validated separately + configurable under/over offset tolerance)
                  const validation = validateContoursGeometry(contoursMm, bleedContoursMm, totalWidthMm, totalHeightMm, {
                    targetBleedMm: bleedOffsetMm > 0.05 ? bleedOffsetMm : null,
                    offsetToleranceUnderMm: options.offsetToleranceUnderMm,
                    offsetToleranceOverMm: options.offsetToleranceOverMm,
                    maxLocalOverRatio: options.maxLocalOverRatio,
                    hardOverLimitMm: options.hardOverLimitMm,
                  });
                  for (let bi = 0; bi < bleedReport.length; bi++) {
                    const br = bleedReport[bi];
                    const diag = validation.bleedDiagnostics?.[bi];
                    if (diag) {
                      br.index = diag.index;
                      br.maxUnderMm = diag.maxUnderMm;
                      br.maxOverMm = diag.maxOverMm;
                      br.underDeviationMm = diag.underDeviationMm;
                      br.overDeviationMm = diag.overDeviationMm;
                      br.overRatio = diag.overRatio;
                      br.maxOverRunMm = diag.maxOverRunMm;
                      br.maxOverRunPercent = diag.maxOverRunPercent;
                      br.overRegionCount = diag.overRegionCount;
                      br.overClassification = diag.overClassification;
                      br.geometryValid = diag.geometryValid;
                      br.offsetWithinTolerance = diag.offsetWithinTolerance;
                      br.status = diag.status;
                      br.reasons = diag.reasons;
                    }
                    if (br.tier === 2 && br.warning) {
                      validation.warnings.push(`Tem #${br.stickerIndex}: Đã dùng Fallback Tầng 2 (${br.method}) — ${br.warning}`);
                    }
                  }

                  // Attach bleedContoursMm, bleedReport & validation metadata directly onto the returned array so existing callers remain 100% compatible
                  Object.assign(contoursMm, {
                    bleedContoursMm,
                    bleedReport,
                    bleedBudgetUsedPx: bleedBudgetState.usedPixels,
                    validation,
                    groupingReport,
                    pxPerMm,
                  });

                  return contoursMm;
                }

                /**
                 * STEP 5 Helper: Write ONE single closed Cubic Bézier path (m ... c ... l ... h S) to a pdf-lib PDFPage.
                 * Never splits a contour into hundreds of disconnected page.drawLine segments!
                 */
                export function drawClosedBezierContourOnPdfPage(page, polyOrContour, transformMmToPdfPt, options = {}) {
                  const {
                    color = cmyk(0, 1, 0, 0),
                    thicknessPt = 0.35,
                  } = options;

                  const beziers = polyOrContour?.beziersMm;
                  const ops = [
                    pushGraphicsState(),
                    setStrokingColor(color),
                    setLineWidth(thicknessPt),
                    setLineJoin(LineJoinStyle.Round),
                    setLineCap(LineCapStyle.Round),
                  ];

                  if (Array.isArray(beziers) && beziers.length >= 2) {
                    for (const cmd of beziers) {
                      if (cmd.type === 'M') {
                        const [x, y] = transformMmToPdfPt(cmd.to[0], cmd.to[1]);
                        ops.push(moveTo(x, y));
                      } else if (cmd.type === 'L') {
                        const [x, y] = transformMmToPdfPt(cmd.to[0], cmd.to[1]);
                        ops.push(lineTo(x, y));
                      } else if (cmd.type === 'C') {
                        const [x1, y1] = transformMmToPdfPt(cmd.c1[0], cmd.c1[1]);
                        const [x2, y2] = transformMmToPdfPt(cmd.c2[0], cmd.c2[1]);
                        const [x3, y3] = transformMmToPdfPt(cmd.to[0], cmd.to[1]);
                        ops.push(appendBezierCurve(x1, y1, x2, y2, x3, y3));
                      }
                    }
                    ops.push(closePath(), stroke(), popGraphicsState());
                    page.pushOperators(...ops);
                    return;
                  }

                  // Fallback if only ptsMm array is provided: fit corner-preserving Cubic Bézier on the fly so PDF still gets 1 closed Bézier path!
                  const pts = Array.isArray(polyOrContour) ? polyOrContour : polyOrContour?.ptsMm || [];
                  if (pts.length < 2) return;
                  const fitted = pts.length >= 3 ? fitCornerPreservingBezier(pts) : null;
                  if (fitted && fitted.beziersMm && fitted.beziersMm.length >= 2) {
                    for (const cmd of fitted.beziersMm) {
                      if (cmd.type === 'M') {
                        const [x, y] = transformMmToPdfPt(cmd.to[0], cmd.to[1]);
                        ops.push(moveTo(x, y));
                      } else if (cmd.type === 'C') {
                        const [x1, y1] = transformMmToPdfPt(cmd.c1[0], cmd.c1[1]);
                        const [x2, y2] = transformMmToPdfPt(cmd.c2[0], cmd.c2[1]);
                        const [x3, y3] = transformMmToPdfPt(cmd.to[0], cmd.to[1]);
                        ops.push(appendBezierCurve(x1, y1, x2, y2, x3, y3));
                      }
                    }
                  } else {
                    const [sx, sy] = transformMmToPdfPt(pts[0][0], pts[0][1]);
                    ops.push(moveTo(sx, sy));
                    for (let i = 1; i < pts.length; i++) {
                      const [lx, ly] = transformMmToPdfPt(pts[i][0], pts[i][1]);
                      ops.push(lineTo(lx, ly));
                    }
                  }
                  ops.push(closePath(), stroke(), popGraphicsState());
                  page.pushOperators(...ops);
                }

                /**
                 * Generate a 4-side Bleed PDF from a source Canvas/Image or PDF at full 300 DPI, setting TrimBox & BleedBox properly
                 */
                export async function exportBleedExtendedPdf({
                  sourceType, // 'pdf' | 'image'
                  sourceFile,
                  renderedCanvas,
                  trimWmm,
                  trimHmm,
                  bleedEdges, // { top, bottom, left, right } in mm
                  fillMode, // 'mirror' | 'stretch' | 'solid'
                  solidColorHex = '#ffffff',
                }) {
                  const doc = await PDFDocument.create();
                  const bL = Math.max(0, Number(bleedEdges.left) || 0);
                  const bR = Math.max(0, Number(bleedEdges.right) || 0);
                  const bT = Math.max(0, Number(bleedEdges.top) || 0);
                  const bB = Math.max(0, Number(bleedEdges.bottom) || 0);

                  const mediaWmm = trimWmm + bL + bR;
                  const mediaHmm = trimHmm + bT + bB;
                  const mediaWPt = mediaWmm * MM_TO_PT;
                  const mediaHPt = mediaHmm * MM_TO_PT;

                  // Build composite bleed canvas at 300 DPI (11.811 px/mm, capped safely at 4800px)
                  const dpiScale = Math.min(PX_PER_MM_300DPI, 4800 / Math.max(1, mediaWmm, mediaHmm));
                  const outW = Math.max(20, Math.round(mediaWmm * dpiScale));
                  const outH = Math.max(20, Math.round(mediaHmm * dpiScale));
                  const c = document.createElement('canvas');
                  c.width = outW;
                  c.height = outH;
                  const ctx = c.getContext('2d');

                  const x0 = bL * dpiScale;
                  const y0 = bT * dpiScale;
                  const w0 = trimWmm * dpiScale;
                  const h0 = trimHmm * dpiScale;

                  if (fillMode === 'solid') {
                    ctx.fillStyle = solidColorHex;
                    ctx.fillRect(0, 0, outW, outH);
                  } else {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, outW, outH);

                    const sw = renderedCanvas.width;
                    const sh = renderedCanvas.height;

                    if (fillMode === 'mirror') {
                      if (bL > 0) {
                        const stripW = Math.min(sw, Math.max(2, Math.round((bL / trimWmm) * sw)));
                        ctx.save();
                        ctx.translate(x0, y0);
                        ctx.scale(-1, 1);
                        ctx.drawImage(renderedCanvas, 0, 0, stripW, sh, 0, 0, x0, h0);
                        ctx.restore();
                      }
                      if (bR > 0) {
                        const stripW = Math.min(sw, Math.max(2, Math.round((bR / trimWmm) * sw)));
                        ctx.save();
                        ctx.translate(x0 + w0 + bR * dpiScale, y0);
                        ctx.scale(-1, 1);
                        ctx.drawImage(renderedCanvas, sw - stripW, 0, stripW, sh, 0, 0, bR * dpiScale, h0);
                        ctx.restore();
                      }
                      if (bT > 0) {
                        const stripH = Math.min(sh, Math.max(2, Math.round((bT / trimHmm) * sh)));
                        ctx.save();
                        ctx.translate(x0, y0);
                        ctx.scale(1, -1);
                        ctx.drawImage(renderedCanvas, 0, 0, sw, stripH, 0, 0, w0, y0);
                        ctx.restore();
                      }
                      if (bB > 0) {
                        const stripH = Math.min(sh, Math.max(2, Math.round((bB / trimHmm) * sh)));
                        ctx.save();
                        ctx.translate(x0, y0 + h0 + bB * dpiScale);
                        ctx.scale(1, -1);
                        ctx.drawImage(renderedCanvas, 0, sh - stripH, sw, stripH, 0, 0, w0, bB * dpiScale);
                        ctx.restore();
                      }
                    } else {
                      if (bL > 0) ctx.drawImage(renderedCanvas, 0, 0, 2, sh, 0, y0, x0, h0);
                      if (bR > 0) ctx.drawImage(renderedCanvas, sw - 2, 0, 2, sh, x0 + w0, y0, bR * dpiScale, h0);
                      if (bT > 0) ctx.drawImage(renderedCanvas, 0, 0, sw, 2, x0, 0, w0, y0);
                      if (bB > 0) ctx.drawImage(renderedCanvas, 0, sh - 2, sw, 2, x0, y0 + h0, w0, bB * dpiScale);
                    }

                    if (bL > 0 && bT > 0) ctx.drawImage(renderedCanvas, 0, 0, 2, 2, 0, 0, x0, y0);
                    if (bR > 0 && bT > 0) ctx.drawImage(renderedCanvas, sw - 2, 0, 2, 2, x0 + w0, 0, bR * dpiScale, y0);
                    if (bL > 0 && bB > 0) ctx.drawImage(renderedCanvas, 0, sh - 2, 2, 2, 0, y0 + h0, x0, bB * dpiScale);
                    if (bR > 0 && bB > 0) ctx.drawImage(renderedCanvas, sw - 2, sh - 2, 2, 2, x0 + w0, y0 + h0, bR * dpiScale, bB * dpiScale);
                  }

                  const page = doc.addPage([mediaWPt, mediaHPt]);
                  page.setTrimBox(bL * MM_TO_PT, bB * MM_TO_PT, trimWmm * MM_TO_PT, trimHmm * MM_TO_PT);
                  page.setBleedBox(0, 0, mediaWPt, mediaHPt);

                  const bleedPngBytes = await (await fetch(c.toDataURL('image/png'))).arrayBuffer();
                  const bleedImg = await doc.embedPng(bleedPngBytes);
                  page.drawImage(bleedImg, { x: 0, y: 0, width: mediaWPt, height: mediaHPt });

                  if (sourceType === 'pdf' && sourceFile) {
                    const srcBytes = await sourceFile.arrayBuffer();
                    const srcDoc = await PDFDocument.load(srcBytes);
                    const [embedded] = await doc.embedPages([srcDoc.getPages()[0]]);
                    page.drawPage(embedded, {
                      x: bL * MM_TO_PT,
                      y: bB * MM_TO_PT,
                      width: trimWmm * MM_TO_PT,
                      height: trimHmm * MM_TO_PT,
                    });
                  } else {
                    const origBytes = await (await fetch(renderedCanvas.toDataURL('image/png'))).arrayBuffer();
                    const origImg = await doc.embedPng(origBytes);
                    page.drawImage(origImg, {
                      x: bL * MM_TO_PT,
                      y: bB * MM_TO_PT,
                      width: trimWmm * MM_TO_PT,
                      height: trimHmm * MM_TO_PT,
                    });
                  }

                  return await doc.save();
                }

                /**
                 * STEP 5: Export 1:1 PDF with 300 DPI Image (or native Vector PDF page) +
                 * Exact N Closed Cubic Bézier Paths for CUT (Magenta) and BLEED (Cyan).
                 */
                export async function exportContourTracedPdf(
                  renderedCanvas,
                  widthMm,
                  heightMm,
                  contoursMm,
                  padMm = 6,
                  options = {}
                ) {
                  const {
                    sourceType = 'image',
                    sourceFile = null,
                    activePdfPage = 1,
                    includeBleedContour = true,
                  } = options;

                  const doc = await PDFDocument.create();
                  const sheetW = (widthMm + padMm * 2) * MM_TO_PT;
                  const sheetH = (heightMm + padMm * 2) * MM_TO_PT;
                  const page = doc.addPage([sheetW, sheetH]);
                  page.setCropBox(0, 0, sheetW, sheetH);
                  page.setBleedBox(0, 0, sheetW, sheetH);
                  page.setTrimBox(padMm * MM_TO_PT, padMm * MM_TO_PT, widthMm * MM_TO_PT, heightMm * MM_TO_PT);

                  if (sourceType === 'pdf' && sourceFile) {
                    // Embed native vector PDF page (infinite resolution) + 300 DPI fallback if needed
                    try {
                      const srcBytes = await sourceFile.arrayBuffer();
                      const srcDoc = await PDFDocument.load(srcBytes);
                      const srcPages = srcDoc.getPages();
                      const targetPage = srcPages[Math.max(0, Math.min(srcPages.length - 1, (activePdfPage || 1) - 1))];
                      const [embedded] = await doc.embedPages([targetPage]);
                      page.drawPage(embedded, {
                        x: padMm * MM_TO_PT,
                        y: padMm * MM_TO_PT,
                        width: widthMm * MM_TO_PT,
                        height: heightMm * MM_TO_PT,
                      });
                    } catch {
                      const pngBytes = await (await fetch(renderedCanvas.toDataURL('image/png'))).arrayBuffer();
                      const img = await doc.embedPng(pngBytes);
                      page.drawImage(img, {
                        x: padMm * MM_TO_PT,
                        y: padMm * MM_TO_PT,
                        width: widthMm * MM_TO_PT,
                        height: heightMm * MM_TO_PT,
                      });
                    }
                  } else {
                    const pngBytes = await (await fetch(renderedCanvas.toDataURL('image/png'))).arrayBuffer();
                    const img = await doc.embedPng(pngBytes);
                    page.drawImage(img, {
                      x: padMm * MM_TO_PT,
                      y: padMm * MM_TO_PT,
                      width: widthMm * MM_TO_PT,
                      height: heightMm * MM_TO_PT,
                    });
                  }

                  const toPdfPt = (xMm, yMm) => [(padMm + xMm) * MM_TO_PT, sheetH - (padMm + yMm) * MM_TO_PT];

                  // 1. Draw BLEED Layer first (Cyan CMYK 1,0,0,0) as N independent closed Cubic Bézier paths
                  const bleedContours = contoursMm?.bleedContoursMm || [];
                  if (includeBleedContour && bleedContours.length > 0) {
                    const invalidIndices = [];
                    bleedContours.forEach((bp, i) => {
                      if (!bp || bp.invalid || (bp.length < 3 && !bp.beziersMm?.length)) invalidIndices.push(i + 1);
                    });
                    if (invalidIndices.length > 0 && !options.allowInvalidBleed) {
                      throw new Error(`Không thể xuất PDF: Tem #${invalidIndices.join(', #')} có đường BLEED chưa hợp lệ`);
                    }
                    const cyanBleed = cmyk(1, 0, 0, 0);
                    for (const bleedPoly of bleedContours) {
                      if (!bleedPoly || bleedPoly.invalid) continue;
                      drawClosedBezierContourOnPdfPage(page, bleedPoly, toPdfPt, {
                        color: cyanBleed,
                        thicknessPt: 0.3,
                      });
                    }
                  }

                  // 2. Draw CUT Layer on top (Magenta CMYK 0,1,0,0) as N independent closed Cubic Bézier paths
                  const magentaCut = cmyk(0, 1, 0, 0);
                  for (const cutPoly of contoursMm) {
                    drawClosedBezierContourOnPdfPage(page, cutPoly, toPdfPt, {
                      color: magentaCut,
                      thicknessPt: 0.35,
                    });
                  }

                  return await doc.save();
                }

                async function canvasToPngArrayBuffer(canvas) {
                  if (typeof canvas.toBlob === 'function') {
                    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
                    if (blob) return await blob.arrayBuffer();
                  }
                  const dataUrl = canvas.toDataURL('image/png');
                  if (typeof fetch === 'function') {
                    return await (await fetch(dataUrl)).arrayBuffer();
                  }
                  const base64 = dataUrl.split(',')[1] || '';
                  const bin = atob(base64);
                  const out = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                  return out.buffer;
                }

                /**
                 * Split a multi-sticker sheet into a multi-page 300 DPI PDF (1 sticker per page, masked cleanly to its Bleed/Cut contour).
                 * Cutline Engine 3.1.1: Pre-validates ALL stickers before creating PDF, uses exact cubic Bézier bounds,
                 * blocks production export on invalid required BLEED or degenerate dimensions, and releases offscreen canvases.
                 */
                export async function exportSplitStickersPdf(
                  renderedCanvas,
                  totalWidthMm,
                  totalHeightMm,
                  contoursMm,
                  bleedPadMm = 1.5,
                  options = {}
                ) {
                  const { allowInvalidBleed = false } = options;
                  if (!renderedCanvas || !Number.isFinite(renderedCanvas.width) || renderedCanvas.width <= 0 || !Number.isFinite(renderedCanvas.height) || renderedCanvas.height <= 0) {
                    throw new RangeError('exportSplitStickersPdf: Ảnh nguồn không hợp lệ');
                  }
                  if (!Number.isFinite(totalWidthMm) || totalWidthMm <= 0 || !Number.isFinite(totalHeightMm) || totalHeightMm <= 0) {
                    throw new RangeError('exportSplitStickersPdf: Kích thước tờ nguồn (mm) không hợp lệ');
                  }
                  if (!Array.isArray(contoursMm) || contoursMm.length === 0) {
                    throw new Error('exportSplitStickersPdf: Không có tem nào để xuất PDF');
                  }

                  const pad = Math.max(0, Number(bleedPadMm) || 0);
                  const bleedList = Array.isArray(contoursMm?.bleedContoursMm) ? contoursMm.bleedContoursMm : [];
                  const hasBleedList = bleedList.length > 0;
                  const guard = 0.1; // includes half of 0.30 pt stroke + rounding margin

                  // Pre-flight validation of ALL stickers before creating PDF (never silently drop a sticker)
                  const stickerSpecs = [];
                  const preflightErrors = [];

                  for (let idx = 0; idx < contoursMm.length; idx++) {
                    const stickerNum = idx + 1;
                    const poly = contoursMm[idx];
                    if (!poly || !hasAllFiniteCoords(poly) || (poly.length < 3 && !poly.beziersMm?.length)) {
                      preflightErrors.push(`Tem #${stickerNum}: Đường CUT không hợp lệ hoặc rỗng`);
                      continue;
                    }
                    const bleedPoly = hasBleedList ? bleedList[idx] : null;
                    if (hasBleedList && (!bleedPoly || bleedPoly.invalid || !hasAllFiniteCoords(bleedPoly))) {
                      if (!allowInvalidBleed) {
                        preflightErrors.push(`Tem #${stickerNum}: Đường BLEED bắt buộc chưa hợp lệ (${bleedPoly?.error || 'thiếu dữ liệu'})`);
                        continue;
                      }
                    }

                    const validBleed = bleedPoly && !bleedPoly.invalid && (bleedPoly.length >= 3 || bleedPoly.beziersMm?.length >= 2) ? bleedPoly : null;
                    const clipPoly = validBleed || poly;

                    const cutBounds = contourBoundsMm(poly);
                    const bb = contourBoundsMm(clipPoly);
                    if (!cutBounds.valid || !bb.valid) {
                      preflightErrors.push(`Tem #${stickerNum}: Không tính được bounding box hữu hạn`);
                      continue;
                    }

                    const trimW = cutBounds.width;
                    const trimH = cutBounds.height;
                    if (
                      !Number.isFinite(trimW) ||
                      !Number.isFinite(trimH) ||
                      trimW < PRECISION_BLEED_BUDGET.minStickerSizeMm ||
                      trimH < PRECISION_BLEED_BUDGET.minStickerSizeMm ||
                      trimW > PRECISION_BLEED_BUDGET.maxStickerSizeMm ||
                      trimH > PRECISION_BLEED_BUDGET.maxStickerSizeMm
                    ) {
                      preflightErrors.push(`Tem #${stickerNum}: Kích thước không hợp lệ (${trimW.toFixed(2)}×${trimH.toFixed(2)} mm)`);
                      continue;
                    }

                    const minX = Math.min(cutBounds.minX - pad, bb.minX) - guard;
                    const minY = Math.min(cutBounds.minY - pad, bb.minY) - guard;
                    const pageWmm = Math.max(cutBounds.maxX + pad, bb.maxX) + guard - minX;
                    const pageHmm = Math.max(cutBounds.maxY + pad, bb.maxY) + guard - minY;

                    if (
                      !Number.isFinite(pageWmm) ||
                      !Number.isFinite(pageHmm) ||
                      pageWmm <= 0 ||
                      pageHmm <= 0 ||
                      pageWmm > PRECISION_BLEED_BUDGET.maxStickerSizeMm ||
                      pageHmm > PRECISION_BLEED_BUDGET.maxStickerSizeMm
                    ) {
                      preflightErrors.push(`Tem #${stickerNum}: Khổ trang PDF không hợp lệ (${pageWmm}×${pageHmm} mm)`);
                      continue;
                    }

                    const trimXmm = cutBounds.minX - minX;
                    const trimYBottomMm = minY + pageHmm - cutBounds.maxY;
                    if (trimXmm < -1e-4 || trimYBottomMm < -1e-4 || trimXmm + trimW > pageWmm + 1e-4 || trimYBottomMm + trimH > pageHmm + 1e-4) {
                      preflightErrors.push(`Tem #${stickerNum}: Quan hệ TrimBox/MediaBox không hợp lệ`);
                      continue;
                    }

                    stickerSpecs.push({
                      poly,
                      bleedPoly: validBleed,
                      clipPoly,
                      cutBounds,
                      trimW,
                      trimH,
                      minX,
                      minY,
                      pageWmm,
                      pageHmm,
                      trimXmm: Math.max(0, trimXmm),
                      trimYBottomMm: Math.max(0, trimYBottomMm),
                    });
                  }

                  if (preflightErrors.length > 0) {
                    throw new Error(`Không thể xuất PDF sản xuất vì phát hiện lỗi:\n- ${preflightErrors.join('\n- ')}`);
                  }

                  const doc = await PDFDocument.create();
                  const pxPerMmX = renderedCanvas.width / Math.max(1, totalWidthMm);
                  const pxPerMmY = renderedCanvas.height / Math.max(1, totalHeightMm);
                  const magentaCut = cmyk(0, 1, 0, 0);
                  const cyanBleed = cmyk(1, 0, 0, 0);

                  for (const spec of stickerSpecs) {
                    const { poly, bleedPoly, clipPoly, trimW, trimH, minX, minY, pageWmm, pageHmm, trimXmm, trimYBottomMm } = spec;

                    // Render each individual sticker crop at full 300 DPI (or source canvas DPI if higher; NOT capped by Precision Offset budget)
                    const targetPxPerMmX = Math.max(pxPerMmX, PX_PER_MM_300DPI);
                    const targetPxPerMmY = Math.max(pxPerMmY, PX_PER_MM_300DPI);
                    const cropPxW = Math.max(8, Math.round(pageWmm * targetPxPerMmX));
                    const cropPxH = Math.max(8, Math.round(pageHmm * targetPxPerMmY));
                    const offscreen = document.createElement('canvas');
                    offscreen.width = cropPxW;
                    offscreen.height = cropPxH;

                    let pngBytes;
                    try {
                      const ctx = offscreen.getContext('2d');
                      ctx.save();
                      canvasContour(ctx, clipPoly, ([x, y]) => [((x - minX) * cropPxW) / pageWmm, ((y - minY) * cropPxH) / pageHmm]);
                      ctx.clip();

                      const scaleX = cropPxW / pageWmm / pxPerMmX;
                      const scaleY = cropPxH / pageHmm / pxPerMmY;
                      const srcX = (minX * cropPxW) / pageWmm;
                      const srcY = (minY * cropPxH) / pageHmm;
                      ctx.drawImage(renderedCanvas, -srcX, -srcY, renderedCanvas.width * scaleX, renderedCanvas.height * scaleY);
                      ctx.restore();

                      pngBytes = await canvasToPngArrayBuffer(offscreen);
                    } finally {
                      offscreen.width = 0;
                      offscreen.height = 0;
                    }

                    const pageWPt = pageWmm * MM_TO_PT;
                    const pageHPt = pageHmm * MM_TO_PT;
                    const page = doc.addPage([pageWPt, pageHPt]);
                    page.setCropBox(0, 0, pageWPt, pageHPt);
                    page.setBleedBox(0, 0, pageWPt, pageHPt);
                    page.setTrimBox(trimXmm * MM_TO_PT, trimYBottomMm * MM_TO_PT, trimW * MM_TO_PT, trimH * MM_TO_PT);

                    const img = await doc.embedPng(pngBytes);
                    page.drawImage(img, { x: 0, y: 0, width: pageWPt, height: pageHPt });

                    const toLocalPdfPt = (xMm, yMm) => [(xMm - minX) * MM_TO_PT, pageHPt - (yMm - minY) * MM_TO_PT];

                    // Draw closed Cubic Bézier BLEED path (Cyan) if present
                    if (bleedPoly) {
                      drawClosedBezierContourOnPdfPage(page, bleedPoly, toLocalPdfPt, {
                        color: cyanBleed,
                        thicknessPt: 0.25,
                      });
                    }

                    // Draw closed Cubic Bézier CUT path (Magenta)
                    drawClosedBezierContourOnPdfPage(page, poly, toLocalPdfPt, {
                      color: magentaCut,
                      thicknessPt: 0.3,
                    });
                  }

                  return await doc.save();
                }
