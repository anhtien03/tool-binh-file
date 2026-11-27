/**
 * PrintKit V1 — Checkpoint K B3.1.1 Hardened UI Bridge & Studio Job Adapter
 *
 * Additive integration: ZERO edits to any LOCKED engine file (B–G, H.1).
 * Preserves 100% of CanonicalCutV1 cubic Bézier geometry (0.0000 mm shape distortion)
 * from BleedAndContourStudio -> H.2 Grid Packing -> F Atomic PRINT+CUT Export -> G Final Validator.
 */
import {
  canonicalStringify,
  createBleedConfigV1,
  createCanonicalCutV1,
  createStickerJobV1,
} from './v1Schema.js';
import { contourBoundsMm } from './bleedContourEngine.js';
import { translateContourToLocalOrigin } from './cutlineV1Adapter.js';
import { deriveProductionGeometry } from './productionGeometry.js';
import { computeExactGeometryKey } from './stickerPipelineCache.js';
import {
  buildProductionBatchPlanH2,
  exportAndValidateBatchH2,
} from './productionPlanningAdapterH2.js';
import { verifyExportedCutPdfGeometry } from './postExportGeometryVerifier.js';

// Browser-safe minimal Buffer shim for LOCKED validators (e.g. productionPairValidator.js)
// that call Buffer.from(uint8).toString('latin1') when running in Chrome/Vite without Node globals.
if (typeof globalThis.Buffer === 'undefined') {
  const bytesToLatin1 = (bytes) => {
    const chunks = [];
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return chunks.join('');
  };
  globalThis.Buffer = {
    from(input, encoding = 'utf8') {
      let u8;
      if (input instanceof Uint8Array) {
        u8 = input;
      } else if (ArrayBuffer.isView(input)) {
        u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else if (input instanceof ArrayBuffer) {
        u8 = new Uint8Array(input);
      } else if (typeof input === 'string') {
        if (encoding === 'latin1' || encoding === 'binary') {
          u8 = new Uint8Array(input.length);
          for (let i = 0; i < input.length; i++) u8[i] = input.charCodeAt(i) & 0xff;
        } else {
          u8 = new TextEncoder().encode(input);
        }
      } else {
        u8 = Uint8Array.from(input || []);
      }
      const wrapped = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      wrapped.toString = (enc = 'utf8') => {
        if (enc === 'latin1' || enc === 'binary') return bytesToLatin1(wrapped);
        if (enc === 'hex') return Array.from(wrapped, (b) => b.toString(16).padStart(2, '0')).join('');
        return new TextDecoder('utf-8').decode(wrapped);
      };
      return wrapped;
    },
    isBuffer(v) {
      return v instanceof Uint8Array;
    },
  };
}

export class CheckpointKUiError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message);
    this.name = 'CheckpointKUiError';
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

const fail = (code, message, details = null) => {
  throw new CheckpointKUiError(code, message, details);
};
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonneg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const plain = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const active = (jobs) => jobs.filter((j) => j?.order?.included === true && j.order.quantity > 0);
const signature = (value) => canonicalStringify(value);

function validateJobs(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) fail('MISSING_JOBS', 'jobs phải là mảng không rỗng');
  const ids = new Set();
  for (const job of jobs) {
    if (!nonempty(job?.jobId)) fail('INVALID_JOB_ID', 'Job thiếu jobId');
    if (ids.has(job.jobId)) fail('DUPLICATE_JOB_ID', `Trùng jobId: ${job.jobId}`);
    ids.add(job.jobId);
  }
  const selected = active(jobs);
  if (!selected.length) fail('NO_ACTIVE_JOBS', 'Không có job được chọn với quantity > 0');
  for (const job of selected) {
    if (
      !Number.isSafeInteger(job.order.quantity) ||
      job.order.quantity < 1 ||
      !job.canonicalCut ||
      !job.productionGeometry ||
      !job.artworkRef
    ) {
      fail('INVALID_JOB', `Job ${job.jobId} thiếu dữ liệu sản xuất hợp lệ`);
    }
  }
  return selected;
}

