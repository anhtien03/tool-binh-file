/**
 * PrintKit V1 — Phase 1 Bleed & Contour Studio Pure Edit Helpers
 *
 * Pure, testable, zero-LOCKED-edits helpers for:
 *  1. Non-destructive canvas preprocessing for tracing (shadow removal, PNG alpha mode, manual mask)
 *  2. Additive corner rounding (fillet) in mm — leaves VECTOR_ORIGINAL untouched when cornerRadiusMm <= 0
 *  3. Merging selected contours ("Gộp với tem")
 *  4. Direct canvas hit-testing (point-in-polygon + bbox fallback) for sticker selection
 *  5. 4-mode Dieline contour resolution (original | png_alpha | bleed_edge | none)
 *  6. Scope filtering ("Đối tượng đang chọn" vs "Toàn trang")
 *  7. UI slider mapping ("XEM VÀ CHỈNH ĐƯỜNG BẾ")
 *  8. Prepress PDF TrimBox/BleedBox extraction for "PDF/PNG đã có biên"
 */

import { PDFDocument, PDFName } from 'pdf-lib';

export const DIELINE_MODES = Object.freeze({
  ORIGINAL: 'original',
  PNG_ALPHA: 'png_alpha',
  BLEED_EDGE: 'bleed_edge',
  NONE: 'none',
});

export const DIELINE_MODE_OPTIONS = Object.freeze([
  { id: DIELINE_MODES.ORIGINAL, label: 'Theo hình gốc' },
  { id: DIELINE_MODES.PNG_ALPHA, label: 'Theo biên trong suốt PNG' },
  { id: DIELINE_MODES.BLEED_EDGE, label: 'Theo mép tràn lề' },
  { id: DIELINE_MODES.NONE, label: 'Không vẽ đường cắt' },
]);

export const MANUAL_EDIT_TOOLS = Object.freeze({
  NONE: 'none',
  ERASE_SHADOW: 'erase_shadow',
  KEEP_REGION: 'keep_region',
  MERGE_STICKER: 'merge_sticker',
});

/**
 * Map the 3 visual contour sliders to tracer parameters cleanly.
 */
export function mapSliderControlsToTracerParams({
  antiAliasPct = 50,
  fidelityPct = 50,
  minAreaMm2 = 1.0,
} = {}) {
  const aa = Math.max(0, Math.min(100, Number(antiAliasPct) || 0));
  const fid = Math.max(0, Math.min(100, Number(fidelityPct) || 0));
  const area = Math.max(0.5, Math.min(50, Number(minAreaMm2) || 1.0));

  const smoothLevel = Math.max(0, Math.min(3, Math.round((aa / 100) * 3)));
  const simplifyMm = Math.round((0.35 - (fid / 100) * 0.30) * 1000) / 1000; // 0.35mm .. 0.05mm
  const cornerAngleDeg = Math.round(115 + (fid / 100) * 35); // 115° .. 150°

  return {
    smoothLevel,
    simplifyMm,
    cornerAngleDeg,
    minAreaMm2: area,
  };
}

/**
 * Extract RGBA pixel buffer from either an HTMLCanvasElement or a Node test buffer `{ width, height, data }`.
 */
function readRgbaBuffer(surface) {
  if (!surface) return null;
  if (typeof surface.getContext === 'function') {
    const w = surface.width | 0;
    const h = surface.height | 0;
    if (w <= 0 || h <= 0) return null;
    const ctx = surface.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: new Uint8ClampedArray(img.data), isCanvas: true };
  }
  if (surface.width > 0 && surface.height > 0 && surface.data && surface.data.length >= surface.width * surface.height * 4) {
    return {
      width: surface.width | 0,
      height: surface.height | 0,
      data: new Uint8ClampedArray(surface.data),
      isCanvas: false,
    };
  }
  return null;
}

function writeRgbaBuffer(buf, createCanvasFn) {
  if (buf.isCanvas && typeof document !== 'undefined') {
    const out = createCanvasFn ? createCanvasFn(buf.width, buf.height) : document.createElement('canvas');
    out.width = buf.width;
    out.height = buf.height;
    const ctx = out.getContext('2d');
    const imgData = ctx.createImageData(buf.width, buf.height);
    imgData.data.set(buf.data);
    ctx.putImageData(imgData, 0, 0);
    return out;
  }
  return { width: buf.width, height: buf.height, data: buf.data };
}

