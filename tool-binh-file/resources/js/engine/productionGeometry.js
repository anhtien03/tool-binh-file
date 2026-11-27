/**
 * PrintKit Architecture V1 — Derived Production Geometry (Checkpoint D)
 *
 * Layer 2 of the one-way two-layer geometry DAG:
 *   Canonical CUT (naturalTrimMm)
 *     -> pure algebraic scale to targetSizeMm -> cutTargetMm
 *     -> physical Precision BLEED directly in target-mm space (via LOCKED 3.1.2 helpers)
 *     -> 3.1.2 geometry validation & diagnostics (no duplicated thresholds)
 *     -> deterministic ProductionGeometryCacheV1 (cache hit on identical productionGeoHash)
 *
 * Invariants:
 *  - NEVER mutates canonicalCut.
 *  - NEVER re-runs recognition, Smart Grouping, Bézier refitting, or CUT offset.
 *  - ZERO 2% heuristic: Precision BLEED is always derived in target-mm space (exact physical mm at 20%, 50%, 100%, 200%).
 *  - lockAspectRatio = true rejects non-uniform targetSizeMm with ASPECT_RATIO_MISMATCH.
 *  - white_border scales with artwork (conservative min(scaleX, scaleY) on non-uniform + NON_UNIFORM_SCALE warning).
 */

import {
  contourBoundsMm,
  precisionBleedFromCut,
  offsetPolygonAndFitBezierMm,
  validateContoursGeometry,
} from './bleedContourEngine.js';
import {
  CUTLINE_ENGINE_VERSION,
  canonicalStringify,
  validateCanonicalCutV1,
  validateBleedConfigV1,
  validateProductionGeometryCacheV1,
  nextProductionGeometryRevision,
  assertNoBinaryInState,
} from './v1Schema.js';

export const PRODUCTION_GEOMETRY_VERSION = '1.0';
export const ASPECT_RATIO_EPSILON = 1e-4;
const BOUNDS_POSTCONDITION_EPS_MM = 1e-3;

function r3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

export class ProductionGeometryError extends Error {
  constructor({ code, message, jobId = null, productionGeometryRevision = 0, cause = null }) {
    super(message);
    this.name = 'ProductionGeometryError';
    this.stage = 'PRODUCTION_GEOMETRY';
    this.code = code; // 'INVALID_INPUT' | 'ASPECT_RATIO_MISMATCH' | 'PRODUCTION_GEOMETRY_ERROR' | 'BLEED_GENERATION_FAILED'
    this.jobId = jobId;
    this.productionGeometryRevision = productionGeometryRevision;
    this.cause = cause;
  }

  toJSON() {
    return {
      stage: this.stage,
      jobId: this.jobId,
      productionGeometryRevision: this.productionGeometryRevision,
      code: this.code,
      message: this.message,
      cause: this.cause ? String(this.cause?.message || this.cause) : null,
    };
  }
}

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('productionGeometry: crypto.subtle.digest is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pure algebraic scaling of a canonical contour from naturalTrimMm -> targetSizeMm.
 * Returns a brand-new contour object; NEVER mutates the input canonical contour.
 * Does NOT simplify, refit, or offset.
 */
export function scaleContourMm(contour, scaleX, scaleY) {
  if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) {
    throw new RangeError(`scaleContourMm: invalid scale (${scaleX}, ${scaleY})`);
  }
  const scalePt = (pt) => {
    if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new RangeError('scaleContourMm: non-finite coordinate in contour');
    }
    return [pt[0] * scaleX, pt[1] * scaleY];
  };

  const scaledPts = Array.isArray(contour) ? contour.map(scalePt) : [];
  const scaledBeziers = Array.isArray(contour?.beziersMm)
    ? contour.beziersMm.map((cmd) => {
        const out = { type: cmd.type };
        if (cmd.to) out.to = scalePt(cmd.to);
        if (cmd.c1) out.c1 = scalePt(cmd.c1);
        if (cmd.c2) out.c2 = scalePt(cmd.c2);
        return out;
      })
    : undefined;
  const scaledAnchors = Array.isArray(contour?.anchorsMm) ? contour.anchorsMm.map(scalePt) : undefined;

  const outContour = [...scaledPts];
  Object.assign(outContour, {
    beziersMm: scaledBeziers,
    anchorsMm: scaledAnchors,
    closed: contour?.closed !== false,
    cornerCount: contour?.cornerCount || 0,
  });
  return outContour;
}