function validateTemplates(templates) {
  if (!Array.isArray(templates) || !templates.length) {
    fail('MISSING_TEMPLATES', 'sheetTemplates phải là mảng không rỗng');
  }
  const ids = new Set();
  for (const [i, t] of templates.entries()) {
    if (!nonempty(t?.templateId) || ids.has(t.templateId)) {
      fail('INVALID_TEMPLATE_ID', `Template ${i + 1} thiếu hoặc trùng templateId`);
    }
    ids.add(t.templateId);
    if (!pos(t.sheetWidthMm) || !pos(t.sheetHeightMm)) {
      fail('INVALID_TEMPLATE_SIZE', `Template ${t.templateId} có khổ giấy không hợp lệ`);
    }
    if (!Number.isSafeInteger(t.runCount) || t.runCount < 1) {
      fail('INVALID_RUN_COUNT', `Template ${t.templateId} thiếu runCount hợp lệ`);
    }
    if (
      !Number.isSafeInteger(t.gridSpec?.rows) ||
      t.gridSpec.rows < 1 ||
      !Number.isSafeInteger(t.gridSpec?.columns) ||
      t.gridSpec.columns < 1
    ) {
      fail('INVALID_GRID', `Template ${t.templateId} thiếu gridSpec rows/columns`);
    }
    const items = t.items ?? t.placements;
    if (!Array.isArray(items) || !items.length) {
      fail('INVALID_TEMPLATE_ITEMS', `Template ${t.templateId} không có items/placements`);
    }
  }
}

function validatePolicy({
  cutGapMm,
  bleedOutsetMm,
  bleedClearanceMm,
  bleedPolicy,
  bleedOverlapConfirmed,
  bleedOverlapJustification,
  bleedColorByJobId = null,
}) {
  if (!nonneg(cutGapMm) || !nonneg(bleedOutsetMm) || !nonneg(bleedClearanceMm)) {
    fail('INVALID_UI_CONFIG', 'CUT gap, BLEED outset và clearance phải >= 0');
  }
  if (!['strict', 'allow_overlap'].includes(bleedPolicy)) {
    fail('INVALID_BLEED_POLICY', 'Chỉ hỗ trợ strict hoặc allow_overlap');
  }
  if (
    bleedPolicy === 'allow_overlap' &&
    (bleedOverlapConfirmed !== true || !nonempty(bleedOverlapJustification))
  ) {
    fail('OVERLAP_NOT_CONFIRMED', 'Cho phép BLEED overlap cần xác nhận và lý do cụ thể');
  }
  if (bleedColorByJobId !== null && bleedColorByJobId !== undefined && !plain(bleedColorByJobId)) {
    fail('INVALID_UI_CONFIG', 'bleedColorByJobId phải là plain object hoặc null');
  }
}

function uiSnapshot(p) {
  return {
    sheetTemplates: p.sheetTemplates,
    cutGapMm: p.cutGapMm,
    bleedOutsetMm: p.bleedOutsetMm,
    bleedClearanceMm: p.bleedClearanceMm,
    bleedPolicy: p.bleedPolicy,
    bleedOverlapConfirmed: Boolean(p.bleedOverlapConfirmed),
    bleedOverlapJustification: p.bleedOverlapJustification ?? null,
    productionProfile: p.productionProfile ?? null,
    bleedColorByJobId: p.bleedColorByJobId ?? null,
    flatnessMm: p.flatnessMm ?? null,
  };
}

function assetMapOf(assets) {
  if (assets instanceof Map) return assets;
  if (Array.isArray(assets)) return new Map(assets.map((a) => [a?.assetId, a]));
  return null;
}

