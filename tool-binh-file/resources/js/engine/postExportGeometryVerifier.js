/**
 * PrintKit Architecture V1 — Phase V1-A5: Independent Post-Export CUT.pdf Geometry Verifier
 *
 * Enforces Point D:
 *  - Reads back the ACTUAL exported CUT.pdf bytes (browser-safe, ZERO Node Buffer dependency).
 *  - Parses every stroked CUT path from the PDF content stream.
 *  - Inverts each placement's exact rigidMatrixMm back into job-local mm space.
 *  - Measures real geometric fidelity against original CanonicalCutV1 / cutTargetMm:
 *      1. Contour count (1-to-1 match with ImpositionPlanV1 placements)
 *      2. Bézier segment count (structural preservation)
 *      3. Closedness & 0 self-intersections
 *      4. Bidirectional Hausdorff & mean deviation (mm)
 *      5. Radial valley depth preservation (mm)
 *      6. Tangent continuity / new kinks (comparing cubic Bézier derivatives)
 *      7. Sheet-level CUT-CUT minimum gap & 0 collisions
 *      8. BLEED validity check
 *  - Returns status 'PASS' | 'WARNING' | 'BLOCK' so checkpointKUiBridge blocks release on violation.
 *
 * ZERO edits to any LOCKED engine file.
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import { tessellateAndVerifyContourMm } from './productionBleedSafetyH22.js';

export const POST_EXPORT_VERIFIER_VERSION = 'V1-A5.0';
const PT_TO_MM = 1 / MM_TO_PT;

export const DEFAULT_POST_EXPORT_TOLERANCES = Object.freeze({
  maxHausdorffMm: 0.02,
  maxMeanDeviationMm: 0.008,
  maxValleyDepthDeltaMm: 0.015,
  kinkDeltaThresholdDeg: 5.0,
  cutGapSlackMm: 0.05,
  flatnessMm: 0.005,
});

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

function bytesToLatin1(bytes) {
  if (!bytes || !bytes.length) return '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunks = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return chunks.join('');
}

function mulCtm(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a2 * a1 + b2 * c1,
    a2 * b1 + b2 * d1,
    c2 * a1 + d2 * c1,
    c2 * b1 + d2 * d1,
    e2 * a1 + f2 * c1 + e1,
    e2 * b1 + f2 * d1 + f1,
  ];
}

function applyCtm(ctm, x, y) {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

function decodePageStream(page) {
  const contents = page.node.get(PDFName.of('Contents'));
  if (!contents) return '';
  const ctx = page.doc.context;
  const dec = (ref) => {
    const obj = ctx.lookup(ref);
    if (!(obj instanceof PDFRawStream)) return '';
    try {
      return bytesToLatin1(decodePDFRawStream(obj).decode());
    } catch {
      return bytesToLatin1(obj.contents);
    }
  };
  if (contents instanceof PDFArray) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) out += '\n' + dec(contents.get(i));
    return out;
  }
  return dec(contents);
}

/**
 * Parse all stroked paths from an exported CUT.pdf page into sheet-mm Y-down coordinates.
 */
