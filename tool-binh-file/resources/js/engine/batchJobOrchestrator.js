/**
 * PrintKit Architecture V1 — Batch Job Orchestrator (Checkpoint E)
 *
 * Pure state-machine & bounded-concurrency orchestration over:
 *   ResourceStore (B) -> AssetAnalyzer (C) -> CutlineV1Adapter (C) -> ProductionGeometry (D)
 *
 * Rules:
 *  - ZERO reimplementation of image analysis, Smart Grouping, CUT, BLEED, or geometry validation.
 *  - Bounded concurrency (strictly 1 or 2 in V1; fail-fast on invalid concurrency).
 *  - Cooperative cancellation via AbortSignal (no new jobs started; completed jobs intact; status = 'CANCELLED').
 *  - Per-asset / per-page / per-job failure isolation (one failure never aborts the batch).
 *  - Deterministic spatial-region identity reconciliation on multi-sticker page rerun (NEVER pure array index).
 *  - Resource ownership: SourceAsset owns source resourceId; StickerJob references resourceId without double-retaining.
 *  - Zero binary/Canvas/DOM leakage in BatchResult (verified via assertNoBinaryInState).
 */

import {
  createEntityId,
  createCutConfigV1,
  createBleedConfigV1,
  createSourceAssetV1,
  createStickerJobV1,
  createInitialJobValidationV1,
  validateStickerJobV1,
  updateStickerJobOrder,
  nextCutRevision,
  nextJobRevision,
  assertUniqueJobIds,
  assertNoBinaryInState,
} from './v1Schema.js';
import { analyzePage } from './assetAnalyzer.js';
import { extractCanonicalCutsForPage } from './cutlineV1Adapter.js';
import { deriveProductionGeometry } from './productionGeometry.js';

export const ORCHESTRATOR_STAGES = Object.freeze([
  'INGESTED',
  'ANALYZED',
  'WAITING_EXTRACTION',
  'WAITING_REVIEW',
  'CUTLINE',
  'PRODUCTION_GEOMETRY',
  'READY',
  'WARNING',
  'BLOCKED',
  'FAILED',
]);

function r2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function createDefaultOrder(naturalTrimMm, overrides = {}) {
  return {
    targetSizeMm: overrides.targetSizeMm
      ? { w: overrides.targetSizeMm.w, h: overrides.targetSizeMm.h }
      : { w: naturalTrimMm.w, h: naturalTrimMm.h },
    lockAspectRatio: overrides.lockAspectRatio ?? true,
    quantity: overrides.quantity ?? 1,
    allowRotate: overrides.allowRotate ?? true,
    included: overrides.included ?? true,
  };
}

function makeFailureRecord({ assetId = null, pageIndex = 1, extractionId = null, jobId = null, stage, code, message }) {
  return Object.freeze({
    assetId,
    pageIndex,
    extractionId,
    jobId,
    stage,
    code,
    message: String(message || 'Unknown error'),
  });
}

