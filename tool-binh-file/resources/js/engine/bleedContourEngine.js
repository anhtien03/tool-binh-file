import { PDFDocument, cmyk } from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';

/**
 * 2-Pass Squared Euclidean Distance Transform (Meijster / Felzenszwalb-Huttenlocher 1D->2D)
 * Exact O(W * H) distance from foreground pixels.
 */
function computeDistanceField(binaryMask, w, h) {
  const INF = 1e9;
  const g = new Float32Array(w * h);

  // Pass 1: vertical
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

  // Pass 2: horizontal squared distance
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
      const gq2 = gq >= INF ? INF : gq * g;
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
 * Ramer-Douglas-Peucker polygon simplification
 */
function rdpSimplify(points, eps) {
  if (points.length < 4) return points;
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
    const left = rdpSimplify(points.slice(0, idx + 1), eps);
    const right = rdpSimplify(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

/**
 * Chaikin corner-cutting smoothing for closed loops
 */
function chaikinSmoothClosed(pts, iterations = 2) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const next = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const p0 = cur[i];
      const p1 = cur[(i + 1) % n];
      next.push([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25]);
      next.push([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75]);
    }
    cur = next;
  }
  return cur;
}

/**
 * Trace outer contours of all connected components on a binary mask using Moore-Neighbor Tracing
 */
function traceConnectedContours(mask, w, h, minAreaPx) {
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

  // Flood-fill helper to mark entire component visited & compute area
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
        // Found unvisited outer boundary start pixel (entering from left background)
        const area = floodMark(x, y);
        if (area < minAreaPx) continue;

        const poly = [];
        let cx = x, cy = y;
        let backDir = 0; // came from West
        const maxSteps = Math.min(12000, (w + h) * 8);
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
          if (contours.length >= 80) return contours;
        }
      }
    }
  }

  return contours;
}

/**
 * Trace CutContour polygons (in mm) from an HTMLImageElement or HTMLCanvasElement
 */
export function extractStickerContoursFromImage(imgElement, totalWidthMm, totalHeightMm, options = {}) {
  const {
    offsetMm = 2.0,
    smoothLevel = 2, // 0..3 Chaikin iterations
    simplifyMm = 0.45,
    minAreaMm2 = 4.0,
    alphaThreshold = 30,
    bgTolerance = 28,
  } = options;

  const maxDim = 560;
  const aspect = imgElement.width / Math.max(1, imgElement.height);
  const workW = aspect >= 1 ? maxDim : Math.max(64, Math.round(maxDim * aspect));
  const workH = aspect >= 1 ? Math.max(64, Math.round(maxDim / aspect)) : maxDim;

  // Add padding so positive offsets never clip against canvas edges
  const pxPerMm = workW / Math.max(1, totalWidthMm);
  const padPx = Math.ceil(Math.max(4, Math.abs(offsetMm) * pxPerMm + 6));
  const cw = workW + padPx * 2;
  const ch = workH + padPx * 2;

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(imgElement, padPx, padPx, workW, workH);

  const imgData = ctx.getImageData(0, 0, cw, ch).data;
  // Detect whether image uses transparency at corners
  const cornerAlpha = imgData[(padPx * cw + padPx) * 4 + 3];
  const useAlpha = cornerAlpha < 240;

  // Sample corner RGB if opaque
  const bgR = imgData[(padPx * cw + padPx) * 4];
  const bgG = imgData[(padPx * cw + padPx) * 4 + 1];
  const bgB = imgData[(padPx * cw + padPx) * 4 + 2];

  const fgMask = new Uint8Array(cw * ch);
  for (let y = padPx; y < padPx + workH; y++) {
    for (let x = padPx; x < padPx + workW; x++) {
      const i4 = (y * cw + x) * 4;
      const a = imgData[i4 + 3];
      if (useAlpha) {
        if (a >= alphaThreshold) fgMask[y * cw + x] = 1;
      } else {
        const dr = Math.abs(imgData[i4] - bgR);
        const dg = Math.abs(imgData[i4 + 1] - bgG);
        const db = Math.abs(imgData[i4 + 2] - bgB);
        if (a >= alphaThreshold && dr + dg + db > bgTolerance * 2) {
          fgMask[y * cw + x] = 1;
        }
      }
    }
  }

  let finalMask = fgMask;
  const offsetPx = offsetMm * pxPerMm;

  if (offsetPx > 0.25) {
    const dist = computeDistanceField(fgMask, cw, ch);
    finalMask = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      if (dist[i] <= offsetPx) finalMask[i] = 1;
    }
  } else if (offsetPx < -0.25) {
    // Erode by computing distance from background
    const bgMask = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) bgMask[i] = fgMask[i] ? 0 : 1;
    const distBg = computeDistanceField(bgMask, cw, ch);
    finalMask = new Uint8Array(cw * ch);
    const thr = Math.abs(offsetPx);
    for (let i = 0; i < cw * ch; i++) {
      if (distBg[i] > thr) finalMask[i] = 1;
    }
  }

  const minAreaPx = Math.max(12, minAreaMm2 * pxPerMm * pxPerMm);
  const rawLoops = traceConnectedContours(finalMask, cw, ch, minAreaPx);

  const simplifyPx = Math.max(0.6, simplifyMm * pxPerMm);
  const contoursMm = rawLoops.map((loop) => {
    const simplified = rdpSimplify([...loop, loop[0]], simplifyPx).slice(0, -1);
    const smoothed = smoothLevel > 0 ? chaikinSmoothClosed(simplified, smoothLevel) : simplified;
    return smoothed.map(([px, py]) => [
      Math.round(((px - padPx) / pxPerMm) * 100) / 100,
      Math.round(((py - padPx) / pxPerMm) * 100) / 100,
    ]);
  });

  return contoursMm;
}

