/**
 * PrintKit Architecture V1 — Phase V1-A2: Vector First Pipeline
 *
 * Bridges Direct PDF Vector Importer (V1-A1) -> Layer 1 CanonicalCutV1 -> BLEED -> Studio UI
 * while strictly enforcing all 5 tightened engineering rules:
 *  A. Never auto-treat arbitrary vector paths as CUT (respects importer confidence & rejection).
 *  B. Never auto-fallback to raster when offsetMm != 0:
 *       - |offsetMm| < 0.01  -> VECTOR_ORIGINAL (0.0000mm Bézier preservation)
 *       - |offsetMm| >= 0.01 -> Controlled vector offset -> VECTOR_TRANSFORMED
 *       - Unsupported/failed -> Explicit user confirmation required before raster fallback
 *  C. Full CanonicalCutV1 contract (coordinate system, segment order, winding, closedness,
 *     contour-job provenance) + verified polygon+Bézier contract for precisionBleedFromCut().
 *  E. Explicit 4-state provenance taxonomy:
 *       VECTOR_ORIGINAL | VECTOR_TRANSFORMED | RASTER_DERIVED | VECTOR_IMPORT_REJECTED
 *
 * ZERO edits to any LOCKED engine file.
 */

import {
  extractPdfVectorContours,
  CONTOUR_PROVENANCE,
} from './pdfVectorContourImporter.js';
import {
  contourBoundsMm,
  precisionBleedFromCut,
  offsetPolygonAndFitBezierMm,
  validateContoursGeometry,
} from './bleedContourEngine.js';
import { tessellateAndVerifyContourMm } from './productionBleedSafetyH22.js';
import { translateContourToLocalOrigin } from './cutlineV1Adapter.js';
import {
  CUTLINE_ENGINE_VERSION,
  createCanonicalCutV1,
  createJobId,
  assertNoBinaryInState,
} from './v1Schema.js';

export { CONTOUR_PROVENANCE };
export const VECTOR_FIRST_PIPELINE_VERSION = 'V1-A2.0';

function cloneBeziersMm(beziersMm) {
  if (!Array.isArray(beziersMm)) return [];
  return beziersMm.map((cmd) => {
    const out = { type: cmd.type };
    if (cmd.c1) out.c1 = [cmd.c1[0], cmd.c1[1]];
    if (cmd.c2) out.c2 = [cmd.c2[0], cmd.c2[1]];
    if (cmd.to) out.to = [cmd.to[0], cmd.to[1]];
    return out;
  });
}

function signedPolyArea(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return s * 0.5;
}

/**
 * Step 1: Run direct PDF vector contour extraction with Point A confidence gating.
 */
export async function runVectorFirstPdfImport(pdfBytes, options = {}) {
  const res = await extractPdfVectorContours(pdfBytes, options);
  return {
    ...res,
    pipelineVersion: VECTOR_FIRST_PIPELINE_VERSION,
  };
}

/**
 * Convert a single imported vector contour into a Studio/V1-compatible polygon+Bézier contour object.
 * - Array elements are tessellated [x, y] mm points (satisfies polygon APIs like precisionBleedFromCut,
 *   contourBoundsMm, sampleStickerEdgeColor, and centroid badge rendering).
 * - `.beziersMm` is an untouched deep clone of the original cubic Bézier commands.
 * - Preserves segment order, winding orientation, closedness, coordinateSystem, and provenance.
 */