export function parseStrokedPathsFromPdfPage(page) {
  const mb = page.getMediaBox();
  const pageWidthMm = r4(mb.width * PT_TO_MM);
  const pageHeightMm = r4(mb.height * PT_TO_MM);
  const stream = decodePageStream(page);

  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let curSubpaths = [];
  let curCmds = [];
  let curPt = null;
  let startPt = null;
  const strokedPaths = [];

  const toSheetMm = (xPt, yPt) => {
    const [gx, gy] = applyCtm(ctm, xPt, yPt);
    return [(gx - mb.x) * PT_TO_MM, (mb.height - (gy - mb.y)) * PT_TO_MM];
  };

  const closeCurrentSubpath = () => {
    if (startPt && curPt && Math.hypot(curPt[0] - startPt[0], curPt[1] - startPt[1]) > 1e-4) {
      curCmds.push({ type: 'L', to: [...startPt] });
      curPt = [...startPt];
    }
  };

  const resetPath = () => {
    curSubpaths = [];
    curCmds = [];
    curPt = null;
    startPt = null;
  };

  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const RE_CM = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+cm$`);
  const RE_M = new RegExp(`^(${NUM})\\s+(${NUM})\\s+m$`);
  const RE_L = new RegExp(`^(${NUM})\\s+(${NUM})\\s+l$`);
  const RE_C = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+c$`);
  const RE_V = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+v$`);
  const RE_Y = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+y$`);
  const RE_RE = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+re$`);

  for (const rawLine of stream.split(/\r?\n/)) {
    const l = rawLine.trim();
    if (!l) continue;

    if (l === 'q') { stack.push([...ctm]); continue; }
    if (l === 'Q') { if (stack.length) ctm = stack.pop(); continue; }

    const cm = l.match(RE_CM);
    if (cm) { ctm = mulCtm(ctm, cm.slice(1, 7).map(Number)); continue; }

    const mOp = l.match(RE_M);
    if (mOp) {
      if (curCmds.length >= 3) curSubpaths.push(curCmds);
      const pt = toSheetMm(parseFloat(mOp[1]), parseFloat(mOp[2]));
      curCmds = [{ type: 'M', to: pt }];
      curPt = pt;
      startPt = pt;
      continue;
    }
    const lOp = l.match(RE_L);
    if (lOp && curPt) {
      const pt = toSheetMm(parseFloat(lOp[1]), parseFloat(lOp[2]));
      curCmds.push({ type: 'L', to: pt });
      curPt = pt;
      continue;
    }
    const cOp = l.match(RE_C);
    if (cOp && curPt) {
      const c1 = toSheetMm(parseFloat(cOp[1]), parseFloat(cOp[2]));
      const c2 = toSheetMm(parseFloat(cOp[3]), parseFloat(cOp[4]));
      const to = toSheetMm(parseFloat(cOp[5]), parseFloat(cOp[6]));
      curCmds.push({ type: 'C', c1, c2, to });
      curPt = to;
      continue;
    }
    const vOp = l.match(RE_V);
    if (vOp && curPt) {
      const c2 = toSheetMm(parseFloat(vOp[1]), parseFloat(vOp[2]));
      const to = toSheetMm(parseFloat(vOp[3]), parseFloat(vOp[4]));
      curCmds.push({ type: 'C', c1: [...curPt], c2, to });
      curPt = to;
      continue;
    }
    const yOp = l.match(RE_Y);
    if (yOp && curPt) {
      const c1 = toSheetMm(parseFloat(yOp[1]), parseFloat(yOp[2]));
      const to = toSheetMm(parseFloat(yOp[3]), parseFloat(yOp[4]));
      curCmds.push({ type: 'C', c1, c2: [...to], to });
      curPt = to;
      continue;
    }
    const reOp = l.match(RE_RE);
    if (reOp) {
      if (curCmds.length >= 3) curSubpaths.push(curCmds);
      const x = parseFloat(reOp[1]), y = parseFloat(reOp[2]), w = parseFloat(reOp[3]), h = parseFloat(reOp[4]);
      const p0 = toSheetMm(x, y);
      const p1 = toSheetMm(x + w, y);
      const p2 = toSheetMm(x + w, y + h);
      const p3 = toSheetMm(x, y + h);
      curCmds = [{ type: 'M', to: p0 }, { type: 'L', to: p1 }, { type: 'L', to: p2 }, { type: 'L', to: p3 }, { type: 'L', to: p0 }];
      curPt = p0;
      startPt = p0;
      continue;
    }
    if (l === 'h') {
      closeCurrentSubpath();
      continue;
    }
    if (l === 'S' || l === 's' || l === 'B' || l === 'B*' || l === 'b' || l === 'b*') {
      if (l === 's' || l === 'b' || l === 'b*') closeCurrentSubpath();
      if (curCmds.length >= 3) curSubpaths.push(curCmds);
      for (const sub of curSubpaths) {
        if (sub.length >= 3) strokedPaths.push(sub);
      }
      resetPath();
      continue;
    }
    if (l === 'f' || l === 'f*' || l === 'F' || l === 'n' || l === 'W' || l === 'W*' || l === 'W n' || l === 'W* n') {
      resetPath();
    }
  }

  return { pageWidthMm, pageHeightMm, strokedPaths };
}

function invertRigidPoint(rigidMatrixMm, pt) {
  const [a, b, c, d, tx, ty] = rigidMatrixMm;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [pt[0], pt[1]];
  const dx = pt[0] - tx;
  const dy = pt[1] - ty;
  return [(d * dx - c * dy) / det, (-b * dx + a * dy) / det];
}

function invertRigidBeziers(beziersMm, rigidMatrixMm) {
  return beziersMm.map((cmd) => {
    const out = { type: cmd.type };
    if (cmd.to) out.to = invertRigidPoint(rigidMatrixMm, cmd.to);
    if (cmd.c1) out.c1 = invertRigidPoint(rigidMatrixMm, cmd.c1);
    if (cmd.c2) out.c2 = invertRigidPoint(rigidMatrixMm, cmd.c2);
    return out;
  });
}

function countNonDegenerateSegments(beziersMm) {
  if (!Array.isArray(beziersMm)) return 0;
  let count = 0;
  let cur = null;
  for (const cmd of beziersMm) {
    if (cmd.type === 'M' && cmd.to) {
      cur = cmd.to;
    } else if (cmd.type === 'C' && cmd.to) {
      count++;
      cur = cmd.to;
    } else if (cmd.type === 'L' && cmd.to) {
      if (!cur || Math.hypot(cmd.to[0] - cur[0], cmd.to[1] - cur[1]) > 1e-4) {
        count++;
      }
      cur = cmd.to;
    }
  }
  return count;
}

function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-16) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

function directedPolyDistance(polyA, polyB) {
  let maxSq = 0;
  let sumDist = 0;
  const nB = polyB.length;
  for (let i = 0; i < polyA.length; i++) {
    const [px, py] = polyA[i];
    let minSq = Infinity;
    for (let j = 0; j < nB; j++) {
      const [ax, ay] = polyB[j];
      const [bx, by] = polyB[(j + 1) % nB];
      const dSq = pointToSegmentDistSq(px, py, ax, ay, bx, by);
      if (dSq < minSq) minSq = dSq;
    }
    if (minSq > maxSq) maxSq = minSq;
    sumDist += Math.sqrt(minSq);
  }
  return { max: Math.sqrt(maxSq), mean: polyA.length ? sumDist / polyA.length : 0 };
}

function computeHausdorffAndMeanMm(polyA, polyB) {
  const dAB = directedPolyDistance(polyA, polyB);
  const dBA = directedPolyDistance(polyB, polyA);
  return {
    hausdorffMm: Math.max(dAB.max, dBA.max),
    meanMm: (dAB.mean + dBA.mean) * 0.5,
  };
}

/**
 * Measure global radial span AND exact 72-ray angular radial profile from centroid.
 * Ray-edge intersection eliminates vertex bin-boundary aliasing while catching
 * flattening of even 1 valley out of 12.
 */
function measureRadialValleyProfileMm(poly, bounds, rays = 72) {
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const n = poly.length;
  let rMin = Infinity;
  let rMax = -Infinity;
  const rayR = new Float64Array(rays);

  for (let k = 0; k < rays; k++) {
    const theta = (2 * Math.PI * k) / rays;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    let minT = Infinity;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % n];
      const vx = bx - ax;
      const vy = by - ay;
      const denom = dx * vy - dy * vx;
      if (Math.abs(denom) < 1e-12) continue;
      const wx = ax - cx;
      const wy = ay - cy;
      const t = (wx * vy - wy * vx) / denom;
      if (t < 0 || t >= minT) continue;
      const u = (wx * dy - wy * dx) / denom;
      if (u >= -1e-7 && u <= 1 + 1e-7) {
        minT = t;
      }
    }
    rayR[k] = Number.isFinite(minT) ? minT : NaN;
    if (Number.isFinite(minT)) {
      if (minT < rMin) rMin = minT;
      if (minT > rMax) rMax = minT;
    }
  }

  const depths = new Float64Array(rays);
  for (let k = 0; k < rays; k++) {
    depths[k] = Number.isFinite(rayR[k]) && Number.isFinite(rMax) ? rMax - rayR[k] : NaN;
  }
  return {
    globalSpanMm: Number.isFinite(rMin) && Number.isFinite(rMax) ? rMax - rMin : 0,
    sectorDepthsMm: depths,
  };
}

function maxValleyProfileDeltaMm(origProfile, expProfile) {
  let maxDelta = Math.abs(expProfile.globalSpanMm - origProfile.globalSpanMm);
  const a = origProfile.sectorDepthsMm;
  const b = expProfile.sectorDepthsMm;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      const d = Math.abs(a[i] - b[i]);
      if (d > maxDelta) maxDelta = d;
    }
  }
  return maxDelta;
}

/**
 * Compute turning angles (degrees) at every junction between consecutive Bézier/Line segments.
 */
function measureJunctionTangentJumpsDeg(beziersMm) {
  const segs = [];
  let cur = null;
  for (const cmd of beziersMm || []) {
    if (cmd.type === 'M' && cmd.to) {
      cur = cmd.to;
    } else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to && cur) {
      const startDx = cmd.c1[0] - cur[0];
      const startDy = cmd.c1[1] - cur[1];
      const endDx = cmd.to[0] - cmd.c2[0];
      const endDy = cmd.to[1] - cmd.c2[1];
      const sLen = Math.hypot(startDx, startDy);
      const eLen = Math.hypot(endDx, endDy);
      const fallbackDx = cmd.to[0] - cur[0];
      const fallbackDy = cmd.to[1] - cur[1];
      const fLen = Math.hypot(fallbackDx, fallbackDy);
      if (fLen > 1e-4 || sLen > 1e-4 || eLen > 1e-4) {
        segs.push({
          inDir: sLen > 1e-5 ? [startDx / sLen, startDy / sLen] : [fallbackDx / (fLen || 1), fallbackDy / (fLen || 1)],
          outDir: eLen > 1e-5 ? [endDx / eLen, endDy / eLen] : [fallbackDx / (fLen || 1), fallbackDy / (fLen || 1)],
        });
      }
      cur = cmd.to;
    } else if (cmd.type === 'L' && cmd.to && cur) {
      const dx = cmd.to[0] - cur[0];
      const dy = cmd.to[1] - cur[1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-4) {
        segs.push({ inDir: [dx / len, dy / len], outDir: [dx / len, dy / len] });
      }
      cur = cmd.to;
    }
  }
  const jumps = [];
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i].outDir;
    const b = segs[(i + 1) % segs.length].inDir;
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
    jumps.push((Math.acos(dot) * 180) / Math.PI);
  }
  return jumps;
}

/**
 * Per-junction comparison so a new kink on a smooth segment is NEVER masked by an
 * existing intentional sharp corner elsewhere on the contour.
 */
function countNewTangentKinks(origJumps, expJumps, thresholdDeg) {
  if (!expJumps.length) return 0;
  if (origJumps.length === expJumps.length) {
    let kinks = 0;
    for (let i = 0; i < expJumps.length; i++) {
      if (expJumps[i] > origJumps[i] + thresholdDeg) kinks++;
    }
    return kinks;
  }
  // Fallback when segment counts differ: compare sorted descending jump spectra
  const oSorted = [...origJumps].sort((a, b) => b - a);
  const eSorted = [...expJumps].sort((a, b) => b - a);
  let kinks = 0;
  for (let i = 0; i < eSorted.length; i++) {
    const ref = i < oSorted.length ? oSorted[i] : 0;
    if (eSorted[i] > ref + thresholdDeg) kinks++;
  }
  return kinks;
}

function pointInPoly(pt, poly) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const ccw = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = ccw(ax, ay, bx, by, cx, cy);
  const d2 = ccw(ax, ay, bx, by, dx, dy);
  const d3 = ccw(cx, cy, dx, dy, ax, ay);
  const d4 = ccw(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function minPolygonPairDistanceMm(polyA, polyB) {
  const nA = polyA.length;
  const nB = polyB.length;
  if (nA < 3 || nB < 3) return Infinity;

  // 1. Check containment (one polygon inside the other)
  if (pointInPoly(polyA[0], polyB) || pointInPoly(polyB[0], polyA)) {
    return 0;
  }

  // 2. Check edge-edge intersections AND bidirectional vertex-to-edge minimum distance
  const stepA = nA > 200 ? Math.floor(nA / 120) : 1;
  const stepB = nB > 200 ? Math.floor(nB / 120) : 1;
  let minSq = Infinity;

  for (let i = 0; i < nA; i += stepA) {
    const [ax, ay] = polyA[i];
    const [bx, by] = polyA[(i + stepA) % nA];
    for (let j = 0; j < nB; j += stepB) {
      const [cx, cy] = polyB[j];
      const [dx, dy] = polyB[(j + stepB) % nB];
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
        return 0;
      }
      const dSq1 = pointToSegmentDistSq(ax, ay, cx, cy, dx, dy);
      if (dSq1 < minSq) minSq = dSq1;
      const dSq2 = pointToSegmentDistSq(cx, cy, ax, ay, bx, by);
      if (dSq2 < minSq) minSq = dSq2;
    }
  }
  return Math.sqrt(minSq);
}

/**
 * Independent Post-Export Geometry Verification on ACTUAL exported CUT.pdf bytes.
 */
export async function verifyExportedCutPdfGeometry({
  cutPdfBytes,
  impositionPlan,
  jobs,
  expectedCutGapMm = 0,
  tolerances = {},
}) {
  const tol = { ...DEFAULT_POST_EXPORT_TOLERANCES, ...tolerances };
  const errors = [];
  const warnings = [];
  const jobMap = new Map((jobs || []).map((j) => [j.jobId, j]));

  if (!cutPdfBytes || !cutPdfBytes.byteLength) {
    return {
      verifierVersion: POST_EXPORT_VERIFIER_VERSION,
      status: 'BLOCK',
      passed: false,
      errors: ['EMPTY_CUT_PDF_BYTES: Không đọc được dữ liệu CUT.pdf sau xuất'],
      warnings: [],
      metrics: null,
      perSheet: [],
    };
  }

  const cutDoc = await PDFDocument.load(cutPdfBytes);
  const pdfPages = cutDoc.getPages();
  const planSheets = impositionPlan?.sheets || [];

  if (pdfPages.length !== planSheets.length) {
    errors.push(`PAGE_COUNT_MISMATCH: CUT.pdf có ${pdfPages.length} trang nhưng ImpositionPlan có ${planSheets.length} trang`);
  }

  let totalExpectedContours = 0;
  let totalExportedContours = 0;
  let totalClosedContours = 0;
  let totalSelfIntersections = 0;
  let totalSegmentMismatches = 0;
  let totalNewKinks = 0;
  let globalMaxHausdorffMm = 0;
  let globalMeanSum = 0;
  let globalMeanCount = 0;
  let globalMaxValleyDeltaMm = 0;
  let globalMinCutGapMm = Infinity;
  let globalCutCollisions = 0;
  const perSheet = [];

  // Cache tessellated original contours & tangent jumps per jobId
  const origCache = new Map();
  const getOrigData = (jobId) => {
    if (origCache.has(jobId)) return origCache.get(jobId);
    const job = jobMap.get(jobId);
    const cutTarget = job?.productionGeometry?.cutTargetMm;
    const origBeziers = Array.isArray(cutTarget?.beziersMm) ? cutTarget.beziersMm : [];
    const origTess = tessellateAndVerifyContourMm(
      { beziersMm: origBeziers, closed: true },
      { flatnessMm: tol.flatnessMm }
    );
    const data = {
      job,
      origBeziers,
      origSegCount: countNonDegenerateSegments(origBeziers),
      origTess,
      origValleyProfile: origTess.valid ? measureRadialValleyProfileMm(origTess.poly, origTess.bounds) : null,
      origTangentJumpsDeg: measureJunctionTangentJumpsDeg(origBeziers),
    };
    origCache.set(jobId, data);
    return data;
  };

  for (let s = 0; s < Math.min(pdfPages.length, planSheets.length); s++) {
    const page = pdfPages[s];
    const sheetPlan = planSheets[s];
    const placements = sheetPlan.placements || [];
    totalExpectedContours += placements.length;

    // Pre-compute minimum expected sticker area on this sheet for adaptive noise filtering
    let minExpectedAreaMm2 = Infinity;
    for (const pl of placements) {
      const o = getOrigData(pl.jobId);
      if (o.origTess.valid && o.origTess.areaMm2 < minExpectedAreaMm2) {
        minExpectedAreaMm2 = o.origTess.areaMm2;
      }
    }
    const noiseAreaCutoffMm2 = Number.isFinite(minExpectedAreaMm2)
      ? Math.min(0.5, minExpectedAreaMm2 * 0.25)
      : 0.5;

    const { pageWidthMm, pageHeightMm, strokedPaths } = parseStrokedPathsFromPdfPage(page);

    if (Math.abs(pageWidthMm - sheetPlan.widthMm) > 0.05 || Math.abs(pageHeightMm - sheetPlan.heightMm) > 0.05) {
      errors.push(
        `SHEET_SIZE_MISMATCH (Sheet ${s + 1}): CUT.pdf ${pageWidthMm}×${pageHeightMm}mm != Plan ${sheetPlan.widthMm}×${sheetPlan.heightMm}mm`
      );
    }

    const cutCandidates = [];
    for (const cmds of strokedPaths) {
      const segCnt = countNonDegenerateSegments(cmds);
      if (segCnt < 3) continue;
      const tess = tessellateAndVerifyContourMm({ beziersMm: cmds, closed: true }, { flatnessMm: tol.flatnessMm });
      if (!tess.valid) {
        // Still record invalid path if large enough to be a broken sticker contour
        if (tess.areaMm2 >= noiseAreaCutoffMm2 || segCnt >= 4) {
          totalSelfIntersections++;
          errors.push(`INVALID_EXPORTED_CONTOUR (Sheet ${s + 1}): ${tess.reason || 'open or self-intersecting'}`);
        }
        continue;
      }
      if (tess.areaMm2 < noiseAreaCutoffMm2) continue;
      cutCandidates.push({
        beziersMm: cmds,
        segCount: segCnt,
        tess,
        cx: (tess.bounds.minX + tess.bounds.maxX) * 0.5,
        cy: (tess.bounds.minY + tess.bounds.maxY) * 0.5,
      });
    }

    totalExportedContours += cutCandidates.length;
    totalClosedContours += cutCandidates.length;

    if (cutCandidates.length !== placements.length) {
      errors.push(
        `CONTOUR_COUNT_MISMATCH (Sheet ${s + 1}): CUT.pdf có ${cutCandidates.length} contour nhưng kế hoạch có ${placements.length}`
      );
    }

    // Match each placement to its nearest exported CUT path in sheet-mm
    const used = new Uint8Array(cutCandidates.length);
    let sheetMaxHausdorff = 0;
    let sheetMaxValleyDelta = 0;
    let sheetSegMismatches = 0;
    let sheetNewKinks = 0;

    for (let p = 0; p < placements.length; p++) {
      const pl = placements[p];
      const orig = getOrigData(pl.jobId);
      if (!orig.origTess.valid) {
        errors.push(`INVALID_ORIGINAL_CONTOUR: Job ${pl.jobId}`);
        continue;
      }
      // Compute expected sheet centroid via rigidMatrixMm
      const oCx = (orig.origTess.bounds.minX + orig.origTess.bounds.maxX) * 0.5;
      const oCy = (orig.origTess.bounds.minY + orig.origTess.bounds.maxY) * 0.5;
      const [a, b, c, d, tx, ty] = pl.rigidMatrixMm;
      const expCx = a * oCx + c * oCy + tx;
      const expCy = b * oCx + d * oCy + ty;

      let bestIdx = -1;
      let bestDist = Infinity;
      for (let k = 0; k < cutCandidates.length; k++) {
        if (used[k]) continue;
        const dist = Math.hypot(cutCandidates[k].cx - expCx, cutCandidates[k].cy - expCy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = k;
        }
      }

      if (bestIdx === -1 || bestDist > 5.0) {
        errors.push(`UNMATCHED_PLACEMENT (Sheet ${s + 1}, ${pl.placementId}): Không tìm thấy contour khớp trong CUT.pdf`);
        continue;
      }
      used[bestIdx] = 1;
      const expPath = cutCandidates[bestIdx];

      // 1. Segment count check
      if (expPath.segCount !== orig.origSegCount) {
        sheetSegMismatches++;
        totalSegmentMismatches++;
      }

      // 2. Invert rigidMatrixMm back into job-local mm space
      const invBeziers = invertRigidBeziers(expPath.beziersMm, pl.rigidMatrixMm);
      const invTess = tessellateAndVerifyContourMm({ beziersMm: invBeziers, closed: true }, { flatnessMm: tol.flatnessMm });
      if (!invTess.valid) {
        totalSelfIntersections++;
        errors.push(`INVERTED_CONTOUR_INVALID (${pl.placementId})`);
        continue;
      }

      // 3. Hausdorff & mean deviation
      const { hausdorffMm, meanMm } = computeHausdorffAndMeanMm(orig.origTess.poly, invTess.poly);
      if (hausdorffMm > sheetMaxHausdorff) sheetMaxHausdorff = hausdorffMm;
      if (hausdorffMm > globalMaxHausdorffMm) globalMaxHausdorffMm = hausdorffMm;
      globalMeanSum += meanMm;
      globalMeanCount++;

      // 4. Angular valley depth profile delta (catches single-valley flattening too)
      const expValleyProfile = measureRadialValleyProfileMm(invTess.poly, invTess.bounds);
      const vDelta = orig.origValleyProfile ? maxValleyProfileDeltaMm(orig.origValleyProfile, expValleyProfile) : 0;
      if (vDelta > sheetMaxValleyDelta) sheetMaxValleyDelta = vDelta;
      if (vDelta > globalMaxValleyDeltaMm) globalMaxValleyDeltaMm = vDelta;

      // 5. Per-junction tangent continuity / new kinks
      const expJumps = measureJunctionTangentJumpsDeg(invBeziers);
      const newKinksHere = countNewTangentKinks(orig.origTangentJumpsDeg, expJumps, tol.kinkDeltaThresholdDeg);
      if (newKinksHere > 0) {
        sheetNewKinks++;
        totalNewKinks++;
      }
    }

    // 6. Sheet-level CUT-CUT minimum gap & true overlap/collision check (bbox-pruned)
    let sheetMinGap = Infinity;
    for (let i = 0; i < cutCandidates.length; i++) {
      const A = cutCandidates[i];
      for (let j = i + 1; j < cutCandidates.length; j++) {
        const B = cutCandidates[j];
        const dxBox = Math.max(0, A.tess.bounds.minX - B.tess.bounds.maxX, B.tess.bounds.minX - A.tess.bounds.maxX);
        const dyBox = Math.max(0, A.tess.bounds.minY - B.tess.bounds.maxY, B.tess.bounds.minY - A.tess.bounds.maxY);
        const lbDist = Math.hypot(dxBox, dyBox);
        if (lbDist > Math.max(sheetMinGap, expectedCutGapMm + 1.0)) continue;

        const gap = minPolygonPairDistanceMm(A.tess.poly, B.tess.poly);
        if (gap < 1e-4) {
          globalCutCollisions++;
        }
        if (gap < sheetMinGap) sheetMinGap = gap;
      }
    }
    if (sheetMinGap < globalMinCutGapMm) globalMinCutGapMm = sheetMinGap;

    if (sheetSegMismatches > 0) {
      errors.push(`BEZIER_SEGMENT_MISMATCH (Sheet ${s + 1}): ${sheetSegMismatches} tem bị thay đổi số đoạn Bézier`);
    }
    if (sheetMaxHausdorff > tol.maxHausdorffMm) {
      errors.push(
        `HAUSDORFF_EXCEEDED (Sheet ${s + 1}): Sai lệch Hausdorff ${r4(sheetMaxHausdorff)}mm > ngưỡng ${tol.maxHausdorffMm}mm`
      );
    }
    if (sheetMaxValleyDelta > tol.maxValleyDepthDeltaMm) {
      errors.push(
        `VALLEY_DEPTH_DISTORTED (Sheet ${s + 1}): Sai lệch độ sâu khe lõm ${r4(sheetMaxValleyDelta)}mm > ngưỡng ${tol.maxValleyDepthDeltaMm}mm`
      );
    }
    if (sheetNewKinks > 0) {
      errors.push(`TANGENT_KINKS_DETECTED (Sheet ${s + 1}): Phát hiện ${sheetNewKinks} tem có khấc gợn tiếp tuyến mới`);
    }

    perSheet.push({
      sheetIndex: s + 1,
      expectedContours: placements.length,
      exportedContours: cutCandidates.length,
      segmentMismatches: sheetSegMismatches,
      maxHausdorffMm: r4(sheetMaxHausdorff),
      maxValleyDepthDeltaMm: r4(sheetMaxValleyDelta),
      newKinksCount: sheetNewKinks,
      minCutGapMm: Number.isFinite(sheetMinGap) ? r4(sheetMinGap) : null,
    });
  }

  // 7. BLEED validity audit across all active jobs
  let bleedCheckedCount = 0;
  let bleedInvalidCount = 0;
  for (const job of jobs || []) {
    if (!job?.order?.included || !(job.order.quantity > 0)) continue;
    if (job.bleedConfig?.bleedMode === 'precision' && job.bleedConfig?.bleedOffsetMm > 0.05) {
      bleedCheckedCount++;
      const bGeo = job.productionGeometry?.bleedTargetMm;
      const bStatus = job.validation?.geometryValidation?.bleedStatus;
      if (!bGeo || bStatus === 'FAIL' || bStatus === 'INVALID') {
        bleedInvalidCount++;
        errors.push(`BLEED_INVALID (${job.jobId}): BLEED không hợp lệ hoặc bị thiếu`);
      } else {
        const bt = tessellateAndVerifyContourMm(
          { beziersMm: bGeo.beziersMm, closed: true },
          { flatnessMm: 0.01 }
        );
        if (!bt.valid) {
          bleedInvalidCount++;
          errors.push(`BLEED_GEOMETRY_BROKEN (${job.jobId}): ${bt.reason || 'open/self-intersecting'}`);
        }
      }
    }
  }

  const meanDeviationMm = globalMeanCount > 0 ? globalMeanSum / globalMeanCount : 0;
  if (meanDeviationMm > tol.maxMeanDeviationMm) {
    errors.push(`MEAN_DEVIATION_EXCEEDED: Sai lệch trung bình ${r4(meanDeviationMm)}mm > ngưỡng ${tol.maxMeanDeviationMm}mm`);
  }
  if (globalCutCollisions > 0) {
    errors.push(`CUT_CUT_COLLISION: Phát hiện ${globalCutCollisions} cặp đường CUT chạm/giao nhau trong CUT.pdf`);
  }
  if (expectedCutGapMm > 0 && Number.isFinite(globalMinCutGapMm) && globalMinCutGapMm < expectedCutGapMm - tol.cutGapSlackMm) {
    errors.push(
      `CUT_GAP_VIOLATION: Khoảng cách CUT-CUT nhỏ nhất ${r4(globalMinCutGapMm)}mm < yêu cầu ${expectedCutGapMm}mm`
    );
  }

  const passed = errors.length === 0;
  return {
    verifierVersion: POST_EXPORT_VERIFIER_VERSION,
    status: passed ? (warnings.length > 0 ? 'WARNING' : 'PASS') : 'BLOCK',
    passed,
    errors,
    warnings,
    metrics: {
      expectedContours: totalExpectedContours,
      exportedContours: totalExportedContours,
      closedContours: totalClosedContours,
      selfIntersections: totalSelfIntersections,
      segmentMismatches: totalSegmentMismatches,
      maxHausdorffMm: r4(globalMaxHausdorffMm),
      meanDeviationMm: r4(meanDeviationMm),
      maxValleyDepthDeltaMm: r4(globalMaxValleyDeltaMm),
      newKinksCount: totalNewKinks,
      minCutGapMm: Number.isFinite(globalMinCutGapMm) ? r4(globalMinCutGapMm) : null,
      cutCollisions: globalCutCollisions,
      bleedCheckedCount,
      bleedInvalidCount,
    },
    perSheet,
  };
}
