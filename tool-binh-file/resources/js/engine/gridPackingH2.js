/**
 * PrintKit Architecture V1 — Checkpoint H.2 Deterministic Grid Packing
 *
 * Pure, additive 2D grid placement engine in physical millimetres.
 *  - ZERO edits to locked B–G / H.1 modules.
 *  - Uses buildRigidMatrixMm / isRigidMatrixMm from batchImpositionAdapter.js (det = +1, no scale/mirror/shear).
 *  - Never mutates source CUT/BLEED geometry.
 *  - Never silently drops items when grid capacity or safe area is exceeded.
 */

import {
  buildRigidMatrixMm,
  isRigidMatrixMm,
} from './batchImpositionAdapter.js';

export const GRID_PACKING_H2_VERSION = 'H2.0';

export class GridPackingError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'GridPackingError';
    this.stage = 'GRID_PACKING_H2';
    this.code = code; // 'INVALID_GRID_CONFIG' | 'GRID_CAPACITY_EXCEEDED' | 'ITEM_TOO_LARGE' | 'INVALID_PLACEMENT'
    this.details = details;
  }
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

function assertPositiveFinite(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new GridPackingError('INVALID_GRID_CONFIG', `${name} must be a finite number > 0`, { name, value: v });
  }
  return v;
}

function assertNonNegFinite(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new GridPackingError('INVALID_GRID_CONFIG', `${name} must be a finite number >= 0`, { name, value: v });
  }
  return v;
}

function assertPosInt(v, name) {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new GridPackingError('INVALID_GRID_CONFIG', `${name} must be a positive safe integer`, { name, value: v });
  }
  return v;
}

/**
 * Compute usable safe area on a sheet after margins and optional registration mark clearance.
 */
export function resolveSafeAreaMm({ sheetWidthMm, sheetHeightMm, marginsMm = {}, productionProfile = null, safeAreaMm = null }) {
  assertPositiveFinite(sheetWidthMm, 'sheetWidthMm');
  assertPositiveFinite(sheetHeightMm, 'sheetHeightMm');

  if (safeAreaMm) {
    const left = assertNonNegFinite(safeAreaMm.left, 'safeAreaMm.left');
    const top = assertNonNegFinite(safeAreaMm.top, 'safeAreaMm.top');
    const right = assertPositiveFinite(safeAreaMm.right, 'safeAreaMm.right');
    const bottom = assertPositiveFinite(safeAreaMm.bottom, 'safeAreaMm.bottom');
    if (right > sheetWidthMm + 1e-6 || bottom > sheetHeightMm + 1e-6 || right <= left || bottom <= top) {
      throw new GridPackingError('INVALID_GRID_CONFIG', 'safeAreaMm is out of sheet bounds or empty', { safeAreaMm });
    }
    return Object.freeze({ left, top, right, bottom, width: r4(right - left), height: r4(bottom - top) });
  }

  const mTop = assertNonNegFinite(marginsMm.top ?? 0, 'marginsMm.top');
  const mRight = assertNonNegFinite(marginsMm.right ?? 0, 'marginsMm.right');
  const mBottom = assertNonNegFinite(marginsMm.bottom ?? 0, 'marginsMm.bottom');
  const mLeft = assertNonNegFinite(marginsMm.left ?? 0, 'marginsMm.left');

  const markClearance =
    productionProfile && productionProfile.markMode !== 'none' && productionProfile.markSizeMm > 0
      ? Number(productionProfile.markInsetMm || 8) + Number(productionProfile.markSizeMm) / 2 + 2
      : 0;

  const left = Math.max(mLeft, markClearance);
  const top = Math.max(mTop, markClearance);
  const right = sheetWidthMm - Math.max(mRight, markClearance);
  const bottom = sheetHeightMm - Math.max(mBottom, markClearance);

  if (right <= left || bottom <= top) {
    throw new GridPackingError('INVALID_GRID_CONFIG', 'Usable sheet safe area <= 0 after margins and mark clearance', {
      sheetWidthMm,
      sheetHeightMm,
      marginsMm,
      markClearance,
    });
  }

  return Object.freeze({ left: r4(left), top: r4(top), right: r4(right), bottom: r4(bottom), width: r4(right - left), height: r4(bottom - top) });
}

/**
 * Deterministic 2D Grid Packer for a single SheetTemplate.
 *
 * - Supports explicit rows/columns, pitchXmm/pitchYmm, originXmm/originYmm, centerX/centerY,
 *   allowRotate (0° or 90°), partial grids, multi-SKU deterministic order, and safe area bounds.
 * - Preserves 1-based copyIndex per jobId via shared `nextCopyIndexByJobId` counter map.
 * - Throws GridPackingError('GRID_CAPACITY_EXCEEDED') if items exceed rows*columns or safe area.
 */