export function convertVectorContourToStudioPoly(
  vecContour,
  { flatnessMm = 0.005, provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL } = {}
) {
  const clonedBeziers = cloneBeziersMm(vecContour.beziersMm);
  const tess = tessellateAndVerifyContourMm(
    { beziersMm: clonedBeziers, closed: vecContour.closed !== false },
    { flatnessMm }
  );
  if (!tess.valid || !Array.isArray(tess.poly) || tess.poly.length < 3) {
    throw new Error(`Invalid vector contour #${vecContour.stickerIndex || '?'}: ${tess.reason || 'tessellation failed'}`);
  }
  const sArea = signedPolyArea(tess.poly);
  const poly = tess.poly.map(([x, y]) => [x, y]);
  Object.assign(poly, {
    beziersMm: clonedBeziers,
    closed: true,
    cornerCount: 0,
    compIdx: Math.max(0, (vecContour.stickerIndex || 1) - 1),
    provenance,
    coordinateSystem: vecContour.coordinateSystem || 'SHEET_MM_Y_DOWN',
    winding: vecContour.winding || (sArea >= 0 ? 'CW' : 'CCW'),
    sourceMeta: {
      stickerIndex: vecContour.stickerIndex ?? null,
      source: vecContour.source || 'PDF_VECTOR_DIRECT',
      selectionMode: vecContour.selectionMode || null,
      ocgName: vecContour.ocgName ?? null,
      paintOp: vecContour.paintOp ?? null,
      bezierSegmentCount: clonedBeziers.filter((c) => c.type === 'C' || c.type === 'L').length,
      printColorMetadata: vecContour.printColorMetadata ?? null,
    },
  });
  return poly;
}

/**
 * Generate a Precision BLEED contour from a polygon+Bézier CUT contour WITHOUT mutating CUT.
 * Calls LOCKED `precisionBleedFromCut` (Tier 1) and falls back to `offsetPolygonAndFitBezierMm` (Tier 2).
 */
function deriveSingleBleedFromCut(cutPoly, bleedOffsetMm, pageW, pageH) {
  if (!(bleedOffsetMm > 0.05)) return null;
  // Pass polygon array (with .beziersMm attached) — matches exact bleedContourEngine.js contract
  try {
    const cand1 = precisionBleedFromCut(cutPoly, bleedOffsetMm, {});
    if (cand1 && cand1.length >= 3) {
      const v1 = validateContoursGeometry([cutPoly], [cand1], pageW, pageH, { targetBleedMm: bleedOffsetMm });
      if (v1.geometryValid) {
        cand1.fallbackTier = 1;
        cand1.fallbackMethod = 'precision';
        return cand1;
      }
    }
  } catch {
    // Fall through to Tier 2
  }
  try {
    const cand2 = offsetPolygonAndFitBezierMm(cutPoly, bleedOffsetMm, {});
    if (cand2 && cand2.length >= 3) {
      cand2.fallbackTier = 2;
      cand2.fallbackMethod = 'polygon-offset-fallback';
      return cand2;
    }
  } catch {
    // Return null if Tier 2 also fails
  }
  return null;
}

/**
 * Apply controlled vector offset (Point B) directly on a vector CUT contour without rasterizing.
 * Returns { ok: true, poly } or { ok: false, reason }.
 */
function applyControlledVectorOffset(basePoly, offsetMm, pageW, pageH) {
  try {
    let offsetPoly = null;
    if (offsetMm > 0) {
      try {
        offsetPoly = precisionBleedFromCut(basePoly, offsetMm, {});
      } catch {
        offsetPoly = offsetPolygonAndFitBezierMm(basePoly, offsetMm, {});
      }
    } else {
      offsetPoly = offsetPolygonAndFitBezierMm(basePoly, offsetMm, {});
    }

    if (!offsetPoly || !Array.isArray(offsetPoly) || offsetPoly.length < 3) {
      return { ok: false, reason: 'VECTOR_OFFSET_EMPTY_RESULT' };
    }
    const v = validateContoursGeometry([offsetPoly], [], pageW, pageH, {});
    if (!v.geometryValid || v.selfIntersections > 0) {
      return { ok: false, reason: 'VECTOR_OFFSET_GEOMETRY_INVALID' };
    }

    const sArea = signedPolyArea(offsetPoly);
    Object.assign(offsetPoly, {
      closed: true,
      compIdx: basePoly.compIdx,
      provenance: CONTOUR_PROVENANCE.VECTOR_TRANSFORMED,
      coordinateSystem: basePoly.coordinateSystem || 'SHEET_MM_Y_DOWN',
      winding: sArea >= 0 ? 'CW' : 'CCW',
      sourceMeta: {
        ...(basePoly.sourceMeta || {}),
        originalBezierSegmentCount: basePoly.sourceMeta?.bezierSegmentCount ?? null,
        appliedOffsetMm: offsetMm,
        transformMethod: 'CONTROLLED_VECTOR_OFFSET',
      },
    });
    return { ok: true, poly: offsetPoly };
  } catch (err) {
    return { ok: false, reason: err?.message || 'VECTOR_OFFSET_EXCEPTION' };
  }
}