/**
 * Non-destructive preprocessing copy for contour tracing ONLY.
 * Original renderedCanvas artwork is NEVER mutated or deformed.
 *
 * - shadowRemovalMode === 'auto': strips soft drop shadows / low-alpha grey fringes
 * - forcePngAlpha === true: strictly respects transparent PNG alpha channel
 * - manualMaskCanvas:
 *     Red stroke (R > 128 && G < 80)   -> erase/exclude ("Xóa bóng")
 *     Green stroke (G > 128 && R < 80) -> force-include ("Giữ lại")
 */
export function preprocessCanvasForTracing(
  canvas,
  { shadowRemovalMode = 'keep', forcePngAlpha = false, manualMaskCanvas = null } = {}
) {
  const src = readRgbaBuffer(canvas);
  if (!src) return canvas;

  const needsShadow = shadowRemovalMode === 'auto';
  const needsAlpha = Boolean(forcePngAlpha);
  const maskBuf = manualMaskCanvas ? readRgbaBuffer(manualMaskCanvas) : null;

  if (!needsShadow && !needsAlpha && !maskBuf) {
    // Still return a clean copy if buffer-based, or original canvas when zero transforms requested
    return canvas;
  }

  const { width, height, data } = src;
  const totalPx = width * height;

  // Detect whether image actually has meaningful transparency
  let hasTransparency = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 245) {
      hasTransparency = true;
      break;
    }
  }

  for (let p = 0; p < totalPx; p++) {
    const idx = p * 4;
    let r = data[idx];
    let g = data[idx + 1];
    let b = data[idx + 2];
    let a = data[idx + 3];

    if (needsAlpha && hasTransparency) {
      if (a < 24) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 0;
        r = 255; g = 255; b = 255; a = 0;
      } else {
        // Keep opaque interior pixels (even white sticker borders) as solid foreground for alpha tracer
        if (r > 245 && g > 245 && b > 245 && a >= 200) {
          data[idx] = 232;
          data[idx + 1] = 232;
          data[idx + 2] = 232;
        }
        data[idx + 3] = 255;
        a = 255;
      }
    }

    if (needsShadow && a > 0) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      if (hasTransparency) {
        // Semi-transparent soft drop shadow or grey halo around sticker
        const isSoftAlphaShadow = a < 175 || (a < 225 && sat < 26 && lum < 170);
        if (isSoftAlphaShadow) {
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = 0;
          a = 0;
        }
      } else {
        // Opaque white-background soft grey drop shadow (neutral low-chroma grey near white)
        const isLightGreyShadow = sat < 20 && lum >= 182 && lum <= 248;
        if (isLightGreyShadow) {
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = 255;
        }
      }
    }

    if (maskBuf && maskBuf.width === width && maskBuf.height === height) {
      const mr = maskBuf.data[idx];
      const mg = maskBuf.data[idx + 1];
      const ma = maskBuf.data[idx + 3];
      if (ma > 32) {
        if (mr > 128 && mg < 80) {
          // Erase / Xóa bóng -> exclude from contour
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = hasTransparency ? 0 : 255;
        } else if (mg > 128 && mr < 80) {
          // Keep / Giữ lại -> force solid foreground on tracing copy only
          data[idx] = Math.min(r, 40);
          data[idx + 1] = Math.min(g, 40);
          data[idx + 2] = Math.min(b, 40);
          data[idx + 3] = 255;
        }
      }
    }
  }

  return writeRgbaBuffer(src);
}

/**
 * Compute polygon bounding box in mm.
 */
