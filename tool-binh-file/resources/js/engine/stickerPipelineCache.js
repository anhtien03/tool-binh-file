/**
 * PrintKit V1 — Versioned Canonical Sticker Pipeline Cache
 *
 * Strictly separates immutable geometry from per-job metadata (Condition 3 & 4):
 *  - Geometry key = exact SHA-256 of local-origin CanonicalCutV1.beziersMm + naturalTrimMm + winding.
 *  - ProductionGeometryCacheV1 is keyed by LOCKED productionGeometry.js's exact `productionGeoHash`
 *    (which hashes cutInputHash, cutRevision, targetSizeMm, bleedConfig, lockAspectRatio, versions —
 *    and NEVER hashes jobId, quantity, sheet size, margins, gap, or placement).
 *  - Each StickerInstance retains its own unique jobId, sourceAssetId, artworkRef.resourceId, and cropBoxMm.
 *  - Tracks exact measured telemetry: bleedEngineCalls, geoCacheHits, geoCacheMisses, layoutComputations.
 */

import { canonicalStringify } from './v1Schema.js';
import { precisionBleedFromCut } from './bleedContourEngine.js';
import { computeProductionGeoHash, deriveProductionGeometry } from './productionGeometry.js';

export const STICKER_PIPELINE_CACHE_VERSION = '1.0';

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('stickerPipelineCache: crypto.subtle.digest is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute exact IEEE-754 geometryKey for a local-origin contour (NEVER quantizes or alters CUT!).
 */
export async function computeExactGeometryKey(localCut, naturalTrimMm, winding = 'CW', hashTextFn = defaultSha256Text) {
  const payload = canonicalStringify({
    v: STICKER_PIPELINE_CACHE_VERSION,
    naturalTrimMm: { w: naturalTrimMm.w, h: naturalTrimMm.h },
    winding,
    closed: localCut?.closed !== false,
    beziersMm: Array.isArray(localCut?.beziersMm) ? localCut.beziersMm : localCut,
  });
  return await hashTextFn(payload);
}

/**
 * Create a versioned, inspectable session cache for the Single Sticker Pipeline V1.
 */
export function createStickerPipelineCache({ hashTextFn = defaultSha256Text } = {}) {
  const prodGeoByHash = new Map(); // productionGeoHash -> { productionGeometry, geometryValidation, geometryKey }
  const jobSetBySourceKey = new Map(); // sourceBatchKey -> { jobs, assets, resourceStore, createdAt }
  const batchPlanByLayoutKey = new Map(); // layoutKey -> { batchVersion, planState }

  const stats = {
    version: STICKER_PIPELINE_CACHE_VERSION,
    geometryVersion: 1,
    layoutVersion: 1,
    bleedEngineCalls: 0,
    geoCacheHits: 0,
    geoCacheMisses: 0,
    jobSetHits: 0,
    jobSetMisses: 0,
    layoutComputations: 0,
    layoutCacheHits: 0,
    distinctGeometryKeys: new Set(),
    lastLayoutMs: 0,
  };

  /**
   * Derive or reuse ProductionGeometryCacheV1 strictly through LOCKED deriveProductionGeometry.
   * Wraps precisionBleedFromCut via deps.precisionBleedFn to measure EXACT engine call count.
   */
  async function getOrDeriveProductionGeometry({
    jobId,
    canonicalCut,
    targetSizeMm,
    bleedConfig,
    lockAspectRatio = true,
  }) {
    stats.distinctGeometryKeys.add(canonicalCut.cutInputHash);
    const geoHash = await computeProductionGeoHash(
      { canonicalCut, targetSizeMm, bleedConfig, lockAspectRatio },
      hashTextFn
    );

    const cached = prodGeoByHash.get(geoHash);
    if (cached) {
      stats.geoCacheHits++;
      // Delegate to LOCKED deriveProductionGeometry's native cacheHit branch for 100% contract fidelity
      return await deriveProductionGeometry({
        jobId,
        canonicalCut,
        targetSizeMm,
        bleedConfig,
        lockAspectRatio,
        existingProductionGeometry: cached.productionGeometry,
        existingGeometryValidation: cached.geometryValidation,
        deps: { hashTextFn },
      });
    }

    stats.geoCacheMisses++;
    const countedPrecisionBleed = (...args) => {
      stats.bleedEngineCalls++;
      return precisionBleedFromCut(...args);
    };

    const derived = await deriveProductionGeometry({
      jobId,
      canonicalCut,
      targetSizeMm,
      bleedConfig,
      lockAspectRatio,
      deps: {
        precisionBleedFn: countedPrecisionBleed,
        hashTextFn,
      },
    });

    prodGeoByHash.set(geoHash, {
      productionGeometry: derived.productionGeometry,
      geometryValidation: derived.geometryValidation,
      geometryKey: canonicalCut.cutInputHash,
    });
    return derived;
  }

  function getJobSet(sourceBatchKey) {
    const hit = jobSetBySourceKey.get(sourceBatchKey);
    if (hit) {
      stats.jobSetHits++;
      return hit;
    }
    stats.jobSetMisses++;
    return null;
  }

  function setJobSet(sourceBatchKey, entry) {
    jobSetBySourceKey.set(sourceBatchKey, entry);
  }

  function getBatchPlan(layoutKey) {
    const hit = batchPlanByLayoutKey.get(layoutKey);
    if (hit) {
      stats.layoutCacheHits++;
      return hit;
    }
    return null;
  }

  function setBatchPlan(layoutKey, planState) {
    stats.layoutComputations++;
    const entry = { batchVersion: ++stats.layoutVersion, planState };
    batchPlanByLayoutKey.set(layoutKey, entry);
    return entry;
  }

  function invalidateLayout() {
    batchPlanByLayoutKey.clear();
    stats.layoutVersion++;
  }

  function invalidateGeometry() {
    prodGeoByHash.clear();
    jobSetBySourceKey.clear();
    batchPlanByLayoutKey.clear();
    stats.geometryVersion++;
    stats.layoutVersion++;
  }

  function getStatsSnapshot() {
    return {
      version: stats.version,
      geometryVersion: stats.geometryVersion,
      layoutVersion: stats.layoutVersion,
      bleedEngineCalls: stats.bleedEngineCalls,
      geoCacheHits: stats.geoCacheHits,
      geoCacheMisses: stats.geoCacheMisses,
      jobSetHits: stats.jobSetHits,
      jobSetMisses: stats.jobSetMisses,
      layoutComputations: stats.layoutComputations,
      layoutCacheHits: stats.layoutCacheHits,
      distinctGeometryKeyCount: stats.distinctGeometryKeys.size,
      prodGeoCacheEntries: prodGeoByHash.size,
      lastLayoutMs: stats.lastLayoutMs,
    };
  }

  function recordLayoutDurationMs(ms) {
    stats.lastLayoutMs = Math.round(ms * 100) / 100;
  }

  return {
    getOrDeriveProductionGeometry,
    getJobSet,
    setJobSet,
    getBatchPlan,
    setBatchPlan,
    invalidateLayout,
    invalidateGeometry,
    getStatsSnapshot,
    recordLayoutDurationMs,
  };
}
