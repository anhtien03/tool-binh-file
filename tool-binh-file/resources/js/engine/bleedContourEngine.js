import {
  PDFDocument,
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
export function fitCornerPreservingBezier(rawPtsMm, options = {}) {
  const {
    simplifyTolMm = 0.22,
    cornerAngleDeg = 130,
    smoothPasses = 2,
    tension = 0.3,
  } = options;

  if (!rawPtsMm || rawPtsMm.length < 3) {
    return { ptsMm: rawPtsMm || [], beziersMm: [], svgPathMm: '', cornerCount: 0 };
  }

  // 1. Sub-pixel Gaussian fairing on the dense 1px boundary loop to erase pixel staircase teeth
  const preFaired = smoothDenseLoopSubpixel(rawPtsMm, Math.max(2, smoothPasses + 2));

  // 2. Closed-loop RDP simplification
  let pts = rdpSimplifyClosed(preFaired, Math.max(0.12, simplifyTolMm));
  if (pts.length < 3) pts = preFaired;

  // 3. Merge/filter vertices that are too close (< 0.45 mm) so short-long segment transitions never create hooks
  const minEdgeMm = 0.45;
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

  // 4. Identify TRUE sharp corners (only genuinely sharp tips, e.g. <= 85°..100°, with both arms >= 1.2mm)
  // Shallow concave bends (105°..175°) are ALWAYS kept C1 smooth so neither Magenta nor Cyan ever kinks!
  const strictCornerLimit = Math.min(95, Math.max(60, cornerAngleDeg - 35));
  const isCorner = new Uint8Array(n);
  let cornerCount = 0;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const arm1 = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const arm2 = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const deg = computeVertexAngleDeg(prev, curr, next);
    if (deg <= strictCornerLimit && arm1 >= 1.1 && arm2 >= 1.1) {
      isCorner[i] = 1;
      cornerCount++;
    }
  }

  // 5. Corner-locked Laplacian fairing on anchor vertices for silky-smooth curvature
  let faired = pts.map(([x, y]) => [x, y]);
  const anchorPasses = Math.max(1, smoothPasses);
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
function buildGeometricContourObj(ptsMm, shapeMode) {
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
    const useRx = shapeMode === 'circle' ? Math.max(rx, ry) : rx;
    const useRy = shapeMode === 'circle' ? Math.max(rx, ry) : ry;
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
      [r3(minX), r3(minY)],
      [r3(maxX), r3(minY)],
      [r3(maxX), r3(maxY)],
      [r3(minX), r3(maxY)],
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

  const fitted = fitCornerPreservingBezier(offsetPts, fitOptions);
  const arr = [...fitted.ptsMm];
  Object.assign(arr, fitted);
  return arr;
}

/**
 * STEP 4: Geometric Validation (Closedness, Self-Intersection, Sticker-to-Sticker Collision)
 */
function segmentsIntersect(a, b, c, d) {
  const ccw = (p1, p2, p3) => (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

export function validateContoursGeometry(cutContoursMm, bleedContoursMm = [], totalWidthMm = 330, totalHeightMm = 390) {
  const count = cutContoursMm.length;
  let closedCount = 0;
  let selfIntersections = 0;
  let totalBezierSegments = 0;
  let totalSharpCorners = 0;

  const bboxes = [];

  for (let idx = 0; idx < count; idx++) {
    const poly = cutContoursMm[idx];
    if (!poly || poly.length < 3) continue;
    closedCount++;
    totalBezierSegments += poly.beziersMm ? poly.beziersMm.length - 1 : poly.length;
    totalSharpCorners += poly.cornerCount || 0;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    bboxes.push({ idx, minX, minY, maxX, maxY, poly });

    // Check non-adjacent segments of anchorsMm for self-intersection
    const anchors = poly.anchorsMm || poly;
    const m = anchors.length;
    if (m >= 4 && m <= 240) {
      for (let i = 0; i < m; i++) {
        const a1 = anchors[i];
        const a2 = anchors[(i + 1) % m];
        for (let j = i + 2; j < m; j++) {
          if (i === 0 && j === m - 1) continue;
          const b1 = anchors[j];
          const b2 = anchors[(j + 1) % m];
          if (segmentsIntersect(a1, a2, b1, b2)) {
            selfIntersections++;
          }
        }
      }
    }
  }

  // Check pairwise sticker collisions
  const collisions = [];
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      const A = bboxes[i];
      const B = bboxes[j];
      if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) continue;
      // Bounding boxes overlap: check actual polygon edge intersection
      const pA = A.poly.anchorsMm || A.poly;
      const pB = B.poly.anchorsMm || B.poly;
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
      if (hit) collisions.push([A.idx + 1, B.idx + 1]);
    }
  }

  return {
    valid: closedCount === count && selfIntersections === 0 && collisions.length === 0,
    stickerCount: count,
    closedCount,
    bleedPathCount: bleedContoursMm.length,
    totalBezierSegments,
    totalSharpCorners,
    selfIntersections,
    collisions,
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
  } = options;

  // High-resolution tracing grid (up to 1400px so 1px ~ 0.25mm on 330x390mm sheet, fast & crisp)
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

  // STEP 1: Alpha-first detection (check corners & sample grid for alpha transparency)
  let transparentSamples = 0;
  let totalSamples = 0;
  for (let sy = padPx; sy < padPx + workH; sy += Math.max(1, (workH / 20) | 0)) {
    for (let sx = padPx; sx < padPx + workW; sx += Math.max(1, (workW / 20) | 0)) {
      totalSamples++;
      if (imgData[(sy * cw + sx) * 4 + 3] < 242) transparentSamples++;
    }
  }
  const cornerAlpha = imgData[(padPx * cw + padPx) * 4 + 3];
  const useAlpha = cornerAlpha < 242 || transparentSamples > totalSamples * 0.03;

  const bgR = imgData[(padPx * cw + padPx) * 4];
  const bgG = imgData[(padPx * cw + padPx) * 4 + 1];
  const bgB = imgData[(padPx * cw + padPx) * 4 + 2];

  let fgMask = new Uint8Array(cw * ch);
  const effCornerMm = ignoreCornerMarks
    ? Math.max(cornerIgnoreMm, Math.min(totalWidthMm, totalHeightMm) * 0.08)
    : 0;
  const cornerIgnorePx = ignoreCornerMarks ? Math.round(effCornerMm * pxPerMm) : 0;

  for (let y = padPx; y < padPx + workH; y++) {
    for (let x = padPx; x < padPx + workW; x++) {
      if (cornerIgnorePx > 0) {
        const lx = x - padPx;
        const ly = y - padPx;
        const inLeft = lx < cornerIgnorePx;
        const inRight = lx >= workW - cornerIgnorePx;
        const inTop = ly < cornerIgnorePx;
        const inBottom = ly >= workH - cornerIgnorePx;
        if ((inLeft || inRight) && (inTop || inBottom)) continue;
      }
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

  // Fill internal holes inside each sticker (1 sticker = 1 solid outer contour without MORPH_CLOSE bridging fins)
  fgMask = fillInteriorHoles(fgMask, cw, ch);

  // Apply Euclidean Rolling-Ball Offset for CUT line:
  // If offsetMm is small (< 1.25mm), roll a smooth 1.25mm ball over halftone pixel teeth first, then step back to exact offsetMm!
  let cutMask = fgMask;
  const offsetPx = offsetMm * pxPerMm;
  const minSmoothBallPx = Math.max(2.2, 1.25 * pxPerMm);

  if (offsetPx >= minSmoothBallPx) {
    const dist = computeDistanceField(fgMask, cw, ch);
    cutMask = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      if (dist[i] <= offsetPx) cutMask[i] = 1;
    }
    cutMask = fillInteriorHoles(cutMask, cw, ch);
  } else if (offsetPx >= -0.2) {
    // Rolling-ball smoothing: dilate by minSmoothBallPx, fill holes, then erode back by (minSmoothBallPx - max(0, offsetPx))
    const distOut = computeDistanceField(fgMask, cw, ch);
    let dilated = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      if (distOut[i] <= minSmoothBallPx) dilated[i] = 1;
    }
    dilated = fillInteriorHoles(dilated, cw, ch);

    const erodePx = minSmoothBallPx - Math.max(0, offsetPx);
    if (erodePx > 0.25) {
      const bgMask = new Uint8Array(cw * ch);
      for (let i = 0; i < cw * ch; i++) bgMask[i] = dilated[i] ? 0 : 1;
      const distBg = computeDistanceField(bgMask, cw, ch);
      cutMask = new Uint8Array(cw * ch);
      for (let i = 0; i < cw * ch; i++) {
        if (distBg[i] > erodePx) cutMask[i] = 1;
      }
    } else {
      cutMask = dilated;
    }
  } else {
    const bgMask = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) bgMask[i] = fgMask[i] ? 0 : 1;
    const distBg = computeDistanceField(bgMask, cw, ch);
    cutMask = new Uint8Array(cw * ch);
    const thr = Math.abs(offsetPx);
    for (let i = 0; i < cw * ch; i++) {
      if (distBg[i] > thr) cutMask[i] = 1;
    }
  }

  const minAreaPx = Math.max(16, minAreaMm2 * pxPerMm * pxPerMm);
  const rawLoops = traceConnectedContoursChainNone(cutMask, cw, ch, minAreaPx);

  // Convert raw pixel loops to mm and run STEP 2 (Corner-Preserving Cubic Bézier Fitting)
  // Default ~0.45px simplify tolerance in mm
  const effSimplifyMm = Math.max(0.08, Math.min(simplifyMm, 0.65 / Math.max(1, pxPerMm) + simplifyMm * 0.5));
  const fitOpts = {
    simplifyTolMm: effSimplifyMm,
    cornerAngleDeg,
    smoothPasses: Math.max(0, Math.min(3, smoothLevel)),
  };

  let contoursMm = rawLoops.map((loop) => {
    const rawPtsMm = loop.map(([px, py]) => [
      ((px - padPx) / pxPerMm),
      ((py - padPx) / pxPerMm),
    ]);
    if (shapeMode !== 'auto') {
      return buildGeometricContourObj(rawPtsMm, shapeMode);
    }
    const fitted = fitCornerPreservingBezier(rawPtsMm, fitOpts);
    const arr = [...fitted.ptsMm];
    Object.assign(arr, fitted);
    return arr;
  });

  // Post-filter residual corner & edge registration marks (e.g. L-marks at 4 corners or tiny ▲ feed triangle along sheet edge)
  if (ignoreCornerMarks && contoursMm.length > 1) {
    const cornerZoneX = Math.max(26, totalWidthMm * 0.095);
    const cornerZoneY = Math.max(26, totalHeightMm * 0.095);
    const maxMarkSize = Math.max(28, Math.min(totalWidthMm, totalHeightMm) * 0.085);
    const edgeMarginMm = Math.max(16, Math.min(totalWidthMm, totalHeightMm) * 0.05);
    const maxEdgeTickSize = Math.max(16, Math.min(totalWidthMm, totalHeightMm) * 0.045);

    contoursMm = contoursMm.filter((poly) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const w = maxX - minX;
      const h = maxY - minY;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const nearLeft = cx < cornerZoneX;
      const nearRight = cx > totalWidthMm - cornerZoneX;
      const nearTop = cy < cornerZoneY;
      const nearBottom = cy > totalHeightMm - cornerZoneY;
      // 1. Corner registration marks (L-marks / circle marks)
      if ((nearLeft || nearRight) && (nearTop || nearBottom) && w < maxMarkSize && h < maxMarkSize) {
        return false;
      }
      // 2. Small sheet-edge directional marks (like the ▲ triangle at the bottom edge of 330x390mm sheet)
      const onSheetBorder =
        minX < edgeMarginMm ||
        maxX > totalWidthMm - edgeMarginMm ||
        minY < edgeMarginMm ||
        maxY > totalHeightMm - edgeMarginMm;
      if (onSheetBorder && w < maxEdgeTickSize && h < maxEdgeTickSize) {
        return false;
      }
      return true;
    });
  }

  // STEP 3: Create outward BLEED Cubic Bézier contours using per-sticker ISOLATED Euclidean Distance Field
  // (Because each sticker is dilated in its own isolated local bounding box, adjacent stickers on the sheet NEVER merge
  // and concave corners NEVER produce miter spikes/hooks!)
  let bleedContoursMm = [];
  if (bleedOffsetMm > 0.05 && contoursMm.length > 0) {
    const bleedPx = Math.max(0.5, bleedOffsetMm * pxPerMm);
    const localPadPx = Math.ceil(bleedPx + 8);

    bleedContoursMm = contoursMm.map((cutPoly) => {
      if (shapeMode !== 'auto') {
        return buildGeometricContourObj(
          cutPoly.map(([x, y]) => [x, y]),
          shapeMode
        );
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of cutPoly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      const polyPxW = Math.max(8, Math.ceil((maxX - minX) * pxPerMm));
      const polyPxH = Math.max(8, Math.ceil((maxY - minY) * pxPerMm));
      const lw = polyPxW + localPadPx * 2;
      const lh = polyPxH + localPadPx * 2;

      // Rasterize this single closed cutPoly onto an isolated local canvas
      const locCanvas = document.createElement('canvas');
      locCanvas.width = lw;
      locCanvas.height = lh;
      const lctx = locCanvas.getContext('2d');
      lctx.fillStyle = '#ffffff';
      lctx.beginPath();
      cutPoly.forEach(([x, y], idx) => {
        const px = (x - minX) * pxPerMm + localPadPx;
        const py = (y - minY) * pxPerMm + localPadPx;
        if (idx === 0) lctx.moveTo(px, py);
        else lctx.lineTo(px, py);
      });
      lctx.closePath();
      lctx.fill();

      const lData = lctx.getImageData(0, 0, lw, lh).data;
      const locMask = new Uint8Array(lw * lh);
      for (let i = 0; i < lw * lh; i++) {
        if (lData[i * 4 + 3] > 128) locMask[i] = 1;
      }

      const distBleed = computeDistanceField(locMask, lw, lh);
      let dilatedMask = new Uint8Array(lw * lh);
      for (let i = 0; i < lw * lh; i++) {
        if (distBleed[i] <= bleedPx) dilatedMask[i] = 1;
      }
      dilatedMask = fillInteriorHoles(dilatedMask, lw, lh);

      const loops = traceConnectedContoursChainNone(dilatedMask, lw, lh, 12);
      if (loops.length > 0) {
        // Pick largest loop
        loops.sort((a, b) => b.length - a.length);
        const rawPtsMm = loops[0].map(([px, py]) => [
          minX + (px - localPadPx) / pxPerMm,
          minY + (py - localPadPx) / pxPerMm,
        ]);
        const fitted = fitCornerPreservingBezier(rawPtsMm, fitOpts);
        const arr = [...fitted.ptsMm];
        Object.assign(arr, fitted);
        return arr;
      }

      return offsetPolygonAndFitBezierMm(cutPoly, bleedOffsetMm, fitOpts);
    });
  }

  // STEP 4: Geometric Validation
  const validation = validateContoursGeometry(contoursMm, bleedContoursMm, totalWidthMm, totalHeightMm);

  // Attach bleedContoursMm & validation metadata directly onto the returned array so existing callers remain 100% compatible
  Object.assign(contoursMm, {
    bleedContoursMm,
    validation,
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
    const cyanBleed = cmyk(1, 0, 0, 0);
    for (const bleedPoly of bleedContours) {
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

/**
 * Split a multi-sticker sheet into a multi-page 300 DPI PDF (1 sticker per page, masked cleanly to its Bleed/Cut contour).
 * Each page gets 1 closed Cubic Bézier CUT path (Magenta) + 1 closed Cubic Bézier BLEED path (Cyan).
 */
export async function exportSplitStickersPdf(renderedCanvas, totalWidthMm, totalHeightMm, contoursMm, bleedPadMm = 1.5) {
  const doc = await PDFDocument.create();
  const pxPerMmX = renderedCanvas.width / Math.max(1, totalWidthMm);
  const pxPerMmY = renderedCanvas.height / Math.max(1, totalHeightMm);
  const magentaCut = cmyk(0, 1, 0, 0);
  const cyanBleed = cmyk(1, 0, 0, 0);
  const pad = Math.max(0, Number(bleedPadMm) || 0);
  const bleedList = contoursMm?.bleedContoursMm || [];

  for (let idx = 0; idx < contoursMm.length; idx++) {
    const poly = contoursMm[idx];
    if (!poly || poly.length < 3) continue;
    const bleedPoly = bleedList[idx] || null;
    const clipPoly = bleedPoly && bleedPoly.length >= 3 ? bleedPoly : poly;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const trimW = Math.max(2, maxX - minX);
    const trimH = Math.max(2, maxY - minY);
    const pageWmm = trimW + pad * 2;
    const pageHmm = trimH + pad * 2;

    // Render each individual sticker crop at full 300 DPI (or source canvas DPI if higher)
    const targetPxPerMmX = Math.max(pxPerMmX, PX_PER_MM_300DPI);
    const targetPxPerMmY = Math.max(pxPerMmY, PX_PER_MM_300DPI);
    const cropPxW = Math.max(8, Math.round(pageWmm * targetPxPerMmX));
    const cropPxH = Math.max(8, Math.round(pageHmm * targetPxPerMmY));
    const offscreen = document.createElement('canvas');
    offscreen.width = cropPxW;
    offscreen.height = cropPxH;
    const ctx = offscreen.getContext('2d');

    ctx.save();
    ctx.beginPath();
    clipPoly.forEach(([x, y], i) => {
      const px = (x - minX + pad) * targetPxPerMmX;
      const py = (y - minY + pad) * targetPxPerMmY;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.clip();

    const scaleX = targetPxPerMmX / pxPerMmX;
    const scaleY = targetPxPerMmY / pxPerMmY;
    const srcX = (minX - pad) * targetPxPerMmX;
    const srcY = (minY - pad) * targetPxPerMmY;
    ctx.drawImage(
      renderedCanvas,
      -srcX,
      -srcY,
      renderedCanvas.width * scaleX,
      renderedCanvas.height * scaleY
    );
    ctx.restore();

    const pageWPt = pageWmm * MM_TO_PT;
    const pageHPt = pageHmm * MM_TO_PT;
    const page = doc.addPage([pageWPt, pageHPt]);
    page.setTrimBox(pad * MM_TO_PT, pad * MM_TO_PT, trimW * MM_TO_PT, trimH * MM_TO_PT);
    page.setBleedBox(0, 0, pageWPt, pageHPt);

    const pngBytes = await (await fetch(offscreen.toDataURL('image/png'))).arrayBuffer();
    const img = await doc.embedPng(pngBytes);
    page.drawImage(img, { x: 0, y: 0, width: pageWPt, height: pageHPt });

    const toLocalPdfPt = (xMm, yMm) => [(xMm - minX + pad) * MM_TO_PT, pageHPt - (yMm - minY + pad) * MM_TO_PT];

    // Draw closed Cubic Bézier BLEED path (Cyan) if present
    if (bleedPoly && bleedPoly.length >= 3) {
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
