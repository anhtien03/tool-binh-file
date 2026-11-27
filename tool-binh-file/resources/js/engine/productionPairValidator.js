/**
 * PrintKit Architecture V1 — Production Pair & Cross-Format Validator (Checkpoint G)
 *
 * Pure READ / VALIDATE / CROSS-CHECK module on actual serialized PDF & SVG bytes.
 * NEVER creates geometry, NEVER modifies CUT/BLEED, NEVER recomputes layout.
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import { applyRigidMatrixMm } from './batchImpositionAdapter.js';

const PT_TO_MM = 1 / MM_TO_PT;
const DIM_TOL_MM = 0.015;
const ALIGN_TOL_MM = 0.015;
const MARK_TOL_MM = 0.02;

export const KNOWN_PRODUCTION_OBJECTS = Object.freeze(['registrationMarks']);

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

function decodePageStream(page) {
  const contents = page.node.get(PDFName.of('Contents'));
  if (!contents) return '';
  const ctx = page.doc.context;
  const decodeOne = (ref) => {
    const obj = ctx.lookup(ref);
    if (!(obj instanceof PDFRawStream)) return '';
    try {
      return Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
    } catch {
      return Buffer.from(obj.contents).toString('latin1');
    }
  };
  if (contents instanceof PDFArray) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) out += '\n' + decodeOne(contents.get(i));
    return out;
  }
  return decodeOne(contents);
}

function countXObjects(page) {
  const res = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
  if (!res) return 0;
  const xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xo) return 0;
  return xo.entries().length;
}

function computeBeziersBoundsMm(beziersMm) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (pt) => {
    if (!pt) return;
    if (pt[0] < minX) minX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] > maxY) maxY = pt[1];
  };
  for (const cmd of beziersMm || []) {
    if (cmd.to) add(cmd.to);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Inspect actual serialized CUT.pdf page content stream:
 * recovers Magenta CUT closed vector paths (bounds in sheet-mm), registration marks, and raster XObject check.
 */
export function inspectSerializedCutPage(page) {
  const mb = page.getMediaBox();
  const hPt = mb.height;
  const stream = decodePageStream(page);
  const xObjectCount = countXObjects(page);

  const cutPaths = [];
  const marks = [];
  let inCut = false;
  let curPts = [];
  let inBlackFill = false;
  let blackFillPts = [];
  let curTxPt = 0;
  let curTyPt = 0;

  for (const raw of stream.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l === 'q') {
      curTxPt = 0;
      curTyPt = 0;
      blackFillPts = [];
      continue;
    }
    if (/^0\s+1\s+0\s+0\s+K$/.test(l)) {
      inCut = true;
      curPts = [];
      continue;
    }
    if (/^(0\s+0\s+0\s+1\s+k|0\s+0\s+0\s+rg)$/.test(l)) {
      inBlackFill = true;
      blackFillPts = [];
      continue;
    }
    if (l === 'Q') {
      inCut = false;
      inBlackFill = false;
      curPts = [];
      blackFillPts = [];
      curTxPt = 0;
      curTyPt = 0;
      continue;
    }

    const cm = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm$/);
    if (cm && Math.abs(parseFloat(cm[1]) - 1) < 1e-6 && Math.abs(parseFloat(cm[4]) - 1) < 1e-6) {
      curTxPt += parseFloat(cm[5]);
      curTyPt += parseFloat(cm[6]);
      continue;
    }

    // Registration mark rectangles (filled black rects via either `re` or `m/l/.../f`)
    if (inBlackFill) {
      const re = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+re$/);
      if (re) {
        const xPt = parseFloat(re[1]) + curTxPt;
        const yBotPt = parseFloat(re[2]) + curTyPt;
        const wPt = parseFloat(re[3]);
        const hRectPt = parseFloat(re[4]);
        marks.push({
          xMm: r4(xPt * PT_TO_MM),
          yMm: r4((hPt - (yBotPt + hRectPt)) * PT_TO_MM),
          wMm: r4(wPt * PT_TO_MM),
          hMm: r4(hRectPt * PT_TO_MM),
        });
        continue;
      }
      const bml = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+[ml]$/);
      if (bml) {
        blackFillPts.push([parseFloat(bml[1]) + curTxPt, parseFloat(bml[2]) + curTyPt]);
        continue;
      }
      if ((l === 'f' || l === 'f*' || l === 'B') && blackFillPts.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of blackFillPts) {
          if (px < minX) minX = px; if (py < minY) minY = py;
          if (px > maxX) maxX = px; if (py > maxY) maxY = py;
        }
        marks.push({
          xMm: r4(minX * PT_TO_MM),
          yMm: r4((hPt - maxY) * PT_TO_MM),
          wMm: r4((maxX - minX) * PT_TO_MM),
          hMm: r4((maxY - minY) * PT_TO_MM),
        });
        blackFillPts = [];
        continue;
      }
    }

    if (!inCut) continue;
    const ml = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+[ml]$/);
    if (ml) {
      curPts.push([parseFloat(ml[1]) * PT_TO_MM, (hPt - parseFloat(ml[2])) * PT_TO_MM]);
      continue;
    }
    const c = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
    if (c) {
      curPts.push([parseFloat(c[5]) * PT_TO_MM, (hPt - parseFloat(c[6])) * PT_TO_MM]);
      continue;
    }
    if ((l === 'S' || l === 's') && curPts.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of curPts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      cutPaths.push({
        minX: r4(minX),
        minY: r4(minY),
        maxX: r4(maxX),
        maxY: r4(maxY),
        w: r4(maxX - minX),
        h: r4(maxY - minY),
        cx: r4((minX + maxX) / 2),
        cy: r4((minY + maxY) / 2),
      });
      curPts = [];
    }
  }

  return {
    widthMm: r4(mb.width * PT_TO_MM),
    heightMm: r4(mb.height * PT_TO_MM),
    xObjectCount,
    cutPaths,
    marks,
  };
}

