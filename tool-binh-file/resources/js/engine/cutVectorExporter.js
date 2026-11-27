/**
 * PrintKit Architecture V1 — Authoritative CUT Master & Vector Exporters (Checkpoint F)
 *
 * Single authoritative CutMasterV1 representation derived strictly from:
 *   ImpositionPlanV1 + StickerJobV1.productionGeometry.cutTargetMm + placement.rigidMatrixMm
 *
 * All CUT formats (PDF, SVG, AI, Illustrator/CorelDRAW handoff) read ONLY from CutMasterV1:
 *  - ZERO re-offsetting, ZERO simplifying, ZERO refitting, ZERO rasterizing CUT.
 *  - AI format returns FORMAT_NOT_SUPPORTED (NEVER fakes .ai by renaming .pdf/.eps).
 *  - Supports sheetSelection ('ALL' | [0-based indices]) without recomputing layout.
 */

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
  setStrokingColor,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import { applyRigidMatrixMm } from './batchImpositionAdapter.js';
import { assertNoBinaryInState } from './v1Schema.js';

export const CUT_MASTER_VERSION = '1.0';
export const SUPPORTED_CUT_FORMATS = Object.freeze({
  PDF: 'SUPPORTED',
  SVG: 'SUPPORTED',
  AI: 'FORMAT_NOT_SUPPORTED', // Honest status: no native Adobe Illustrator writer in current JS stack
});

export class CutExportError extends Error {
  constructor({ code, message, format = null, planId = null }) {
    super(message);
    this.name = 'CutExportError';
    this.stage = 'CUT_EXPORT';
    this.code = code; // 'FORMAT_NOT_SUPPORTED' | 'INVALID_SELECTION' | 'INVALID_CUT_MASTER'
    this.format = format;
    this.planId = planId;
  }
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

/**
 * Transform a target-local contour (points + Bézier commands) to sheet-mm using placement.rigidMatrixMm.
 * Applied ONCE to construct authoritative CutMasterV1.
 */
export function transformContourByRigidMatrixMm(contour, rigidMatrixMm) {
  const mapPt = (pt) => {
    const [x, y] = applyRigidMatrixMm(rigidMatrixMm, pt);
    return [r4(x), r4(y)];
  };

  const beziersMm = Array.isArray(contour?.beziersMm) && contour.beziersMm.length > 0
    ? contour.beziersMm.map((cmd) => {
        const out = { type: cmd.type };
        if (cmd.to) out.to = mapPt(cmd.to);
        if (cmd.c1) out.c1 = mapPt(cmd.c1);
        if (cmd.c2) out.c2 = mapPt(cmd.c2);
        return out;
      })
    : Array.isArray(contour) && contour.length >= 3
    ? [
        { type: 'M', to: mapPt(contour[0]) },
        ...contour.slice(1).map((p) => ({ type: 'L', to: mapPt(p) })),
        { type: 'L', to: mapPt(contour[0]) },
      ]
    : [];

  return {
    beziersMm,
    closed: true,
  };
}

/**
 * Build the single authoritative CutMasterV1 from ImpositionPlanV1 + StickerJobV1[].
 * Contains ONLY CUT vector geometry + sheet dimensions + shared registrationMarks (NO BLEED, NO raster CUT).
 */
export function buildCutMasterV1(plan, jobs) {
  const jobMap = new Map(jobs.map((j) => [j.jobId, j]));
  const sheets = plan.sheets.map((sh) => {
    const placements = sh.placements.map((pl) => {
      const job = jobMap.get(pl.jobId);
      if (!job || !job.productionGeometry?.cutTargetMm) {
        throw new CutExportError({
          code: 'INVALID_CUT_MASTER',
          planId: plan.planId,
          message: `Missing productionGeometry.cutTargetMm for job ${pl.jobId}`,
        });
      }
      const cutPathMm = transformContourByRigidMatrixMm(job.productionGeometry.cutTargetMm, pl.rigidMatrixMm);
      return {
        placementId: pl.placementId,
        jobId: pl.jobId,
        copyIndex: pl.copyIndex,
        jobRevision: pl.jobRevision,
        cutRevision: pl.cutRevision,
        productionGeometryRevision: pl.productionGeometryRevision,
        rotationDeg: pl.rotationDeg,
        targetSizeMm: { ...pl.targetSizeMm },
        rigidMatrixMm: [...pl.rigidMatrixMm],
        cutPathMm,
      };
    });

    return {
      sheetIndex: sh.sheetIndex,
      widthMm: sh.widthMm,
      heightMm: sh.heightMm,
      placements,
      registrationMarks: (sh.registrationMarks || []).map((m) => ({ ...m })),
    };
  });

  const cutMaster = {
    version: CUT_MASTER_VERSION,
    planId: plan.planId,
    planRevision: plan.planRevision,
    productionProfile: { ...plan.productionProfile },
    sheets,
  };
  assertNoBinaryInState(cutMaster, 'cutMaster');
  return cutMaster;
}

/**
 * Resolve sheetSelection ('ALL' or 0-based index array [0, 2, ...]) without recomputing imposition.
 */
export function resolveSelectedSheets(cutMaster, sheetSelection = 'ALL') {
  if (sheetSelection === 'ALL' || sheetSelection === undefined || sheetSelection === null) {
    return {
      indices: cutMaster.sheets.map((_, i) => i),
      sheets: cutMaster.sheets,
    };
  }
  if (!Array.isArray(sheetSelection) || sheetSelection.length === 0) {
    throw new CutExportError({ code: 'INVALID_SELECTION', planId: cutMaster.planId, message: 'sheetSelection must be "ALL" or non-empty 0-based index array' });
  }
  const uniqueIndices = [];
  const seen = new Set();
  for (const idx of sheetSelection) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= cutMaster.sheets.length) {
      throw new CutExportError({
        code: 'INVALID_SELECTION',
        planId: cutMaster.planId,
        message: `sheetSelection index ${idx} out of bounds (0..${cutMaster.sheets.length - 1})`,
      });
    }
    if (!seen.has(idx)) {
      seen.add(idx);
      uniqueIndices.push(idx);
    }
  }
  return {
    indices: uniqueIndices,
    sheets: uniqueIndices.map((i) => cutMaster.sheets[i]),
  };
}