/**
 * Deterministic productionGeoHash covering ONLY inputs that affect Production Geometry:
 *   canonicalCut.cutInputHash, canonicalCut.cutRevision, targetSizeMm, bleedConfig,
 *   lockAspectRatio, productionGeometryVersion, cutlineEngineVersion.
 * Explicitly EXCLUDES quantity, sheet size, margins, gap, allowRotate, placement.
 */
export async function computeProductionGeoHash(params, hashTextFn = defaultSha256Text) {
  const cut = validateCanonicalCutV1(params?.canonicalCut);
  const bleedConfig = validateBleedConfigV1(params?.bleedConfig);
  const targetSizeMm = params?.targetSizeMm;
  if (
    !targetSizeMm ||
    !Number.isFinite(targetSizeMm.w) ||
    targetSizeMm.w <= 0 ||
    !Number.isFinite(targetSizeMm.h) ||
    targetSizeMm.h <= 0
  ) {
    throw new RangeError('computeProductionGeoHash: targetSizeMm must have positive finite w and h');
  }
  const lockAspectRatio = params?.lockAspectRatio !== false;

  const payload = canonicalStringify({
    cutInputHash: cut.cutInputHash,
    cutRevision: cut.cutRevision,
    targetSizeMm: { w: targetSizeMm.w, h: targetSizeMm.h },
    bleedConfig,
    lockAspectRatio,
    productionGeometryVersion: PRODUCTION_GEOMETRY_VERSION,
    cutlineEngineVersion: CUTLINE_ENGINE_VERSION,
  });
  return await hashTextFn(payload);
}

/**
 * Build GeometryValidation block directly from 3.1.2 validateContoursGeometry output
 * (zero duplicated thresholds; preserves 3.1.2 PASS/WARNING/FAIL & LOCAL_CORNER_OVER semantics).
 */
function buildGeometryValidationFrom312(val312, productionGeometryRevision, bleedMode, extraReasons = []) {
  const diag = Array.isArray(val312.bleedDiagnostics) && val312.bleedDiagnostics.length > 0
    ? val312.bleedDiagnostics[0]
    : null;
  const reasons = [...(diag?.reasons || []), ...(val312.errors || []), ...extraReasons].filter(Boolean);
  const isNoBleed = bleedMode === 'none' || bleedMode === 'white_border' || !diag;

  return {
    productionGeometryRevision,
    geometryValid: Boolean(val312.geometryValid),
    offsetWithinTolerance: isNoBleed ? true : Boolean(val312.offsetWithinTolerance),
    bleedStatus: isNoBleed ? 'NONE' : diag.status,
    overClassification: isNoBleed ? 'NONE' : diag.overClassification || 'NONE',
    metrics: isNoBleed
      ? null
      : {
          minDistMm: diag.minDistMm,
          avgDistMm: diag.avgDistMm,
          maxDistMm: diag.maxDistMm,
          maxUnderMm: diag.maxUnderMm,
          maxOverMm: diag.maxOverMm,
          maxOverRunMm: diag.maxOverRunMm ?? 0,
          maxOverRunPercent: diag.maxOverRunPercent ?? 0,
          overRegionCount: diag.overRegionCount ?? 0,
        },
    reasons,
  };
}

/**
 * Derive Layer 2 ProductionGeometryCacheV1 + GeometryValidation in target-mm space.
 */