/**
 * Inspect actual serialized PRINT.pdf page content stream:
 * recovers each artwork draw (Do) with its CTM + clip-path bounds, plus registration marks.
 */
export function inspectSerializedPrintPage(page) {
  const mb = page.getMediaBox();
  const hPt = mb.height;
  const stream = decodePageStream(page);
  const xObjectCount = countXObjects(page);

  const artworkDraws = [];
  const marks = [];
  let curClipPts = [];
  let lastCm = null;
  let inBlackFill = false;
  let blackFillPts = [];
  let curTxPt = 0;
  let curTyPt = 0;

  for (const raw of stream.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (/^(0\s+0\s+0\s+1\s+k|0\s+0\s+0\s+rg)$/.test(l)) {
      inBlackFill = true;
      blackFillPts = [];
      continue;
    }
    if (l === 'q') {
      curClipPts = [];
      lastCm = null;
      blackFillPts = [];
      curTxPt = 0;
      curTyPt = 0;
      continue;
    }
    if (l === 'Q') {
      inBlackFill = false;
      blackFillPts = [];
      curTxPt = 0;
      curTyPt = 0;
      continue;
    }
    if (inBlackFill) {
      const re = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+re$/);
      if (re) {
        const xPt = parseFloat(re[1]) + curTxPt;
        const yBotPt = parseFloat(re[2]) + curTyPt;
        const wPt = parseFloat(re[3]);
        const hRectPt = parseFloat(re[4]);
        marks.push({
          xMm: r4(xPt * PT_TO_MM),
          yMm: r4((hPt - (yBotPt + hRectPt)) * PT_TO_MM),
          wMm: r4(wPt * PT_TO_MM),
          hMm: r4(hRectPt * PT_TO_MM),
        });
        continue;
      }
      const bml = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+[ml]$/);
      if (bml) {
        blackFillPts.push([parseFloat(bml[1]) + curTxPt, parseFloat(bml[2]) + curTyPt]);
        continue;
      }
      if ((l === 'f' || l === 'f*' || l === 'B') && blackFillPts.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of blackFillPts) {
          if (px < minX) minX = px; if (py < minY) minY = py;
          if (px > maxX) maxX = px; if (py > maxY) maxY = py;
        }
        marks.push({
          xMm: r4(minX * PT_TO_MM),
          yMm: r4((hPt - maxY) * PT_TO_MM),
          wMm: r4((maxX - minX) * PT_TO_MM),
          hMm: r4((maxY - minY) * PT_TO_MM),
        });
        blackFillPts = [];
        continue;
      }
    }

    const ml = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+[ml]$/);
    if (ml) {
      curClipPts.push([parseFloat(ml[1]) * PT_TO_MM, (hPt - parseFloat(ml[2])) * PT_TO_MM]);
      continue;
    }
    const c = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
    if (c) {
      curClipPts.push([parseFloat(c[5]) * PT_TO_MM, (hPt - parseFloat(c[6])) * PT_TO_MM]);
      continue;
    }

    const cm = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm$/);
    if (cm) {
      const m = cm.slice(1, 7).map(Number);
      if (Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6) {
        curTxPt += m[4];
        curTyPt += m[5];
      }
      if (!(Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[4]) < 1e-6 && Math.abs(m[5]) < 1e-6)) {
        lastCm = m;
      }
      continue;
    }

    if (/^\/\S+\s+Do$/.test(l)) {
      let clipBounds = null;
      if (curClipPts.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of curClipPts) {
          if (x < minX) minX = x; if (y < minY) minY = y;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        clipBounds = { minX: r4(minX), minY: r4(minY), maxX: r4(maxX), maxY: r4(maxY) };
      }
      artworkDraws.push({ ctm: lastCm, clipBounds });
      curClipPts = [];
      lastCm = null;
    }
  }

  return {
    widthMm: r4(mb.width * PT_TO_MM),
    heightMm: r4(mb.height * PT_TO_MM),
    xObjectCount,
    artworkDraws,
    marks,
  };
}

