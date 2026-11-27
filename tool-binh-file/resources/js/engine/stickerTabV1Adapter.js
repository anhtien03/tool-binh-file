/**
 * PrintKit V1 — Sticker Tab Imposition Adapter (PdfEditor <-> Checkpoint K / H.2 / H.2.2)
 *
 * Bridges the existing Bình Tem Bế UI (PdfEditor.jsx + PdfCanvasPreview.jsx) directly to the
 * authoritative PrintKit V1/H.2 pipeline so Preview and Export ALWAYS use ONE shared H.2 plan.
 * Supports BOTH single-page (1 sticker repeated or N distinct) AND multi-page batches
 * (e.g. 7-page L0110.063 Giảm 3%..30%, 99 stickers/page × 7 pages = 693 stickers).
 *
 * Strict invariants:
 *  - ZERO edits to any LOCKED engine file.
 *  - ZERO silent fallback to legacy impositionEngine / pdfExporter when V1 payload is active.
 *  - Unsupported UI options explicitly report unsupportedReasons.
 *  - Preserves 100% of CanonicalCutV1 cubic Bézier geometry and runs post-export CUT.pdf verification.
 */

import { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFNumber, StandardFonts, cmyk, rgb } from 'pdf-lib';
import { PAPER_SIZES } from './impositionEngine.js';
import { createResourceStore } from './resourceStore.js';
import { PRODUCTION_PROFILES } from './batchImpositionAdapter.js';
import { transformContourByRigidMatrixMm } from './cutVectorExporter.js';
import { contourBoundsMm } from './bleedContourEngine.js';
import { updateStickerJobOrder } from './v1Schema.js';
import {
  buildStudioStickerJobsV1,
  createCheckpointKBatch,
  exportCheckpointKBatch,
  releaseCheckpointKOutput,
} from './checkpointKUiBridge.js';
import { createStickerPipelineCache } from './stickerPipelineCache.js';
import { verifyExportedCutPdfGeometry } from './postExportGeometryVerifier.js';
import {
  getMachineProfile,
  inferMachineProfileFromPontType,
  getMarkQuietZoneRectsMm,
} from './machineCompatibilityProfiles.js';
import { validateMachineCompatibility } from './machineCompatibilityValidator.js';
import { ensureSpotCutContourColorSpace, exportLayeredAiFiles } from './layeredAiExporter.js';

const EXTRA_V1_PAPER_SIZES = {
  D320x330: { width: 320, height: 330 },
};

/**
 * Resolve physical sheet dimensions (mm) from PdfEditor config identically to the UI.
 */
export function resolveSheetDimensionsMm(config = {}) {
  const preset =
    EXTRA_V1_PAPER_SIZES[config.paperSizeKey] ||
    PAPER_SIZES[config.paperSizeKey] ||
    PAPER_SIZES.D330x390 || { width: 330, height: 390 };
  const isCustomPaper = String(config.paperSizeKey || '').toLowerCase() === 'custom';
  let w = isCustomPaper ? Number(config.customPaperWidth) || 330 : preset.width;
  let h = isCustomPaper ? Number(config.customPaperHeight) || 390 : preset.height;
  if (config.orientation === 'landscape' && w < h) [w, h] = [h, w];
  if (config.orientation === 'portrait' && w > h) [w, h] = [h, w];
  return { sheetWidthMm: w, sheetHeightMm: h };
}

/**
 * Check whether current PdfEditor sticker UI config is supported by PrintKit V1/H.2.
 * NEVER silently falls back to legacy on unsupported features!
 */
export function checkV1StickerConfigCompatibility(config = {}) {
  const unsupportedReasons = [];
  const warnings = [];

  const layout = config.stickerLayout || 'optimal';
  if (layout === 'honeycomb') {
    unsupportedReasons.push(
      'Kiểu xếp "Tổ ong (Honeycomb)" chưa được hỗ trợ trong PrintKit V1/H.2. Hãy chọn "Xếp tối ưu (Lưới)" hoặc "Lưới cơ bản".'
    );
  } else if (layout === 'nesting') {
    unsupportedReasons.push(
      'Kiểu xếp "Lồng ghép tự do (Nesting xoay góc lẻ)" chưa được hỗ trợ trong PrintKit V1/H.2. Hãy chuyển sang "Xếp tối ưu (Lưới)" để giữ nguyên đường bế Bézier gốc.'
    );
  }

  if (config.clusterSplit && config.clusterSplit !== 'none') {
    unsupportedReasons.push(
      `Tính năng chia cụm "${config.clusterSplit}" chưa được hỗ trợ trong PrintKit V1/H.2. Hãy đặt về "Không chia cụm".`
    );
  }

  if (config.stickerTrimMarks && config.stickerTrimMarks !== 'none') {
    unsupportedReasons.push(
      'Đường cắt xén rời (Guillotine trim marks) chưa được hỗ trợ trong PrintKit V1/H.2. Hãy đặt về "Không".'
    );
  }

  if (config.stickerShape && config.stickerShape !== 'pdfContour') {
    unsupportedReasons.push(
      `V1 đang bảo toàn đường bế gốc (pdfContour), không hỗ trợ ép đổi hình sang "${config.stickerShape}" tại tab Bình Tem.`
    );
  }

  const pontType = config.pontType || 'graphtec';
  if (pontType === 'circle5mm' || pontType === 'circleHollow') {
    warnings.push(
      `Boong "${pontType}" được ánh xạ sang bộ boong 4 góc chuẩn V1 (markInset=${Number(config.pontMarginMm) || 10}mm, size=${Number(config.pontSizeMm) || 5}mm) khi xuất IN/BẾ.`
    );
  }

  let productionProfile = PRODUCTION_PROFILES.NONE;
  if (pontType !== 'none') {
    const rawInset = Number(config.pontMarginMm);
    const rawSize = Number(config.pontSizeMm);
    const markInsetMm = Number.isFinite(rawInset) && rawInset >= 5 ? Math.min(40, rawInset) : PRODUCTION_PROFILES.GENERIC.markInsetMm;
    const markSizeMm = Number.isFinite(rawSize) && rawSize >= 2 ? Math.min(12, rawSize) : PRODUCTION_PROFILES.GENERIC.markSizeMm;
    productionProfile = Object.freeze({
      ...PRODUCTION_PROFILES.GENERIC,
      markInsetMm,
      markSizeMm,
    });
  }

  return {
    supported: unsupportedReasons.length === 0,
    unsupportedReasons,
    warnings,
    productionProfile,
  };
}