/**
 * Generate a 4-side Bleed PDF from a source Canvas/Image or PDF, setting TrimBox & BleedBox properly
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

  // Build composite bleed canvas at 300 DPI equivalent (max 2400px)
  const dpiScale = Math.min(8, 2200 / Math.max(mediaWmm, mediaHmm));
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

    // Draw mirrored or stretched 4-side strips from renderedCanvas
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
      // Edge stretch: repeat 2px outer edge
      if (bL > 0) ctx.drawImage(renderedCanvas, 0, 0, 2, sh, 0, y0, x0, h0);
      if (bR > 0) ctx.drawImage(renderedCanvas, sw - 2, 0, 2, sh, x0 + w0, y0, bR * dpiScale, h0);
      if (bT > 0) ctx.drawImage(renderedCanvas, 0, 0, sw, 2, x0, 0, w0, y0);
      if (bB > 0) ctx.drawImage(renderedCanvas, 0, sh - 2, sw, 2, x0, y0 + h0, w0, bB * dpiScale);
    }

    // Fill 4 corners cleanly
    if (bL > 0 && bT > 0) ctx.drawImage(renderedCanvas, 0, 0, 2, 2, 0, 0, x0, y0);
    if (bR > 0 && bT > 0) ctx.drawImage(renderedCanvas, sw - 2, 0, 2, 2, x0 + w0, 0, bR * dpiScale, y0);
    if (bL > 0 && bB > 0) ctx.drawImage(renderedCanvas, 0, sh - 2, 2, 2, 0, y0 + h0, x0, bB * dpiScale);
    if (bR > 0 && bB > 0) ctx.drawImage(renderedCanvas, sw - 2, sh - 2, 2, 2, x0 + w0, y0 + h0, bR * dpiScale, bB * dpiScale);
  }

  const page = doc.addPage([mediaWPt, mediaHPt]);
  page.setTrimBox(bL * MM_TO_PT, bB * MM_TO_PT, trimWmm * MM_TO_PT, trimHmm * MM_TO_PT);
  page.setBleedBox(0, 0, mediaWPt, mediaHPt);

  // Draw bleed background image
  const bleedPngBytes = await (await fetch(c.toDataURL('image/png'))).arrayBuffer();
  const bleedImg = await doc.embedPng(bleedPngBytes);
  page.drawImage(bleedImg, { x: 0, y: 0, width: mediaWPt, height: mediaHPt });

  // Draw crisp original center (vector if PDF!)
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
 * Export 1:1 PDF with Sticker Image + Vector CutContour Magenta lines
 */
export async function exportContourTracedPdf(renderedCanvas, widthMm, heightMm, contoursMm, padMm = 6) {
  const doc = await PDFDocument.create();
  const sheetW = (widthMm + padMm * 2) * MM_TO_PT;
  const sheetH = (heightMm + padMm * 2) * MM_TO_PT;
  const page = doc.addPage([sheetW, sheetH]);

  const pngBytes = await (await fetch(renderedCanvas.toDataURL('image/png'))).arrayBuffer();
  const img = await doc.embedPng(pngBytes);
  page.drawImage(img, {
    x: padMm * MM_TO_PT,
    y: padMm * MM_TO_PT,
    width: widthMm * MM_TO_PT,
    height: heightMm * MM_TO_PT,
  });

  const magenta = cmyk(0, 1, 0, 0);
  for (const poly of contoursMm) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      page.drawLine({
        start: { x: (padMm + a[0]) * MM_TO_PT, y: sheetH - (padMm + a[1]) * MM_TO_PT },
        end: { x: (padMm + b[0]) * MM_TO_PT, y: sheetH - (padMm + b[1]) * MM_TO_PT },
        thickness: 0.3,
        color: magenta,
      });
    }
  }

  return await doc.save();
}