function drawCutMasterPathOnPdfPage(page, cutPathMm, sheetHPt, color, thicknessPt = 0.3) {
  const ops = [pushGraphicsState(), setStrokingColor(color), setLineWidth(thicknessPt)];
  for (const cmd of cutPathMm.beziersMm) {
    if (cmd.type === 'M') {
      ops.push(moveTo(cmd.to[0] * MM_TO_PT, sheetHPt - cmd.to[1] * MM_TO_PT));
    } else if (cmd.type === 'L') {
      ops.push(lineTo(cmd.to[0] * MM_TO_PT, sheetHPt - cmd.to[1] * MM_TO_PT));
    } else if (cmd.type === 'C') {
      ops.push(
        appendBezierCurve(
          cmd.c1[0] * MM_TO_PT,
          sheetHPt - cmd.c1[1] * MM_TO_PT,
          cmd.c2[0] * MM_TO_PT,
          sheetHPt - cmd.c2[1] * MM_TO_PT,
          cmd.to[0] * MM_TO_PT,
          sheetHPt - cmd.to[1] * MM_TO_PT
        )
      );
    }
  }
  ops.push(closePath(), stroke(), popGraphicsState());
  page.pushOperators(...ops);
}

function drawRegistrationMarksOnPdfPage(page, marks, sheetHPt) {
  const black = cmyk(0, 0, 0, 1);
  for (const m of marks) {
    page.drawRectangle({
      x: m.xMm * MM_TO_PT,
      y: sheetHPt - (m.yMm + m.sizeMm) * MM_TO_PT,
      width: m.sizeMm * MM_TO_PT,
      height: m.sizeMm * MM_TO_PT,
      color: black,
    });
  }
}

/**
 * Export CutMasterV1 to 1:1 Vector PDF (CUT_ONLY or CUT_PLUS_PRINT when printOverlayRenderer provided).
 */
export async function exportCutMasterToPdf(cutMaster, options = {}) {
  const {
    sheetSelection = 'ALL',
    scope = 'CUT_ONLY',
    printOverlayRenderer = null, // optional async (doc, page, sheet) => void for CUT_PLUS_PRINT
  } = options;

  const { indices, sheets } = resolveSelectedSheets(cutMaster, sheetSelection);
  const doc = await PDFDocument.create();
  const cutMagenta = cmyk(0, 1, 0, 0);
  const includeMarks = Boolean(cutMaster.productionProfile?.includeMarksInCut);

  for (const sh of sheets) {
    const wPt = sh.widthMm * MM_TO_PT;
    const hPt = sh.heightMm * MM_TO_PT;
    const page = doc.addPage([wPt, hPt]);
    page.setCropBox(0, 0, wPt, hPt);
    page.setBleedBox(0, 0, wPt, hPt);
    page.setTrimBox(0, 0, wPt, hPt);

    if (scope === 'CUT_PLUS_PRINT' && typeof printOverlayRenderer === 'function') {
      await printOverlayRenderer(doc, page, sh);
    }

    if (includeMarks && sh.registrationMarks.length > 0) {
      drawRegistrationMarksOnPdfPage(page, sh.registrationMarks, hPt);
    }

    for (const pl of sh.placements) {
      drawCutMasterPathOnPdfPage(page, pl.cutPathMm, hPt, cutMagenta, 0.3);
    }
  }

  return {
    format: 'PDF',
    mimeType: 'application/pdf',
    exportedSheetIndices: indices,
    bytes: await doc.save(),
  };
}