export function packSheetTemplateGrid({
  templateId,
  sheetIndex,
  sheetWidthMm,
  sheetHeightMm,
  marginsMm = {},
  safeAreaMm = null,
  productionProfile = null,
  gridSpec,
  items, // [{ jobId, copiesPerRun, placementIdPrefix? }]
  jobMap, // Map<jobId, StickerJobV1>
  nextCopyIndexByJobId = new Map(), // shared 1-based copyIndex counter per jobId
}) {
  if (!templateId || typeof templateId !== 'string') {
    throw new GridPackingError('INVALID_GRID_CONFIG', 'templateId is required');
  }
  assertPosInt(sheetIndex, 'sheetIndex');
  if (!gridSpec || typeof gridSpec !== 'object') {
    throw new GridPackingError('INVALID_GRID_CONFIG', 'gridSpec is required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new GridPackingError('INVALID_GRID_CONFIG', 'items must be a non-empty array');
  }

  const rows = assertPosInt(gridSpec.rows, 'gridSpec.rows');
  const columns = assertPosInt(gridSpec.columns, 'gridSpec.columns');
  const fillOrder = gridSpec.fillOrder ?? 'row_major';
  if (fillOrder !== 'row_major' && fillOrder !== 'col_major') {
    throw new GridPackingError('INVALID_GRID_CONFIG', `Unsupported fillOrder: ${fillOrder}`);
  }

  const safe = resolveSafeAreaMm({ sheetWidthMm, sheetHeightMm, marginsMm, productionProfile, safeAreaMm });

  // Expand items deterministically in exact caller order (never Object.keys random order)
  const expanded = [];
  for (let idx = 0; idx < items.length; idx++) {
    const entry = items[idx];
    const job = jobMap.get(entry.jobId);
    if (!job) {
      throw new GridPackingError('INVALID_PLACEMENT', `Unknown jobId "${entry.jobId}" in template "${templateId}"`);
    }
    const copies = assertPosInt(entry.copiesPerRun ?? 1, `items[${idx}].copiesPerRun`);
    for (let c = 0; c < copies; c++) {
      expanded.push({ job, entryIndex: idx });
    }
  }

  const capacity = rows * columns;
  if (expanded.length > capacity) {
    throw new GridPackingError(
      'GRID_CAPACITY_EXCEEDED',
      `Template ${templateId}: requested ${expanded.length} placements exceeds grid capacity ${columns}×${rows}=${capacity}`,
      { templateId, requested: expanded.length, columns, rows, capacity }
    );
  }

  const gridAllowRotate = Boolean(gridSpec.allowRotate ?? false);
  const defaultCutGapMm = assertNonNegFinite(gridSpec.cutGapMm ?? 2, 'gridSpec.cutGapMm');

  // Determine uniform cell orientation & max cell dimensions deterministically
  const chooseRotation = (job) => {
    const tw = job.order.targetSizeMm.w;
    const th = job.order.targetSizeMm.h;
    if (gridSpec.rotationDeg !== undefined && gridSpec.rotationDeg !== null) {
      return gridSpec.rotationDeg;
    }
    const canRotate = gridAllowRotate && Boolean(job.order.allowRotate);
    if (!canRotate || Math.abs(tw - th) < 1e-6) return 0;

    // Explicit deterministic rule when allowRotate=true:
    // choose 90° ONLY if 0° does not fit the cell/sheet while 90° does, or if pitchX/pitchY is given and 90° fits better.
    const fits0 = tw * columns + defaultCutGapMm * (columns - 1) <= safe.width + 1e-6 && th * rows + defaultCutGapMm * (rows - 1) <= safe.height + 1e-6;
    const fits90 = th * columns + defaultCutGapMm * (columns - 1) <= safe.width + 1e-6 && tw * rows + defaultCutGapMm * (rows - 1) <= safe.height + 1e-6;
    if (!fits0 && fits90) return 90;
    return 0;
  };

  let maxCellW = 0;
  let maxCellH = 0;
  const resolvedItems = expanded.map(({ job }) => {
    const rot = chooseRotation(job);
    const tw = job.order.targetSizeMm.w;
    const th = job.order.targetSizeMm.h;
    const boxW = rot === 90 || rot === 270 ? th : tw;
    const boxH = rot === 90 || rot === 270 ? tw : th;
    if (boxW > maxCellW) maxCellW = boxW;
    if (boxH > maxCellH) maxCellH = boxH;
    return { job, rot, tw, th, boxW, boxH };
  });

  const pitchXmm = gridSpec.pitchXmm !== undefined && gridSpec.pitchXmm !== null
    ? assertPositiveFinite(gridSpec.pitchXmm, 'gridSpec.pitchXmm')
    : r4(maxCellW + defaultCutGapMm);
  const pitchYmm = gridSpec.pitchYmm !== undefined && gridSpec.pitchYmm !== null
    ? assertPositiveFinite(gridSpec.pitchYmm, 'gridSpec.pitchYmm')
    : r4(maxCellH + defaultCutGapMm);

  const gridTotalW = r4((columns - 1) * pitchXmm + maxCellW);
  const gridTotalH = r4((rows - 1) * pitchYmm + maxCellH);

  // Explicit deterministic origin precedence:
  // 1. Explicit originXmm / originYmm
  // 2. centerX / centerY within sheet (or safe area if centerInSafeArea=true)
  // 3. safe.left / safe.top
  const originXmm =
    gridSpec.originXmm !== undefined && gridSpec.originXmm !== null
      ? assertNonNegFinite(gridSpec.originXmm, 'gridSpec.originXmm')
      : gridSpec.centerX
      ? r4(gridSpec.centerInSafeArea ? safe.left + (safe.width - gridTotalW) / 2 : (sheetWidthMm - gridTotalW) / 2)
      : safe.left;

  const originYmm =
    gridSpec.originYmm !== undefined && gridSpec.originYmm !== null
      ? assertNonNegFinite(gridSpec.originYmm, 'gridSpec.originYmm')
      : gridSpec.centerY
      ? r4(gridSpec.centerInSafeArea ? safe.top + (safe.height - gridTotalH) / 2 : (sheetHeightMm - gridTotalH) / 2)
      : safe.top;

  // Build deterministic slot list
  const slots = [];
  if (fillOrder === 'row_major') {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        slots.push({ row: r, col: c });
      }
    }
  } else {
    for (let c = 0; c < columns; c++) {
      for (let r = 0; r < rows; r++) {
        slots.push({ row: r, col: c });
      }
    }
  }

  const placements = [];
  for (let i = 0; i < resolvedItems.length; i++) {
    const { job, rot, tw, th, boxW, boxH } = resolvedItems[i];
    const { row, col } = slots[i];

    // Center smaller SKU cleanly inside cell if multi-SKU sizes differ
    const cellOffsetX = (maxCellW - boxW) / 2;
    const cellOffsetY = (maxCellH - boxH) / 2;
    const xMm = r4(originXmm + col * pitchXmm + cellOffsetX);
    const yMm = r4(originYmm + row * pitchYmm + cellOffsetY);

    if (
      xMm < safe.left - 1e-4 ||
      yMm < safe.top - 1e-4 ||
      xMm + boxW > safe.right + 1e-4 ||
      yMm + boxH > safe.bottom + 1e-4
    ) {
      throw new GridPackingError(
        'GRID_CAPACITY_EXCEEDED',
        `Template ${templateId}: placement [${row},${col}] (${job.jobId}) at (${xMm}, ${yMm})..(${r4(xMm + boxW)}, ${r4(yMm + boxH)}) exceeds safe area [${safe.left}, ${safe.top}]..[${safe.right}, ${safe.bottom}]`,
        { templateId, jobId: job.jobId, row, col, xMm, yMm, boxW, boxH, safeArea: safe }
      );
    }

    const copyIndex = (nextCopyIndexByJobId.get(job.jobId) ?? 0) + 1;
    nextCopyIndexByJobId.set(job.jobId, copyIndex);

    const rigidMatrixMm = buildRigidMatrixMm(xMm, yMm, tw, th, rot);
    if (!isRigidMatrixMm(rigidMatrixMm)) {
      throw new GridPackingError('INVALID_PLACEMENT', `Non-rigid matrix produced for ${job.jobId}#${copyIndex}`);
    }

    placements.push({
      placementId: `${templateId}::${job.jobId}#${copyIndex}`,
      jobId: job.jobId,
      copyIndex, // Strictly 1-based; NEVER overloaded with runCount
      jobRevision: job.jobRevision,
      cutRevision: job.canonicalCut.cutRevision,
      productionGeometryRevision: job.productionGeometry.productionGeometryRevision,
      targetSizeMm: { w: tw, h: th },
      sheetIndex,
      gridCell: { row, col },
      xMm,
      yMm,
      rotationDeg: rot,
      rigidMatrixMm,
    });
  }

  return Object.freeze({
    templateId,
    sheetIndex,
    rows,
    columns,
    pitchXmm,
    pitchYmm,
    originXmm,
    originYmm,
    gridTotalW,
    gridTotalH,
    safeArea: safe,
    placementCount: placements.length,
    capacity,
    placements,
  });
}
