/**
 * PrintKit V1 — Phase 3: PRINT/CUT Pair Preview, Overlay Deviation Check & Preview-vs-Export Parity Engine
 *
 * Pure, deterministic, browser- & Node-compatible module (ZERO edits to 17 LOCKED engine files).
 * Operates strictly on the ONE shared BatchPlan / previewPlan so PRINT Preview, CUT Preview,
 * Overlay Inspection, Pair Thumbnails, and Exported PDFs are always cross-checked from the same source.
 */

import { PDFDocument } from 'pdf-lib';

const PT_TO_MM = 25.4 / 72;

export const PAIR_VIEW_MODES = Object.freeze({
  SIDE_BY_SIDE: 'sideBySide',
  OVERLAY: 'overlay',
  SINGLE: 'single',
});

export const PARITY_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  WARNING: 'WARNING',
  MISMATCH: 'MISMATCH',
  NOT_EXPORTED: 'NOT_EXPORTED',
});

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

function fnv1aUpdate(h, str) {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Compute synchronized scroll position from a source viewport to a target viewport.
 * Preserves exact pixels when max scrollable ranges match, and falls back to ratio sync when they differ.
 */
export function computeSyncedScrollPosition({
  sourceScrollLeft = 0,
  sourceScrollTop = 0,
  sourceMaxX = 0,
  sourceMaxY = 0,
  targetMaxX = 0,
  targetMaxY = 0,
} = {}) {
  const sMaxX = Math.max(0, Number(sourceMaxX) || 0);
  const sMaxY = Math.max(0, Number(sourceMaxY) || 0);
  const tMaxX = Math.max(0, Number(targetMaxX) || 0);
  const tMaxY = Math.max(0, Number(targetMaxY) || 0);
  const sLeft = Math.max(0, Math.min(sMaxX, Number(sourceScrollLeft) || 0));
  const sTop = Math.max(0, Math.min(sMaxY, Number(sourceScrollTop) || 0));

  let targetScrollLeft = 0;
  if (tMaxX > 0 && sMaxX > 0) {
    targetScrollLeft = Math.abs(sMaxX - tMaxX) <= 1 ? sLeft : (sLeft / sMaxX) * tMaxX;
  }
  let targetScrollTop = 0;
  if (tMaxY > 0 && sMaxY > 0) {
    targetScrollTop = Math.abs(sMaxY - tMaxY) <= 1 ? sTop : (sTop / sMaxY) * tMaxY;
  }

  return {
    scrollLeft: Math.round(Math.max(0, Math.min(tMaxX, targetScrollLeft))),
    scrollTop: Math.round(Math.max(0, Math.min(tMaxY, targetScrollTop))),
  };
}

/**
 * Deterministic zoom stepping shared by mouse wheel (either PRINT or CUT pane) and toolbar buttons.
 */
export function computeSyncedZoom(currentZoom = 1.0, deltaTicks = 0, { min = 0.35, max = 10.0 } = {}) {
  const ticks = Math.max(-5, Math.min(5, Math.trunc(Number(deltaTicks) || 0)));
  let z = Number.isFinite(Number(currentZoom)) ? Number(currentZoom) : 1.0;
  for (let i = 0; i < Math.abs(ticks); i++) {
    const step = z >= 2.5 ? 0.35 : z >= 1.5 ? 0.22 : 0.15;
    z += ticks > 0 ? step : -step;
  }
  return Math.round(Math.min(max, Math.max(min, z)) * 100) / 100;
}

/**
 * Compute tight bounding box (mm) of a cubic Bézier command list or polygon point array.
 * Samples cubic Bézier segments finely so extrema are accurately captured.
 */
export function computePathBoundsMm(pathObj) {
  if (!pathObj) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const pushPt = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  const beziers = Array.isArray(pathObj)
    ? pathObj[0]?.type
      ? pathObj
      : null
    : Array.isArray(pathObj.beziersMm)
    ? pathObj.beziersMm
    : null;

  if (beziers && beziers.length > 0) {
    let cur = [0, 0];
    for (const cmd of beziers) {
      if ((cmd.type === 'M' || cmd.type === 'L') && cmd.to) {
        pushPt(cmd.to[0], cmd.to[1]);
        cur = cmd.to;
      } else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
        const [x0, y0] = cur;
        const [x1, y1] = cmd.c1;
        const [x2, y2] = cmd.c2;
        const [x3, y3] = cmd.to;
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          const bx = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const by = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          pushPt(bx, by);
        }
        cur = cmd.to;
      }
    }
  } else if (pathObj.kind === 'rect') {
    pushPt(pathObj.x, pathObj.y);
    pushPt((pathObj.x || 0) + (pathObj.w || 0), (pathObj.y || 0) + (pathObj.h || 0));
  } else if (pathObj.kind === 'ellipse') {
    pushPt((pathObj.cx || 0) - (pathObj.rx || 0), (pathObj.cy || 0) - (pathObj.ry || 0));
    pushPt((pathObj.cx || 0) + (pathObj.rx || 0), (pathObj.cy || 0) + (pathObj.ry || 0));
  } else {
    const pts = Array.isArray(pathObj) ? pathObj : Array.isArray(pathObj.pts) ? pathObj.pts : null;
    if (pts) {
      for (const pt of pts) {
        if (Array.isArray(pt) && pt.length >= 2) pushPt(pt[0], pt[1]);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    minX: r4(minX),
    minY: r4(minY),
    maxX: r4(maxX),
    maxY: r4(maxY),
    w: r4(maxX - minX),
    h: r4(maxY - minY),
    cx: r4((minX + maxX) / 2),
    cy: r4((minY + maxY) / 2),
  };
}

/**
 * Analyze Artwork (PRINT) vs CutContour (CUT) geometric registration on a sheet
 * for the Overlay Deviation Inspection view.
 */
export function analyzeArtworkCutOverlay(sheet, { maxAllowedDeltaMm = 0.05 } = {}) {
  if (!sheet || typeof sheet !== 'object') {
    return {
      status: 'WARNING',
      checkedPlacements: 0,
      matchedCutPaths: 0,
      unmatchedCount: 0,
      maxCenterDeltaMm: 0,
      maxBoundsDeltaMm: 0,
      maxMarkDeltaMm: 0,
      minBleedMarginMm: null,
      issues: [{ code: 'EMPTY_SHEET', severity: 'WARNING', message: 'Chưa có tờ bình để kiểm tra chồng lớp.' }],
    };
  }

  const placements = Array.isArray(sheet.placements) ? sheet.placements : [];
  const cutPaths = Array.isArray(sheet.stickerCutPaths) ? sheet.stickerCutPaths : [];
  const issues = [];

  if (placements.length === 0) {
    return {
      status: 'WARNING',
      checkedPlacements: 0,
      matchedCutPaths: 0,
      unmatchedCount: cutPaths.length,
      maxCenterDeltaMm: 0,
      maxBoundsDeltaMm: 0,
      maxMarkDeltaMm: 0,
      minBleedMarginMm: null,
      issues: [{ code: 'EMPTY_SHEET', severity: 'WARNING', message: 'Tờ bình chưa có tem nào để kiểm tra chồng lớp.' }],
    };
  }

  if (placements.length !== cutPaths.length) {
    issues.push({
      code: 'CUT_COUNT_MISMATCH',
      severity: 'FAIL',
      message: `Số lượng vùng IN (${placements.length}) khác số đường BẾ (${cutPaths.length}).`,
      printCount: placements.length,
      cutCount: cutPaths.length,
    });
  }

  let maxCenterDeltaMm = 0;
  let maxBoundsDeltaMm = 0;
  let minBleedMarginMm = Infinity;
  let matchedCutPaths = 0;
  const count = Math.min(placements.length, cutPaths.length);

  for (let i = 0; i < count; i++) {
    const p = placements[i];
    const cut = cutPaths[i];
    const cutBox = computePathBoundsMm(cut);
    if (!cutBox) {
      if (issues.length < 10) {
        issues.push({
          code: 'INVALID_CUT_PATH',
          severity: 'FAIL',
          placementIndex: i,
          jobId: p?.jobId || null,
          message: `Tem #${i + 1} có đường BẾ trống hoặc không đọc được tọa độ hình học.`,
        });
      }
      continue;
    }

    matchedCutPaths++;
    const pMinX = Number(p.x) || 0;
    const pMinY = Number(p.y) || 0;
    const pW = Number(p.trimW) || 0;
    const pH = Number(p.trimH) || 0;
    const pCx = pMinX + pW / 2;
    const pCy = pMinY + pH / 2;

    const dx = Math.abs(cutBox.cx - pCx);
    const dy = Math.abs(cutBox.cy - pCy);
    const centerDelta = Math.hypot(dx, dy);
    const boundsDelta = Math.max(
      Math.abs(cutBox.minX - pMinX),
      Math.abs(cutBox.minY - pMinY),
      Math.abs(cutBox.maxX - (pMinX + pW)),
      Math.abs(cutBox.maxY - (pMinY + pH))
    );

    if (centerDelta > maxCenterDeltaMm) maxCenterDeltaMm = centerDelta;
    if (boundsDelta > maxBoundsDeltaMm) maxBoundsDeltaMm = boundsDelta;

    if (centerDelta > maxAllowedDeltaMm || boundsDelta > maxAllowedDeltaMm * 1.5) {
      if (issues.length < 10) {
        issues.push({
          code: 'ALIGNMENT_DEVIATION',
          severity: 'FAIL',
          placementIndex: i,
          jobId: p.jobId || null,
          centerDeltaMm: r4(centerDelta),
          boundsDeltaMm: r4(boundsDelta),
          message: `Tem #${i + 1} lệch tâm ${r4(centerDelta)}mm / lệch biên ${r4(boundsDelta)}mm giữa Artwork và CUT.`,
        });
      }
    }

    if (Array.isArray(p.bleedBeziersMm) && p.bleedBeziersMm.length >= 2) {
      const bleedBox = computePathBoundsMm(p.bleedBeziersMm);
      if (bleedBox) {
        const margin = Math.min(
          cutBox.minX - bleedBox.minX,
          cutBox.minY - bleedBox.minY,
          bleedBox.maxX - cutBox.maxX,
          bleedBox.maxY - cutBox.maxY
        );
        if (margin < minBleedMarginMm) minBleedMarginMm = margin;
        if (margin < -0.02 && issues.length < 10) {
          issues.push({
            code: 'BLEED_UNDERSHOOT',
            severity: 'WARNING',
            placementIndex: i,
            marginMm: r4(margin),
            message: `Tem #${i + 1}: đường BẾ vượt ra ngoài vùng BLEED (${r4(margin)}mm).`,
          });
        }
      }
    }
  }

  // Cross-check registration marks parity between PRINT and CUT
  const printMarks = Array.isArray(sheet.pontMarks) ? sheet.pontMarks : [];
  const cutMarks = Array.isArray(sheet.stickerPontMarks) ? sheet.stickerPontMarks : printMarks;
  let maxMarkDeltaMm = 0;
  if (printMarks.length !== cutMarks.length) {
    issues.push({
      code: 'MARK_PARITY_MISMATCH',
      severity: 'FAIL',
      message: `Số boong định vị IN (${printMarks.length}) khác BẾ (${cutMarks.length}).`,
    });
  } else {
    for (let i = 0; i < printMarks.length; i++) {
      const pm = printMarks[i];
      const cm = cutMarks[i];
      const d = Math.hypot((Number(pm.cx) || 0) - (Number(cm.cx) || 0), (Number(pm.cy) || 0) - (Number(cm.cy) || 0));
      if (d > maxMarkDeltaMm) maxMarkDeltaMm = d;
      if (d > 0.01) {
        issues.push({
          code: 'MARK_PARITY_MISMATCH',
          severity: 'FAIL',
          corner: pm.corner || i,
          deltaMm: r4(d),
          message: `Boong ${pm.corner || i + 1} lệch ${r4(d)}mm giữa PRINT và CUT.`,
        });
      }
    }
  }

  const hasFail = issues.some((it) => it.severity === 'FAIL');
  const hasWarn = issues.some((it) => it.severity === 'WARNING');
  return {
    status: hasFail ? 'FAIL' : hasWarn ? 'WARNING' : 'PASS',
    checkedPlacements: placements.length,
    matchedCutPaths,
    unmatchedCount: Math.abs(placements.length - cutPaths.length),
    maxCenterDeltaMm: r4(maxCenterDeltaMm),
    maxBoundsDeltaMm: r4(maxBoundsDeltaMm),
    maxMarkDeltaMm: r4(maxMarkDeltaMm),
    minBleedMarginMm: Number.isFinite(minBleedMarginMm) ? r4(minBleedMarginMm) : null,
    issues,
  };
}

/**
 * Convert a preview CUT path into a compact SVG `d` string (sheet-mm coordinates)
 * for crisp vector mini-thumbnails in the Pair Thumbnail strip.
 */
export function buildCutPathSvgD(cp) {
  if (!cp) return '';
  const f = (n) => (Number.isFinite(n) ? Number(n).toFixed(2) : '0');
  if (cp.kind === 'bezier' && Array.isArray(cp.beziersMm) && cp.beziersMm.length >= 2) {
    const parts = [];
    for (const cmd of cp.beziersMm) {
      if (cmd.type === 'M' && cmd.to) parts.push(`M${f(cmd.to[0])} ${f(cmd.to[1])}`);
      else if (cmd.type === 'L' && cmd.to) parts.push(`L${f(cmd.to[0])} ${f(cmd.to[1])}`);
      else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
        parts.push(`C${f(cmd.c1[0])} ${f(cmd.c1[1])} ${f(cmd.c2[0])} ${f(cmd.c2[1])} ${f(cmd.to[0])} ${f(cmd.to[1])}`);
      }
    }
    if (cp.closed) parts.push('Z');
    return parts.join(' ');
  }
  if (cp.kind === 'poly' && Array.isArray(cp.pts) && cp.pts.length >= 2) {
    const parts = cp.pts.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`);
    if (cp.closed) parts.push('Z');
    return parts.join(' ');
  }
  if (cp.kind === 'rect') {
    const x = cp.x || 0;
    const y = cp.y || 0;
    const w = cp.w || 0;
    const h = cp.h || 0;
    return `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;
  }
  if (cp.kind === 'ellipse') {
    const cx = cp.cx || 0;
    const cy = cp.cy || 0;
    const rx = Math.max(0.1, cp.rx || 0);
    const ry = Math.max(0.1, cp.ry || 0);
    return `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;
  }
  return '';
}

/**
 * Build Pair Thumbnail descriptors for every sheet pair (PRINT + CUT) in the active plan.
 */
export function buildPairThumbnailsModel(previewPlan, { parityReport = null } = {}) {
  const sheets = Array.isArray(previewPlan?.sheets) ? previewPlan.sheets : [];
  const parityBySheet = new Map();
  if (Array.isArray(parityReport?.sheetChecks)) {
    for (const sc of parityReport.sheetChecks) {
      parityBySheet.set(sc.sheetIndex, sc);
    }
  }

  return sheets.map((sh, idx) => {
    const overlay = analyzeArtworkCutOverlay(sh);
    const cutPaths = Array.isArray(sh.stickerCutPaths) ? sh.stickerCutPaths : [];
    // Cap SVG paths per mini-thumbnail at 140 for instant rendering even on ultra-dense sheets
    const cutSvgPaths = cutPaths.slice(0, 140).map(buildCutPathSvgD).filter(Boolean);
    const placementRects = (sh.placements || []).slice(0, 140).map((p) => ({
      x: r4(p.x),
      y: r4(p.y),
      w: r4(p.trimW),
      h: r4(p.trimH),
      artworkPageIdx: p.artworkPageIdx ?? p.pageIndex ?? 0,
    }));
    const paritySheet = parityBySheet.get(idx) || null;
    const sheetW = Number(sh.widthMm) || Number(previewPlan?.sheetDim?.width) || 330;
    const sheetH = Number(sh.heightMm) || Number(previewPlan?.sheetDim?.height) || 390;

    return {
      sheetIndex: idx,
      sheetNumber: sh.sheetNumber || idx + 1,
      runCount: Math.max(1, Number(sh.runCount) || 1),
      widthMm: sheetW,
      heightMm: sheetH,
      placementCount: sh.placements?.length || 0,
      cutPathCount: cutPaths.length,
      markCount: sh.pontMarks?.length || 0,
      pontMarks: sh.pontMarks || [],
      placementRects,
      cutSvgPaths,
      clusterLabel: sh.clusterLabel || null,
      overlayStatus: overlay.status,
      maxOverlayDeltaMm: overlay.maxCenterDeltaMm,
      parityStatus: paritySheet?.status || parityReport?.status || PARITY_STATUS.NOT_EXPORTED,
    };
  });
}

/**
 * Compute a deterministic parity signature representing everything currently displayed in Preview
 * (geometry, sheet dimensions, placements, marks, trim marks, paper guides, slug, spot color, profile).
 */
export function computePreviewPlanParitySignature(v1PlanState) {
  if (!v1PlanState?.supported || !v1PlanState?.previewPlan) return null;
  const imp = v1PlanState.checkpoint?.batchPlan?.impositionPlan || null;
  const manifest = v1PlanState.checkpoint?.batchPlan?.productionOrderManifest || null;
  const sheets = v1PlanState.previewPlan.sheets || [];

  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const feed = (token) => {
    h1 = fnv1aUpdate(h1, token);
    h2 = fnv1aUpdate(h2, token);
  };

  feed(`plan:${imp?.planHash || 'none'}|fresh:${manifest?.batchFreshnessHash || 'none'}|`);
  feed(`pont:${v1PlanState.pontType || 'none'}|mp:${v1PlanState.machineProfileId || ''}|spot:${v1PlanState.requireSpotCutContour ? 1 : 0}|`);
  feed(`slug:${v1PlanState.showSlugLine !== false ? 1 : 0}|tm:${v1PlanState.stickerTrimMarks || 'none'}|pg:${v1PlanState.showPaperGuides ? 1 : 0}|`);
  feed(`sheets:${sheets.length}|`);

  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    feed(`S${i}:${r4(sh.widthMm)}x${r4(sh.heightMm)}:rc=${sh.runCount || 1}:pl=${sh.placements?.length || 0}:cut=${sh.stickerCutPaths?.length || 0}:mk=${sh.pontMarks?.length || 0}:tm=${sh.v1TrimMarks?.length || 0}:pg=${sh.paperGuides?.length || 0}:slug=${sh.slugText || ''}|`);
    for (const pm of sh.pontMarks || []) {
      feed(`M:${pm.corner}:${pm.type}:${r4(pm.cx)},${r4(pm.cy)},${r4(pm.size)}|`);
    }
    for (const pl of sh.placements || []) {
      feed(`P:${pl.jobId || ''}:${r4(pl.x)},${r4(pl.y)},${r4(pl.trimW)}x${r4(pl.trimH)}@${pl.rotate || 0}|`);
    }
  }

  return `PRV-${sheets.length}-${h1.toString(16)}-${h2.toString(16)}`;
}

/**
 * Cross-check Preview plan against the latest exported PRINT.pdf & CUT_TRANG_k.pdf artifacts.
 * Detects BOTH:
 *  1. Live staleness (user edited parameters after exporting -> STALE_EXPORT_VS_PREVIEW)
 *  2. Real serialized PDF byte discrepancies (page count, MediaBox size, placement count,
 *     post-export Hausdorff / serialized alignment deviation, blocked export).
 */
export async function checkPreviewVsExportParity({
  v1PlanState,
  lastExport = null,
  exportedPrintPdfBytes = null,
  exportedCutPageFiles = null,
  dimToleranceMm = 0.05,
  geometryToleranceMm = 0.02,
} = {}) {
  const currentSignature = computePreviewPlanParitySignature(v1PlanState);
  const previewSheets = v1PlanState?.previewPlan?.sheets || [];
  const discrepancies = [];
  const sheetChecks = [];

  if (!v1PlanState?.supported || previewSheets.length === 0) {
    return {
      status: PARITY_STATUS.MISMATCH,
      inSync: false,
      currentSignature,
      exportedSignature: lastExport?.previewParitySignature || null,
      discrepancies: [
        {
          code: 'NO_VALID_PREVIEW_PLAN',
          severity: 'FAIL',
          message: 'Chưa có kế hoạch Preview V1 hợp lệ để đối chiếu với PDF xuất.',
        },
      ],
      sheetChecks: [],
      summaryMessage: 'Chưa có kế hoạch Preview V1 hợp lệ.',
    };
  }

  // If no export bytes and no lastExport record yet, return NOT_EXPORTED (informational)
  const hasExportData = Boolean(lastExport || exportedPrintPdfBytes || (Array.isArray(exportedCutPageFiles) && exportedCutPageFiles.length > 0));
  if (!hasExportData) {
    return {
      status: PARITY_STATUS.NOT_EXPORTED,
      inSync: true,
      currentSignature,
      exportedSignature: null,
      discrepancies: [],
      sheetChecks: previewSheets.map((sh, idx) => ({
        sheetIndex: idx,
        sheetNumber: sh.sheetNumber || idx + 1,
        status: PARITY_STATUS.NOT_EXPORTED,
      })),
      summaryMessage: 'Preview và Export dùng chung 1 BatchPlan V1/H.2 — xuất PDF để xác thực đối chiếu byte-level.',
    };
  }

  // 1. Live Staleness Check (Preview changed after last export)
  if (lastExport?.previewParitySignature && currentSignature && lastExport.previewParitySignature !== currentSignature) {
    discrepancies.push({
      code: 'STALE_EXPORT_VS_PREVIEW',
      severity: 'WARNING',
      message: 'Preview đã thay đổi sau lần xuất PDF gần nhất — file PDF đã tải trước đó không còn khớp Preview hiện tại, hãy xuất lại.',
      currentSignature,
      exportedSignature: lastExport.previewParitySignature,
    });
  }

  // 2. FinalCheck / Post-Export Verification Gate Status
  const finalStatus = lastExport?.status || lastExport?.finalCheck?.status || null;
  if (finalStatus === 'BLOCK') {
    discrepancies.push({
      code: 'EXPORT_BLOCKED',
      severity: 'FAIL',
      message: 'Lần xuất gần nhất bị chặn (BLOCK) bởi bộ kiểm định sản xuất — không được đưa xuống máy.',
    });
  }

  const maxAlignedDelta = Number(lastExport?.finalCheck?.metrics?.maxSerializedAlignmentDeltaMm);
  if (Number.isFinite(maxAlignedDelta) && maxAlignedDelta > geometryToleranceMm) {
    discrepancies.push({
      code: 'GEOMETRY_DEVIATION_EXCEEDED',
      severity: 'FAIL',
      deltaMm: r4(maxAlignedDelta),
      message: `Sai lệch căn chỉnh PRINT↔CUT trên PDF xuất (${r4(maxAlignedDelta)}mm) vượt ngưỡng ${geometryToleranceMm}mm.`,
    });
  }

  const maxHausdorff = Number(lastExport?.postExportVerification?.maxHausdorffMm);
  if (Number.isFinite(maxHausdorff) && maxHausdorff > geometryToleranceMm) {
    discrepancies.push({
      code: 'GEOMETRY_DEVIATION_EXCEEDED',
      severity: 'FAIL',
      maxHausdorffMm: r4(maxHausdorff),
      message: `Sai lệch hình học Bézier CUT.pdf (${r4(maxHausdorff)}mm) vượt ngưỡng ${geometryToleranceMm}mm.`,
    });
  }

  // 3. Deep Byte-Level Verification of Exported PRINT.pdf
  if (exportedPrintPdfBytes && exportedPrintPdfBytes.byteLength > 0) {
    try {
      const printDoc = await PDFDocument.load(exportedPrintPdfBytes, { ignoreEncryption: true });
      const pdfPageCount = printDoc.getPageCount();
      if (pdfPageCount !== previewSheets.length) {
        discrepancies.push({
          code: 'PAGE_COUNT_MISMATCH',
          severity: 'FAIL',
          role: 'PRINT',
          previewPages: previewSheets.length,
          exportedPages: pdfPageCount,
          message: `Số trang PRINT.pdf xuất (${pdfPageCount}) khác số tờ trên Preview (${previewSheets.length}).`,
        });
      }
      const checkCount = Math.min(pdfPageCount, previewSheets.length);
      for (let i = 0; i < checkCount; i++) {
        const pg = printDoc.getPage(i);
        const mb = pg.getMediaBox();
        const wMm = mb.width * PT_TO_MM;
        const hMm = mb.height * PT_TO_MM;
        const sh = previewSheets[i];
        const dw = Math.abs(wMm - sh.widthMm);
        const dh = Math.abs(hMm - sh.heightMm);
        const sizeOk = dw <= dimToleranceMm && dh <= dimToleranceMm;
        if (!sizeOk) {
          discrepancies.push({
            code: 'SHEET_SIZE_MISMATCH',
            severity: 'FAIL',
            role: 'PRINT',
            sheetIndex: i,
            previewSizeMm: { w: sh.widthMm, h: sh.heightMm },
            exportedSizeMm: { w: r4(wMm), h: r4(hMm) },
            message: `Tờ #${i + 1} PRINT.pdf (${r4(wMm)}×${r4(hMm)}mm) lệch khổ giấy so với Preview (${sh.widthMm}×${sh.heightMm}mm).`,
          });
        }
        sheetChecks.push({
          sheetIndex: i,
          sheetNumber: sh.sheetNumber || i + 1,
          printSizeOk: sizeOk,
          printSizeMm: { w: r4(wMm), h: r4(hMm) },
          status: sizeOk ? PARITY_STATUS.VERIFIED : PARITY_STATUS.MISMATCH,
        });
      }
    } catch (err) {
      discrepancies.push({
        code: 'INVALID_EXPORTED_PDF',
        severity: 'FAIL',
        role: 'PRINT',
        message: `Không đọc được PRINT.pdf xuất để đối chiếu: ${err?.message || 'Unknown error'}`,
      });
    }
  }

  // 4. Deep Byte-Level Verification of Exported CUT_TRANG_k.pdf files
  if (Array.isArray(exportedCutPageFiles) && exportedCutPageFiles.length > 0) {
    if (exportedCutPageFiles.length !== previewSheets.length) {
      discrepancies.push({
        code: 'PAGE_COUNT_MISMATCH',
        severity: 'FAIL',
        role: 'CUT',
        previewPages: previewSheets.length,
        exportedPages: exportedCutPageFiles.length,
        message: `Số file CUT PDF xuất (${exportedCutPageFiles.length}) khác số tờ trên Preview (${previewSheets.length}).`,
      });
    }
    const checkCount = Math.min(exportedCutPageFiles.length, previewSheets.length);
    for (let i = 0; i < checkCount; i++) {
      const cf = exportedCutPageFiles[i];
      const sh = previewSheets[i];
      let cutOk = true;

      if (Number.isFinite(cf.placementCount) && cf.placementCount !== sh.placements.length) {
        cutOk = false;
        discrepancies.push({
          code: 'PLACEMENT_COUNT_MISMATCH',
          severity: 'FAIL',
          role: 'CUT',
          sheetIndex: i,
          previewPlacements: sh.placements.length,
          exportedPlacements: cf.placementCount,
          message: `Tờ #${i + 1} CUT PDF có ${cf.placementCount} tem, khác Preview (${sh.placements.length} tem).`,
        });
      }

      if (cf.bytes && cf.bytes.byteLength > 0) {
        try {
          const cutDoc = await PDFDocument.load(cf.bytes, { ignoreEncryption: true });
          const mb = cutDoc.getPage(0).getMediaBox();
          const wMm = mb.width * PT_TO_MM;
          const hMm = mb.height * PT_TO_MM;
          if (Math.abs(wMm - sh.widthMm) > dimToleranceMm || Math.abs(hMm - sh.heightMm) > dimToleranceMm) {
            cutOk = false;
            discrepancies.push({
              code: 'SHEET_SIZE_MISMATCH',
              severity: 'FAIL',
              role: 'CUT',
              sheetIndex: i,
              previewSizeMm: { w: sh.widthMm, h: sh.heightMm },
              exportedSizeMm: { w: r4(wMm), h: r4(hMm) },
              message: `Tờ #${i + 1} CUT PDF (${r4(wMm)}×${r4(hMm)}mm) lệch khổ giấy so với Preview (${sh.widthMm}×${sh.heightMm}mm).`,
            });
          }
        } catch (err) {
          cutOk = false;
          discrepancies.push({
            code: 'INVALID_EXPORTED_PDF',
            severity: 'FAIL',
            role: 'CUT',
            sheetIndex: i,
            message: `Không đọc được CUT_TRANG_${i + 1}.pdf: ${err?.message || 'Unknown error'}`,
          });
        }
      }

      if (cf.verification && cf.verification.status !== 'PASS') {
        cutOk = false;
        discrepancies.push({
          code: 'GEOMETRY_DEVIATION_EXCEEDED',
          severity: 'FAIL',
          role: 'CUT',
          sheetIndex: i,
          message: `Tờ #${i + 1} CUT PDF không đạt hậu kiểm hình học (${cf.verification.status}).`,
        });
      }

      const existing = sheetChecks[i];
      if (existing) {
        existing.cutOk = cutOk;
        if (!cutOk) existing.status = PARITY_STATUS.MISMATCH;
      } else {
        sheetChecks.push({
          sheetIndex: i,
          sheetNumber: sh.sheetNumber || i + 1,
          cutOk,
          status: cutOk ? PARITY_STATUS.VERIFIED : PARITY_STATUS.MISMATCH,
        });
      }
    }
  }

  const hasFail = discrepancies.some((d) => d.severity === 'FAIL');
  const hasWarn = discrepancies.some((d) => d.severity === 'WARNING');
  const status = hasFail ? PARITY_STATUS.MISMATCH : hasWarn ? PARITY_STATUS.WARNING : PARITY_STATUS.VERIFIED;

  return {
    status,
    inSync: status === PARITY_STATUS.VERIFIED,
    currentSignature,
    exportedSignature: lastExport?.previewParitySignature || currentSignature,
    discrepancies,
    sheetChecks:
      sheetChecks.length > 0
        ? sheetChecks
        : previewSheets.map((sh, idx) => ({
            sheetIndex: idx,
            sheetNumber: sh.sheetNumber || idx + 1,
            status,
          })),
    summaryMessage:
      status === PARITY_STATUS.VERIFIED
        ? `Preview khớp 100% với PDF xuất (${previewSheets.length} cặp trang IN/BẾ đã xác thực).`
        : discrepancies[0]?.message || 'Phát hiện sai lệch giữa Preview và PDF xuất.',
  };
}