/**
 * Step 2: Resolve Studio contours from a PDF Vector Import result, enforcing Points A, B, C, E.
 *
 * Returns:
 *   {
 *     mode: 'VECTOR_ORIGINAL' | 'VECTOR_TRANSFORMED' | 'CONFIRM_RASTER_FOR_TRANSFORM' | 'REJECTED' | 'FALLBACK_RASTER',
 *     provenance: CONTOUR_PROVENANCE.*,
 *     contoursMm: Array (with .bleedContoursMm & .validation attached when contours exist),
 *     requiresUserConfirmation: boolean,
 *     warnings: string[],
 *     reasons: string[],
 *     selectionMode: string | null,
 *     confidence: number,
 *   }
 */
export function resolveVectorFirstContours(
  vectorImportResult,
  {
    offsetMm = 0,
    bleedOffsetMm = 1.5,
    shapeMode = 'auto',
    pageWidthMm = null,
    pageHeightMm = null,
    perStickerOverrides = {},
    flatnessMm = 0.005,
  } = {}
) {
  if (!vectorImportResult) {
    return {
      mode: 'FALLBACK_RASTER',
      provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
      contoursMm: [],
      requiresUserConfirmation: false,
      warnings: ['Không có kết quả nhập PDF vector — dùng bộ dò Raster'],
      reasons: ['NO_VECTOR_RESULT'],
      selectionMode: null,
      confidence: 0,
    };
  }

  // Point A: Vector import was explicitly rejected due to low confidence / ambiguity
  if (vectorImportResult.status === 'CONFIRMATION_REQUIRED') {
    return {
      mode: 'REJECTED',
      provenance: CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED,
      contoursMm: [],
      requiresUserConfirmation: true,
      warnings: vectorImportResult.warnings || [],
      reasons: vectorImportResult.reasons || ['VECTOR_IMPORT_REJECTED'],
      selectionMode: vectorImportResult.selectionMode || null,
      confidence: vectorImportResult.confidence ?? 0,
    };
  }

  // Raster-only PDF (no closed vector contours at all) -> automatic controlled fallback to raster
  if (vectorImportResult.status !== 'OK' || !Array.isArray(vectorImportResult.contours) || vectorImportResult.contours.length === 0) {
    return {
      mode: 'FALLBACK_RASTER',
      provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
      contoursMm: [],
      requiresUserConfirmation: false,
      warnings: vectorImportResult.warnings || [],
      reasons: vectorImportResult.reasons || ['NO_VECTOR_CONTOURS'],
      selectionMode: null,
      confidence: 0,
    };
  }

  const pageW = pageWidthMm || vectorImportResult.pageWidthMm || 330;
  const pageH = pageHeightMm || vectorImportResult.pageHeightMm || 390;

  // Build base VECTOR_ORIGINAL polygons (never mutated)
  const basePolys = [];
  for (let i = 0; i < vectorImportResult.contours.length; i++) {
    const ovr = perStickerOverrides?.[i];
    if (ovr?.hidden) continue;
    basePolys.push(
      convertVectorContourToStudioPoly(vectorImportResult.contours[i], {
        flatnessMm,
        provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
      })
    );
  }

  const hasPerStickerShapeOverride = Object.values(perStickerOverrides || {}).some(
    (o) => o && !o.hidden && o.shapeMode && o.shapeMode !== 'default' && o.shapeMode !== 'auto'
  );

  // Point B: Shape override (circle/oval/rect) cannot preserve original freeform Bézier; ask user before raster
  if (shapeMode !== 'auto' || hasPerStickerShapeOverride) {
    return {
      mode: 'CONFIRM_RASTER_FOR_TRANSFORM',
      provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
      contoursMm: [],
      requiresUserConfirmation: true,
      warnings: [
        `Chế độ ép hình (${shapeMode}) sẽ thay thế đường Bézier vector gốc. Hãy đặt lại "Tự do (Freeform)" để giữ vector gốc hoặc xác nhận chuyển sang Raster.`,
      ],
      reasons: ['SHAPE_OVERRIDE_REQUIRES_CONFIRMATION'],
      selectionMode: vectorImportResult.selectionMode,
      confidence: vectorImportResult.confidence ?? 0.95,
    };
  }

  const effOffsetMm = Number(offsetMm) || 0;
  const isZeroOffset = Math.abs(effOffsetMm) < 0.01;
  const hasPerStickerOffset = Object.values(perStickerOverrides || {}).some(
    (o) => o && !o.hidden && typeof o.offsetMm === 'number' && Math.abs(o.offsetMm) >= 0.01
  );

  let finalCutPolys = [];
  let provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL;
  const warnings = [...(vectorImportResult.warnings || [])];

  if (isZeroOffset && !hasPerStickerOffset) {
    // Point B: offsetMm === 0 -> 100% VECTOR_ORIGINAL preservation
    finalCutPolys = basePolys;
    provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL;
  } else {
    // Point B: offsetMm !== 0 -> Controlled Vector Offset (NEVER auto-drop Bézier to raster!)
    provenance = CONTOUR_PROVENANCE.VECTOR_TRANSFORMED;
    for (let i = 0; i < basePolys.length; i++) {
      const bp = basePolys[i];
      const ovrOffset = perStickerOverrides?.[bp.compIdx]?.offsetMm;
      const stickerOffset = typeof ovrOffset === 'number' ? ovrOffset : effOffsetMm;
      if (Math.abs(stickerOffset) < 0.01) {
        finalCutPolys.push(bp);
        continue;
      }
      const res = applyControlledVectorOffset(bp, stickerOffset, pageW, pageH);
      if (!res.ok) {
        return {
          mode: 'CONFIRM_RASTER_FOR_TRANSFORM',
          provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
          contoursMm: [],
          requiresUserConfirmation: true,
          warnings: [
            `Không thể offset vector trực tiếp (${stickerOffset > 0 ? '+' : ''}${stickerOffset}mm) cho tem #${i + 1} (${res.reason}). Đặt Offset = 0mm để giữ đường Bézier gốc hoặc xác nhận chuyển sang Raster.`,
          ],
          reasons: ['VECTOR_OFFSET_UNSUPPORTED', res.reason],
          selectionMode: vectorImportResult.selectionMode,
          confidence: vectorImportResult.confidence ?? 0.95,
        };
      }
      finalCutPolys.push(res.poly);
    }
    warnings.push(
      `Đã áp dụng Vector Offset có kiểm soát (${effOffsetMm > 0 ? '+' : ''}${effOffsetMm} mm) trực tiếp trên đường vector gốc — KHÔNG tái dò raster.`
    );
  }

  // Point C: Derive BLEED from CUT using exact polygon+Bézier contract without mutating CUT
  const effBleedMm = Math.max(0, Number(bleedOffsetMm) || 0);
  const bleedContoursMm = [];
  if (effBleedMm > 0.05) {
    for (const cutPoly of finalCutPolys) {
      const bPoly = deriveSingleBleedFromCut(cutPoly, effBleedMm, pageW, pageH);
      bleedContoursMm.push(bPoly);
    }
  }

  const validation = validateContoursGeometry(
    finalCutPolys,
    bleedContoursMm.filter(Boolean),
    pageW,
    pageH,
    { targetBleedMm: effBleedMm > 0.05 ? effBleedMm : null }
  );

  // Attach Studio-compatible properties onto contoursMm array
  const contoursMm = [...finalCutPolys];
  contoursMm.bleedContoursMm = bleedContoursMm;
  contoursMm.validation = validation;
  contoursMm.provenance = provenance;
  contoursMm.selectionMode = vectorImportResult.selectionMode;
  contoursMm.confidence = vectorImportResult.confidence;

  return {
    mode: provenance === CONTOUR_PROVENANCE.VECTOR_ORIGINAL ? 'VECTOR_ORIGINAL' : 'VECTOR_TRANSFORMED',
    provenance,
    contoursMm,
    requiresUserConfirmation: false,
    warnings,
    reasons: [],
    selectionMode: vectorImportResult.selectionMode,
    confidence: vectorImportResult.confidence ?? 0.95,
  };
}