function computeRegionIoU(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Deterministic spatial identity reconciliation for multi-sticker page reruns.
 * Matches new candidates to existing jobs by sourceRegionMm IoU (NEVER by array index!).
 * Ambiguous matches are explicitly flagged instead of guessing a wrong jobId.
 */
export function reconcilePageStickers(existingPageJobs, newCandidates) {
  if (!existingPageJobs || existingPageJobs.length === 0) {
    return {
      matched: newCandidates.map((cand) => ({ existingJob: null, candidate: cand, iou: 0 })),
      ambiguous: [],
      removedJobIds: [],
    };
  }

  const usedExisting = new Set();
  const matched = [];
  const ambiguous = [];

  for (const cand of newCandidates) {
    const scored = [];
    for (const oldJob of existingPageJobs) {
      if (usedExisting.has(oldJob.jobId)) continue;
      const iou = computeRegionIoU(oldJob.origin.sourceRegionMm, cand.origin.sourceRegionMm);
      scored.push({ oldJob, iou });
    }
    scored.sort((a, b) => b.iou - a.iou);

    const best = scored[0];
    const second = scored[1];
    if (best && best.iou >= 0.55) {
      if (second && second.iou >= 0.55 && best.iou - second.iou < 0.1) {
        ambiguous.push({
          candidate: cand,
          competingJobIds: [best.oldJob.jobId, second.oldJob.jobId],
          scores: [r2(best.iou), r2(second.iou)],
        });
      } else {
        usedExisting.add(best.oldJob.jobId);
        matched.push({ existingJob: best.oldJob, candidate: cand, iou: best.iou });
      }
    } else {
      matched.push({ existingJob: null, candidate: cand, iou: 0 });
    }
  }

  const removedJobIds = existingPageJobs.filter((j) => !usedExisting.has(j.jobId)).map((j) => j.jobId);
  return { matched, ambiguous, removedJobIds };
}

function evaluateReadinessValidation({
  jobRevision,
  geometryValidation,
  pixelSize,
  naturalSizeMm,
  sourceRegionMm,
  targetSizeMm,
  scaleX,
  scaleY,
  nonUniformScale,
  extraWarnings = [],
}) {
  // Estimate pixel coverage of this sticker's source region on the source page
  const pxPerMmX = pixelSize.w / Math.max(0.01, naturalSizeMm.w);
  const pxPerMmY = pixelSize.h / Math.max(0.01, naturalSizeMm.h);
  const stickerPxW = sourceRegionMm.w * pxPerMmX;
  const stickerPxH = sourceRegionMm.h * pxPerMmY;
  const effectiveDpi = r2(Math.min(stickerPxW / (targetSizeMm.w / 25.4), stickerPxH / (targetSizeMm.h / 25.4)));
  const dpiStatus = effectiveDpi >= 250 ? 'OK' : effectiveDpi >= 150 ? 'WARNING' : 'FAIL';

  const reasons = [...(geometryValidation.reasons || []), ...extraWarnings];
  if (dpiStatus === 'WARNING') reasons.push(`DPI thực tế trung bình (${effectiveDpi} DPI < 250 DPI)`);
  if (dpiStatus === 'FAIL') reasons.push(`DPI thực tế quá thấp (${effectiveDpi} DPI < 150 DPI)`);

  let status = 'READY';
  let productionReady = true;

  if (!geometryValidation.geometryValid || !geometryValidation.offsetWithinTolerance) {
    status = 'BLOCKED';
    productionReady = false;
  } else if (dpiStatus === 'FAIL') {
    status = 'WARNING';
    productionReady = false;
  } else if (geometryValidation.bleedStatus === 'WARNING' || dpiStatus === 'WARNING' || nonUniformScale) {
    status = 'WARNING';
    productionReady = true;
  }

  return {
    evaluatedJobRevision: jobRevision,
    effectiveDpi,
    dpiStatus,
    nonUniformScale: Boolean(nonUniformScale),
    status,
    productionReady,
    reasons,
  };
}

/**
 * Bounded concurrency worker pool (strictly 1 or 2 workers in V1) with cooperative AbortSignal.
 */
async function runBoundedQueue(items, concurrency, signal, workerFn) {
  let cursor = 0;
  let cancelled = false;

  async function worker() {
    while (true) {
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      const idx = cursor++;
      if (idx >= items.length) return;
      await workerFn(items[idx], idx);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const runners = [];
  for (let w = 0; w < workerCount; w++) runners.push(worker());
  await Promise.all(runners);
  return { cancelled: cancelled || Boolean(signal?.aborted) };
}

/**
 * Create a Batch Job Orchestrator instance (Architecture V1).
 */
export function createBatchJobOrchestrator(options = {}) {
  const {
    resourceStore,
    concurrency = 2,
    defaultCutConfig = {},
    defaultBleedConfig = {},
    deps = {},
  } = options;

  if (!resourceStore || typeof resourceStore.acquire !== 'function' || typeof resourceStore.release !== 'function') {
    throw new TypeError('createBatchJobOrchestrator: a valid resourceStore is required');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new RangeError(`createBatchJobOrchestrator: concurrency must be 1 or 2 in V1 (got ${concurrency})`);
  }

  const baseCutConfig = createCutConfigV1(defaultCutConfig);
  const baseBleedConfig = createBleedConfigV1(defaultBleedConfig);

  const analyzePageFn = typeof deps.analyzePageFn === 'function' ? deps.analyzePageFn : analyzePage;
  const extractCanonicalFn = typeof deps.extractCanonicalFn === 'function' ? deps.extractCanonicalFn : extractCanonicalCutsForPage;
  const deriveProductionFn = typeof deps.deriveProductionFn === 'function' ? deps.deriveProductionFn : deriveProductionGeometry;

  /** @type {Map<string, object>} assetId -> SourceAssetV1 */
  const assets = new Map();
  /** @type {Map<string, object>} jobId -> StickerJobV1 */
  const jobs = new Map();
  /** @type {string[]} ordered jobIds for stable display order (NOT relational identity) */
  const jobOrder = [];
  /** @type {Array<object>} */
  let waitingReview = [];
  /** @type {Array<object>} */
  let waitingExtraction = [];
  /** @type {Array<object>} */
  let failures = [];

  function buildStats() {
    let ready = 0, warning = 0, blocked = 0;
    for (const j of jobs.values()) {
      const st = j.validation.readinessValidation.status;
      if (st === 'READY') ready++;
      else if (st === 'WARNING') warning++;
      else blocked++;
    }
    let totalPages = 0;
    for (const a of assets.values()) totalPages += a.pageCount;
    return {
      sourceAssets: assets.size,
      pages: totalPages,
      jobs: jobs.size,
      ready,
      warning,
      blocked,
      failed: failures.length,
      waitingReview: waitingReview.length,
      waitingExtraction: waitingExtraction.length,
    };
  }

  function snapshotJobs() {
    const out = jobOrder.map((id) => jobs.get(id)).filter(Boolean);
    assertUniqueJobIds(out);
    return out;
  }

  function upsertJob(job) {
    validateStickerJobV1(job);
    if (!jobs.has(job.jobId)) jobOrder.push(job.jobId);
    jobs.set(job.jobId, job);
  }

  /**
   * Run a full batch from raw source inputs:
   *   input item = {
   *     assetId?, fileName, sourceType, binaryInput (Blob/File/Uint8Array/ArrayBuffer), mimeType?,
   *     pages: [{ pageIndex, pixelSize, naturalSizeMm, imageData?, isCorrupt?, hints?, imagePlacementsMm?, renderToTempCanvas }]
   *   }
   */
  async function runBatch(sourceInputs, runOptions = {}) {
    const { signal = null, onProgress = null } = runOptions;
    if (!Array.isArray(sourceInputs)) {
      throw new TypeError('runBatch: sourceInputs must be an array');
    }

    const batchId = createEntityId('BATCH');
    const pageWorkItems = [];

    // 1. Ingest assets into ResourceStore (SourceAsset owns its source resourceId)
    for (const src of sourceInputs) {
      if (signal?.aborted) break;
      try {
        const meta = await resourceStore.acquire(src.binaryInput, {
          kind: 'source_file',
          mimeType: src.mimeType,
          ephemeral: false,
        });
        const pages = Array.isArray(src.pages) && src.pages.length > 0 ? src.pages : [];
        const firstPage = pages[0] || { pixelSize: { w: 1, h: 1 }, naturalSizeMm: { w: 1, h: 1 } };

        // Analyze first page eagerly for asset-level summary (pure metadata; no CUT/BLEED)
        const firstAnalysis = analyzePageFn({
          assetId: src.assetId || null,
          pageIndex: firstPage.pageIndex ?? 1,
          pixelSize: firstPage.pixelSize,
          naturalSizeMm: firstPage.naturalSizeMm,
          imageData: firstPage.imageData ?? null,
          isCorrupt: Boolean(src.isCorrupt || firstPage.isCorrupt || pages.length === 0),
          hints: firstPage.hints || {},
        });

        const asset = createSourceAssetV1({
          assetId: src.assetId,
          fileName: src.fileName || 'unnamed',
          sourceType: src.sourceType || 'image',
          pageCount: Math.max(1, pages.length),
          resourceId: meta.resourceId,
          sourceHash: meta.sha256,
          pixelSize:
            firstPage.pixelSize?.w > 0 && firstPage.pixelSize?.h > 0
              ? firstPage.pixelSize
              : { w: 1, h: 1 },
          naturalSizeMm:
            firstPage.naturalSizeMm?.w > 0 && firstPage.naturalSizeMm?.h > 0
              ? firstPage.naturalSizeMm
              : { w: 1, h: 1 },
          analysis: firstAnalysis,
        });
        assets.set(asset.assetId, asset);

        for (let pIdx = 0; pIdx < pages.length; pIdx++) {
          pageWorkItems.push({
            asset,
            pageSpec: pages[pIdx],
            pageIndex: pages[pIdx].pageIndex ?? pIdx + 1,
            orderDefaults: src.orderDefaults || {},
            cutConfig: src.cutConfig ? createCutConfigV1({ ...baseCutConfig, ...src.cutConfig }) : baseCutConfig,
            bleedConfig: src.bleedConfig ? createBleedConfigV1({ ...baseBleedConfig, ...src.bleedConfig }) : baseBleedConfig,
          });
        }
        if (pages.length === 0) {
          failures.push(
            makeFailureRecord({
              assetId: asset.assetId,
              pageIndex: 1,
              stage: 'INGESTED',
              code: 'NO_PAGES',
              message: `Asset ${asset.fileName} không có trang nào`,
            })
          );
        }
      } catch (err) {
        failures.push(
          makeFailureRecord({
            assetId: src?.assetId ?? null,
            pageIndex: 1,
            stage: 'INGESTED',
            code: 'INGEST_ERROR',
            message: err?.message || String(err),
          })
        );
      }
    }

    const totalWork = pageWorkItems.length;
    let completedWork = 0;

    const emitProgress = () => {
      if (typeof onProgress !== 'function') return;
      const st = buildStats();
      onProgress(
        Object.freeze({
          completed: Math.min(completedWork, totalWork),
          total: totalWork,
          ready: st.ready,
          warning: st.warning,
          blocked: st.blocked,
          failed: st.failed,
          waitingReview: st.waitingReview,
          waitingExtraction: st.waitingExtraction,
        })
      );
    };

    emitProgress();

    // 2. Bounded-concurrency page processing (strictly concurrency 1 or 2)
    const { cancelled } = await runBoundedQueue(pageWorkItems, concurrency, signal, async (work) => {
      const { asset, pageSpec, pageIndex, orderDefaults, cutConfig, bleedConfig } = work;
      try {
        // 2a. Analyze page
        const analysis = analyzePageFn({
          assetId: asset.assetId,
          pageIndex,
          pixelSize: pageSpec.pixelSize,
          naturalSizeMm: pageSpec.naturalSizeMm,
          imageData: pageSpec.imageData ?? null,
          isCorrupt: Boolean(pageSpec.isCorrupt),
          hints: pageSpec.hints || {},
        });

        // 2b. Route according to Analyzer contract (never runs Cutline on MOCKUP / INVALID / low confidence)
        if (analysis.recommendedAction === 'BLOCK') {
          failures.push(
            makeFailureRecord({
              assetId: asset.assetId,
              pageIndex,
              stage: 'ANALYZED',
              code: 'INVALID_ASSET',
              message: analysis.reasons.join('; ') || 'Asset không hợp lệ',
            })
          );
          return;
        }
        if (analysis.recommendedAction === 'NEED_EXTRACTION') {
          waitingExtraction.push(
            Object.freeze({
              assetId: asset.assetId,
              pageIndex,
              stage: 'WAITING_EXTRACTION',
              classification: analysis.classification,
              confidence: analysis.confidence,
              reasons: [...analysis.reasons],
            })
          );
          return;
        }
        if (analysis.recommendedAction === 'NEED_REVIEW') {
          waitingReview.push(
            Object.freeze({
              assetId: asset.assetId,
              pageIndex,
              stage: 'WAITING_REVIEW',
              classification: analysis.classification,
              confidence: analysis.confidence,
              estimatedDpi: analysis.estimatedDpi,
              reasons: [...analysis.reasons],
            })
          );
          return;
        }

        // 2c. DIRECT_CUTLINE -> Layer 1 Canonical CUT via CutlineV1Adapter (inside temp canvas lifecycle if provided)
        let cutResult;
        try {
          if (typeof pageSpec.withRenderedElement === 'function') {
            cutResult = await pageSpec.withRenderedElement(async (imgElement) =>
              extractCanonicalFn({
                assetId: asset.assetId,
                pageIndex,
                extractionId: pageSpec.extractionId ?? null,
                artworkResourceId: asset.resourceId,
                artworkContentHash: asset.sourceHash,
                imgElement,
                totalWidthMm: pageSpec.naturalSizeMm.w,
                totalHeightMm: pageSpec.naturalSizeMm.h,
                cutConfig,
                imagePlacementsMm: pageSpec.imagePlacementsMm || [],
              })
            );
          } else {
            cutResult = await extractCanonicalFn({
              assetId: asset.assetId,
              pageIndex,
              extractionId: pageSpec.extractionId ?? null,
              artworkResourceId: asset.resourceId,
              artworkContentHash: asset.sourceHash,
              imgElement: pageSpec.imgElement,
              totalWidthMm: pageSpec.naturalSizeMm.w,
              totalHeightMm: pageSpec.naturalSizeMm.h,
              cutConfig,
              imagePlacementsMm: pageSpec.imagePlacementsMm || [],
            });
          }
        } catch (cutErr) {
          failures.push(
            makeFailureRecord({
              assetId: asset.assetId,
              pageIndex,
              extractionId: pageSpec.extractionId ?? null,
              jobId: cutErr?.jobId ?? null,
              stage: 'CUTLINE',
              code: cutErr?.code || 'CUTLINE_ERROR',
              message: cutErr?.message || String(cutErr),
            })
          );
          return;
        }

        // 2d. For each detected sticker on page -> Layer 2 Derived Production Geometry -> StickerJobV1
        for (const cand of cutResult.stickers) {
          const defaultOrder = createDefaultOrder(cand.canonicalCut.naturalTrimMm, orderDefaults);
          try {
            const prodOut = await deriveProductionFn({
              jobId: cand.jobId,
              canonicalCut: cand.canonicalCut,
              targetSizeMm: defaultOrder.targetSizeMm,
              bleedConfig,
              lockAspectRatio: defaultOrder.lockAspectRatio,
            });

            const readiness = evaluateReadinessValidation({
              jobRevision: 1,
              geometryValidation: prodOut.geometryValidation,
              pixelSize: pageSpec.pixelSize,
              naturalSizeMm: pageSpec.naturalSizeMm,
              sourceRegionMm: cand.origin.sourceRegionMm,
              targetSizeMm: defaultOrder.targetSizeMm,
              scaleX: prodOut.productionGeometry.scaleX,
              scaleY: prodOut.productionGeometry.scaleY,
              nonUniformScale: prodOut.nonUniformScale,
              extraWarnings: prodOut.warnings,
            });

            const job = createStickerJobV1({
              jobId: cand.jobId,
              jobRevision: 1,
              label:
                cutResult.stickers.length > 1
                  ? `${asset.fileName} #${cand.origin.sourceStickerIndex}`
                  : asset.fileName,
              origin: cand.origin,
              artworkRef: cand.artworkRef,
              cutConfig: cand.cutConfig,
              bleedConfig,
              canonicalCut: cand.canonicalCut,
              productionGeometry: prodOut.productionGeometry,
              order: defaultOrder,
              validation: {
                geometryValidation: prodOut.geometryValidation,
                readinessValidation: readiness,
              },
            });
            upsertJob(job);
          } catch (prodErr) {
            // Failure isolation: preserve job as BLOCKED + record structured failure, never abort remaining stickers/pages
            failures.push(
              makeFailureRecord({
                assetId: asset.assetId,
                pageIndex,
                extractionId: cand.origin.extractionId,
                jobId: cand.jobId,
                stage: 'PRODUCTION_GEOMETRY',
                code: prodErr?.code || 'PRODUCTION_GEOMETRY_ERROR',
                message: prodErr?.message || String(prodErr),
              })
            );
            const blockedJob = createStickerJobV1({
              jobId: cand.jobId,
              jobRevision: 1,
              label:
                cutResult.stickers.length > 1
                  ? `${asset.fileName} #${cand.origin.sourceStickerIndex}`
                  : asset.fileName,
              origin: cand.origin,
              artworkRef: cand.artworkRef,
              cutConfig: cand.cutConfig,
              bleedConfig,
              canonicalCut: cand.canonicalCut,
              productionGeometry: null,
              order: defaultOrder,
              validation: createInitialJobValidationV1({
                geometryValidation: {
                  productionGeometryRevision: 0,
                  geometryValid: false,
                  offsetWithinTolerance: false,
                  bleedStatus: 'FAIL',
                  overClassification: 'NONE',
                  reasons: [prodErr?.message || String(prodErr)],
                },
                readinessValidation: {
                  evaluatedJobRevision: 1,
                  effectiveDpi: 0,
                  dpiStatus: 'FAIL',
                  nonUniformScale: false,
                  status: 'BLOCKED',
                  productionReady: false,
                  reasons: [prodErr?.message || String(prodErr)],
                },
              }),
            });
            upsertJob(blockedJob);
          }
        }
      } finally {
        completedWork++;
        emitProgress();
      }
    });

    const stats = buildStats();
    const status = cancelled
      ? 'CANCELLED'
      : failures.length > 0 && jobs.size === 0
      ? 'FAILED'
      : 'COMPLETED';

    const result = {
      batchId,
      status,
      jobs: snapshotJobs(),
      waitingReview: [...waitingReview],
      waitingExtraction: [...waitingExtraction],
      failures: [...failures],
      stats,
    };

    assertNoBinaryInState(result, 'batchResult');
    return result;
  }

  /**
   * Targeted invalidation: update order (quantity / allowRotate / included / targetSizeMm / lockAspectRatio).
   *  - quantity / allowRotate / included -> 0 Cutline calls, 0 ProductionGeometry calls!
   *  - targetSizeMm / lockAspectRatio -> 0 Cutline calls, reruns ONLY ProductionGeometry for this jobId!
   */
  async function updateJobOrderById(jobId, orderPatch) {
    const existing = jobs.get(jobId);
    if (!existing) throw new ReferenceError(`BatchOrchestrator: unknown jobId "${jobId}"`);

    const nextOrder = { ...existing.order, ...orderPatch };
    const sizeOrLockChanged =
      nextOrder.targetSizeMm?.w !== existing.order.targetSizeMm.w ||
      nextOrder.targetSizeMm?.h !== existing.order.targetSizeMm.h ||
      nextOrder.lockAspectRatio !== existing.order.lockAspectRatio;

    if (!sizeOrLockChanged) {
      const updated = updateStickerJobOrder(existing, orderPatch);
      upsertJob(updated);
      return { job: updated, recomputed: 'NONE' };
    }

    // Reuse CanonicalCutV1 (0 Cutline calls!) -> recompute ONLY ProductionGeometry for this jobId
    const asset = assets.get(existing.origin.sourceAssetId);
    const prodOut = await deriveProductionFn({
      jobId: existing.jobId,
      canonicalCut: existing.canonicalCut,
      targetSizeMm: nextOrder.targetSizeMm,
      bleedConfig: existing.bleedConfig,
      lockAspectRatio: nextOrder.lockAspectRatio,
      existingProductionGeometry: existing.productionGeometry,
      existingGeometryValidation: existing.validation.geometryValidation,
    });

    const nextRev = prodOut.cacheHit ? existing.jobRevision : nextJobRevision(existing.jobRevision);
    const readiness = evaluateReadinessValidation({
      jobRevision: nextRev,
      geometryValidation: prodOut.geometryValidation,
      pixelSize: asset.pixelSize,
      naturalSizeMm: asset.naturalSizeMm,
      sourceRegionMm: existing.origin.sourceRegionMm,
      targetSizeMm: nextOrder.targetSizeMm,
      scaleX: prodOut.productionGeometry.scaleX,
      scaleY: prodOut.productionGeometry.scaleY,
      nonUniformScale: prodOut.nonUniformScale,
      extraWarnings: prodOut.warnings,
    });

    const updated = createStickerJobV1({
      ...existing,
      jobRevision: nextRev,
      order: nextOrder,
      productionGeometry: prodOut.productionGeometry,
      validation: {
        geometryValidation: prodOut.geometryValidation,
        readinessValidation: readiness,
      },
    });
    upsertJob(updated);
    return { job: updated, recomputed: prodOut.cacheHit ? 'NONE' : 'PRODUCTION_GEOMETRY' };
  }

  /**
   * Targeted invalidation: update bleedConfig for a single jobId.
   * Reuses CanonicalCutV1 (0 Cutline calls!), recomputes ONLY ProductionGeometry for this jobId.
   */
  async function updateJobBleedConfigById(jobId, bleedPatch) {
    const existing = jobs.get(jobId);
    if (!existing) throw new ReferenceError(`BatchOrchestrator: unknown jobId "${jobId}"`);

    const nextBleedConfig = createBleedConfigV1({ ...existing.bleedConfig, ...bleedPatch });
    const asset = assets.get(existing.origin.sourceAssetId);
    const prodOut = await deriveProductionFn({
      jobId: existing.jobId,
      canonicalCut: existing.canonicalCut,
      targetSizeMm: existing.order.targetSizeMm,
      bleedConfig: nextBleedConfig,
      lockAspectRatio: existing.order.lockAspectRatio,
      existingProductionGeometry: existing.productionGeometry,
      existingGeometryValidation: existing.validation.geometryValidation,
    });

    const nextRev = prodOut.cacheHit ? existing.jobRevision : nextJobRevision(existing.jobRevision);
    const readiness = evaluateReadinessValidation({
      jobRevision: nextRev,
      geometryValidation: prodOut.geometryValidation,
      pixelSize: asset.pixelSize,
      naturalSizeMm: asset.naturalSizeMm,
      sourceRegionMm: existing.origin.sourceRegionMm,
      targetSizeMm: existing.order.targetSizeMm,
      scaleX: prodOut.productionGeometry.scaleX,
      scaleY: prodOut.productionGeometry.scaleY,
      nonUniformScale: prodOut.nonUniformScale,
      extraWarnings: prodOut.warnings,
    });

    const updated = createStickerJobV1({
      ...existing,
      jobRevision: nextRev,
      bleedConfig: nextBleedConfig,
      productionGeometry: prodOut.productionGeometry,
      validation: {
        geometryValidation: prodOut.geometryValidation,
        readinessValidation: readiness,
      },
    });
    upsertJob(updated);
    return { job: updated, recomputed: prodOut.cacheHit ? 'NONE' : 'PRODUCTION_GEOMETRY' };
  }

  /**
   * Targeted invalidation: update cutConfig for a job's source page.
   * Explicitly declares CUTLINE_SCOPE_PAGE when the page has >1 stickers, reruns ONLY that page
   * (leaving all other assets/jobs untouched), and reconciles identities via spatial IoU (NOT array index!).
   */
  async function updateJobCutConfigById(jobId, cutPatch, { imgElement, imagePlacementsMm = [] }) {
    const targetJob = jobs.get(jobId);
    if (!targetJob) throw new ReferenceError(`BatchOrchestrator: unknown jobId "${jobId}"`);

    const asset = assets.get(targetJob.origin.sourceAssetId);
    const pageIndex = targetJob.origin.pageIndex;
    const extractionId = targetJob.origin.extractionId;
    const nextCutConfig = createCutConfigV1({ ...targetJob.cutConfig, ...cutPatch });

    const pageJobs = snapshotJobs().filter(
      (j) =>
        j.origin.sourceAssetId === asset.assetId &&
        j.origin.pageIndex === pageIndex &&
        j.origin.extractionId === extractionId
    );
    const scope = pageJobs.length > 1 ? 'CUTLINE_SCOPE_PAGE' : 'CUTLINE_SCOPE_JOB';

    const cutResult = await extractCanonicalFn({
      assetId: asset.assetId,
      pageIndex,
      extractionId,
      artworkResourceId: asset.resourceId,
      artworkContentHash: asset.sourceHash,
      imgElement,
      totalWidthMm: asset.naturalSizeMm.w,
      totalHeightMm: asset.naturalSizeMm.h,
      cutConfig: nextCutConfig,
      imagePlacementsMm,
    });

    const { matched, ambiguous } = reconcilePageStickers(pageJobs, cutResult.stickers);
    const updatedJobs = [];

    for (const { existingJob, candidate } of matched) {
      const keepJobId = existingJob ? existingJob.jobId : candidate.jobId;
      const cutChanged = !existingJob || existingJob.canonicalCut?.cutInputHash !== candidate.canonicalCut.cutInputHash;
      const nextCutRev = existingJob
        ? cutChanged
          ? nextCutRevision(existingJob.canonicalCut?.cutRevision ?? 0)
          : existingJob.canonicalCut.cutRevision
        : 1;

      const updatedCanonical = {
        ...candidate.canonicalCut,
        cutRevision: nextCutRev,
      };
      const keepOrder = existingJob ? existingJob.order : createDefaultOrder(updatedCanonical.naturalTrimMm);
      const keepBleed = existingJob ? existingJob.bleedConfig : baseBleedConfig;

      const prodOut = await deriveProductionFn({
        jobId: keepJobId,
        canonicalCut: updatedCanonical,
        targetSizeMm: keepOrder.targetSizeMm,
        bleedConfig: keepBleed,
        lockAspectRatio: keepOrder.lockAspectRatio,
        existingProductionGeometry: existingJob?.productionGeometry ?? null,
        existingGeometryValidation: existingJob?.validation?.geometryValidation ?? null,
      });

      const nextRev = existingJob
        ? prodOut.cacheHit && !cutChanged
          ? existingJob.jobRevision
          : nextJobRevision(existingJob.jobRevision)
        : 1;

      const readiness = evaluateReadinessValidation({
        jobRevision: nextRev,
        geometryValidation: prodOut.geometryValidation,
        pixelSize: asset.pixelSize,
        naturalSizeMm: asset.naturalSizeMm,
        sourceRegionMm: candidate.origin.sourceRegionMm,
        targetSizeMm: keepOrder.targetSizeMm,
        scaleX: prodOut.productionGeometry.scaleX,
        scaleY: prodOut.productionGeometry.scaleY,
        nonUniformScale: prodOut.nonUniformScale,
        extraWarnings: prodOut.warnings,
      });

      const job = createStickerJobV1({
        jobId: keepJobId,
        jobRevision: nextRev,
        label: existingJob ? existingJob.label : `${asset.fileName} #${candidate.origin.sourceStickerIndex}`,
        origin: candidate.origin,
        artworkRef: candidate.artworkRef,
        cutConfig: nextCutConfig,
        bleedConfig: keepBleed,
        canonicalCut: updatedCanonical,
        productionGeometry: prodOut.productionGeometry,
        order: keepOrder,
        validation: {
          geometryValidation: prodOut.geometryValidation,
          readinessValidation: readiness,
        },
      });
      upsertJob(job);
      updatedJobs.push(job);
    }

    for (const amb of ambiguous) {
      waitingReview.push(
        Object.freeze({
          assetId: asset.assetId,
          pageIndex,
          stage: 'WAITING_REVIEW',
          code: 'RECONCILIATION_AMBIGUOUS',
          competingJobIds: amb.competingJobIds,
          reasons: [`Không thể khớp định danh an toàn khi chạy lại trang #${pageIndex}`],
        })
      );
    }

    return {
      dependencyScope: scope,
      updatedJobs,
      ambiguousCount: ambiguous.length,
    };
  }

  /**
   * Remove an asset and all jobs derived from it, releasing ONLY its owned source resourceId.
   */
  function removeAsset(assetId) {
    const asset = assets.get(assetId);
    if (!asset) throw new ReferenceError(`BatchOrchestrator.removeAsset: unknown assetId "${assetId}"`);
    assets.delete(assetId);
    for (const [jId, job] of Array.from(jobs.entries())) {
      if (job.origin.sourceAssetId === assetId) {
        jobs.delete(jId);
        const pos = jobOrder.indexOf(jId);
        if (pos >= 0) jobOrder.splice(pos, 1);
      }
    }
    resourceStore.release(asset.resourceId);
  }

  return Object.freeze({
    runBatch,
    updateJobOrderById,
    updateJobBleedConfigById,
    updateJobCutConfigById,
    removeAsset,
    getJobs: snapshotJobs,
    getJob: (jobId) => jobs.get(jobId) || null,
    getAsset: (assetId) => assets.get(assetId) || null,
    getStats: buildStats,
  });
}