function compareMarks(actualMarks, expectedMarks) {
  if (actualMarks.length !== expectedMarks.length) {
    return { ok: false, reason: `Marks count mismatch (actual=${actualMarks.length}, expected=${expectedMarks.length})` };
  }
  for (let i = 0; i < expectedMarks.length; i++) {
    const exp = expectedMarks[i];
    const hit = actualMarks.find(
      (a) =>
        Math.abs(a.xMm - exp.xMm) <= MARK_TOL_MM &&
        Math.abs(a.yMm - exp.yMm) <= MARK_TOL_MM &&
        Math.abs(a.wMm - exp.sizeMm) <= MARK_TOL_MM &&
        Math.abs(a.hMm - exp.sizeMm) <= MARK_TOL_MM
    );
    if (!hit) {
      return { ok: false, reason: `Registration mark ${exp.id} missing or shifted` };
    }
  }
  return { ok: true, reason: null };
}

function maxBoundsDelta(a, b) {
  return Math.max(
    Math.abs(a.minX - b.minX),
    Math.abs(a.minY - b.minY),
    Math.abs(a.maxX - b.maxX),
    Math.abs(a.maxY - b.maxY)
  );
}

/**
 * Validate CUT SVG bytes directly against authoritative CutMasterV1 sheet (<= 0.01mm delta).
 */