function polyBoundsMm(poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const x = poly[i][0];
    const y = poly[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function polyAbsAreaMm2(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(s) * 0.5;
}

/**
 * Standard ray-casting point-in-polygon check in mm.
 */
export function pointInPolygonMm(poly, x, y) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Direct sticker hit-test on canvas in mm coordinates.
 * Prefers exact point-in-polygon (smallest area if nested), with padded bbox fallback.
 */
export function hitTestStickerAtMm(contoursMm, xMm, yMm, toleranceMm = 1.0) {
  if (!Array.isArray(contoursMm) || contoursMm.length === 0) return null;
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return null;

  let bestPolyHit = null;
  let bestBboxHit = null;

  for (let idx = 0; idx < contoursMm.length; idx++) {
    const poly = contoursMm[idx];
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const compIdx = poly.compIdx !== undefined ? poly.compIdx : idx;
    const b = polyBoundsMm(poly);

    // Quick reject outside padded bbox
    if (
      xMm < b.minX - toleranceMm ||
      xMm > b.maxX + toleranceMm ||
      yMm < b.minY - toleranceMm ||
      yMm > b.maxY + toleranceMm
    ) {
      continue;
    }

    const area = polyAbsAreaMm2(poly);
    if (pointInPolygonMm(poly, xMm, yMm)) {
      if (!bestPolyHit || area < bestPolyHit.area) {
        bestPolyHit = { index: idx, compIdx, hitType: 'polygon', area };
      }
    } else if (
      xMm >= b.minX - toleranceMm &&
      xMm <= b.maxX + toleranceMm &&
      yMm >= b.minY - toleranceMm &&
      yMm <= b.maxY + toleranceMm
    ) {
      const cx = (b.minX + b.maxX) * 0.5;
      const cy = (b.minY + b.maxY) * 0.5;
      const dist = Math.hypot(xMm - cx, yMm - cy);
      if (!bestBboxHit || dist < bestBboxHit.dist) {
        bestBboxHit = { index: idx, compIdx, hitType: 'bbox', dist };
      }
    }
  }

  if (bestPolyHit) {
    return { index: bestPolyHit.index, compIdx: bestPolyHit.compIdx, hitType: 'polygon' };
  }
  if (bestBboxHit) {
    return { index: bestBboxHit.index, compIdx: bestBboxHit.compIdx, hitType: 'bbox' };
  }
  return null;
}

/**
 * Build closed cubic Bézier path commands from a polygon with optional quadratic-fillet curves.
 */
function buildLineBeziersFromPoly(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const cmds = [{ type: 'M', to: [poly[0][0], poly[0][1]] }];
  for (let i = 1; i < poly.length; i++) {
    cmds.push({ type: 'L', to: [poly[i][0], poly[i][1]] });
  }
  cmds.push({ type: 'L', to: [poly[0][0], poly[0][1]] });
  return cmds;
}

/**
 * Additive corner rounding (fillet) in mm.
 * When cornerRadiusMm <= 0, returns `poly` untouched (preserving VECTOR_ORIGINAL Bézier 100%).
 */
export function applyCornerRoundingMm(poly, cornerRadiusMm = 0) {
  const r = Number(cornerRadiusMm) || 0;
  if (!(r > 0.01) || !Array.isArray(poly) || poly.length < 3) {
    return poly;
  }

  // Deduplicate closing vertex if duplicated
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    if (pts.length > 0) {
      const prev = pts[pts.length - 1];
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 1e-4) continue;
    }
    pts.push([p[0], p[1]]);
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-4) {
    pts.pop();
  }
  if (pts.length < 3) return poly;

  const n = pts.length;
  const outPts = [];
  const beziers = [];
  const SAMPLES = 4;

  for (let i = 0; i < n; i++) {
    const pPrev = pts[(i - 1 + n) % n];
    const pCurr = pts[i];
    const pNext = pts[(i + 1) % n];

    const v1x = pPrev[0] - pCurr[0];
    const v1y = pPrev[1] - pCurr[1];
    const v2x = pNext[0] - pCurr[0];
    const v2y = pNext[1] - pCurr[1];
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);

    if (len1 < 1e-4 || len2 < 1e-4) {
      outPts.push([pCurr[0], pCurr[1]]);
      continue;
    }

    const u1x = v1x / len1;
    const u1y = v1y / len1;
    const u2x = v2x / len2;
    const u2y = v2y / len2;
    const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const angle = Math.acos(dot);

    // Nearly straight vertex (>= 172 deg) -> no fillet needed
    if (angle > (172 * Math.PI) / 180) {
      outPts.push([pCurr[0], pCurr[1]]);
      if (beziers.length === 0) beziers.push({ type: 'M', to: [pCurr[0], pCurr[1]] });
      else beziers.push({ type: 'L', to: [pCurr[0], pCurr[1]] });
      continue;
    }

    const maxD = Math.min(len1 * 0.45, len2 * 0.45);
    const halfAngle = angle * 0.5;
    const tanHalf = Math.max(0.1, Math.tan(halfAngle));
    const d = Math.min(maxD, r / tanHalf);

    const startX = pCurr[0] + u1x * d;
    const startY = pCurr[1] + u1y * d;
    const endX = pCurr[0] + u2x * d;
    const endY = pCurr[1] + u2y * d;

    // Quadratic-to-cubic exact elevation: c1 = start + 2/3*(curr - start), c2 = end + 2/3*(curr - end)
    const c1x = startX + (2 / 3) * (pCurr[0] - startX);
    const c1y = startY + (2 / 3) * (pCurr[1] - startY);
    const c2x = endX + (2 / 3) * (pCurr[0] - endX);
    const c2y = endY + (2 / 3) * (pCurr[1] - endY);

    if (beziers.length === 0) {
      beziers.push({ type: 'M', to: [startX, startY] });
    } else {
      beziers.push({ type: 'L', to: [startX, startY] });
    }
    beziers.push({
      type: 'C',
      c1: [c1x, c1y],
      c2: [c2x, c2y],
      to: [endX, endY],
    });

    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const omt = 1 - t;
      const qx = omt * omt * startX + 2 * omt * t * pCurr[0] + t * t * endX;
      const qy = omt * omt * startY + 2 * omt * t * pCurr[1] + t * t * endY;
      outPts.push([qx, qy]);
    }
  }

  if (beziers.length >= 2) {
    const first = beziers[0].to;
    beziers.push({ type: 'L', to: [first[0], first[1]] });
  }

  const rounded = outPts.length >= 3 ? outPts : poly.map(([x, y]) => [x, y]);
  rounded.beziersMm = beziers.length >= 3 ? beziers : buildLineBeziersFromPoly(rounded);
  rounded.closed = true;
  if (poly.compIdx !== undefined) rounded.compIdx = poly.compIdx;
  if (poly.provenance !== undefined) rounded.provenance = poly.provenance;
  if (poly.coordinateSystem !== undefined) rounded.coordinateSystem = poly.coordinateSystem;
  if (poly.winding !== undefined) rounded.winding = poly.winding;
  rounded.sourceMeta = { ...(poly.sourceMeta || {}), cornerRadiusMm: r };
  return rounded;
}