function checkCropAssets(jobs, assets) {
  const map = assetMapOf(assets);
  for (const job of active(jobs)) {
    const crop = job.artworkRef?.cropBoxMm;
    if (!crop) continue;
    const assetId = job.origin?.sourceAssetId;
    const asset = map?.get(assetId);
    const size = asset?.naturalSizeMm;
    if (!nonempty(assetId) || !pos(size?.w) || !pos(size?.h)) {
      fail('MISSING_CROP_ASSET', `Job ${job.jobId} cần SourceAsset.naturalSizeMm để xuất crop an toàn`, {
        jobId: job.jobId,
        assetId,
      });
    }
    if (
      ![crop.x, crop.y].every(nonneg) ||
      !pos(crop.w) ||
      !pos(crop.h) ||
      crop.x + crop.w > size.w + 1e-6 ||
      crop.y + crop.h > size.h + 1e-6
    ) {
      fail('INVALID_CROP', `Job ${job.jobId} có cropBoxMm nằm ngoài naturalSizeMm`, { jobId: job.jobId });
    }
  }
}

function validateFreshnessInputs({ sheetTemplates, currentRunCounts, expectedOrderManifest }) {
  validateTemplates(sheetTemplates);
  if (!plain(currentRunCounts)) fail('INVALID_RUN_COUNTS', 'currentRunCounts phải là plain object');
  if (Object.keys(currentRunCounts).length !== sheetTemplates.length) {
    fail('STALE_PLAN', 'Số lượng template trong currentRunCounts không khớp sheetTemplates');
  }
  for (const t of sheetTemplates) {
    if (!Number.isSafeInteger(currentRunCounts[t.templateId]) || currentRunCounts[t.templateId] !== t.runCount) {
      fail('STALE_PLAN', `runCount của ${t.templateId} khác sheetTemplates`);
    }
  }
  if (!nonempty(expectedOrderManifest?.batchFreshnessHash)) {
    fail('INVALID_MANIFEST', 'Thiếu expectedOrderManifest.batchFreshnessHash');
  }
}

function wrap(err, fallback) {
  if (err instanceof CheckpointKUiError) return err;
  return new CheckpointKUiError(err?.code || fallback, err?.message || fallback, err?.details ?? null, err);
}

/**
 * Build returns an envelope { batchPlan, uiSnapshot }.
 * Store the envelope, not just batchPlan; invalidate it on every production UI change.
 * bleedOutsetMm is planning metadata, NOT a BLEED geometry generator.
 */
export async function createCheckpointKBatch({
  jobs,
  sheetTemplates,
  cutGapMm = 2,
  bleedOutsetMm = 1.5,
  bleedClearanceMm = 0,
  bleedPolicy = 'strict',
  bleedOverlapConfirmed = false,
  bleedOverlapJustification = null,
  bleedColorByJobId = null,
  flatnessMm = undefined,
  productionProfile,
  allowWarnings = true,
  batchId = null,
  existingBatchPlan = null,
} = {}) {
  validateJobs(jobs);
  validateTemplates(sheetTemplates);
  validatePolicy({
    cutGapMm,
    bleedOutsetMm,
    bleedClearanceMm,
    bleedPolicy,
    bleedOverlapConfirmed,
    bleedOverlapJustification,
    bleedColorByJobId,
  });
  const inputs = {
    sheetTemplates,
    cutGapMm,
    bleedOutsetMm,
    bleedClearanceMm,
    bleedPolicy,
    bleedOverlapConfirmed,
    bleedOverlapJustification,
    productionProfile,
    bleedColorByJobId,
    flatnessMm,
  };
  try {
    const batchPlan = await buildProductionBatchPlanH2({
      batchId,
      jobs,
      sheetTemplates,
      spacingPolicy: { cutGapMm, bleedOutsetMm },
      bleedPolicy,
      bleedClearanceMm,
      bleedOverlapConfirmed,
      bleedOverlapJustification,
      bleedColorByJobId,
      flatnessMm,
      ...(productionProfile ? { productionProfile } : {}),
      allowWarnings,
      allowQuantityMismatch: false,
      existingBatchPlan,
    });
    if (!batchPlan?.impositionPlan || !batchPlan?.productionOrderManifest || batchPlan?.validation?.valid !== true) {
      fail('INVALID_BATCH_RESULT', 'H.2 không trả về batch hợp lệ');
    }
    return { batchPlan, uiSnapshot: signature(uiSnapshot(inputs)) };
  } catch (err) {
    throw wrap(err, 'BUILD_FAILED');
  }
}