function getBoundsWH(contour) {
  const b = contourBoundsMm(contour);
  return {
    minX: b.minX,
    minY: b.minY,
    w: b.w ?? b.width ?? Math.max(0.1, b.maxX - b.minX),
    h: b.h ?? b.height ?? Math.max(0.1, b.maxY - b.minY),
  };
}

/**
 * Convert an authoritative H.2 ImpositionPlanV1 into the exact previewPlan format consumed by
 * PdfCanvasPreview.jsx — guaranteeing 100% shared geometry between Preview and PRINT/CUT export.
 */
export function buildPreviewPlanFromH2Batch(
  batchPlan,
  jobs,
  { pontType = 'graphtec', machineProfileId = null, provenanceBadge = '', assetIdToPageIdx = null } = {}
) {
  const imp = batchPlan.impositionPlan;
  const jobMap = new Map(jobs.map((j) => [j.jobId, j]));

  const runCountsByTpl = batchPlan.productionOrderManifest?.runCountsByTemplateId || {};
  const sheets = imp.sheets.map((sh, sIdx) => {
    const sheetRunCount = Math.max(1, Number(runCountsByTpl[sh.templateId]) || 1);
    const placements = [];
    const stickerCutPaths = [];
    const stickerBleedPaths = [];

    for (const pl of sh.placements) {
      const job = jobMap.get(pl.jobId);
      const cutWorld = job?.productionGeometry?.cutTargetMm
        ? transformContourByRigidMatrixMm(job.productionGeometry.cutTargetMm, pl.rigidMatrixMm)
        : null;
      const bleedWorld = job?.productionGeometry?.bleedTargetMm
        ? transformContourByRigidMatrixMm(job.productionGeometry.bleedTargetMm, pl.rigidMatrixMm)
        : null;

      const rm = pl.rigidMatrixMm;
      const xMm = Array.isArray(rm) ? rm[4] : Number(rm?.tx) || 0;
      const yMm = Array.isArray(rm) ? rm[5] : Number(rm?.ty) || 0;
      const wMm = pl.targetSizeMm.w;
      const hMm = pl.targetSizeMm.h;
      const rot = Number.isFinite(pl.rotationDeg)
        ? pl.rotationDeg
        : Array.isArray(rm)
          ? Math.round((Math.atan2(rm[1], rm[0]) * 180) / Math.PI)
          : Number(rm?.rotationDeg) || 0;
      const crop = job?.artworkRef?.cropBoxMm || { x: 0, y: 0, w: wMm, h: hMm };
      const assetId = job?.origin?.sourceAssetId;
      const artworkPageIdx = assetIdToPageIdx && assetIdToPageIdx.has(assetId) ? assetIdToPageIdx.get(assetId) : 0;

      placements.push({
        pageIndex: artworkPageIdx,
        artworkPageIdx,
        v1Placement: true,
        jobId: pl.jobId,
        x: xMm,
        y: yMm,
        trimW: wMm,
        trimH: hMm,
        rotate: rot,
        block: 'primary',
        clipBleed: {
          top: job?.bleedConfig?.bleedOffsetMm || 0,
          right: job?.bleedConfig?.bleedOffsetMm || 0,
          bottom: job?.bleedConfig?.bleedOffsetMm || 0,
          left: job?.bleedConfig?.bleedOffsetMm || 0,
        },
        srcTrimBoxMm: {
          offsetLeft: crop.x,
          offsetTop: crop.y,
          trimW: crop.w,
          trimH: crop.h,
          isCustom: true,
        },
        bleedBeziersMm: bleedWorld?.beziersMm || null,
      });

      if (cutWorld?.beziersMm && cutWorld.beziersMm.length >= 2) {
        stickerCutPaths.push({
          kind: 'bezier',
          beziersMm: cutWorld.beziersMm,
          pts: cutWorld,
          closed: true,
        });
      }
      if (bleedWorld?.beziersMm && bleedWorld.beziersMm.length >= 2) {
        stickerBleedPaths.push({
          kind: 'bezier',
          beziersMm: bleedWorld.beziersMm,
          closed: true,
        });
      }
    }

    const pontMarks = [];
    const profile = imp.productionProfile;
    if (profile && profile.includeMarksInCut) {
      const inset = profile.markInsetMm || 10;
      const size = profile.markSizeMm || 5;
      const corners = [
        { cx: inset, cy: inset, corner: 'TL' },
        { cx: sh.widthMm - inset, cy: inset, corner: 'TR' },
        { cx: inset, cy: sh.heightMm - inset, corner: 'BL' },
        { cx: sh.widthMm - inset, cy: sh.heightMm - inset, corner: 'BR' },
      ];
      for (const c of corners) {
        pontMarks.push({
          type: pontType === 'none' ? 'none' : pontType,
          cx: c.cx,
          cy: c.cy,
          size,
          x: c.cx,
          y: c.cy,
          sizeMm: size,
          corner: c.corner,
        });
      }
    }

    const machineProf = getMachineProfile(machineProfileId) || inferMachineProfileFromPontType(pontType);
    const quietZoneRectsMm =
      profile && profile.includeMarksInCut && pontType !== 'none' && machineProf
        ? getMarkQuietZoneRectsMm({
          sheetWidthMm: sh.widthMm,
          sheetHeightMm: sh.heightMm,
          markInsetMm: profile.markInsetMm || 10,
          markSizeMm: profile.markSizeMm || 5,
          quietZoneMm: machineProf.quietZoneMm || 5,
        })
        : [];

    return {
      sheetNumber: sIdx + 1,
      physicalSheet: sIdx + 1,
      runCount: sheetRunCount,
      side: 'front',
      widthMm: sh.widthMm,
      heightMm: sh.heightMm,
      placements,
      marks: { lines: [], registrations: [] },
      pontMarks,
      quietZoneRectsMm,
      stickerCutPaths,
      stickerBleedPaths,
      stickerPontMarks: pontMarks,
      isV1Authoritative: true,
      slugText: `PrintKit V1 (${provenanceBadge || 'V1'}) | Tờ ${sIdx + 1}/${imp.sheets.length} (×${sheetRunCount} tờ) | ${placements.length} tem/tờ | Khổ ${sh.widthMm}×${sh.heightMm}mm`,
    };
  });

  const firstSheet = imp.sheets[0];
  const sheetW = firstSheet?.widthMm || 330;
  const sheetH = firstSheet?.heightMm || 390;
  const itemsPerSheet = firstSheet?.placements?.length || 0;
  const totalPlacements = imp.sheets.reduce((acc, s) => acc + s.placements.length, 0);
  const totalPhysicalSheets = sheets.reduce((acc, s) => acc + (s.runCount || 1), 0);
  const totalProducedStickers = sheets.reduce((acc, s) => acc + s.placements.length * (s.runCount || 1), 0);
  const firstPl = firstSheet?.placements?.[0];
  const trimW = Number((firstPl?.targetSizeMm?.w || 0).toFixed(2));
  const trimH = Number((firstPl?.targetSizeMm?.h || 0).toFixed(2));
  const usedArea = firstSheet
    ? firstSheet.placements.reduce((sum, pl) => sum + (pl.targetSizeMm?.w || 0) * (pl.targetSizeMm?.h || 0), 0)
    : 0;
  const utilizationPct = sheetW * sheetH > 0 ? Math.min(100, Math.round((usedArea / (sheetW * sheetH)) * 1000) / 10) : 0;

  return {
    mode: 'sticker',
    isV1Authoritative: true,
    sheetWidthMm: sheetW,
    sheetHeightMm: sheetH,
    sheetDim: { width: sheetW, height: sheetH },
    sheets,
    totalSheets: imp.sheets.length,
    totalPlacements,
    jobChecks: [],
    summary: {
      itemsPerSheet,
      primaryCount: itemsPerSheet,
      secondaryCount: 0,
      utilizationPct,
      ratioSheetsNeeded: totalPhysicalSheets,
      totalPlacedItems: totalProducedStickers,
      totalNeededItems: totalProducedStickers,
      physicalSheets: totalPhysicalSheets,
      trimW,
      trimH,
    },
    stats: {
      pagesPerSheet: itemsPerSheet,
      totalSheets: imp.sheets.length,
      physicalSheets: totalPhysicalSheets,
    },
  };
}