/**
 * Andrew's monotone chain 2D convex hull (guaranteed simple, closed, non-self-intersecting).
 */
function convexHullMm(points) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const sorted = points
    .map(([x, y]) => [Number(x), Number(y)])
    .sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Merge 2+ selected sticker contours into 1 combined outer contour ("Gộp với tem").
 * `selectedIndices` matches either `poly.compIdx` or array index.
 */
export function mergeSelectedContours(contoursMm, selectedIndices = []) {
  if (!Array.isArray(contoursMm) || contoursMm.length < 2) return contoursMm;
  const selSet = new Set(Array.isArray(selectedIndices) ? selectedIndices : []);
  if (selSet.size < 2) return contoursMm;

  const matchedPositions = [];
  for (let i = 0; i < contoursMm.length; i++) {
    const poly = contoursMm[i];
    const cIdx = poly?.compIdx !== undefined ? poly.compIdx : i;
    if (selSet.has(cIdx)) {
      matchedPositions.push(i);
    }
  }
  if (matchedPositions.length < 2) return contoursMm;

  const matchedSet = new Set(matchedPositions);
  const firstPos = matchedPositions[0];
  const firstPoly = contoursMm[firstPos];
  const allPts = [];
  const mergedCompIds = [];
  for (const pos of matchedPositions) {
    const poly = contoursMm[pos];
    mergedCompIds.push(poly?.compIdx !== undefined ? poly.compIdx : pos);
    for (const pt of poly) {
      if (Array.isArray(pt) && pt.length >= 2) allPts.push([pt[0], pt[1]]);
    }
  }

  const hull = convexHullMm(allPts);
  if (hull.length < 3) return contoursMm;

  hull.beziersMm = buildLineBeziersFromPoly(hull);
  hull.closed = true;
  hull.compIdx = firstPoly?.compIdx !== undefined ? firstPoly.compIdx : firstPos;
  hull.provenance = firstPoly?.provenance;
  hull.mergedFrom = mergedCompIds;

  // Also merge corresponding bleed contours if present
  const oldBleeds = Array.isArray(contoursMm.bleedContoursMm) ? contoursMm.bleedContoursMm : null;
  let mergedBleed = null;
  if (oldBleeds && oldBleeds.length === contoursMm.length) {
    const bleedPts = [];
    for (const pos of matchedPositions) {
      const bPoly = oldBleeds[pos];
      if (Array.isArray(bPoly)) {
        for (const pt of bPoly) {
          if (Array.isArray(pt) && pt.length >= 2) bleedPts.push([pt[0], pt[1]]);
        }
      }
    }
    if (bleedPts.length >= 3) {
      const bHull = convexHullMm(bleedPts);
      bHull.beziersMm = buildLineBeziersFromPoly(bHull);
      bHull.closed = true;
      bHull.compIdx = hull.compIdx;
      mergedBleed = bHull;
    }
  }

  const result = [];
  const newBleeds = [];
  for (let i = 0; i < contoursMm.length; i++) {
    if (i === firstPos) {
      result.push(hull);
      if (oldBleeds) newBleeds.push(mergedBleed || hull);
    } else if (!matchedSet.has(i)) {
      result.push(contoursMm[i]);
      if (oldBleeds && oldBleeds[i]) newBleeds.push(oldBleeds[i]);
    }
  }

  if (oldBleeds) result.bleedContoursMm = newBleeds;
  if (contoursMm.provenance !== undefined) result.provenance = contoursMm.provenance;
  if (contoursMm.validation !== undefined) {
    result.validation = {
      ...contoursMm.validation,
      stickerCount: result.length,
      closedCount: result.length,
    };
  }
  return result;
}