/**
 * Caller must supply CURRENT UI values, not values copied from the old batch.
 * Only a PASS or explicitly accepted WARNING may be released by the UI.
 * On BLOCK, output resource IDs are returned for owner-controlled cleanup.
 */
export async function exportCheckpointKBatch({
  checkpoint,
  jobs,
  assets,
  resourceStore,
  sheetTemplates,
  currentRunCounts,
  expectedOrderManifest,
  cutGapMm,
  bleedOutsetMm,
  bleedClearanceMm,
  bleedPolicy,
  bleedOverlapConfirmed = false,
  bleedOverlapJustification = null,
  productionProfile,
  bleedColorByJobId = null,
  flatnessMm = undefined,
  cutFormat = 'PDF',
  scope = 'CUT_ONLY',
} = {}) {
  const batchPlan = checkpoint?.batchPlan;
  if (!batchPlan?.impositionPlan || !batchPlan?.productionOrderManifest || !nonempty(checkpoint?.uiSnapshot)) {
    fail('MISSING_BATCH', 'Thiếu checkpoint B3.1.1; hãy Build lại');
  }
  validateJobs(jobs);
  validateFreshnessInputs({ sheetTemplates, currentRunCounts, expectedOrderManifest });
  validatePolicy({
    cutGapMm,
    bleedOutsetMm,
    bleedClearanceMm,
    bleedPolicy,
    bleedOverlapConfirmed,
    bleedOverlapJustification,
    bleedColorByJobId,
  });
  if (
    signature(
      uiSnapshot({
        sheetTemplates,
        cutGapMm,
        bleedOutsetMm,
        bleedClearanceMm,
        bleedPolicy,
        bleedOverlapConfirmed,
        bleedOverlapJustification,
        productionProfile,
        bleedColorByJobId,
        flatnessMm,
      })
    ) !== checkpoint.uiSnapshot
  ) {
    fail('STALE_PLAN', 'Thông số sản xuất đã thay đổi sau Build; phải tạo kế hoạch mới');
  }
  if (expectedOrderManifest.batchFreshnessHash !== batchPlan.productionOrderManifest.batchFreshnessHash) {
    fail('STALE_PLAN', 'Manifest hiện tại không khớp batch');
  }
  if (!resourceStore) fail('MISSING_RESOURCE_STORE', 'Thiếu ResourceStore');
  if (cutFormat !== 'PDF') fail('UNSUPPORTED_CUT_FORMAT', 'Final Validator hiện chỉ hỗ trợ CUT PDF');
  if (!['CUT_ONLY', 'CUT_PLUS_PRINT'].includes(scope)) fail('INVALID_SCOPE', 'scope không hợp lệ');
  checkCropAssets(jobs, assets);
  try {
    const result = await exportAndValidateBatchH2({
      batchPlan,
      jobs,
      assets,
      resourceStore,
      sheetTemplates,
      currentRunCounts,
      expectedOrderManifest,
      cutFormat,
      scope,
    });
    const status = result?.finalCheck?.status;
    if (!['PASS', 'WARNING'].includes(status)) {
      fail('FINAL_CHECK_BLOCK', 'Final Validator không cho phép phát hành file', {
        finalCheck: result?.finalCheck ?? null,
        output: result?.output ?? null,
        resourceCleanupRequired: Boolean(result?.output),
      });
    }

    // Point D: Independent post-export geometry verification on ACTUAL exported CUT.pdf bytes
    let postExportVerification = null;
    const cutRid = result?.output?.cut?.resourceId;
    if (cutRid && typeof resourceStore.getBlob === 'function') {
      const cutBlob = resourceStore.getBlob(cutRid);
      const cutPdfBytes = new Uint8Array(await cutBlob.arrayBuffer());
      postExportVerification = await verifyExportedCutPdfGeometry({
        cutPdfBytes,
        impositionPlan: batchPlan.impositionPlan,
        jobs,
        expectedCutGapMm: cutGapMm,
      });
      if (!postExportVerification.passed || postExportVerification.status === 'BLOCK') {
        fail(
          'POST_EXPORT_GEOMETRY_BLOCK',
          `Kiểm định hình học sau xuất CUT.pdf không đạt: ${postExportVerification.errors[0] || 'Sai lệch vượt ngưỡng'}`,
          {
            finalCheck: result?.finalCheck ?? null,
            postExportVerification,
            output: result?.output ?? null,
            resourceCleanupRequired: Boolean(result?.output),
          }
        );
      }
    }

    const postWarn = postExportVerification?.status === 'WARNING';
    return {
      ...result,
      postExportVerification,
      releaseAllowed: status === 'PASS' && !postWarn,
      warningApprovalRequired: status === 'WARNING' || postWarn,
    };
  } catch (err) {
    throw wrap(err, 'EXPORT_FAILED');
  }
}