function normalizePayloadPages(v1Payload) {
  if (!v1Payload) return [];
  if (Array.isArray(v1Payload.pages) && v1Payload.pages.length > 0) {
    return v1Payload.pages;
  }
  if (Array.isArray(v1Payload.contoursMm) && v1Payload.contoursMm.length > 0) {
    return [
      {
        pageNum: 1,
        cleanArtworkCanvas: v1Payload.cleanArtworkCanvas || null,
        cleanArtworkBytes: v1Payload.cleanArtworkBytes,
        sourceSizeMm: v1Payload.sourceSizeMm,
        contoursMm: v1Payload.contoursMm,
        bleedOffsetMm: v1Payload.bleedOffsetMm || 0,
        contourProvenance: v1Payload.contourProvenance || null,
      },
    ];
  }
  return [];
}

function fingerprintBytes(bytes) {
  if (!bytes || !bytes.byteLength) return 'empty';
  const len = bytes.byteLength;
  const mid = len >> 1;
  return `${len}:${bytes[0]}:${bytes[mid]}:${bytes[len - 1]}`;
}

function fingerprintContours(contoursMm) {
  if (!Array.isArray(contoursMm) || contoursMm.length === 0) return '0';
  const first = contoursMm[0];
  const last = contoursMm[contoursMm.length - 1];
  const fSegs = first?.beziersMm?.length || first?.length || 0;
  const lSegs = last?.beziersMm?.length || last?.length || 0;
  const fPt = first?.beziersMm?.[0]?.p0 || first?.[0] || [0, 0];
  const lPt = last?.beziersMm?.[0]?.p0 || last?.[0] || [0, 0];
  return `${contoursMm.length}:${fSegs}:${lSegs}:${fPt[0]},${fPt[1]}:${lPt[0]},${lPt[1]}`;
}

function computeSourceBatchKey(payloadPages, baseName) {
  return payloadPages
    .map((pg, idx) => {
      const w = pg.sourceSizeMm?.w ?? 0;
      const h = pg.sourceSizeMm?.h ?? 0;
      const bleed = Math.max(0, Number(pg.bleedOffsetMm) || 0);
      return [
        baseName,
        pg.pageNum ?? idx + 1,
        w,
        h,
        bleed,
        fingerprintBytes(pg.cleanArtworkBytes),
        fingerprintContours(pg.contoursMm),
      ].join('|');
    })
    .join('||');
}

/**
 * Build ONE authoritative V1/H.2 plan + matching Preview plan from BleedAndContourStudio payload
 * (1 page OR N pages such as 7-page L0110.063) and current PdfEditor sticker UI config.
 *
 * Uses versioned `pipelineCache` so layout-only changes (sheet size, margins, cutGap, boong,
 * bleedPolicy, runCount) reuse ProductionGeometryCacheV1 & StickerJobs with ZERO precisionBleedFromCut calls.
 */