export async function deriveProductionGeometry(params = {}) {
  const {
    jobId = null,
    canonicalCut,
    targetSizeMm,
    bleedConfig,
    lockAspectRatio = true,
    existingProductionGeometry = null,
    existingGeometryValidation = null,
    deps = {},
  } = params;

  const precisionBleedFn = typeof deps.precisionBleedFn === 'function' ? deps.precisionBleedFn : precisionBleedFromCut;
  const fallbackBleedFn = typeof deps.fallbackBleedFn === 'function' ? deps.fallbackBleedFn : offsetPolygonAndFitBezierMm;
  const validateFn = typeof deps.validateFn === 'function' ? deps.validateFn : validateContoursGeometry;
  const hashTextFn = typeof deps.hashTextFn === 'function' ? deps.hashTextFn : defaultSha256Text;

  const prevRev = existingProductionGeometry?.productionGeometryRevision ?? 0;

  // 1. Validate inputs fail-fast
  let validCut;
  let validBleedCfg;
  try {
    validCut = validateCanonicalCutV1(canonicalCut);
    validBleedCfg = validateBleedConfigV1(bleedConfig);
    if (
      !targetSizeMm ||
      !Number.isFinite(targetSizeMm.w) ||
      targetSizeMm.w <= 0 ||
      !Number.isFinite(targetSizeMm.h) ||
      targetSizeMm.h <= 0
    ) {
      throw new RangeError(`targetSizeMm không hợp lệ (${targetSizeMm?.w}x${targetSizeMm?.h})`);
    }
    if (typeof lockAspectRatio !== 'boolean') {
      throw new TypeError('lockAspectRatio must be a boolean');
    }
  } catch (err) {
    throw new ProductionGeometryError({
      code: 'INVALID_INPUT',
      message: err?.message || String(err),
      jobId,
      productionGeometryRevision: prevRev,
      cause: err,
    });
  }

  // 2. Compute scale & enforce Aspect Ratio Policy
  const scaleX = targetSizeMm.w / validCut.naturalTrimMm.w;
  const scaleY = targetSizeMm.h / validCut.naturalTrimMm.h;
  const relDiff = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  const nonUniformScale = relDiff > ASPECT_RATIO_EPSILON;

  if (lockAspectRatio && nonUniformScale) {
    throw new ProductionGeometryError({
      code: 'ASPECT_RATIO_MISMATCH',
      message: `Tỷ lệ targetSizeMm (${targetSizeMm.w}×${targetSizeMm.h} mm) không khớp naturalTrimMm (${r3(validCut.naturalTrimMm.w)}×${r3(validCut.naturalTrimMm.h)} mm) khi lockAspectRatio=true (scaleX=${r3(scaleX)}, scaleY=${r3(scaleY)})`,
      jobId,
      productionGeometryRevision: prevRev,
    });
  }

  const warnings = nonUniformScale ? ['NON_UNIFORM_SCALE'] : [];

  // 3. Deterministic hash & Cache Hit check
  const productionGeoHash = await computeProductionGeoHash(
    {
      canonicalCut: validCut,
      targetSizeMm,
      bleedConfig: validBleedCfg,
      lockAspectRatio,
    },
    hashTextFn
  );

  if (
    existingProductionGeometry &&
    existingProductionGeometry.productionGeoHash === productionGeoHash
  ) {
    return {
      cacheHit: true,
      nonUniformScale,
      warnings,
      productionGeometry: existingProductionGeometry,
      geometryValidation: existingGeometryValidation,
    };
  }

  // 4. Scale Canonical CUT -> cutTargetMm (pure algebraic scaling, never mutates canonicalCut)
  const nextRev = nextProductionGeometryRevision(prevRev);
  let cutTargetMm;
  try {
    cutTargetMm = scaleContourMm(validCut.cutNaturalMm, scaleX, scaleY);
    const scaledBounds = contourBoundsMm(cutTargetMm);
    if (
      !scaledBounds.valid ||
      Math.abs(scaledBounds.width - targetSizeMm.w) > BOUNDS_POSTCONDITION_EPS_MM ||
      Math.abs(scaledBounds.height - targetSizeMm.h) > BOUNDS_POSTCONDITION_EPS_MM
    ) {
      throw new Error(
        `Bounds post-condition failed: got ${r3(scaledBounds.width)}×${r3(scaledBounds.height)} mm, expected ${r3(targetSizeMm.w)}×${r3(targetSizeMm.h)} mm`
      );
    }
  } catch (err) {
    throw new ProductionGeometryError({
      code: 'PRODUCTION_GEOMETRY_ERROR',
      message: `Lỗi biến đổi CUT sang target-mm: ${err?.message || String(err)}`,
      jobId,
      productionGeometryRevision: nextRev,
      cause: err,
    });
  }

  // 5. Derive Production BLEED in target-mm space according to bleedMode
  let bleedTargetMm = null;
  let bleedTier = 0;
  let effectiveWhiteBorderMm = null;
  let val312 = null;
  const extraReasons = [];

  const padBoxW = targetSizeMm.w + Math.max(4, validBleedCfg.bleedOffsetMm * 2 + 4);
  const padBoxH = targetSizeMm.h + Math.max(4, validBleedCfg.bleedOffsetMm * 2 + 4);
  const valOpts = {
    targetBleedMm:
      validBleedCfg.bleedMode === 'precision' && validBleedCfg.bleedOffsetMm > 0.05
        ? validBleedCfg.bleedOffsetMm
        : null,
    offsetToleranceUnderMm: validBleedCfg.offsetToleranceUnderMm,
    offsetToleranceOverMm: validBleedCfg.offsetToleranceOverMm,
  };

  if (validBleedCfg.bleedMode === 'none') {
    bleedTargetMm = null;
    bleedTier = 0;
    val312 = validateFn([cutTargetMm], [], padBoxW, padBoxH, valOpts);
  } else if (validBleedCfg.bleedMode === 'white_border') {
    bleedTargetMm = null;
    bleedTier = 0;
    if (validCut.naturalWhiteBorderMm !== null && validCut.naturalWhiteBorderMm !== undefined) {
      effectiveWhiteBorderMm = r3(validCut.naturalWhiteBorderMm * Math.min(scaleX, scaleY));
    }
    val312 = validateFn([cutTargetMm], [], padBoxW, padBoxH, valOpts);
  } else if (validBleedCfg.bleedMode === 'precision') {
    if (validBleedCfg.bleedOffsetMm <= 0.05) {
      bleedTargetMm = null;
      bleedTier = 0;
      val312 = validateFn([cutTargetMm], [], padBoxW, padBoxH, valOpts);
    } else {
      // Orchestrate LOCKED 3.1.2 Tier 1 -> Tier 2 -> Tier 3 failure directly on cutTargetMm
      let tier1Err = null;
      let accepted = null;

      try {
        const cand1 = precisionBleedFn(cutTargetMm, validBleedCfg.bleedOffsetMm, {});
        if (cand1) {
          cand1.fallbackTier = 1;
          cand1.fallbackMethod = 'precision';
        }
        const v1 = validateFn([cutTargetMm], [cand1], padBoxW, padBoxH, valOpts);
        if (v1.geometryValid) {
          accepted = cand1;
          bleedTier = 1;
          val312 = v1;
        } else {
          tier1Err = `Tier 1 không đạt hình học: ${(v1.errors || []).join('; ')}`;
        }
      } catch (err1) {
        tier1Err = `Tier 1 lỗi: ${err1?.message || String(err1)}`;
      }

      if (!accepted) {
        let tier2Err = null;
        try {
          const cand2 = fallbackBleedFn(cutTargetMm, validBleedCfg.bleedOffsetMm, {});
          if (cand2) {
            cand2.fallbackTier = 2;
            cand2.fallbackMethod = 'polygon-offset-fallback';
          }
          const v2 = validateFn([cutTargetMm], [cand2], padBoxW, padBoxH, valOpts);
          if (v2.geometryValid) {
            accepted = cand2;
            bleedTier = 2;
            val312 = v2;
            extraReasons.push(tier1Err);
          } else {
            tier2Err = `Tier 2 không đạt hình học: ${(v2.errors || []).join('; ')}`;
          }
        } catch (err2) {
          tier2Err = `Tier 2 lỗi: ${err2?.message || String(err2)}`;
        }

        if (!accepted) {
          throw new ProductionGeometryError({
            code: 'BLEED_GENERATION_FAILED',
            message: `Không thể tạo Production BLEED (${validBleedCfg.bleedOffsetMm}mm): ${tier1Err} | ${tier2Err}`,
            jobId,
            productionGeometryRevision: nextRev,
          });
        }
      }

      bleedTargetMm = accepted;
    }
  }

  const productionGeometry = validateProductionGeometryCacheV1({
    productionGeoHash,
    productionGeometryRevision: nextRev,
    targetSizeMm: { w: targetSizeMm.w, h: targetSizeMm.h },
    scaleX,
    scaleY,
    cutTargetMm,
    bleedTargetMm,
    bleedTier,
    effectiveWhiteBorderMm,
  });

  const geometryValidation = buildGeometryValidationFrom312(
    val312,
    nextRev,
    validBleedCfg.bleedMode,
    extraReasons
  );

  assertNoBinaryInState(productionGeometry, 'productionGeometry');
  assertNoBinaryInState(geometryValidation, 'geometryValidation');

  return {
    cacheHit: false,
    nonUniformScale,
    warnings,
    productionGeometry,
    geometryValidation,
  };
}