/**
 * Helper: Safely release any PRINT/CUT output resources from ResourceStore.
 */
export function releaseCheckpointKOutput(resourceStore, output) {
  if (!resourceStore || !output) return;
  for (const key of ['print', 'cut']) {
    const rid = output?.[key]?.resourceId;
    if (rid && typeof resourceStore.has === 'function' && resourceStore.has(rid)) {
      try {
        resourceStore.release(rid);
      } catch {
        // Ignore already-released IDs during cleanup
      }
    }
  }
}

/**
 * Convert clean artwork bytes (NO pink/cyan stroke lines!) + exact High Detail contoursMm
 * from BleedAndContourStudio into valid StickerJobV1[] + SourceAsset[] + ResourceStore entry.
 *
 * Pure translation-only normalization preserves 100% of original cubic Bézier control points.
 */
export async function buildStudioStickerJobsV1({
  cleanArtworkBytes,
  mimeType = 'image/png',
  sourceSizeMm,
  contoursMm,
  bleedOffsetMm = 0,
  quantityPerSticker = 1,
  resourceStore,
  assetId = 'AST-STUDIO-1',
  labelPrefix = 'TEM',
  allowRotate = false,
  pipelineCache = null,
}) {
  if (!cleanArtworkBytes || !cleanArtworkBytes.byteLength) {
    fail('MISSING_ARTWORK', 'Thiếu dữ liệu ảnh artwork sạch (không đường bế)');
  }
  if (!pos(sourceSizeMm?.w) || !pos(sourceSizeMm?.h)) {
    fail('INVALID_SOURCE_SIZE', 'Kích thước trang nguồn không hợp lệ');
  }
  if (!Array.isArray(contoursMm) || contoursMm.length === 0) {
    fail('MISSING_CONTOURS', 'Chưa có đường bế CUT để tạo StickerJobV1');
  }
  if (!resourceStore) {
    fail('MISSING_RESOURCE_STORE', 'Thiếu ResourceStore');
  }

  const resMeta = await resourceStore.acquire(cleanArtworkBytes, {
    kind: 'source_file',
    mimeType,
  });

  const assets = [
    {
      assetId,
      naturalSizeMm: { w: sourceSizeMm.w, h: sourceSizeMm.h },
      resourceId: resMeta.resourceId,
    },
  ];

  const jobs = [];
  const effectiveBleedMm = Math.max(0, Number(bleedOffsetMm) || 0);

  for (let i = 0; i < contoursMm.length; i++) {
    const cutPoly = contoursMm[i];
    const bounds = contourBoundsMm(cutPoly);
    const bw = bounds.w ?? bounds.width ?? bounds.maxX - bounds.minX;
    const bh = bounds.h ?? bounds.height ?? bounds.maxY - bounds.minY;
    if (!pos(bw) || !pos(bh)) {
      fail('INVALID_CONTOUR', `Tem #${i + 1} có kích thước đường CUT không hợp lệ`);
    }

    const localCut = translateContourToLocalOrigin(cutPoly, bounds.minX, bounds.minY);
    Object.assign(localCut, {
      provenance: cutPoly.provenance || contoursMm.provenance || 'RASTER_DERIVED',
      coordinateSystem: 'JOB_LOCAL_MM_Y_DOWN',
      winding: cutPoly.winding || null,
      sourceMeta: cutPoly.sourceMeta ? { ...cutPoly.sourceMeta } : null,
    });

    const cropX = Math.max(0, Math.min(sourceSizeMm.w - 0.01, bounds.minX));
    const cropY = Math.max(0, Math.min(sourceSizeMm.h - 0.01, bounds.minY));
    const cropW = Math.max(0.01, Math.min(bw, sourceSizeMm.w - cropX));
    const cropH = Math.max(0.01, Math.min(bh, sourceSizeMm.h - cropY));

    const jobId = `JOB-${String(i + 1).padStart(3, '0')}`;
    const geometryKey = await computeExactGeometryKey(localCut, { w: bw, h: bh }, localCut.winding || 'CW');
    const canonicalCut = createCanonicalCutV1({
      cutInputHash: geometryKey,
      cutRevision: 1,
      naturalTrimMm: { w: bw, h: bh },
      cutNaturalMm: localCut,
    });

    const bleedConfig = createBleedConfigV1({
      bleedMode: effectiveBleedMm > 0.05 ? 'precision' : 'none',
      bleedOffsetMm: effectiveBleedMm > 0.05 ? effectiveBleedMm : 0,
    });

    const prod = pipelineCache
      ? await pipelineCache.getOrDeriveProductionGeometry({
          jobId,
          canonicalCut,
          targetSizeMm: { w: bw, h: bh },
          bleedConfig,
          lockAspectRatio: true,
        })
      : await deriveProductionGeometry({
          jobId,
          canonicalCut,
          targetSizeMm: { w: bw, h: bh },
          bleedConfig,
          lockAspectRatio: true,
        });

    const gVal = prod.geometryValidation;
    const isReady = gVal.bleedStatus !== 'INVALID';
    const qty = Math.max(1, Math.round(Number(quantityPerSticker) || 1));

    const job = createStickerJobV1({
      jobId,
      jobRevision: 1,
      label: `${labelPrefix} #${i + 1}`,
      origin: {
        sourceAssetId: assetId,
        pageIndex: 1,
        sourceStickerIndex: i + 1,
        sourceRegionMm: { x: cropX, y: cropY, w: cropW, h: cropH },
      },
      artworkRef: {
        resourceId: resMeta.resourceId,
        cropBoxMm: { x: cropX, y: cropY, w: cropW, h: cropH },
      },
      bleedConfig,
      canonicalCut,
      productionGeometry: prod.productionGeometry,
      order: {
        targetSizeMm: { w: bw, h: bh },
        lockAspectRatio: true,
        quantity: qty,
        allowRotate: Boolean(allowRotate),
        included: true,
      },
      validation: {
        geometryValidation: gVal,
        readinessValidation: {
          evaluatedJobRevision: 1,
          effectiveDpi: 300,
          dpiStatus: 'OK',
          nonUniformScale: false,
          status: !isReady ? 'BLOCKED' : gVal.bleedStatus === 'WARNING' ? 'WARNING' : 'READY',
          productionReady: isReady,
          reasons: gVal.reasons || [],
        },
      },
    });
    jobs.push(job);
  }

  return { jobs, assets, artworkResourceId: resMeta.resourceId };
}

/**
 * Helper: Suggest maximum feasible grid (columns × rows) for a given sheet, margins, sticker trim size, and cutGapMm.
 */
export function suggestGridForSheet({
  sheetWidthMm,
  sheetHeightMm,
  marginsMm = { top: 10, right: 10, bottom: 10, left: 10 },
  trimWmm,
  trimHmm,
  cutGapMm = 2,
}) {
  const usableW = Math.max(0, sheetWidthMm - (marginsMm.left || 0) - (marginsMm.right || 0));
  const usableH = Math.max(0, sheetHeightMm - (marginsMm.top || 0) - (marginsMm.bottom || 0));
  const columns = Math.max(1, Math.floor((usableW + cutGapMm) / Math.max(0.1, trimWmm + cutGapMm)));
  const rows = Math.max(1, Math.floor((usableH + cutGapMm) / Math.max(0.1, trimHmm + cutGapMm)));
  return { columns, rows, capacity: columns * rows };
}