export function validateCutSvgAgainstMaster(svgBytes, cutMaster, sheetIndex0Based = 0, scope = 'CUT_ONLY') {
  const errors = [];
  const svgText = typeof svgBytes === 'string' ? svgBytes : new TextDecoder().decode(svgBytes);
  const sh = cutMaster?.sheets?.[sheetIndex0Based];
  if (!sh) {
    return { valid: false, maxDeltaMm: Infinity, errors: [{ code: 'INVALID_SELECTION', message: `Missing sheet ${sheetIndex0Based} in CutMaster` }] };
  }
  if (!svgText.includes('<svg') || !svgText.includes('</svg>')) {
    return { valid: false, maxDeltaMm: Infinity, errors: [{ code: 'INVALID_SVG', message: 'Invalid SVG document' }] };
  }
  if (/\b(NaN|Infinity|-Infinity)\b/.test(svgText)) {
    errors.push({ code: 'NON_FINITE_SVG', message: 'SVG contains NaN/Infinity coordinates' });
  }
  if (scope === 'CUT_ONLY' && /<image\b/i.test(svgText)) {
    errors.push({ code: 'CUT_VECTOR_MISSING', message: 'CUT_ONLY SVG must not contain raster <image> elements' });
  }

  const wM = svgText.match(/width="(\d*\.?\d+)mm"/);
  const hM = svgText.match(/height="(\d*\.?\d+)mm"/);
  const vbM = svgText.match(/viewBox="0 0 (\d*\.?\d+) (\d*\.?\d+)"/);
  const svgW = Number(wM?.[1]), svgH = Number(hM?.[1]);
  if (!Number.isFinite(svgW) || !Number.isFinite(svgH) || Math.abs(svgW - sh.widthMm) > DIM_TOL_MM || Math.abs(svgH - sh.heightMm) > DIM_TOL_MM) {
    errors.push({ code: 'SVG_SIZE_MISMATCH', message: `SVG physical size (${svgW}x${svgH}mm) != sheet (${sh.widthMm}x${sh.heightMm}mm)` });
  }
  if (!vbM || Math.abs(Number(vbM[1]) - sh.widthMm) > DIM_TOL_MM || Math.abs(Number(vbM[2]) - sh.heightMm) > DIM_TOL_MM) {
    errors.push({ code: 'SVG_VIEWBOX_MISMATCH', message: 'SVG viewBox does not match physical sheet mm' });
  }

  const pathMatches = [...svgText.matchAll(/<path[^>]*d="([^"]+)"/g)];
  if (pathMatches.length !== sh.placements.length) {
    errors.push({
      code: pathMatches.length < sh.placements.length ? 'MISSING_CUT_PLACEMENT' : 'DUPLICATE_CUT_PLACEMENT',
      message: `SVG path count (${pathMatches.length}) != expected placements (${sh.placements.length})`,
    });
  }

  let maxDeltaMm = 0;
  const count = Math.min(pathMatches.length, sh.placements.length);
  for (let i = 0; i < count; i++) {
    const nums = pathMatches[i][1].match(/-?\d*\.?\d+/g)?.map(Number) || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k + 1 < nums.length; k += 2) {
      if (nums[k] < minX) minX = nums[k]; if (nums[k + 1] < minY) minY = nums[k + 1];
      if (nums[k] > maxX) maxX = nums[k]; if (nums[k + 1] > maxY) maxY = nums[k + 1];
    }
    const expB = computeBeziersBoundsMm(sh.placements[i].cutPathMm.beziersMm);
    const d = maxBoundsDelta({ minX, minY, maxX, maxY }, expB);
    if (d > maxDeltaMm) maxDeltaMm = d;
  }
  if (maxDeltaMm > ALIGN_TOL_MM) {
    errors.push({ code: 'SVG_ALIGNMENT_MISMATCH', message: `SVG CUT bounds delta (${r4(maxDeltaMm)}mm) > ${ALIGN_TOL_MM}mm` });
  }

  return { valid: errors.length === 0, pathCount: pathMatches.length, maxDeltaMm: r4(maxDeltaMm), errors };
}

/**
 * Cross-check actual serialized PRINT.pdf & CUT.pdf bytes against ImpositionPlanV1, CutMasterV1 & Manifest.
 */
