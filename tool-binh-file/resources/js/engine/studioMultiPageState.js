/**
 * PrintKit V1 — Multi-Page Studio State Machine & Handoff Guard
 *
 * Strictly separates:
 *   PDF_LOADED -> PREVIEW_READY -> CUT_READY -> BLEED_READY (or NO_CUT / ERROR)
 * per individual PDF page, preventing cross-page contour contamination and
 * guaranteeing that handoff to Bình Tem V1 only uses pages with verified
 * Artwork + CUT + BLEED matching the active bleed configuration.
 */

export const PAGE_STAGE = Object.freeze({
  PDF_LOADED: 'PDF_LOADED',
  PREVIEW_READY: 'PREVIEW_READY',
  CUT_READY: 'CUT_READY',
  BLEED_READY: 'BLEED_READY',
  NO_CUT: 'NO_CUT',
  ERROR: 'ERROR',
});

export const PAGE_STAGE_META = Object.freeze({
  [PAGE_STAGE.PDF_LOADED]: {
    label: 'PDF Loaded',
    shortLabel: 'Chưa bóc',
    tone: 'slate',
  },
  [PAGE_STAGE.PREVIEW_READY]: {
    label: 'Preview Ready',
    shortLabel: 'Preview',
    tone: 'sky',
  },
  [PAGE_STAGE.CUT_READY]: {
    label: 'CUT Ready',
    shortLabel: 'CUT (chờ Bleed)',
    tone: 'amber',
  },
  [PAGE_STAGE.BLEED_READY]: {
    label: 'BLEED Ready',
    shortLabel: 'Sẵn sàng',
    tone: 'emerald',
  },
  [PAGE_STAGE.NO_CUT]: {
    label: 'Không có CUT',
    shortLabel: 'Không có tem',
    tone: 'rose',
  },
  [PAGE_STAGE.ERROR]: {
    label: 'Lỗi bóc tách',
    shortLabel: 'Lỗi',
    tone: 'rose',
  },
});

export function computeFileSignature(bytes, fileName = '') {
  if (!bytes || !bytes.byteLength) return `empty:${fileName}`;
  const len = bytes.byteLength;
  const mid = len >> 1;
  return `${fileName}|${len}|${bytes[0]}|${bytes[mid]}|${bytes[len - 1]}`;
}

function serializePerStickerOverrides(perStickerOverrides) {
  if (!perStickerOverrides || typeof perStickerOverrides !== 'object') return '-';
  const keys = Object.keys(perStickerOverrides).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return '-';
  return keys
    .map((k) => {
      const o = perStickerOverrides[k] || {};
      return `${k}:${o.shapeMode || ''}:${o.offsetMm ?? ''}:${o.hidden ? 1 : 0}`;
    })
    .join(',');
}