/**
 * Simple outward polygon expansion around centroid (fallback only when bleedContoursMm is missing).
 */
function expandPolyOutwardMm(poly, deltaMm) {
  if (!Array.isArray(poly) || poly.length < 3 || !(deltaMm > 0)) return poly;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;

  const out = poly.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return [x, y];
    return [x + (dx / len) * deltaMm, y + (dy / len) * deltaMm];
  });
  out.beziersMm = buildLineBeziersFromPoly(out);
  out.closed = true;
  if (poly.compIdx !== undefined) out.compIdx = poly.compIdx;
  if (poly.provenance !== undefined) out.provenance = poly.provenance;
  return out;
}

/**
 * Resolve final contours according to the 4 Dieline modes:
 *  - 'original'   : Theo hình gốc
 *  - 'png_alpha'  : Theo biên trong suốt PNG
 *  - 'bleed_edge' : Theo mép tràn lề (uses bleedContoursMm[i] as active CUT)
 *  - 'none'       : Không vẽ đường cắt (suppresses CUT output cleanly)
 */
export function resolveDielineModeContours(contoursMm, dielineMode = DIELINE_MODES.ORIGINAL, bleedOffsetMm = 0) {
  const mode = dielineMode || DIELINE_MODES.ORIGINAL;
  if (!Array.isArray(contoursMm)) return [];

  if (mode === DIELINE_MODES.NONE) {
    const empty = [];
    empty.bleedContoursMm = Array.isArray(contoursMm.bleedContoursMm) ? contoursMm.bleedContoursMm : [];
    empty.dielineMode = DIELINE_MODES.NONE;
    empty.dielineSuppressed = true;
    empty.provenance = contoursMm.provenance;
    empty.validation = contoursMm.validation;
    return empty;
  }

  if (mode === DIELINE_MODES.BLEED_EDGE) {
    const bleeds = Array.isArray(contoursMm.bleedContoursMm) ? contoursMm.bleedContoursMm : [];
    const effDelta = Math.max(0.5, Number(bleedOffsetMm) || 0);
    const out = contoursMm.map((poly, idx) => {
      const bPoly = bleeds[idx];
      if (Array.isArray(bPoly) && bPoly.length >= 3 && !bPoly.invalid) {
        const cloned = bPoly.map(([x, y]) => [x, y]);
        cloned.beziersMm = Array.isArray(bPoly.beziersMm) ? bPoly.beziersMm : buildLineBeziersFromPoly(cloned);
        cloned.closed = true;
        cloned.compIdx = poly.compIdx !== undefined ? poly.compIdx : idx;
        cloned.provenance = poly.provenance;
        cloned.sourceMeta = { ...(poly.sourceMeta || {}), promotedFromBleed: true };
        return cloned;
      }
      return expandPolyOutwardMm(poly, effDelta);
    });
    out.bleedContoursMm = bleeds;
    out.dielineMode = DIELINE_MODES.BLEED_EDGE;
    out.dielineSuppressed = false;
    out.provenance = contoursMm.provenance;
    out.validation = contoursMm.validation;
    return out;
  }

  // 'original' or 'png_alpha': preserve exact array & Bézier references
  contoursMm.dielineMode = mode;
  contoursMm.dielineSuppressed = false;
  return contoursMm;
}