export async function validateProductionPair({
  printPdfBytes,
  cutPdfBytes,
  plan,
  cutMaster,
  manifest,
  scope = 'CUT_ONLY',
  productionObjects = null,
}) {
  const errors = [];
  const warnings = [];

  // 0. Check productionObjects extension point (forward-compatible without silently dropping unknown objects)
  if (productionObjects && typeof productionObjects === 'object') {
    for (const key of Object.keys(productionObjects)) {
      if (!KNOWN_PRODUCTION_OBJECTS.includes(key)) {
        errors.push({
          code: 'UNSUPPORTED_PRODUCTION_OBJECT',
          message: `Unsupported productionObject "${key}" in V1 validator (known: ${KNOWN_PRODUCTION_OBJECTS.join(', ')})`,
        });
      }
    }
  }

  let printDoc, cutDoc;
  try {
    printDoc = await PDFDocument.load(printPdfBytes);
  } catch (e) {
    errors.push({ code: 'INVALID_PRINT_PDF', message: `PRINT.pdf decode failed: ${e.message}` });
  }
  try {
    cutDoc = await PDFDocument.load(cutPdfBytes);
  } catch (e) {
    errors.push({ code: 'INVALID_CUT_PDF', message: `CUT.pdf decode failed: ${e.message}` });
  }
  if (!printDoc || !cutDoc) {
    return {
      valid: false,
      pageCountMatch: false,
      pageSizesMatch: false,
      pageOrderMatch: false,
      placementCompleteness: false,
      alignmentPassed: false,
      marksPassed: false,
      expectedPlacements: manifest?.placements?.length || 0,
      printPlacements: 0,
      cutPlacements: 0,
      maxSerializedAlignmentDeltaMm: Infinity,
      errors,
      warnings,
    };
  }

  const printPages = printDoc.getPages();
  const cutPages = cutDoc.getPages();
  const expectedSheetCount = manifest.sheetCount;
  const pageCountMatch = printPages.length === cutPages.length && printPages.length === expectedSheetCount;
  if (!pageCountMatch) {
    errors.push({
      code: 'PAIR_PAGE_MISMATCH',
      message: `Page count mismatch: PRINT=${printPages.length}, CUT=${cutPages.length}, manifest=${expectedSheetCount}`,
    });
  }

  // Verify manifest placement uniqueness
  const seenIds = new Set();
  for (const pl of manifest.placements || []) {
    if (seenIds.has(pl.placementId)) {
      errors.push({ code: 'DUPLICATE_MANIFEST_PLACEMENT', message: `Duplicate placementId ${pl.placementId} in manifest` });
    }
    seenIds.add(pl.placementId);
  }

  const selectedIndices = manifest.exportedSheetIndices || manifest.sheets.map((_, i) => i);
  let pageSizesMatch = true;
  let pageOrderMatch = true;
  let placementCompleteness = true;
  let alignmentPassed = true;
  let marksPassed = true;
  let totalPrintPlacements = 0;
  let totalCutPlacements = 0;
  let maxSerializedAlignmentDeltaMm = 0;

  const pageLoopCount = Math.min(printPages.length, cutPages.length, selectedIndices.length);
  for (let i = 0; i < pageLoopCount; i++) {
    const sheetIdx0 = selectedIndices[i];
    const expMasterSheet = cutMaster.sheets[sheetIdx0];
    const expManifestSheet = manifest.sheets[i];
    const pInfo = inspectSerializedPrintPage(printPages[i]);
    const cInfo = inspectSerializedCutPage(cutPages[i]);

    totalPrintPlacements += pInfo.artworkDraws.length;
    totalCutPlacements += cInfo.cutPaths.length;

    // 1. Page physical size match (PRINT == CUT == Manifest)
    if (
      Math.abs(pInfo.widthMm - cInfo.widthMm) > DIM_TOL_MM ||
      Math.abs(pInfo.heightMm - cInfo.heightMm) > DIM_TOL_MM ||
      Math.abs(cInfo.widthMm - expManifestSheet.widthMm) > DIM_TOL_MM ||
      Math.abs(cInfo.heightMm - expManifestSheet.heightMm) > DIM_TOL_MM
    ) {
      pageSizesMatch = false;
      errors.push({
        code: 'PAIR_PAGE_SIZE_MISMATCH',
        message: `Sheet #${i + 1} size mismatch: PRINT=${pInfo.widthMm}x${pInfo.heightMm}, CUT=${cInfo.widthMm}x${cInfo.heightMm}, expected=${expManifestSheet.widthMm}x${expManifestSheet.heightMm}`,
      });
    }

    // 2. CUT vector presence & no raster CUT in CUT_ONLY
    if (cInfo.cutPaths.length === 0 || (scope === 'CUT_ONLY' && cInfo.xObjectCount > 0)) {
      placementCompleteness = false;
      errors.push({
        code: 'CUT_VECTOR_MISSING',
        message: `Sheet #${i + 1}: CUT vector missing or raster XObject found in CUT_ONLY (paths=${cInfo.cutPaths.length}, xObj=${cInfo.xObjectCount})`,
      });
    }

    // 3. Placement completeness (PRINT & CUT counts vs expected)
    const expCount = expMasterSheet.placements.length;
    if (cInfo.cutPaths.length < expCount) {
      placementCompleteness = false;
      errors.push({
        code: 'MISSING_CUT_PLACEMENT',
        message: `Sheet #${i + 1}: missing CUT placement (actual=${cInfo.cutPaths.length}, expected=${expCount})`,
      });
    } else if (cInfo.cutPaths.length > expCount) {
      placementCompleteness = false;
      errors.push({
        code: 'DUPLICATE_CUT_PLACEMENT',
        message: `Sheet #${i + 1}: duplicate/extra CUT placement (actual=${cInfo.cutPaths.length}, expected=${expCount})`,
      });
    }

    if (pInfo.artworkDraws.length < expCount) {
      placementCompleteness = false;
      errors.push({
        code: 'MISSING_PRINT_PLACEMENT',
        message: `Sheet #${i + 1}: missing PRINT artwork placement (actual=${pInfo.artworkDraws.length}, expected=${expCount})`,
      });
    } else if (pInfo.artworkDraws.length > expCount) {
      placementCompleteness = false;
      errors.push({
        code: 'DUPLICATE_PRINT_PLACEMENT',
        message: `Sheet #${i + 1}: extra PRINT artwork placement (actual=${pInfo.artworkDraws.length}, expected=${expCount})`,
      });
    }

    // 4. Page order & Serialized Geometry Alignment (actual CUT paths vs expected CutMaster bounds)
    if (cInfo.cutPaths.length === expCount && expCount > 0) {
      let pageMaxDelta = 0;
      for (let k = 0; k < expCount; k++) {
        const expB = computeBeziersBoundsMm(expMasterSheet.placements[k].cutPathMm.beziersMm);
        const d = maxBoundsDelta(cInfo.cutPaths[k], expB);
        if (d > pageMaxDelta) pageMaxDelta = d;
      }
      if (pageMaxDelta > ALIGN_TOL_MM) {
        // Check if this CUT page actually matches a DIFFERENT sheet's placements -> PAIR_PAGE_ORDER_MISMATCH
        let matchedOtherSheet = -1;
        for (let otherIdx = 0; otherIdx < cutMaster.sheets.length; otherIdx++) {
          if (otherIdx === sheetIdx0) continue;
          const otherSh = cutMaster.sheets[otherIdx];
          if (otherSh.placements.length !== cInfo.cutPaths.length) continue;
          let otherMax = 0;
          for (let k = 0; k < otherSh.placements.length; k++) {
            const d = maxBoundsDelta(cInfo.cutPaths[k], computeBeziersBoundsMm(otherSh.placements[k].cutPathMm.beziersMm));
            if (d > otherMax) otherMax = d;
          }
          if (otherMax <= ALIGN_TOL_MM) {
            matchedOtherSheet = otherIdx;
            break;
          }
        }
        if (matchedOtherSheet >= 0) {
          pageOrderMatch = false;
          errors.push({
            code: 'PAIR_PAGE_ORDER_MISMATCH',
            message: `CUT page #${i + 1} matches Sheet #${matchedOtherSheet + 1} instead of expected Sheet #${sheetIdx0 + 1}`,
          });
        } else {
          alignmentPassed = false;
          errors.push({
            code: 'PAIR_ALIGNMENT_MISMATCH',
            message: `Sheet #${i + 1}: serialized CUT alignment delta (${r4(pageMaxDelta)}mm) exceeds ${ALIGN_TOL_MM}mm`,
          });
        }
      }
      if (pageMaxDelta > maxSerializedAlignmentDeltaMm) maxSerializedAlignmentDeltaMm = pageMaxDelta;

      // Cross-check PRINT clip-path encloses/aligns with serialized CUT path
      if (pInfo.artworkDraws.length === expCount) {
        for (let k = 0; k < expCount; k++) {
          const cb = pInfo.artworkDraws[k].clipBounds;
          const cp = cInfo.cutPaths[k];
          if (cb && (cb.minX > cp.minX + ALIGN_TOL_MM || cb.minY > cp.minY + ALIGN_TOL_MM || cb.maxX < cp.maxX - ALIGN_TOL_MM || cb.maxY < cp.maxY - ALIGN_TOL_MM)) {
            alignmentPassed = false;
            errors.push({
              code: 'PAIR_ALIGNMENT_MISMATCH',
              message: `Sheet #${i + 1} placement #${k + 1}: PRINT clip bounds do not cover serialized CUT path`,
            });
          }
        }
      }
    }

    // 5. Registration marks validation (NONE = 0, GENERIC = exact 4 corners)
    const expPrintMarks = plan.productionProfile?.includeMarksInPrint ? expMasterSheet.registrationMarks : [];
    const expCutMarks = plan.productionProfile?.includeMarksInCut ? expMasterSheet.registrationMarks : [];
    const pMarkRes = compareMarks(pInfo.marks, expPrintMarks);
    const cMarkRes = compareMarks(cInfo.marks, expCutMarks);
    if (!pMarkRes.ok) {
      marksPassed = false;
      errors.push({ code: 'MARKS_MISMATCH', message: `PRINT Sheet #${i + 1}: ${pMarkRes.reason}` });
    }
    if (!cMarkRes.ok) {
      marksPassed = false;
      errors.push({ code: 'MARKS_MISMATCH', message: `CUT Sheet #${i + 1}: ${cMarkRes.reason}` });
    }
  }

  return {
    valid: errors.length === 0,
    pageCountMatch,
    pageSizesMatch,
    pageOrderMatch,
    placementCompleteness,
    alignmentPassed,
    marksPassed,
    expectedPlacements: manifest.placements.length,
    printPlacements: totalPrintPlacements,
    cutPlacements: totalCutPlacements,
    maxSerializedAlignmentDeltaMm: r4(maxSerializedAlignmentDeltaMm),
    errors,
    warnings,
  };
}
