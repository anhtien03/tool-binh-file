/**
 * PrintKit Architecture V1 — Cutline 3.1.2 Adapter (Checkpoint C)
 *
 * Translates V1 CutConfigV1 -> Cutline Engine 3.1.2 options, calls the LOCKED 3.1.2 engine,
 * and normalizes each detected sticker's CUT contour into Layer 1 CanonicalCutV1 (translation-only).
 *
 * Rules:
 *  - ZERO reimplementation of 3.1.2 algorithms (Smart Grouping, CUT, Bézier, BLEED, Validator).
 *  - Extracts ONLY Layer 1 Canonical CUT (passes bleedOffsetMm: 0 to 3.1.2).
 *  - Distinguishes SOURCE PAGE MM (origin.sourceRegionMm) vs JOB LOCAL MM (cutNaturalMm at origin 0,0).
 *  - Normalization is strictly pure translation (no scale, no simplify, no refit).
 *  - Structured error isolation: never swallows errors, never returns [] on engine failure.
 */

import {
  extractStickerContoursFromImage,
  contourBoundsMm,
} from './bleedContourEngine.js';
import {
  CUTLINE_ENGINE_VERSION,
  validateCutConfigV1,
  createCanonicalCutV1,
  createJobId,
  computeCutInputHash,
  assertNoBinaryInState,
} from './v1Schema.js';

export class CutlineAdapterError extends Error {
  constructor({ code, message, assetId = null, pageIndex = 1, jobId = null, cause = null }) {
    super(message);
    this.name = 'CutlineAdapterError';
    this.stage = 'CUTLINE';
    this.code = code; // 'INVALID_INPUT' | 'ENGINE_ERROR' | 'NO_CONTOUR' | 'NORMALIZATION_ERROR'
    this.assetId = assetId;
    this.pageIndex = pageIndex;
    this.jobId = jobId;
    this.cause = cause;
  }

  toJSON() {
    return {
      stage: this.stage,
      assetId: this.assetId,
      pageIndex: this.pageIndex,
      jobId: this.jobId,
      code: this.code,
      message: this.message,
      cause: this.cause ? String(this.cause?.message || this.cause) : null,
    };
  }
}

/**
 * Single authoritative mapping: CutConfigV1 -> extractStickerContoursFromImage options (3.1.2).
 * Forces bleedOffsetMm = 0 because Checkpoint C extracts ONLY Layer 1 Canonical CUT.
 */
export function mapCutConfigV1ToEngineOptions(cutConfig, extra = {}) {
  const validCfg = validateCutConfigV1(cutConfig);
  const mapped = {
    shapeMode: validCfg.shapeMode,
    offsetMm: validCfg.offsetMm,
    bleedOffsetMm: 0, // Layer 1 Canonical CUT only; Layer 2 Production BLEED is derived in Checkpoint D
    mergeGapMm: validCfg.mergeGapMm,
    cornerAngleDeg: validCfg.cornerAngleDeg,
    smoothLevel: validCfg.smoothLevel,
    simplifyMm: validCfg.simplifyMm,
    minAreaMm2: validCfg.minAreaMm2,
    ignoreCornerMarks: validCfg.ignoreCornerMarks,
  };
  if (Array.isArray(extra.imagePlacementsMm) && extra.imagePlacementsMm.length > 0) {
    mapped.imagePlacementsMm = extra.imagePlacementsMm;
  }
  return Object.freeze(mapped);
}

/**
 * Pure translation-only normalization: SOURCE PAGE MM -> JOB LOCAL MM (origin = 0,0).
 * Preserves exact Bézier control points, anchors, segment count, and topology.
 * Does NOT scale, simplify, refit, or offset.
 */
export function translateContourToLocalOrigin(contour, originXMm, originYMm) {
  if (!Number.isFinite(originXMm) || !Number.isFinite(originYMm)) {
    throw new Error('translateContourToLocalOrigin: origin must be finite numbers');
  }
  const shiftPt = (pt) => {
    if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new Error('translateContourToLocalOrigin: contour contains non-finite coordinate');
    }
    return [pt[0] - originXMm, pt[1] - originYMm];
  };

  const shiftedPts = Array.isArray(contour) ? contour.map(shiftPt) : [];
  const shiftedBeziers = Array.isArray(contour?.beziersMm)
    ? contour.beziersMm.map((cmd) => {
        if (!cmd || typeof cmd !== 'object') {
          throw new Error('translateContourToLocalOrigin: invalid Bézier command');
        }
        const out = { type: cmd.type };
        if (cmd.to) out.to = shiftPt(cmd.to);
        if (cmd.c1) out.c1 = shiftPt(cmd.c1);
        if (cmd.c2) out.c2 = shiftPt(cmd.c2);
        return out;
      })
    : undefined;

  const shiftedAnchors = Array.isArray(contour?.anchorsMm) ? contour.anchorsMm.map(shiftPt) : undefined;

  const localContour = [...shiftedPts];
  Object.assign(localContour, {
    beziersMm: shiftedBeziers,
    anchorsMm: shiftedAnchors,
    closed: contour?.closed !== false,
    cornerCount: contour?.cornerCount || 0,
  });
  return localContour;
}

/**
 * Extract Layer 1 Canonical CUT objects for all detected stickers on a clean rendered page.
 * Returns structured canonical candidates with provenance (sourceAssetId, pageIndex, sourceRegionMm)
 * and fresh immutable jobIds (never array-index-based).
 */