/**
 * Filter contours by export/handoff scope:
 *  - selectionScope === 'selected' with selectedIndices.length > 0 -> only selected stickers
 *  - selectionScope === 'all' -> all stickers on page
 */
export function filterContoursByScope(contoursMm, { selectionScope = 'all', selectedIndices = [] } = {}) {
  if (!Array.isArray(contoursMm) || contoursMm.length === 0) return contoursMm || [];
  if (selectionScope !== 'selected' || !Array.isArray(selectedIndices) || selectedIndices.length === 0) {
    return contoursMm;
  }
  const selSet = new Set(selectedIndices);
  const oldBleeds = Array.isArray(contoursMm.bleedContoursMm) ? contoursMm.bleedContoursMm : [];
  const filtered = [];
  const filteredBleeds = [];

  for (let i = 0; i < contoursMm.length; i++) {
    const poly = contoursMm[i];
    const cIdx = poly?.compIdx !== undefined ? poly.compIdx : i;
    if (selSet.has(cIdx)) {
      filtered.push(poly);
      if (oldBleeds[i]) filteredBleeds.push(oldBleeds[i]);
    }
  }

  filtered.bleedContoursMm = filteredBleeds;
  filtered.provenance = contoursMm.provenance;
  filtered.dielineMode = contoursMm.dielineMode;
  filtered.dielineSuppressed = contoursMm.dielineSuppressed;
  if (contoursMm.validation) {
    filtered.validation = {
      ...contoursMm.validation,
      stickerCount: filtered.length,
      closedCount: filtered.length,
    };
  }
  return filtered;
}

const PT_TO_MM_HELPER = 25.4 / 72;

/**
 * Inspect a PDF page's MediaBox, CropBox, TrimBox, and BleedBox (in top-down mm
 * relative to the rendered viewport CropBox/MediaBox).
 * Used for Vietnamese prepress "PDF đã có biên (tràn lề 2–3 mm)" workflow:
 * detects explicit TrimBox < CropBox/MediaBox so CUT follows TrimBox and
 * existing bleed artwork is preserved without double-bleeding.
 */