function serializeMergedGroups(mergedGroups) {
  if (!Array.isArray(mergedGroups) || mergedGroups.length === 0) return '-';
  const parts = mergedGroups
    .map((grp) =>
      Array.isArray(grp)
        ? [...new Set(grp.map((v) => Number(v)).filter(Number.isFinite))].sort((a, b) => a - b).join('+')
        : ''
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join(';') : '-';
}

export function computeGlobalBleedSettingsSignature({
  offsetMm = 0,
  bleedOffsetMm = 0,
  showBleedContour = true,
  contourBleedFillMode = 'auto',
  contourBleedColorHex = '#ffffff',
  shapeMode = 'auto',
  dielineMode = 'original',
  inputMode = 'multi',
  detailMode = 'standard',
  shadowRemovalMode = 'keep',
  antiAliasPct = 50,
  fidelityPct = 50,
  cornerRadiusMm = 0,
  minAreaMm2 = 8.0,
  mergeGapMm = 0.35,
  forceRasterFallback = false,
} = {}) {
  const effBleed = showBleedContour ? Number(bleedOffsetMm) || 0 : 0;
  const fillMode = showBleedContour && effBleed > 0 ? String(contourBleedFillMode || 'auto') : 'off';
  const fillHex = fillMode === 'solid' ? String(contourBleedColorHex || '#ffffff').toLowerCase() : '-';
  return [
    `off=${(Number(offsetMm) || 0).toFixed(4)}`,
    `bld=${effBleed.toFixed(4)}`,
    `fill=${fillMode}`,
    `hex=${fillHex}`,
    `shp=${String(shapeMode || 'auto')}`,
    `die=${String(dielineMode || 'original')}`,
    `in=${String(inputMode || 'multi')}`,
    `det=${String(detailMode || 'standard')}`,
    `shd=${String(shadowRemovalMode || 'keep')}`,
    `aa=${Math.round(Number(antiAliasPct) || 0)}`,
    `fid=${Math.round(Number(fidelityPct) || 0)}`,
    `cr=${(Number(cornerRadiusMm) || 0).toFixed(3)}`,
    `area=${(Number(minAreaMm2) || 0).toFixed(2)}`,
    `gap=${(Number(mergeGapMm) || 0).toFixed(2)}`,
    `rst=${forceRasterFallback ? 1 : 0}`,
  ].join('|');
}

export function computePageEditSignature({
  perStickerOverrides = null,
  manualMaskRevision = 0,
  mergedGroups = null,
  selectionScope = 'all',
  selectedIndices = null,
  selectedStickerIndices = null,
} = {}) {
  const selScope = selectionScope === 'selected' ? 'selected' : 'all';
  const selSource = selectedIndices ?? selectedStickerIndices;
  const selIds =
    selScope === 'selected' && Array.isArray(selSource)
      ? [...new Set(selSource.map((v) => Number(v)).filter(Number.isFinite))].sort((a, b) => a - b)
      : [];
  const selList = selIds.length > 0 ? selIds.join(',') : '-';
  return [
    `ovr=${serializePerStickerOverrides(perStickerOverrides)}`,
    `msk=${Number(manualMaskRevision) || 0}`,
    `mrg=${serializeMergedGroups(mergedGroups)}`,
    `scp=${selScope}:${selList}`,
  ].join('|');
}

export function computeBleedSettingsSignature(params = {}) {
  return `${computeGlobalBleedSettingsSignature(params)}|${computePageEditSignature(params)}`;
}

export function createInitialPageStates(totalPages, fileSignature) {
  const map = {};
  const n = Math.max(0, Math.floor(Number(totalPages) || 0));
  for (let p = 1; p <= n; p++) {
    map[p] = {
      pageNum: p,
      fileSignature,
      stage: PAGE_STAGE.PDF_LOADED,
      hasPreview: false,
      hasCut: false,
      hasBleed: false,
      contourCount: 0,
      bleedSignature: null,
      pageEditSignature: null,
      errorMessage: null,
    };
  }
  return map;
}

/**
 * Strict ownership guard: guarantees CUT/vector data truly belongs to `expectedPageNum`
 * of the active `expectedFileSignature`. Never allows Page A's contours on Page B.
 */
export function validatePageOwnership({
  expectedPageNum,
  expectedFileSignature,
  actualFileSignature,
  vecRes,
}) {
  if (!expectedFileSignature || actualFileSignature !== expectedFileSignature) {
    return {
      ok: false,
      reason: `Dữ liệu không thuộc file PDF hiện tại (trang ${expectedPageNum}).`,
    };
  }
  if (vecRes && vecRes.pageNumber != null && Number(vecRes.pageNumber) !== Number(expectedPageNum)) {
    return {
      ok: false,
      reason: `Lệch trang vector: yêu cầu trang ${expectedPageNum} nhưng nhận trang ${vecRes.pageNumber}.`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Compute effective display & handoff stage for a page given current global bleed settings
 * and (optionally) that page's own per-page edit signature.
 * - Changing a global bleed setting downgrades pages with stale `bleedSignature` to CUT_READY.
 * - Changing a per-page edit ONLY invalidates the page whose `pageEditSignature` differs.
 */
export function getEffectivePageStage(pageRecord, currentBleedSignature, currentPageEditSignature = undefined) {
  if (!pageRecord) return PAGE_STAGE.PDF_LOADED;
  if (pageRecord.stage === PAGE_STAGE.ERROR) return PAGE_STAGE.ERROR;
  if (pageRecord.stage === PAGE_STAGE.NO_CUT) return PAGE_STAGE.NO_CUT;
  const isNoDieline = pageRecord.dielineMode === 'none';
  const hasValidContours = pageRecord.contourCount > 0 || isNoDieline;
  const globalSigMatch = pageRecord.bleedSignature === currentBleedSignature;
  const pageEditSigMatch =
    currentPageEditSignature === undefined || currentPageEditSignature === null
      ? true
      : pageRecord.pageEditSignature === currentPageEditSignature;
  if (
    pageRecord.hasPreview &&
    pageRecord.hasCut &&
    pageRecord.hasBleed &&
    hasValidContours &&
    globalSigMatch &&
    pageEditSigMatch
  ) {
    return PAGE_STAGE.BLEED_READY;
  }
  if (pageRecord.hasPreview && pageRecord.hasCut && hasValidContours) {
    return PAGE_STAGE.CUT_READY;
  }
  if (pageRecord.hasPreview) {
    return PAGE_STAGE.PREVIEW_READY;
  }
  return PAGE_STAGE.PDF_LOADED;
}

/**
 * Partition requested target pages for handoff to Bình Tem V1.
 * ONLY pages that are truly BLEED_READY (with matching fileSignature, pageNum,
 * global bleedSignature, per-page pageEditSignature, and valid cached Artwork + CUT + BLEED)
 * are included in `readyPages`.
 */
export function partitionPagesForHandoff({
  targetPages,
  pageStates,
  pageCacheMap,
  currentBleedSignature,
  pageEditSignatures = null,
  fileSignature,
}) {
  const readyPages = [];
  const unprocessedPages = [];
  const staleBleedPages = [];
  const invalidPages = [];

  for (const pNum of targetPages) {
    const rec = pageStates?.[pNum];
    const cached = pageCacheMap instanceof Map ? pageCacheMap.get(pNum) : pageCacheMap?.[pNum];
    let expectedPageEditSig;
    if (pageEditSignatures instanceof Map && pageEditSignatures.has(pNum)) {
      expectedPageEditSig = pageEditSignatures.get(pNum);
    } else if (
      pageEditSignatures &&
      !(pageEditSignatures instanceof Map) &&
      typeof pageEditSignatures === 'object' &&
      Object.prototype.hasOwnProperty.call(pageEditSignatures, pNum)
    ) {
      expectedPageEditSig = pageEditSignatures[pNum];
    } else if (rec?.pageEditSignature != null && cached) {
      expectedPageEditSig = computePageEditSignature({
        perStickerOverrides: cached.perStickerOverrides,
        manualMaskRevision: cached.manualMaskRevision,
        mergedGroups: cached.mergedGroups,
        selectionScope: cached.selectionScope,
        selectedIndices: cached.selectedIndices ?? cached.selectedStickerIndices,
      });
    }
    const stage = getEffectivePageStage(rec, currentBleedSignature, expectedPageEditSig);

    if (stage === PAGE_STAGE.NO_CUT || stage === PAGE_STAGE.ERROR) {
      invalidPages.push({
        pageNum: pNum,
        stage,
        reason: rec?.errorMessage || 'Trang không có đường bế vector hợp lệ',
      });
      continue;
    }

    if (stage === PAGE_STAGE.PDF_LOADED || stage === PAGE_STAGE.PREVIEW_READY) {
      unprocessedPages.push({ pageNum: pNum, stage });
      continue;
    }

    if (stage === PAGE_STAGE.CUT_READY) {
      staleBleedPages.push({ pageNum: pNum, stage });
      continue;
    }

    // stage === BLEED_READY: verify cached payload ownership & completeness
    const owner = validatePageOwnership({
      expectedPageNum: pNum,
      expectedFileSignature: fileSignature,
      actualFileSignature: cached?.fileSignature,
      vecRes: cached?.vecRes,
    });
    const artifactGlobalMatch = cached?.bleedArtifact?.bleedSignature === currentBleedSignature;
    const artifactEditMatch =
      expectedPageEditSig === undefined || expectedPageEditSig === null
        ? true
        : cached?.bleedArtifact?.pageEditSignature === expectedPageEditSig;
    const bleedArtifact =
      cached?.bleedArtifact && artifactGlobalMatch && artifactEditMatch
        ? cached.bleedArtifact
        : null;

    const isNoDielineArtifact = bleedArtifact?.dielineMode === 'none' || bleedArtifact?.contoursMm?.dielineSuppressed === true;
    if (
      !owner.ok ||
      !bleedArtifact ||
      !bleedArtifact.cleanArtworkBytes ||
      !bleedArtifact.cleanArtworkBytes.byteLength ||
      !Array.isArray(bleedArtifact.contoursMm) ||
      (!isNoDielineArtifact && bleedArtifact.contoursMm.length === 0) ||
      Number(bleedArtifact.pageNum) !== Number(pNum)
    ) {
      staleBleedPages.push({ pageNum: pNum, stage: PAGE_STAGE.CUT_READY });
      continue;
    }

    readyPages.push({
      pageNum: pNum,
      cleanArtworkCanvas: bleedArtifact.cleanArtworkCanvas,
      cleanArtworkBytes: bleedArtifact.cleanArtworkBytes,
      sourceSizeMm: bleedArtifact.sourceSizeMm,
      contoursMm: bleedArtifact.contoursMm,
      bleedOffsetMm: bleedArtifact.bleedOffsetMm,
      contourProvenance: bleedArtifact.contourProvenance,
    });
  }

  const warningParts = [];
  if (unprocessedPages.length > 0) {
    warningParts.push(
      `Chưa bóc tách (PDF Loaded): Trang ${unprocessedPages.map((x) => x.pageNum).join(', ')}`
    );
  }
  if (staleBleedPages.length > 0) {
    warningParts.push(
      `Chưa cập nhật BLEED theo thông số mới (CUT Ready): Trang ${staleBleedPages.map((x) => x.pageNum).join(', ')}`
    );
  }
  if (invalidPages.length > 0) {
    warningParts.push(
      `Không có đường bế hợp lệ (bỏ qua): Trang ${invalidPages.map((x) => x.pageNum).join(', ')}`
    );
  }

  return {
    readyPages,
    unprocessedPages,
    staleBleedPages,
    invalidPages,
    warningMessage: warningParts.length > 0 ? warningParts.join(' · ') : '',
  };
}
