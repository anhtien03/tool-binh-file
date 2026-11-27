/**
 * PrintKit Architecture V1 — Phase A: Direct PDF Vector Contour Importer
 *
 * Extracts authentic cubic Bézier CUT contours directly from vector PDF content streams
 * with full CTM matrix stack tracking — ZERO rasterization, ZERO edits to LOCKED files.
 *
 * Discrimination rules (NEVER area or bbox alone):
 *  1. Full 2D affine CTM stack (`q`/`Q`/`cm`) + Y-up -> Y-down mm conversion.
 *  2. Tracks paint operator (`fill` vs `stroke` vs `fillStroke`), CMYK/RGB/Gray colors,
 *     line width, and OCG layer visibility (`/OC BDC..EMC`).
 *  3. Topological containment forest (`pointStrictlyInPolygon`) distinguishes the outermost
 *     filled artwork contour (e.g. 20.024mm cream background) from interior decorative strokes
 *     (e.g. 18.025mm burgundy border) and text glyphs.
 *  4. Fail-safe ambiguity detection: returns `CONFIRMATION_REQUIRED` or `FALLBACK_TO_RASTER`
 *     with explicit warnings whenever vector boundaries are missing, raster-only, or ambiguous.
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import { tessellateAndVerifyContourMm } from './productionBleedSafetyH22.js';

export const PDF_VECTOR_IMPORTER_VERSION = 'A1.1';
const PT_TO_MM = 1 / MM_TO_PT;

export const CONTOUR_PROVENANCE = Object.freeze({
  VECTOR_ORIGINAL: 'VECTOR_ORIGINAL',
  VECTOR_TRANSFORMED: 'VECTOR_TRANSFORMED',
  RASTER_DERIVED: 'RASTER_DERIVED',
  VECTOR_IMPORT_REJECTED: 'VECTOR_IMPORT_REJECTED',
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

function signedPolyAreaMm2(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return s * 0.5;
}

function mulCtm(m1, m2) {
  // Standard PDF post-concatenation: m_new = m2 * m1 (point p' = m1(m2(p)))
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
 * Resolve OCG tag -> { name, visible } map for a PDF page.
 */