export async function extractPdfTrimBleedBoxesMm(pdfBytes, pageNumber = 1) {
  try {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const count = doc.getPageCount();
    if (count === 0) return null;
    const idx = Math.max(0, Math.min(count - 1, (Number(pageNumber) || 1) - 1));
    const page = doc.getPage(idx);

    const mb = page.getMediaBox();
    const cb = page.getCropBox() || mb;
    const hasTrimEntry = Boolean(page.node.get(PDFName.of('TrimBox')));
    const hasBleedEntry = Boolean(page.node.get(PDFName.of('BleedBox')));
    const tb = hasTrimEntry ? page.getTrimBox() : null;
    const bb = hasBleedEntry ? page.getBleedBox() : null;

    // Viewport origin is cb (CropBox, or MediaBox if no CropBox)
    const vpX = cb.x;
    const vpY = cb.y;
    const vpW = cb.width;
    const vpH = cb.height;

    const toTopDownMm = (box) => ({
      x: (box.x - vpX) * PT_TO_MM_HELPER,
      y: (vpY + vpH - (box.y + box.height)) * PT_TO_MM_HELPER,
      w: box.width * PT_TO_MM_HELPER,
      h: box.height * PT_TO_MM_HELPER,
    });

    const viewportMm = { x: 0, y: 0, w: vpW * PT_TO_MM_HELPER, h: vpH * PT_TO_MM_HELPER };
    if (!tb) {
      return {
        pageNumber: idx + 1,
        hasExplicitTrimBox: false,
        hasExplicitBleedBox: Boolean(bb),
        hasExistingBleed: false,
        viewportMm,
        trimRectMm: viewportMm,
        bleedRectMm: bb ? toTopDownMm(bb) : viewportMm,
        existingBleedMm: { left: 0, right: 0, top: 0, bottom: 0, min: 0, max: 0 },
      };
    }

    const trimRectMm = toTopDownMm(tb);
    const bleedRectMm = bb ? toTopDownMm(bb) : viewportMm;

    const insetLeft = Math.max(0, trimRectMm.x);
    const insetTop = Math.max(0, trimRectMm.y);
    const insetRight = Math.max(0, viewportMm.w - (trimRectMm.x + trimRectMm.w));
    const insetBottom = Math.max(0, viewportMm.h - (trimRectMm.y + trimRectMm.h));

    const bLeft = Math.max(0, trimRectMm.x - bleedRectMm.x);
    const bTop = Math.max(0, trimRectMm.y - bleedRectMm.y);
    const bRight = Math.max(0, bleedRectMm.x + bleedRectMm.w - (trimRectMm.x + trimRectMm.w));
    const bBottom = Math.max(0, bleedRectMm.y + bleedRectMm.h - (trimRectMm.y + trimRectMm.h));

    const sidesInsetCount = [insetLeft, insetRight, insetTop, insetBottom].filter((v) => v >= 0.3).length;
    const hasExplicitTrimBox =
      sidesInsetCount >= 2 && trimRectMm.w >= 5 && trimRectMm.h >= 5;

    const effLeft = hasBleedEntry ? bLeft : insetLeft;
    const effRight = hasBleedEntry ? bRight : insetRight;
    const effTop = hasBleedEntry ? bTop : insetTop;
    const effBottom = hasBleedEntry ? bBottom : insetBottom;
    const minBleed = Math.min(effLeft, effRight, effTop, effBottom);
    const maxBleed = Math.max(effLeft, effRight, effTop, effBottom);

    return {
      pageNumber: idx + 1,
      hasExplicitTrimBox,
      hasExplicitBleedBox: hasBleedEntry,
      hasExistingBleed: hasExplicitTrimBox && minBleed >= 0.5,
      viewportMm,
      trimRectMm,
      bleedRectMm,
      existingBleedMm: {
        left: +effLeft.toFixed(3),
        right: +effRight.toFixed(3),
        top: +effTop.toFixed(3),
        bottom: +effBottom.toFixed(3),
        min: +minBleed.toFixed(3),
        max: +maxBleed.toFixed(3),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Build a clean 4-corner closed vector contour from a PDF's explicit TrimBox
 * and attach its BleedBox boundary so prepress PDFs with built-in bleed keep
 * their original bleed artwork intact.
 */
export function buildContourFromTrimBoxMm(trimBleedInfo, { offsetMm = 0, extraBleedMm = 0 } = {}) {
  if (!trimBleedInfo?.trimRectMm) return [];
  const off = Number(offsetMm) || 0;
  const tr = trimBleedInfo.trimRectMm;
  const x0 = tr.x - off;
  const y0 = tr.y - off;
  const x1 = tr.x + tr.w + off;
  const y1 = tr.y + tr.h + off;

  const makeRectPoly = (ax, ay, bx, by) => {
    const pts = [
      [ax, ay],
      [bx, ay],
      [bx, by],
      [ax, by],
    ];
    pts.beziersMm = [
      { type: 'M', to: [ax, ay] },
      { type: 'L', to: [bx, ay] },
      { type: 'L', to: [bx, by] },
      { type: 'L', to: [ax, by] },
      { type: 'L', to: [ax, ay] },
    ];
    pts.closed = true;
    pts.compIdx = 0;
    pts.provenance = 'VECTOR_ORIGINAL';
    return pts;
  };

  const cutPoly = makeRectPoly(x0, y0, x1, y1);
  const contours = [cutPoly];

  const br = trimBleedInfo.bleedRectMm;
  let bleedPoly;
  if (trimBleedInfo.hasExistingBleed && br) {
    bleedPoly = makeRectPoly(br.x, br.y, br.x + br.w, br.y + br.h);
  } else {
    const bOff = Math.max(0, Number(extraBleedMm) || 0);
    bleedPoly = makeRectPoly(x0 - bOff, y0 - bOff, x1 + bOff, y1 + bOff);
  }
  contours.bleedContoursMm = [bleedPoly];
  contours.provenance = 'VECTOR_ORIGINAL';
  contours.fromPdfTrimBox = true;
  contours.hasExistingBleed = Boolean(trimBleedInfo.hasExistingBleed);
  contours.validation = {
    valid: true,
    geometryValid: true,
    offsetWithinTolerance: true,
    productionReady: true,
    stickerCount: 1,
    closedCount: 1,
    errors: [],
    warnings: [],
  };
  return contours;
}