function cutPathToSvgD(cutPathMm) {
  const parts = [];
  for (const cmd of cutPathMm.beziersMm) {
    if (cmd.type === 'M') parts.push(`M ${cmd.to[0]} ${cmd.to[1]}`);
    else if (cmd.type === 'L') parts.push(`L ${cmd.to[0]} ${cmd.to[1]}`);
    else if (cmd.type === 'C') parts.push(`C ${cmd.c1[0]} ${cmd.c1[1]}, ${cmd.c2[0]} ${cmd.c2[1]}, ${cmd.to[0]} ${cmd.to[1]}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/**
 * Export CutMasterV1 to 1:1 physical mm SVG (separate PRINT/MARKS/CUT groups when CUT_PLUS_PRINT).
 */
export function exportCutMasterToSvg(cutMaster, options = {}) {
  const {
    sheetSelection = 'ALL',
    scope = 'CUT_ONLY',
    printHrefByPlacementId = null, // optional map placementId -> dataUrl for CUT_PLUS_PRINT SVG
  } = options;

  const { indices, sheets } = resolveSelectedSheets(cutMaster, sheetSelection);
  const sh = sheets[0];
  const includeMarks = Boolean(cutMaster.productionProfile?.includeMarksInCut);

  const printGroup =
    scope === 'CUT_PLUS_PRINT'
      ? `  <g id="PRINT_LAYER">\n${sh.placements
          .map((pl) => {
            const href = printHrefByPlacementId?.get(pl.placementId) || '';
            const [a, b, c, d, tx, ty] = pl.rigidMatrixMm;
            return `    <image id="ART_${pl.placementId}" width="${pl.targetSizeMm.w}" height="${pl.targetSizeMm.h}" transform="matrix(${a} ${b} ${c} ${d} ${tx} ${ty})" href="${href}" />`;
          })
          .join('\n')}\n  </g>\n`
      : '';

  const marksGroup =
    includeMarks && sh.registrationMarks.length > 0
      ? `  <g id="MARKS_LAYER" fill="#000000">\n${sh.registrationMarks
          .map((m) => `    <rect id="${m.id}" x="${m.xMm}" y="${m.yMm}" width="${m.sizeMm}" height="${m.sizeMm}" />`)
          .join('\n')}\n  </g>\n`
      : '';

  const cutGroup = `  <g id="CUT_LAYER" fill="none" stroke="#FF00FF" stroke-width="0.1">\n${sh.placements
    .map((pl) => `    <path id="CUT_${pl.placementId}" data-job-id="${pl.jobId}" data-copy-index="${pl.copyIndex}" d="${cutPathToSvgD(pl.cutPathMm)}" />`)
    .join('\n')}\n  </g>`;

  const svgText = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${sh.widthMm}mm" height="${sh.heightMm}mm" viewBox="0 0 ${sh.widthMm} ${sh.heightMm}" data-plan-id="${cutMaster.planId}" data-plan-revision="${cutMaster.planRevision}" data-sheet-index="${sh.sheetIndex}">\n${printGroup}${marksGroup}${cutGroup}\n</svg>\n`;

  return {
    format: 'SVG',
    mimeType: 'image/svg+xml',
    exportedSheetIndices: indices,
    svgText,
    bytes: new TextEncoder().encode(svgText),
  };
}

/**
 * Honest AI format contract: current JS runtime has NO native Adobe Illustrator writer.
 * NEVER fakes .ai by renaming .pdf or .eps.
 */
export function exportCutMasterToAi(cutMaster) {
  throw new CutExportError({
    code: 'FORMAT_NOT_SUPPORTED',
    format: 'AI',
    planId: cutMaster?.planId ?? null,
    message: 'FORMAT_NOT_SUPPORTED: Native Adobe Illustrator (.ai) writer chưa có trong runtime hiện tại (không giả lập bằng đổi đuôi .pdf/.eps). Dùng PDF hoặc SVG 1:1 để mở trong Illustrator.',
  });
}

export async function exportCutMaster(cutMaster, { format = 'PDF', scope = 'CUT_ONLY', sheetSelection = 'ALL', printOverlayRenderer = null, printHrefByPlacementId = null } = {}) {
  if (format === 'PDF') {
    return await exportCutMasterToPdf(cutMaster, { scope, sheetSelection, printOverlayRenderer });
  }
  if (format === 'SVG') {
    return exportCutMasterToSvg(cutMaster, { scope, sheetSelection, printHrefByPlacementId });
  }
  if (format === 'AI') {
    return exportCutMasterToAi(cutMaster);
  }
  throw new CutExportError({
    code: 'FORMAT_NOT_SUPPORTED',
    format,
    planId: cutMaster?.planId ?? null,
    message: `Unsupported CUT format: ${format}`,
  });
}