export async function buildV1StickerTabPlan({
  v1Payload,
  config,
  bleedPolicy = 'strict',
  bleedOverlapConfirmed = false,
  bleedOverlapJustification = null,
  runCount = 1,
  runCountByPage = null,
  quantityByPage = null,
  resourceStore = null,
  pipelineCache = null,
} = {}) {
  const payloadPages = normalizePayloadPages(v1Payload);
  if (payloadPages.length === 0) {
    return {
      supported: false,
      unsupportedReasons: ['Chưa có dữ liệu contour V1 từ Tràn viền & Đường bế.'],
      warnings: [],
      checkpoint: null,
      previewPlan: null,
    };
  }

  const compat = checkV1StickerConfigCompatibility(config);
  if (!compat.supported) {
    return {
      supported: false,
      unsupportedReasons: compat.unsupportedReasons,
      warnings: compat.warnings,
      checkpoint: null,
      previewPlan: null,
    };
  }

  const cache = pipelineCache || createStickerPipelineCache();
  const { sheetWidthMm, sheetHeightMm } = resolveSheetDimensionsMm(config);
  const profile = compat.productionProfile;
  const markClearance =
    profile.markMode !== 'none' && profile.markSizeMm > 0
      ? Number(profile.markInsetMm || 8) + Number(profile.markSizeMm) / 2 + 2
      : 0;

  const marginsMm = {
    top: Math.max(markClearance, Number(config.marginTop) || 0),
    right: Math.max(markClearance, Number(config.marginRight) || 0),
    bottom: Math.max(markClearance, Number(config.marginBottom) || 0),
    left: Math.max(markClearance, Number(config.marginLeft) || 0),
  };

  const cutGapXMm = Math.max(0, Number(config.gutterX) || 0);
  const cutGapYMm = Math.max(0, Number(config.gutterY) || 0);
  const cutGapMm = Math.min(cutGapXMm, cutGapYMm);
  const safeRunCount = Math.max(1, Math.round(Number(runCount) || 1));
  const align = config.alignment || config.stickerAlignment || 'center';
  const autoFillSheet = config.stickerAutoFillSheet !== false;
  const baseName = (v1Payload.sourceFileName || 'tem').replace(/\.[^.]+$/, '');
  const safeW = Math.max(0, sheetWidthMm - marginsMm.left - marginsMm.right);
  const safeH = Math.max(0, sheetHeightMm - marginsMm.top - marginsMm.bottom);

  // 1. Resolve or build immutable StickerJobs + ProductionGeometryCacheV1 (cached per sourceBatchKey)
  const sourceBatchKey = computeSourceBatchKey(payloadPages, baseName);
  let jobSetEntry = cache.getJobSet(sourceBatchKey);

  if (!jobSetEntry) {
    const store = resourceStore || createResourceStore();
    const pageEntries = [];
    const assetIdToPageIdx = new Map();
    let maxBleedOutset = 0;

    for (let pIdx = 0; pIdx < payloadPages.length; pIdx++) {
      const pg = payloadPages[pIdx];
      const selectedContours = pg.contoursMm || [];
      if (selectedContours.length === 0) continue;

      const isMultiDistinct = selectedContours.length > 1;
      const effectiveBleedMm = Math.max(0, Number(pg.bleedOffsetMm) || 0);
      if (effectiveBleedMm > maxBleedOutset) maxBleedOutset = effectiveBleedMm;

      let maxW = 0;
      let maxH = 0;
      for (const c of selectedContours) {
        const b = getBoundsWH(c);
        if (b.w > maxW) maxW = b.w;
        if (b.h > maxH) maxH = b.h;
      }

      const assetId = `AST-STUDIO-P${pg.pageNum || pIdx + 1}`;
      assetIdToPageIdx.set(assetId, pIdx);

      const built = await buildStudioStickerJobsV1({
        cleanArtworkBytes: pg.cleanArtworkBytes,
        mimeType: 'image/png',
        sourceSizeMm: pg.sourceSizeMm,
        contoursMm: selectedContours,
        bleedOffsetMm: effectiveBleedMm,
        quantityPerSticker: 1,
        resourceStore: store,
        assetId,
        labelPrefix: payloadPages.length > 1 ? `${baseName}-P${pg.pageNum || pIdx + 1}` : baseName,
        allowRotate: false,
        contourProvenance: pg.contourProvenance || v1Payload.contourProvenance || null,
        pipelineCache: cache,
      });

      const pagePrefix = payloadPages.length > 1 ? `P${pg.pageNum || pIdx + 1}-` : '';
      const pageJobs = built.jobs.map((j) =>
        pagePrefix
          ? Object.freeze({
            ...j,
            jobId: `${pagePrefix}${j.jobId}`,
          })
          : j
      );

      pageEntries.push({
        pageNum: pg.pageNum || pIdx + 1,
        isMultiDistinct,
        contourCount: selectedContours.length,
        maxW,
        maxH,
        effectiveBleedMm,
        pageJobs,
        assets: built.assets,
      });
    }

    jobSetEntry = {
      pageEntries,
      resourceStore: store,
      assetIdToPageIdx,
      maxBleedOutset,
    };
    cache.setJobSet(sourceBatchKey, jobSetEntry);
  }

  // 2. Compute H.2 layout templates (fast layout-only stage: 0 precisionBleedFromCut calls on cache hit!)
  const tLayoutStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { pageEntries, resourceStore: store, assetIdToPageIdx, maxBleedOutset } = jobSetEntry;
  const allJobs = [];
  const allAssets = [];
  const sheetTemplates = [];

  for (const entry of pageEntries) {
    const maxFitCols = Math.max(1, Math.floor((safeW + cutGapXMm + 1e-6) / Math.max(0.1, entry.maxW + cutGapXMm)));
    const maxFitRows = Math.max(1, Math.floor((safeH + cutGapYMm + 1e-6) / Math.max(0.1, entry.maxH + cutGapYMm)));

    let columns = maxFitCols;
    let rows = maxFitRows;

    if (entry.isMultiDistinct) {
      if (maxFitCols * maxFitRows < entry.contourCount) {
        return {
          supported: false,
          unsupportedReasons: [
            `Trang ${entry.pageNum}: Khổ giấy ${sheetWidthMm}×${sheetHeightMm}mm với lề ${marginsMm.left}mm và khoảng cách ngang ${cutGapXMm}mm / dọc ${cutGapYMm}mm chỉ chứa tối đa ${maxFitCols}×${maxFitRows} = ${maxFitCols * maxFitRows} tem/tờ, không đủ xếp ${entry.contourCount} tem trên 1 tờ. Hãy giảm khoảng cách tem hoặc chọn khổ giấy lớn hơn.`,
          ],
          warnings: compat.warnings,
          checkpoint: null,
          previewPlan: null,
          cacheStats: cache.getStatsSnapshot(),
        };
      }
      if (entry.contourCount === 99 && maxFitCols >= 9 && maxFitRows >= 11) {
        columns = 9;
        rows = 11;
      } else {
        columns = Math.min(maxFitCols, Math.max(1, Math.ceil(entry.contourCount / maxFitRows)));
        rows = Math.min(maxFitRows, Math.ceil(entry.contourCount / columns));
      }
    }

    const rawPageRun = runCountByPage?.[entry.pageNum];
    const rawPageQty = quantityByPage?.[entry.pageNum];
    let tplRunCount = safeRunCount;
    let placedPerSheet = entry.isMultiDistinct ? entry.contourCount : columns * rows;

    if (entry.isMultiDistinct) {
      if (Number.isFinite(Number(rawPageRun)) && Number(rawPageRun) >= 1) {
        tplRunCount = Math.max(1, Math.round(Number(rawPageRun)));
      } else if (Number.isFinite(Number(rawPageQty)) && Number(rawPageQty) >= 1) {
        tplRunCount = Math.max(1, Math.round(Number(rawPageQty)));
      }
    } else {
      const cap = columns * rows;
      if (Number.isFinite(Number(rawPageQty)) && Number(rawPageQty) >= 1) {
        const reqQty = Math.round(Number(rawPageQty));
        if (!autoFillSheet && reqQty < cap) {
          placedPerSheet = reqQty;
          tplRunCount = 1;
        } else {
          placedPerSheet = cap;
          tplRunCount = Math.max(1, Math.ceil(reqQty / cap));
        }
      } else if (Number.isFinite(Number(rawPageRun)) && Number(rawPageRun) >= 1) {
        placedPerSheet = cap;
        tplRunCount = Math.max(1, Math.round(Number(rawPageRun)));
      }
    }

    const copiesPerSticker = entry.isMultiDistinct ? tplRunCount : placedPerSheet * tplRunCount;
    const adjustedJobs = entry.pageJobs.map((j) =>
      j.order.quantity === copiesPerSticker ? j : updateStickerJobOrder(j, { quantity: copiesPerSticker })
    );

    allJobs.push(...adjustedJobs);
    allAssets.push(...entry.assets);

    const tplId = `TPL-STICKER-V1-P${entry.pageNum}`;
    const items = entry.isMultiDistinct
      ? adjustedJobs.map((j) => ({ jobId: j.jobId, copiesPerRun: 1 }))
      : [{ jobId: adjustedJobs[0].jobId, copiesPerRun: placedPerSheet }];

    const r4 = (v) => Math.round(v * 10000) / 10000;
    const pitchX = r4(entry.maxW + cutGapXMm);
    const pitchY = r4(entry.maxH + cutGapYMm);
    const gridTotalH = r4((rows - 1) * pitchY + entry.maxH);
    const gridSpec = {
      rows,
      columns,
      pitchXmm: pitchX,
      pitchYmm: pitchY,
      centerX: true,
      centerY: align === 'center',
      centerInSafeArea: true,
    };
    if (align === 'top') {
      gridSpec.centerY = false;
      gridSpec.originYmm = Math.ceil(marginsMm.top * 10000) / 10000;
    } else if (align === 'bottom') {
      gridSpec.centerY = false;
      const rawBottomOrigin = Math.max(marginsMm.top, sheetHeightMm - marginsMm.bottom - gridTotalH);
      gridSpec.originYmm = Math.max(marginsMm.top, Math.floor(rawBottomOrigin * 1000) / 1000);
    }

    sheetTemplates.push({
      templateId: tplId,
      sheetWidthMm,
      sheetHeightMm,
      marginsMm,
      runCount: tplRunCount,
      gridSpec,
      items,
    });
  }

  const uiParams = {
    sheetTemplates,
    cutGapMm,
    bleedOutsetMm: maxBleedOutset,
    bleedClearanceMm: 0,
    bleedPolicy,
    bleedOverlapConfirmed: bleedPolicy === 'allow_overlap' ? Boolean(bleedOverlapConfirmed) : false,
    bleedOverlapJustification:
      bleedPolicy === 'allow_overlap'
        ? bleedOverlapJustification || 'Các tem dùng cùng màu nền tràn viền, chỉ chồng BLEED trong vùng rác'
        : null,
    productionProfile: profile,
  };

  const checkpoint = await createCheckpointKBatch({
    jobs: allJobs,
    ...uiParams,
    allowWarnings: true,
  });

  const machineProfileId = config.machineProfileId || null;
  const requireSpotCutContour = config.requireSpotCutContour !== false;

  const previewPlan = buildPreviewPlanFromH2Batch(checkpoint.batchPlan, allJobs, {
    pontType: config.pontType || 'graphtec',
    machineProfileId,
    provenanceBadge: v1Payload.contourProvenance?.badge || payloadPages[0]?.contourProvenance?.badge || 'V1',
    assetIdToPageIdx,
  });

  const tLayoutEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
  cache.recordLayoutDurationMs(tLayoutEnd - tLayoutStart);
  const layoutEntry = cache.setBatchPlan(`${sourceBatchKey}::${sheetWidthMm}x${sheetHeightMm}::${cutGapMm}::${safeRunCount}::${bleedPolicy}`, null);

  const firstTpl = sheetTemplates[0];
  const totalPhysicalSheets = sheetTemplates.reduce((sum, t) => sum + (t.runCount || 1), 0);
  const totalProducedStickers = previewPlan.summary.totalPlacedItems;
  const planObj = {
    supported: true,
    unsupportedReasons: [],
    warnings: [
      ...compat.warnings,
      ...(checkpoint.batchPlan.productionOrderManifest.warnings || []),
    ],
    batchVersion: layoutEntry.batchVersion,
    checkpoint,
    previewPlan,
    jobs: allJobs,
    assets: allAssets,
    resourceStore: store,
    uiParams,
    pontType: config.pontType || 'graphtec',
    machineProfileId,
    requireSpotCutContour,
    showSlugLine: config.showSlugLine !== false,
    runCount: safeRunCount,
    runCountsByTemplateId: { ...checkpoint.batchPlan.productionOrderManifest.runCountsByTemplateId },
    pipelineCache: cache,
    cacheStats: cache.getStatsSnapshot(),
    summary: {
      sheetWidthMm,
      sheetHeightMm,
      cutGapXMm,
      cutGapYMm,
      columns: firstTpl?.gridSpec?.columns || 0,
      rows: firstTpl?.gridSpec?.rows || 0,
      stickersPerSheet: previewPlan.stats.pagesPerSheet,
      totalSheets: previewPlan.totalSheets,
      physicalSheets: totalPhysicalSheets,
      totalStickers: totalProducedStickers,
      alignment: align,
      markInsetMm: profile.markInsetMm,
      markSizeMm: profile.markSizeMm,
      geometryStatus: checkpoint.batchPlan.productionOrderManifest.bleedPolicy.geometryStatus,
      colorStatus: checkpoint.batchPlan.productionOrderManifest.bleedPolicy.colorStatus,
      provenance: v1Payload.contourProvenance || payloadPages[0]?.contourProvenance || null,
    },
  };

  const preReports = await validateMachineCompatibility({
    v1PlanState: planObj,
    cutPageFiles: [],
    machineProfileId,
    pontType: planObj.pontType,
    requireSpotCutContour,
  });
  planObj.geometryReport = preReports.geometryReport;
  planObj.machineReport = preReports.machineReport;
  return planObj;
}