/**
 * Build full Layer 1 CanonicalCutV1 records directly from PDF Vector Import contours (Point C).
 * Preserves:
 *  - Coordinate system separation: SHEET_MM_Y_DOWN (origin.sourceRegionMm) vs JOB_LOCAL_MM_Y_DOWN (cutNaturalMm)
 *  - Exact segment order & cubic Bézier control points (pure translation only)
 *  - Contour winding orientation & closed state
 *  - Contour-to-job relationship (jobId, sourceAssetId, pageIndex, sourceStickerIndex, sourceRegionMm)
 *  - Source provenance metadata (plain JSON-safe, passes assertNoBinaryInState)
 */
export function buildCanonicalCutsFromVectorResult({
  vectorImportResult,
  assetId,
  pageIndex = 1,
  artworkResourceId,
  cutInputHash,
  flatnessMm = 0.005,
  jobIdFactory = createJobId,
}) {
  if (!vectorImportResult || vectorImportResult.status !== 'OK' || !vectorImportResult.contours?.length) {
    throw new Error('buildCanonicalCutsFromVectorResult: requires valid OK vectorImportResult with contours');
  }

  const entries = [];
  for (let i = 0; i < vectorImportResult.contours.length; i++) {
    const vc = vectorImportResult.contours[i];
    const sheetPoly = convertVectorContourToStudioPoly(vc, {
      flatnessMm,
      provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
    });
    const bounds = contourBoundsMm(sheetPoly);
    const bw = bounds.w ?? bounds.width ?? bounds.maxX - bounds.minX;
    const bh = bounds.h ?? bounds.height ?? bounds.maxY - bounds.minY;
    if (!bounds.valid || !(bw > 0) || !(bh > 0)) {
      throw new Error(`Invalid bounds for vector contour #${i + 1}`);
    }

    const cutNaturalMm = translateContourToLocalOrigin(sheetPoly, bounds.minX, bounds.minY);
    Object.assign(cutNaturalMm, {
      provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
      coordinateSystem: 'JOB_LOCAL_MM_Y_DOWN',
      winding: sheetPoly.winding,
      sourceMeta: { ...sheetPoly.sourceMeta },
    });

    const canonicalCut = createCanonicalCutV1({
      cutlineEngineVersion: CUTLINE_ENGINE_VERSION,
      cutInputHash,
      cutRevision: 1,
      naturalTrimMm: { w: bw, h: bh },
      naturalWhiteBorderMm: null,
      cutNaturalMm,
    });

    const sourceRegionMm = {
      x: Math.max(0, bounds.minX),
      y: Math.max(0, bounds.minY),
      w: bw,
      h: bh,
    };

    const entry = {
      jobId: jobIdFactory(),
      provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
      origin: {
        sourceAssetId: assetId,
        pageIndex,
        extractionId: null,
        sourceStickerIndex: vc.stickerIndex ?? i + 1,
        sourceRegionMm,
      },
      artworkRef: {
        resourceId: artworkResourceId,
        thumbnailResourceId: null,
        cropBoxMm: sourceRegionMm,
      },
      canonicalCut,
      printColorMetadata: vc.printColorMetadata ?? null,
    };
    assertNoBinaryInState(entry, `vectorCanonicalSticker[${i}]`);
    entries.push(entry);
  }

  return entries;
}