function resolvePageOcgMap(doc, page) {
  const map = new Map();
  const offRefs = new Set();
  const catalog = doc.catalog;
  const ocProps = catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (ocProps) {
    const dDict = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
    const offArr = dDict?.lookupMaybe(PDFName.of('OFF'), PDFArray);
    if (offArr) {
      for (let i = 0; i < offArr.size(); i++) {
        offRefs.add(String(offArr.get(i)));
      }
    }
  }

  const res = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const props = res?.lookupMaybe(PDFName.of('Properties'), PDFDict);
  if (props) {
    for (const [key, val] of props.entries()) {
      const tag = key.decodeText ? key.decodeText() : String(key).replace(/^\//, '');
      const refStr = String(val);
      const ocg = doc.context.lookup(val);
      if (ocg instanceof PDFDict) {
        const nameObj = ocg.get(PDFName.of('Name'));
        const name = nameObj?.decodeText ? nameObj.decodeText() : String(nameObj || tag).replace(/^\(|\)$/g, '');
        map.set(tag, { name, visible: !offRefs.has(refStr) });
      }
    }
  }
  return map;
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

function isPureMagentaStroke(color) {
  if (!color || color.space !== 'DeviceCMYK') return false;
  const [c, m, y, k] = color.values;
  return c <= 0.02 && m >= 0.95 && y <= 0.02 && k <= 0.02;
}

function isCutLayerName(name) {
  if (!name) return false;
  return /\b(khuon|khuon\s*be|cutcontour|kisscut|diecut|dieline|cut)\b/i.test(name);
}

/**
 * Extract authentic vector CUT contours directly from a PDF page (1-based `pageNumber`).
 */
export async function extractPdfVectorContours(
  pdfBytes,
  {
    pageNumber = 1,
    minAreaMm2 = 8.0,
    maxPageCoverageRatio = 0.9,
    preferExplicitCutLayer = true,
    flatnessMm = 0.002,
  } = {}
) {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  if (pageNumber < 1 || pageNumber > pages.length) {
    return {
      status: 'FALLBACK_TO_RASTER',
      source: 'NONE',
      pageNumber,
      pageWidthMm: 0,
      pageHeightMm: 0,
      contours: [],
      warnings: [`Page ${pageNumber} out of range (1..${pages.length})`],
      reasons: ['INVALID_PAGE_NUMBER'],
      diagnostics: {},
    };
  }

  const page = pages[pageNumber - 1];
  const mb = page.getMediaBox();
  const pageWidthMm = r4(mb.width * PT_TO_MM);
  const pageHeightMm = r4(mb.height * PT_TO_MM);
  const pageAreaMm2 = pageWidthMm * pageHeightMm;

  const ocgMap = resolvePageOcgMap(doc, page);
  const stream = decodePageStream(page);

  // Full graphics state stack with CTM, colors, line width, and OCG stack
  const stack = [];
  let state = {
    ctm: [1, 0, 0, 1, 0, 0],
    fillColor: null,
    strokeColor: null,
    lineWidthPt: 1,
  };
  const ocStack = [];
  let curSubpaths = [];
  let curCmds = [];
  let curPt = null;
  let startPt = null;
  let isClippingPath = false;
  let rasterXObjectDraws = 0;

  const toSheetMm = (xPt, yPt) => {
    const [gx, gy] = applyCtm(state.ctm, xPt, yPt);
    return [(gx - mb.x) * PT_TO_MM, (mb.height - (gy - mb.y)) * PT_TO_MM];
  };

  const rawPaths = [];
  let paintOrder = 0;

  const closeCurrentSubpath = () => {
    if (startPt && curPt && Math.hypot(curPt[0] - startPt[0], curPt[1] - startPt[1]) > 1e-5) {
      curCmds.push({ type: 'L', to: [...startPt] });
      curPt = [...startPt];
    }
  };

  const resetCurrentPath = () => {
    curSubpaths = [];
    curCmds = [];
    curPt = null;
    startPt = null;
  };

  const emitPaintedPath = (paintOp, closeActive = false) => {
    if (isClippingPath) {
      isClippingPath = false;
      resetCurrentPath();
      return;
    }
    const activeOc = ocStack.length > 0 ? ocStack[ocStack.length - 1] : null;
    if (activeOc && activeOc.visible === false) {
      resetCurrentPath();
      return;
    }
    if (closeActive) {
      closeCurrentSubpath();
    }
    if (curCmds.length >= 3) {
      curSubpaths.push(curCmds);
    }
    for (const subCmds of curSubpaths) {
      if (subCmds.length >= 3) {
        rawPaths.push({
          paintOrder: paintOrder++,
          paintOp,
          beziersMm: subCmds,
          fillColor: state.fillColor ? { ...state.fillColor, values: [...state.fillColor.values] } : null,
          strokeColor: state.strokeColor ? { ...state.strokeColor, values: [...state.strokeColor.values] } : null,
          lineWidthPt: state.lineWidthPt,
          ocgName: activeOc?.name ?? null,
        });
      }
    }
    resetCurrentPath();
  };

  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const RE_INLINE_QCM = new RegExp(`^q\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+cm$`);
  const RE_CM = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+cm$`);
  const RE_CMYK_FILL = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(k|scn|sc)$`);
  const RE_CMYK_STROKE = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(K|SCN|SC)$`);
  const RE_RGB_FILL = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+rg$`);
  const RE_RGB_STROKE = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+RG$`);
  const RE_LW = new RegExp(`^(${NUM})\\s+w$`);
  const RE_M = new RegExp(`^(${NUM})\\s+(${NUM})\\s+m$`);
  const RE_L = new RegExp(`^(${NUM})\\s+(${NUM})\\s+l$`);
  const RE_C = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+c$`);
  const RE_V = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+v$`);
  const RE_Y = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+y$`);
  const RE_RE = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+re$`);

  for (const rawLine of stream.split(/\r?\n/)) {
    const l = rawLine.trim();
    if (!l) continue;

    // Handle inline `q 1 0 0 1 tx ty cm` (common in Illustrator PDFs)
    const inlineQcm = l.match(RE_INLINE_QCM);
    if (inlineQcm) {
      stack.push({
        ctm: [...state.ctm],
        fillColor: state.fillColor,
        strokeColor: state.strokeColor,
        lineWidthPt: state.lineWidthPt,
      });
      state.ctm = mulCtm(state.ctm, inlineQcm.slice(1, 7).map(Number));
      continue;
    }

    if (l === 'q') {
      stack.push({
        ctm: [...state.ctm],
        fillColor: state.fillColor,
        strokeColor: state.strokeColor,
        lineWidthPt: state.lineWidthPt,
      });
      continue;
    }
    if (l === 'Q') {
      if (stack.length > 0) state = stack.pop();
      continue;
    }

    const cm = l.match(RE_CM);
    if (cm) {
      state.ctm = mulCtm(state.ctm, cm.slice(1, 7).map(Number));
      continue;
    }

    // OCG marked content
    const ocBdc = l.match(/^\/OC\s+\/(\S+)\s+BDC$/);
    if (ocBdc) {
      const info = ocgMap.get(ocBdc[1]) || { name: ocBdc[1], visible: true };
      ocStack.push(info);
      continue;
    }
    if (l === 'EMC') {
      if (ocStack.length > 0) ocStack.pop();
      continue;
    }

    // Colors & line width
    const cmykFill = l.match(RE_CMYK_FILL);
    if (cmykFill) {
      state.fillColor = { space: 'DeviceCMYK', values: cmykFill.slice(1, 5).map(Number) };
      continue;
    }
    const cmykStroke = l.match(RE_CMYK_STROKE);
    if (cmykStroke) {
      state.strokeColor = { space: 'DeviceCMYK', values: cmykStroke.slice(1, 5).map(Number) };
      continue;
    }
    const rgbFill = l.match(RE_RGB_FILL);
    if (rgbFill) {
      state.fillColor = { space: 'DeviceRGB', values: rgbFill.slice(1, 4).map(Number) };
      continue;
    }
    const rgbStroke = l.match(RE_RGB_STROKE);
    if (rgbStroke) {
      state.strokeColor = { space: 'DeviceRGB', values: rgbStroke.slice(1, 4).map(Number) };
      continue;
    }
    const lw = l.match(RE_LW);
    if (lw) {
      state.lineWidthPt = parseFloat(lw[1]);
      continue;
    }

    if (/^\/\S+\s+Do$/.test(l)) {
      rasterXObjectDraws++;
      continue;
    }

    // Path construction operators (preserve ALL subpaths in compound paths!)
    const mOp = l.match(RE_M);
    if (mOp) {
      if (curCmds.length >= 3) {
        curSubpaths.push(curCmds);
      }
      const pt = toSheetMm(parseFloat(mOp[1]), parseFloat(mOp[2]));
      curCmds = [{ type: 'M', to: pt }];
      curPt = pt;
      startPt = pt;
      isClippingPath = false;
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
      if (curCmds.length >= 3) {
        curSubpaths.push(curCmds);
      }
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
    if (l === 'W' || l === 'W*' || l === 'W n' || l === 'W* n' || l === 'n') {
      isClippingPath = false;
      resetCurrentPath();
      continue;
    }

    // Paint operators (`s`, `b`, `b*` implicitly close the current subpath per PDF spec)
    if (l === 'f' || l === 'f*' || l === 'F') { emitPaintedPath('fill', false); continue; }
    if (l === 'S') { emitPaintedPath('stroke', false); continue; }
    if (l === 's') { emitPaintedPath('stroke', true); continue; }
    if (l === 'B' || l === 'B*') { emitPaintedPath('fillStroke', false); continue; }
    if (l === 'b' || l === 'b*') { emitPaintedPath('fillStroke', true); continue; }
  }

  // Verify geometry & filter valid closed candidate contours (excluding page-sized rects & tiny glyphs)
  const verified = [];
  for (const rp of rawPaths) {
    const tess = tessellateAndVerifyContourMm({ beziersMm: rp.beziersMm, closed: true }, { flatnessMm });
    if (!tess.valid) continue;
    if (tess.areaMm2 < minAreaMm2) continue;
    if (tess.areaMm2 >= pageAreaMm2 * maxPageCoverageRatio) continue;
    const sArea = signedPolyAreaMm2(tess.poly);
    verified.push({
      ...rp,
      poly: tess.poly,
      bounds: tess.bounds,
      areaMm2: tess.areaMm2,
      signedAreaMm2: r4(sArea),
      winding: sArea >= 0 ? 'CW' : 'CCW',
      wMm: r4(tess.bounds.maxX - tess.bounds.minX),
      hMm: r4(tess.bounds.maxY - tess.bounds.minY),
      cx: (tess.bounds.minX + tess.bounds.maxX) * 0.5,
      cy: (tess.bounds.minY + tess.bounds.maxY) * 0.5,
    });
  }

  if (verified.length === 0) {
    return {
      status: 'FALLBACK_TO_RASTER',
      provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
      source: 'NONE',
      confidence: 0,
      confidenceLevel: 'NONE',
      pageNumber,
      pageWidthMm,
      pageHeightMm,
      contours: [],
      warnings: [
        rasterXObjectDraws > 0
          ? 'PDF contains raster XObjects without usable closed vector sticker contours — fallback to raster tracer'
          : 'No valid closed vector sticker contours found in PDF stream — fallback to raster tracer',
      ],
      reasons: ['NO_VECTOR_CONTOURS'],
      diagnostics: { rawPathCount: rawPaths.length, rasterXObjectDraws },
    };
  }

  // Priority 1: Explicit Cut Layer (e.g. `khuon` / `Khuon Be` / `CutContour`) with pure Magenta strokes
  const explicitCutCandidates = preferExplicitCutLayer
    ? verified.filter(
        (v) =>
          (v.paintOp === 'stroke' || v.paintOp === 'fillStroke') &&
          (isCutLayerName(v.ocgName) || isPureMagentaStroke(v.strokeColor))
      )
    : [];

  let selected = [];
  let selectionMode = '';
  let confidence = 0;
  let confidenceLevel = 'LOW';
  const warnings = [];

  if (explicitCutCandidates.length > 0) {
    selected = explicitCutCandidates;
    selectionMode = 'EXPLICIT_CUT_LAYER';
    confidence = 1.0;
    confidenceLevel = 'HIGH';
  } else {
    // Point A: Never silently treat arbitrary vector paths as CUT when raster XObjects are present
    // without an explicit CutContour layer (mixed raster+vector PDF is ambiguous).
    if (rasterXObjectDraws > 0) {
      return {
        status: 'CONFIRMATION_REQUIRED',
        provenance: CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED,
        source: 'AMBIGUOUS_MIXED_RASTER_VECTOR',
        confidence: 0.35,
        confidenceLevel: 'LOW',
        pageNumber,
        pageWidthMm,
        pageHeightMm,
        contours: [],
        warnings: [
          `PDF chứa đồng thời ${rasterXObjectDraws} ảnh raster và ${verified.length} path vector nhưng không có layer CutContour rõ ràng — không tự gán vector làm CUT`,
        ],
        reasons: ['MIXED_RASTER_VECTOR_NO_CUT_LAYER'],
        diagnostics: { rawPathCount: rawPaths.length, verifiedPathCount: verified.length, rasterXObjectDraws },
      };
    }

    // Priority 2: Topological Containment Forest on FILLED artwork regions (NEVER area/bbox alone!)
    // Decorative interior strokes (like 18.025mm burgundy border) are strictly contained inside the outer filled shape
    // AND are stroke-only, so they are cleanly excluded!
    const filledPaths = verified.filter((v) => v.paintOp === 'fill' || v.paintOp === 'fillStroke');
    const strokeOnlyPaths = verified.filter((v) => v.paintOp === 'stroke');

    if (filledPaths.length === 0) {
      return {
        status: 'CONFIRMATION_REQUIRED',
        provenance: CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED,
        source: 'AMBIGUOUS_STROKE_ONLY',
        confidence: 0.25,
        confidenceLevel: 'LOW',
        pageNumber,
        pageWidthMm,
        pageHeightMm,
        contours: [],
        warnings: [
          `Found ${strokeOnlyPaths.length} stroke-only vector paths with no filled artwork regions and no explicit CutContour layer — confirmation or raster fallback required`,
        ],
        reasons: ['STROKE_ONLY_AMBIGUOUS'],
        diagnostics: { filledCount: 0, strokeOnlyCount: strokeOnlyPaths.length },
      };
    }

    // Build strict containment parents among filled paths:
    // Path B has parent A if A.areaMm2 > B.areaMm2 * 1.01 and B's centroid & sample vertices lie inside A.
    const hasParent = new Uint8Array(filledPaths.length);
    for (let i = 0; i < filledPaths.length; i++) {
      const B = filledPaths[i];
      for (let j = 0; j < filledPaths.length; j++) {
        if (i === j) continue;
        const A = filledPaths[j];
        if (A.areaMm2 <= B.areaMm2 * 1.01) continue;
        if (
          B.cx < A.bounds.minX || B.cx > A.bounds.maxX ||
          B.cy < A.bounds.minY || B.cy > A.bounds.maxY
        ) {
          continue;
        }
        // Check centroid + 4 cardinal boundary samples of B lie inside A
        const step = Math.max(1, Math.floor(B.poly.length / 4));
        const samples = [
          [B.cx, B.cy],
          B.poly[0],
          B.poly[step % B.poly.length],
          B.poly[(step * 2) % B.poly.length],
          B.poly[(step * 3) % B.poly.length],
        ];
        if (samples.every((pt) => pointInPoly(pt, A.poly))) {
          hasParent[i] = 1;
          break;
        }
      }
    }

    // Top-level roots in containment forest = true outermost filled artwork boundaries!
    const roots = filledPaths.filter((_, idx) => hasParent[idx] === 0);

    // Deduplicate exact-coincident filled roots (e.g. duplicate identical fill stacked at same position)
    const deduped = [];
    for (const r of roots) {
      const dup = deduped.find(
        (d) =>
          Math.abs(d.cx - r.cx) < 0.05 &&
          Math.abs(d.cy - r.cy) < 0.05 &&
          Math.abs(d.wMm - r.wMm) < 0.05 &&
          Math.abs(d.hMm - r.hMm) < 0.05
      );
      if (!dup) deduped.push(r);
    }

    // Point A check: detect partially overlapping (non-nested) roots — e.g. overlapping decorative vector shapes
    // that are NOT distinct disjoint sticker contours.
    let overlappingPairs = 0;
    for (let i = 0; i < deduped.length; i++) {
      const A = deduped[i];
      for (let j = i + 1; j < deduped.length; j++) {
        const B = deduped[j];
        if (
          A.bounds.maxX < B.bounds.minX ||
          B.bounds.maxX < A.bounds.minX ||
          A.bounds.maxY < B.bounds.minY ||
          B.bounds.maxY < A.bounds.minY
        ) {
          continue;
        }
        const stepB = Math.max(1, Math.floor(B.poly.length / 8));
        let insideCount = 0;
        for (let k = 0; k < B.poly.length; k += stepB) {
          if (pointInPoly(B.poly[k], A.poly)) insideCount++;
        }
        if (insideCount > 0) {
          overlappingPairs++;
          break;
        }
      }
      if (overlappingPairs > 0) break;
    }

    if (overlappingPairs > 0) {
      return {
        status: 'CONFIRMATION_REQUIRED',
        provenance: CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED,
        source: 'AMBIGUOUS_OVERLAPPING_ROOTS',
        confidence: 0.4,
        confidenceLevel: 'LOW',
        pageNumber,
        pageWidthMm,
        pageHeightMm,
        contours: [],
        warnings: [
          `Phát hiện các path vector chồng lấn nhau (${deduped.length} vùng ngoài cùng) không có layer CutContour rõ ràng — yêu cầu xác nhận hoặc chuyển sang Raster Fallback`,
        ],
        reasons: ['AMBIGUOUS_OVERLAPPING_ROOTS'],
        diagnostics: { filledCount: filledPaths.length, rootCount: deduped.length, overlappingPairs },
      };
    }

    // Check for decorative strokes that were rejected (audit confirmation)
    const decorativeStrokesExcluded = strokeOnlyPaths.filter((s) =>
      deduped.some((root) => s.areaMm2 < root.areaMm2 && pointInPoly([s.cx, s.cy], root.poly))
    ).length;

    selected = deduped;
    selectionMode = 'OUTERMOST_FILLED_BOUNDARY';
    confidence = 0.95;
    confidenceLevel = 'HIGH';
    if (decorativeStrokesExcluded > 0) {
      warnings.push(
        `Excluded ${decorativeStrokesExcluded} interior decorative stroke(s) strictly contained inside outer filled artwork boundaries`
      );
    }
  }

  // Deterministic row-major sort (cluster rows by 50% of median sticker height, then X ascending)
  const heights = selected.map((s) => s.hMm).sort((a, b) => a - b);
  const rowBandMm = Math.max(2, (heights[Math.floor(heights.length / 2)] || 20) * 0.6);
  const minYAll = Math.min(...selected.map((s) => s.bounds.minY));
  selected.sort((a, b) => {
    const rA = Math.round((a.bounds.minY - minYAll) / rowBandMm);
    const rB = Math.round((b.bounds.minY - minYAll) / rowBandMm);
    if (rA !== rB) return rA - rB;
    return a.bounds.minX - b.bounds.minX;
  });

  const contours = selected.map((s, idx) => ({
    stickerIndex: idx + 1,
    provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
    source: 'PDF_VECTOR_DIRECT',
    selectionMode,
    coordinateSystem: 'SHEET_MM_Y_DOWN',
    winding: s.winding,
    signedAreaMm2: s.signedAreaMm2,
    ocgName: s.ocgName,
    paintOp: s.paintOp,
    bezierSegmentCount: s.beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length,
    beziersMm: s.beziersMm,
    closed: true,
    boundsMm: {
      minX: r4(s.bounds.minX),
      minY: r4(s.bounds.minY),
      maxX: r4(s.bounds.maxX),
      maxY: r4(s.bounds.maxY),
      w: s.wMm,
      h: s.hMm,
    },
    areaMm2: s.areaMm2,
    printColorMetadata:
      s.fillColor && s.fillColor.space === 'DeviceCMYK'
        ? {
            colorSpace: 'DeviceCMYK',
            cmyk: s.fillColor.values,
            opacity: 1,
            blendMode: 'Normal',
            overprint: false,
            spotColor: null,
            zOrderVerified: true,
          }
        : null,
  }));

  return {
    status: 'OK',
    provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
    source: 'PDF_VECTOR_DIRECT',
    selectionMode,
    confidence,
    confidenceLevel,
    pageNumber,
    pageWidthMm,
    pageHeightMm,
    contours,
    warnings,
    reasons: [],
    diagnostics: {
      rawPathCount: rawPaths.length,
      verifiedPathCount: verified.length,
      selectedCount: contours.length,
      rasterXObjectDraws,
    },
  };
}