/**
 * Export and verify PRINT.pdf + CUT.pdf from the exact same V1/H.2 plan shown in Preview.
 * Runs FinalProductionValidator (G) AND Post-Export CUT.pdf Geometry Verification (V1-A5 / Point D).
 */
export async function exportV1StickerTabOutputs({ v1PlanState, role = 'print' } = {}) {
  if (role === 'svg') {
    throw new Error(
      'PrintKit V1 hiện chỉ hỗ trợ xuất cặp PRINT.pdf + CUT.pdf đã kiểm định 3.1.3 & hậu kiểm Bézier (không dùng exporter SVG legacy).'
    );
  }
  if (!v1PlanState?.supported || !v1PlanState?.checkpoint) {
    throw new Error(
      v1PlanState?.unsupportedReasons?.[0] || 'Chưa có kế hoạch bình tem V1/H.2 hợp lệ để xuất.'
    );
  }

  const { checkpoint, jobs, assets, resourceStore, uiParams } = v1PlanState;
  const currentRunCounts = {};
  for (const t of uiParams.sheetTemplates) {
    currentRunCounts[t.templateId] = t.runCount;
  }
  const expectedOrderManifest = checkpoint.batchPlan.productionOrderManifest;

  try {
    const result = await exportCheckpointKBatch({
      checkpoint,
      jobs,
      assets,
      resourceStore,
      ...uiParams,
      currentRunCounts,
      expectedOrderManifest,
      cutFormat: 'PDF',
      scope: 'CUT_ONLY',
      verifyExportedCutPdf: true,
    });
    return result;
  } catch (err) {
    if (err?.details?.output && resourceStore) {
      releaseCheckpointKOutput(resourceStore, err.details.output);
    }
    throw err;
  }
}