export async function extractCanonicalCutsForPage(params = {}) {
  const {
    assetId,
    pageIndex = 1,
    extractionId = null,
    artworkResourceId,
    artworkContentHash,
    imgElement,
    totalWidthMm,
    totalHeightMm,
    cutConfig,
    imagePlacementsMm = [],
    engineFn = extractStickerContoursFromImage,
    hashTextFn,
    jobIdFactory = createJobId,
  } = params;

  // 1. Fail-fast input validation
  let validatedCutConfig;
  let engineOptions;
  try {
    if (typeof assetId !== 'string' || !assetId.trim()) throw new Error('assetId is required');
    if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error(`pageIndex must be integer >= 1 (got ${pageIndex})`);
    if (typeof artworkResourceId !== 'string' || !artworkResourceId.trim()) {
      throw new Error('artworkResourceId is required');
    }
    if (typeof artworkContentHash !== 'string' || !artworkContentHash.trim()) {
      throw new Error('artworkContentHash is required');
    }
    if (!imgElement || !Number.isFinite(imgElement.width) || !Number.isFinite(imgElement.height) || imgElement.width <= 0 || imgElement.height <= 0) {
      throw new Error('imgElement must have positive finite width and height');
    }
    if (!Number.isFinite(totalWidthMm) || totalWidthMm <= 0 || !Number.isFinite(totalHeightMm) || totalHeightMm <= 0) {
      throw new Error(`totalWidthMm/totalHeightMm must be positive finite numbers (got ${totalWidthMm}x${totalHeightMm})`);
    }
    validatedCutConfig = validateCutConfigV1(cutConfig);
    engineOptions = mapCutConfigV1ToEngineOptions(validatedCutConfig, { imagePlacementsMm });
  } catch (err) {
    throw new CutlineAdapterError({
      code: 'INVALID_INPUT',
      message: err?.message || String(err),
      assetId: assetId ?? null,
      pageIndex: Number.isInteger(pageIndex) ? pageIndex : 1,
      cause: err,
    });
  }

  // 2. Deterministic cutInputHash (strictly independent of quantity, targetSizeMm, sheet, BleedConfigV1)
  const cutInputHash = await computeCutInputHash(
    {
      artworkContentHash,
      pageIndex,
      extractionId,
      cutConfig: validatedCutConfig,
      cutlineEngineVersion: CUTLINE_ENGINE_VERSION,
    },
    hashTextFn
  );

  // 3. Call LOCKED Cutline Engine 3.1.2 (never swallow exceptions)
  let rawContours;
  try {
    rawContours = engineFn(imgElement, totalWidthMm, totalHeightMm, engineOptions);
  } catch (err) {
    throw new CutlineAdapterError({
      code: 'ENGINE_ERROR',
      message: `Cutline Engine 3.1.2 lỗi: ${err?.message || String(err)}`,
      assetId,
      pageIndex,
      cause: err,
    });
  }

  if (!Array.isArray(rawContours) || rawContours.length === 0) {
    throw new CutlineAdapterError({
      code: 'NO_CONTOUR',
      message: `Không tìm thấy đường CUT nào trên trang #${pageIndex} của asset ${assetId}`,
      assetId,
      pageIndex,
    });
  }

  // 4. Normalize each sticker contour via pure translation -> Layer 1 CanonicalCutV1
  const stickers = [];
  for (let i = 0; i < rawContours.length; i++) {
    const rawPoly = rawContours[i];
    const sourceStickerIndex = i + 1;
    const jobId = jobIdFactory();
    try {
      const bounds = contourBoundsMm(rawPoly);
      if (!bounds.valid || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error(`Bounding box không hợp lệ cho sticker #${sourceStickerIndex}`);
      }
      const sourceRegionMm = {
        x: Math.max(0, bounds.minX),
        y: Math.max(0, bounds.minY),
        w: bounds.width,
        h: bounds.height,
      };
      const cutNaturalMm = translateContourToLocalOrigin(rawPoly, bounds.minX, bounds.minY);
      const canonicalCut = createCanonicalCutV1({
        cutlineEngineVersion: CUTLINE_ENGINE_VERSION,
        cutInputHash,
        cutRevision: 1,
        naturalTrimMm: { w: bounds.width, h: bounds.height },
        naturalWhiteBorderMm: null,
        cutNaturalMm,
      });

      const entry = {
        jobId,
        origin: {
          sourceAssetId: assetId,
          pageIndex,
          extractionId,
          sourceStickerIndex,
          sourceRegionMm,
        },
        artworkRef: {
          resourceId: artworkResourceId,
          thumbnailResourceId: null,
          cropBoxMm: sourceRegionMm,
        },
        cutConfig: validatedCutConfig,
        canonicalCut,
      };
      assertNoBinaryInState(entry, `canonicalSticker[${i}]`);
      stickers.push(entry);
    } catch (err) {
      throw new CutlineAdapterError({
        code: 'NORMALIZATION_ERROR',
        message: `Lỗi chuẩn hóa CUT cho sticker #${sourceStickerIndex}: ${err?.message || String(err)}`,
        assetId,
        pageIndex,
        jobId,
        cause: err,
      });
    }
  }

  return {
    assetId,
    pageIndex,
    cutlineEngineVersion: CUTLINE_ENGINE_VERSION,
    cutInputHash,
    engineOptionsUsed: engineOptions,
    groupingReport: rawContours.groupingReport || null,
    engineValidation: rawContours.validation || null,
    stickers,
  };
}