const MM_TO_PT = 72 / 25.4;

function toWinAnsiAscii(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure additive post-stamp helper (ZERO edits to LOCKED productionOutput.js / cutVectorExporter.js):
 *  - Replaces the default LOCKED 5x5mm corner squares with exact shop Graphtec L-marks (┌ ┐ └ ┘)
 *    or circle5mm / circleHollow marks matching Preview 1:1.
 *  - Draws centered top Slug Line on PRINT pages (matching shop L0110.063 header style).
 */
function stampShopMarksAndSlugOnPage({
  page,
  sheet,
  profile,
  pontType = 'graphtec',
  showSlugLine = true,
  slugText = '',
  font = null,
  isCut = false,
}) {
  const wMm = sheet.widthMm;
  const hMm = sheet.heightMm;
  const insetMm = Number(profile?.markInsetMm) || 10;
  const sizeMm = Number(profile?.markSizeMm) || 5;
  const black = cmyk(0, 0, 0, 1);
  const white = rgb(1, 1, 1);

  if (profile && profile.markMode !== 'none' && pontType && pontType !== 'none') {
    const corners = [
      { cx: insetMm, cy: insetMm, corner: 'TL' },
      { cx: wMm - insetMm, cy: insetMm, corner: 'TR' },
      { cx: insetMm, cy: hMm - insetMm, corner: 'BL' },
      { cx: wMm - insetMm, cy: hMm - insetMm, corner: 'BR' },
    ];

    const maskHalfPt = ((sizeMm + 1.0) / 2) * MM_TO_PT;
    const armPt = Math.max(8, sizeMm * 2) * MM_TO_PT;
    const strokePt = 0.6 * MM_TO_PT; // ~1.7pt crisp Graphtec registration bracket

    for (const c of corners) {
      const cxPt = c.cx * MM_TO_PT;
      const cyPt = (hMm - c.cy) * MM_TO_PT; // PDF Y-up

      // White-mask the underlying LOCKED corner square (does not touch any sticker contour)
      page.drawRectangle({
        x: cxPt - maskHalfPt,
        y: cyPt - maskHalfPt,
        width: maskHalfPt * 2,
        height: maskHalfPt * 2,
        color: white,
        borderWidth: 0,
      });

      if (pontType === 'graphtec' || pontType === 'graphtecType2') {
        const isType2 = pontType === 'graphtecType2';
        const rawArmMm = Math.max(5, sizeMm * 1.8);
        const effArmMm = isType2 ? Math.min(rawArmMm, Math.max(3, insetMm - 1.2)) : rawArmMm;
        const effArmPt = effArmMm * MM_TO_PT;
        const halfStroke = strokePt / 2;
        const sx = (c.corner.includes('L') ? 1 : -1) * (isType2 ? -1 : 1);
        const syPdf = (c.corner.includes('T') ? -1 : 1) * (isType2 ? -1 : 1);
        page.drawLine({
          start: { x: cxPt - sx * halfStroke, y: cyPt },
          end: { x: cxPt + sx * effArmPt, y: cyPt },
          thickness: strokePt,
          color: black,
        });
        page.drawLine({
          start: { x: cxPt, y: cyPt - syPdf * halfStroke },
          end: { x: cxPt, y: cyPt + syPdf * effArmPt },
          thickness: strokePt,
          color: black,
        });
      } else if (pontType === 'circle5mm') {
        page.drawCircle({
          x: cxPt,
          y: cyPt,
          size: (sizeMm / 2) * MM_TO_PT,
          color: black,
          borderWidth: 0,
        });
      } else if (pontType === 'circleHollow') {
        page.drawCircle({
          x: cxPt,
          y: cyPt,
          size: (sizeMm / 2) * MM_TO_PT,
          borderColor: black,
          borderWidth: 0.45 * MM_TO_PT,
        });
      }
    }
  }

  if (!isCut && showSlugLine && font && slugText) {
    const cleanText = toWinAnsiAscii(slugText);
    if (cleanText) {
      const fontSize = 7.5;
      const textWidth = font.widthOfTextAtSize(cleanText, fontSize);
      const xPt = Math.max(12 * MM_TO_PT, (wMm * MM_TO_PT - textWidth) / 2);
      const yPt = (hMm - Math.max(8, insetMm * 0.85)) * MM_TO_PT;
      page.drawText(cleanText, {
        x: xPt,
        y: yPt,
        size: fontSize,
        font,
        color: black,
      });
    }
  }
}

/**
 * Export ONE multi-page PRINT.pdf + N individual single-page CUT_TRANG_k.pdf files
 * (Condition 6 & 8: 1 PRINT PDF 7 trang + 7 CUT PDF riêng, mỗi file được kiểm định độc lập
 * MediaBox/CropBox, dấu boong, 100% đường Bézier, Hausdorff, valley depth, 0 kinks, 0 collisions).
 *
 * Always releases temporary output resources from ResourceStore in `finally` to prevent RAM leaks.
 */
async function applySpotCutContourToCutPage(doc, page, spotName = 'CutContour') {
  const csTag = ensureSpotCutContourColorSpace(doc, page, spotName);
  // Rewrite only the CUT stroke color command (e.g. "0 1 0 0 K" or "1 0 0 RG") to "/CS_CutContour CS 1 SCN"
  // without altering a single Bézier coordinate or command.
  const rawContents = page.node.get(PDFName.of('Contents'));
  if (!rawContents) return;
  const resolvedContents = doc.context.lookup(rawContents);
  const refs =
    resolvedContents instanceof PDFArray ||
    (resolvedContents && typeof resolvedContents.size === 'function' && typeof resolvedContents.get === 'function')
      ? Array.from({ length: resolvedContents.size() }, (_, i) => resolvedContents.get(i))
      : [rawContents];

  const inflateBytes = async (raw, isFlate) => {
    if (!isFlate) return new TextDecoder('latin1').decode(raw);
    if (typeof globalThis.DecompressionStream === 'function') {
      try {
        const ds = new globalThis.DecompressionStream('deflate');
        const w = ds.writable.getWriter();
        const wp = w.write(raw).then(() => w.close()).catch(() => { });
        const chunks = [];
        const r = ds.readable.getReader();
        while (true) {
          const { done, value } = await r.read();
          if (done) break;
          chunks.push(value);
        }
        await wp;
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return new TextDecoder('latin1').decode(out);
      } catch {
        // plain stream
      }
    }
    return new TextDecoder('latin1').decode(raw);
  };

  for (let i = 0; i < refs.length; i++) {
    const streamObj = doc.context.lookup(refs[i]);
    if (!streamObj || typeof streamObj.getContents !== 'function') continue;
    const flt = streamObj.dict?.get?.(PDFName.of('Filter'));
    const isFlate = Boolean(flt && String(flt.toString()).includes('FlateDecode'));
    const text = await inflateBytes(streamObj.getContents(), isFlate);
    if (!/\bc\b/.test(text)) continue; // only rewrite streams containing Bézier CUT paths
    const replaced = text.replace(
      /(?:^|\n)(?:1(?:\.0+)?\s+0(?:\.0+)?\s+0(?:\.0+)?\s+RG|0(?:\.0+)?\s+1(?:\.0+)?\s+0(?:\.0+)?\s+0(?:\.0+)?\s+K|0\.88\d*\s+0\.11\d*\s+0\.28\d*\s+RG)(?=\s|$)/g,
      `\n/${csTag} CS\n1 SCN`
    );
    if (replaced !== text) {
      const encoded = new TextEncoder().encode(replaced);
      const newStream = PDFRawStream.of(doc.context.obj({ Length: PDFNumber.of(encoded.length) }), encoded);
      doc.context.assign(refs[i], newStream);
    }
  }
}

export async function exportV1StickerBatchBundle({
  v1PlanState,
  baseName = 'tem',
  verifyEachCutPage = true,
  includeLayeredAi = false,
} = {}) {
  const res = await exportV1StickerTabOutputs({ v1PlanState, role: 'print' });
  const store = v1PlanState.resourceStore;
  const safeBase = (baseName || 'tem').replace(/\.[^.]+$/, '');
  const pontType = v1PlanState.pontType || 'graphtec';
  const machineProfileId = v1PlanState.machineProfileId || null;
  const requireSpotCutContour = Boolean(v1PlanState.requireSpotCutContour);
  const showSlugLine = v1PlanState.showSlugLine !== false;

  try {
    const printRid = res.output?.print?.resourceId;
    const cutRid = res.output?.cut?.resourceId;
    if (!printRid || !cutRid || !store.has(printRid) || !store.has(cutRid)) {
      throw new Error('Thiếu dữ liệu PRINT.pdf hoặc CUT.pdf sau bước kiểm định V1.');
    }

    const rawPrintBytes = new Uint8Array(await store.getBlob(printRid).arrayBuffer());
    const cutCombinedPdfBytes = new Uint8Array(await store.getBlob(cutRid).arrayBuffer());

    const imp = v1PlanState.checkpoint.batchPlan.impositionPlan;
    const profile = imp.productionProfile;
    const runCountsByTpl = v1PlanState.checkpoint.batchPlan.productionOrderManifest?.runCountsByTemplateId || {};
    const expectedSheets = imp.sheets.length;

    // Stamp Graphtec L-marks (or selected pontType) + top Slug Line onto PRINT.pdf
    const printDoc = await PDFDocument.load(rawPrintBytes);
    const helvetica = showSlugLine ? await printDoc.embedFont(StandardFonts.Helvetica) : null;
    for (let sIdx = 0; sIdx < Math.min(expectedSheets, printDoc.getPageCount()); sIdx++) {
      const sheet = imp.sheets[sIdx];
      const runCnt = Math.max(1, Number(runCountsByTpl[sheet.templateId]) || 1);
      const slugText = `${safeBase} - ${sheet.widthMm}x${sheet.heightMm}mm - ${sheet.placements.length} tem/to - ${runCnt} copy - ${expectedSheets}/ ${sIdx + 1}`;
      stampShopMarksAndSlugOnPage({
        page: printDoc.getPage(sIdx),
        sheet,
        profile,
        pontType,
        showSlugLine,
        slugText,
        font: helvetica,
        isCut: false,
      });
    }
    const printPdfBytes = await printDoc.save();

    const srcCutDoc = await PDFDocument.load(cutCombinedPdfBytes);
    if (srcCutDoc.getPageCount() !== expectedSheets) {
      throw new Error(
        `Số trang CUT.pdf (${srcCutDoc.getPageCount()}) không khớp số tờ trong BatchPlan (${expectedSheets}).`
      );
    }

    const PT_TO_MM = 25.4 / 72;
    const cutPageFiles = [];

    for (let sIdx = 0; sIdx < expectedSheets; sIdx++) {
      const sheet = imp.sheets[sIdx];
      const singleDoc = await PDFDocument.create();
      const [copiedPage] = await singleDoc.copyPages(srcCutDoc, [sIdx]);
      singleDoc.addPage(copiedPage);

      if (requireSpotCutContour) {
        await applySpotCutContourToCutPage(singleDoc, singleDoc.getPage(0), 'CutContour');
      }

      // Stamp matching Graphtec L-marks (or selected pontType) on CUT page BEFORE post-export verification
      stampShopMarksAndSlugOnPage({
        page: singleDoc.getPage(0),
        sheet,
        profile,
        pontType,
        showSlugLine: false,
        isCut: true,
      });

      const singleBytes = await singleDoc.save();

      // Independently verify MediaBox, CropBox, marks, and Bézier geometry on EACH split CUT PDF
      let verification = null;
      if (verifyEachCutPage) {
        const reloaded = await PDFDocument.load(singleBytes);
        const pg = reloaded.getPage(0);
        const mb = pg.getMediaBox();
        const cb = pg.getCropBox();
        const mbWmm = mb.width * PT_TO_MM;
        const mbHmm = mb.height * PT_TO_MM;
        const cbWmm = cb.width * PT_TO_MM;
        const cbHmm = cb.height * PT_TO_MM;
        if (
          Math.abs(mbWmm - sheet.widthMm) > 0.05 ||
          Math.abs(mbHmm - sheet.heightMm) > 0.05 ||
          Math.abs(cbWmm - sheet.widthMm) > 0.05 ||
          Math.abs(cbHmm - sheet.heightMm) > 0.05
        ) {
          throw new Error(
            `CUT_TRANG_${sIdx + 1}.pdf có MediaBox/CropBox (${mbWmm.toFixed(2)}×${mbHmm.toFixed(2)}mm) không khớp tờ (${sheet.widthMm}×${sheet.heightMm}mm).`
          );
        }

        const singleSheetPlan = {
          ...imp,
          sheets: [sheet],
        };
        const sheetJobIds = new Set(sheet.placements.map((p) => p.jobId));
        const sheetJobs = v1PlanState.jobs.filter((j) => sheetJobIds.has(j.jobId));
        verification = await verifyExportedCutPdfGeometry({
          cutPdfBytes: singleBytes,
          impositionPlan: singleSheetPlan,
          jobs: sheetJobs,
        });
        if (verification.status !== 'PASS') {
          const reason = verification.blockers?.[0]?.message || 'Lỗi hình học CUT PDF tách trang';
          throw new Error(`Hậu kiểm CUT_TRANG_${sIdx + 1}.pdf thất bại (BLOCK): ${reason}`);
        }
      }

      cutPageFiles.push({
        pageNumber: sIdx + 1,
        fileName: `PrintKitV1_FileBe_${safeBase}_TRANG_${sIdx + 1}.pdf`,
        bytes: singleBytes,
        widthMm: sheet.widthMm,
        heightMm: sheet.heightMm,
        placementCount: sheet.placements.length,
        verification,
      });
    }

    const aiFiles = includeLayeredAi
      ? await exportLayeredAiFiles({
        v1PlanState,
        printPdfBytes,
        pontType,
        requireSpotCutContour: true,
        spotColorName: 'CutContour',
        baseFileName: safeBase,
      })
      : [];

    const dualReports = await validateMachineCompatibility({
      v1PlanState,
      cutPageFiles,
      machineProfileId,
      pontType,
      requireSpotCutContour,
    });

    return {
      printPdfBytes,
      cutCombinedPdfBytes,
      cutPageFiles,
      aiFiles,
      geometryReport: dualReports.geometryReport,
      machineReport: dualReports.machineReport,
      finalCheck: res.finalCheck,
      postExportVerification: res.postExportVerification,
    };
  } finally {
    if (res?.output && store) {
      releaseCheckpointKOutput(store, res.output);
    }
  }
}
