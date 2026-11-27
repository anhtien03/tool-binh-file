/**
 * PrintKit Architecture V1 — Shared Imposition Adapter (Checkpoint F)
 *
 * Computes ONE authoritative ImpositionPlanV1 shared by PRINT and CUT renderers.
 *
 * Invariants:
 *  - ZERO separate PRINT vs CUT layout engines.
 *  - Pure Rigid Transform only (rotation + translation; det = +1; NO scale/shear).
 *  - Deterministic ordering independent of async arrival order.
 *  - Supports 0° / 90° / 180° / 270° rotations, multi-sheet packing, and ProductionProfileV1 marks.
 *  - Snapshots (jobRevision, cutRevision, productionGeometryRevision, targetSizeMm, quantity, included, allowRotate)
 *    to detect STALE_PLAN before any export.
 */

import {
  V1_SCHEMA_VERSION,
  ALLOWED_ROTATIONS,
  createPlanId,
  canonicalStringify,
  nextPlanRevision,
  validateImpositionPlanV1,
  assertNoBinaryInState,
} from './v1Schema.js';

export const IMPOSITION_ADAPTER_VERSION = '1.0';

export const PRODUCTION_PROFILES = Object.freeze({
  NONE: Object.freeze({
    profileId: 'NONE',
    markMode: 'none',
    markSizeMm: 0,
    markInsetMm: 0,
    includeMarksInPrint: false,
    includeMarksInCut: false,
  }),
  GENERIC: Object.freeze({
    profileId: 'GENERIC',
    markMode: 'corner_squares',
    markSizeMm: 5,
    markInsetMm: 8,
    includeMarksInPrint: true,
    includeMarksInCut: true,
  }),
});

export class ImpositionError extends Error {
  constructor({ code, message, jobId = null, planId = null, details = null }) {
    super(message);
    this.name = 'ImpositionError';
    this.stage = 'IMPOSITION';
    this.code = code; // 'INELIGIBLE_JOB' | 'ITEM_TOO_LARGE' | 'STALE_PLAN' | 'INVALID_CONFIG'
    this.jobId = jobId;
    this.planId = planId;
    this.details = details;
  }
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('batchImpositionAdapter: crypto.subtle.digest is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Construct a pure 2D Rigid Transform matrix [a, b, c, d, tx, ty] mapping
 * target-local mm [0..w]x[0..h] -> sheet mm at top-left (xMm, yMm) with CW rotation (screen Y-down).
 * Strictly rotation + translation only (det = +1, zero scale, zero shear).
 */
export function buildRigidMatrixMm(xMm, yMm, wMm, hMm, rotationDeg = 0) {
  const rot = ((rotationDeg % 360) + 360) % 360;
  if (!ALLOWED_ROTATIONS.includes(rot)) {
    throw new ImpositionError({ code: 'INVALID_CONFIG', message: `Unsupported rotationDeg: ${rotationDeg}` });
  }
  if (rot === 0) return [1, 0, 0, 1, r4(xMm), r4(yMm)];
  if (rot === 90) return [0, 1, -1, 0, r4(xMm + hMm), r4(yMm)];
  if (rot === 180) return [-1, 0, 0, -1, r4(xMm + wMm), r4(yMm + hMm)];
  // 270°
  return [0, -1, 1, 0, r4(xMm), r4(yMm + wMm)];
}

/**
 * Single shared coordinate transform used by BOTH PRINT renderer and CUT Master / exporters.
 * Maps a point [u, v] in target-local mm -> [X, Y] in sheet mm.
 */
export function applyRigidMatrixMm(matrix, pt) {
  const [a, b, c, d, tx, ty] = matrix;
  return [a * pt[0] + c * pt[1] + tx, b * pt[0] + d * pt[1] + ty];
}

/**
 * Verify a matrix is strictly rigid (orthonormal columns, det = +1, no scale/shear).
 */
export function isRigidMatrixMm(matrix, eps = 1e-6) {
  if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some((v) => !Number.isFinite(v))) return false;
  const [a, b, c, d] = matrix;
  const len1 = Math.hypot(a, b);
  const len2 = Math.hypot(c, d);
  const dot = a * c + b * d;
  const det = a * d - b * c;
  return Math.abs(len1 - 1) <= eps && Math.abs(len2 - 1) <= eps && Math.abs(dot) <= eps && Math.abs(det - 1) <= eps;
}

/**
 * Generate registration marks ONCE in sheet-mm from ProductionProfileV1.
 * Shared across PRINT.pdf, CUT.pdf, CUT.svg, and future formats.
 */
export function buildRegistrationMarksMm(sheetW, sheetH, profile = PRODUCTION_PROFILES.GENERIC) {
  if (!profile || profile.markMode === 'none' || !profile.markSizeMm) return [];
  const s = profile.markSizeMm;
  const inset = Math.max(s / 2 + 1, profile.markInsetMm || 8);
  const half = s / 2;
  return [
    { id: 'MARK-TL', corner: 'TL', shape: 'square', cxMm: r4(inset), cyMm: r4(inset), sizeMm: s, xMm: r4(inset - half), yMm: r4(inset - half) },
    { id: 'MARK-TR', corner: 'TR', shape: 'square', cxMm: r4(sheetW - inset), cyMm: r4(inset), sizeMm: s, xMm: r4(sheetW - inset - half), yMm: r4(inset - half) },
    { id: 'MARK-BL', corner: 'BL', shape: 'square', cxMm: r4(inset), cyMm: r4(sheetH - inset), sizeMm: s, xMm: r4(inset - half), yMm: r4(sheetH - inset - half) },
    { id: 'MARK-BR', corner: 'BR', shape: 'square', cxMm: r4(sheetW - inset), cyMm: r4(sheetH - inset), sizeMm: s, xMm: r4(sheetW - inset - half), yMm: r4(sheetH - inset - half) },
  ];
}

function assertJobEligibleForProduction(job, allowWarnings) {
  if (!job || !job.jobId) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', message: 'Invalid job object in imposition input' });
  }
  const rv = job.validation?.readinessValidation;
  const gv = job.validation?.geometryValidation;
  if (!job.canonicalCut || !job.productionGeometry) {
    throw new ImpositionError({
      code: 'INELIGIBLE_JOB',
      jobId: job.jobId,
      message: `Job ${job.jobId} chưa có CanonicalCut hoặc ProductionGeometry`,
    });
  }
  if (!rv || !gv || !gv.geometryValid) {
    throw new ImpositionError({
      code: 'INELIGIBLE_JOB',
      jobId: job.jobId,
      message: `Job ${job.jobId} không đạt kiểm định hình học`,
    });
  }
  if (rv.status === 'BLOCKED' || !rv.productionReady) {
    throw new ImpositionError({
      code: 'INELIGIBLE_JOB',
      jobId: job.jobId,
      message: `Job ${job.jobId} bị BLOCKED hoặc chưa productionReady (${(rv.reasons || []).join('; ')})`,
    });
  }
  if (rv.status === 'WARNING' && !allowWarnings) {
    throw new ImpositionError({
      code: 'INELIGIBLE_JOB',
      jobId: job.jobId,
      message: `Job ${job.jobId} ở trạng thái WARNING nhưng allowWarnings=false`,
    });
  }
}

function normalizeSheetConfig(sheetConfig) {
  const widthMm = Number(sheetConfig?.widthMm);
  const heightMm = Number(sheetConfig?.heightMm);
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new ImpositionError({ code: 'INVALID_CONFIG', message: `sheetConfig dimensions invalid (${widthMm}x${heightMm})` });
  }
  const m = sheetConfig?.marginsMm || { top: 10, right: 10, bottom: 10, left: 10 };
  const gapMm = Math.max(0, Number(sheetConfig?.gapMm ?? 3));
  return {
    widthMm,
    heightMm,
    marginsMm: {
      top: Math.max(0, Number(m.top ?? 10)),
      right: Math.max(0, Number(m.right ?? 10)),
      bottom: Math.max(0, Number(m.bottom ?? 10)),
      left: Math.max(0, Number(m.left ?? 10)),
    },
    gapMm,
    registrationMarks: Boolean(sheetConfig?.registrationMarks ?? true),
  };
}

function normalizeProfile(profile, sheetConfig) {
  if (profile && typeof profile === 'object' && profile.profileId) {
    return {
      profileId: profile.profileId,
      markMode: profile.markMode || 'none',
      markSizeMm: Number(profile.markSizeMm || 0),
      markInsetMm: Number(profile.markInsetMm || 8),
      includeMarksInPrint: Boolean(profile.includeMarksInPrint),
      includeMarksInCut: Boolean(profile.includeMarksInCut),
    };
  }
  return sheetConfig.registrationMarks ? { ...PRODUCTION_PROFILES.GENERIC } : { ...PRODUCTION_PROFILES.NONE };
}

function buildJobSnapshot(job) {
  return {
    jobId: job.jobId,
    jobRevision: job.jobRevision,
    cutRevision: job.canonicalCut.cutRevision,
    productionGeometryRevision: job.productionGeometry.productionGeometryRevision,
    targetSizeMm: { w: job.order.targetSizeMm.w, h: job.order.targetSizeMm.h },
    quantity: job.order.quantity,
    included: job.order.included,
    allowRotate: job.order.allowRotate,
  };
}

/**
 * Compute deterministic planHash from logical plan inputs.
 */
export async function computeImpositionPlanHash({ jobs, sheetConfig, productionProfile, forceRotationDeg = null }, hashTextFn = defaultSha256Text) {
  const includedSorted = [...jobs]
    .filter((j) => j.order.included && j.order.quantity > 0)
    .sort((a, b) => a.jobId.localeCompare(b.jobId))
    .map(buildJobSnapshot);

  const payload = canonicalStringify({
    version: IMPOSITION_ADAPTER_VERSION,
    sheetConfig,
    productionProfile,
    forceRotationDeg,
    jobs: includedSorted,
  });
  return await hashTextFn(payload);
}

/**
 * Compute ONE authoritative ImpositionPlanV1 shared across PRINT & CUT.
 * Deterministic shelf-packing across 1..M sheets; supports cache hit on identical planHash.
 */
export async function computeSharedImpositionPlan({
  jobs,
  sheetConfig,
  productionProfile = null,
  allowWarnings = true,
  existingPlan = null,
  forceRotationDeg = null, // optional explicit 0/90/180/270 for testing or forced orientation
  hashTextFn = defaultSha256Text,
}) {
  if (!Array.isArray(jobs)) {
    throw new ImpositionError({ code: 'INVALID_CONFIG', message: 'jobs must be an array' });
  }
  const normSheet = normalizeSheetConfig(sheetConfig);
  const normProfile = normalizeProfile(productionProfile, normSheet);

  // Filter included jobs with quantity > 0; strictly reject ineligible jobs (never silently drop!)
  const activeJobs = jobs.filter((j) => j.order?.included && j.order?.quantity > 0);
  for (const job of activeJobs) {
    assertJobEligibleForProduction(job, allowWarnings);
  }

  const planHash = await computeImpositionPlanHash(
    { jobs: activeJobs, sheetConfig: normSheet, productionProfile: normProfile, forceRotationDeg },
    hashTextFn
  );

  if (existingPlan && existingPlan.planHash === planHash) {
    return { cacheHit: true, plan: existingPlan };
  }

  // Deterministic sort: area descending, then jobId ascending (independent of async completion order)
  const sortedJobs = [...activeJobs].sort((a, b) => {
    const areaA = a.order.targetSizeMm.w * a.order.targetSizeMm.h;
    const areaB = b.order.targetSizeMm.w * b.order.targetSizeMm.h;
    if (Math.abs(areaB - areaA) > 1e-6) return areaB - areaA;
    return a.jobId.localeCompare(b.jobId);
  });

  // Expand each StickerJob into (jobId, copyIndex = 1..quantity) copies
  const copies = [];
  for (const job of sortedJobs) {
    for (let copyIndex = 1; copyIndex <= job.order.quantity; copyIndex++) {
      copies.push({ job, copyIndex });
    }
  }

  const { widthMm, heightMm, marginsMm, gapMm } = normSheet;
  const markClearance = normProfile.markMode !== 'none' ? normProfile.markInsetMm + normProfile.markSizeMm / 2 + 2 : 0;
  const startX = Math.max(marginsMm.left, markClearance);
  const startY = Math.max(marginsMm.top, markClearance);
  const maxX = widthMm - Math.max(marginsMm.right, markClearance);
  const maxY = heightMm - Math.max(marginsMm.bottom, markClearance);
  const availW = maxX - startX;
  const availH = maxY - startY;

  if (availW <= 0 || availH <= 0) {
    throw new ImpositionError({ code: 'INVALID_CONFIG', message: 'Printable sheet area <= 0 after margins/marks' });
  }

  // Multi-sheet deterministic shelf packer
  const rawSheets = [];
  const createSheetState = () => ({
    shelves: [], // { y, height, curX }
    placements: [],
  });

  const tryPlaceOnSheet = (sheetState, item) => {
    const { job, copyIndex } = item;
    const tw = job.order.targetSizeMm.w;
    const th = job.order.targetSizeMm.h;
    const bleedPad = job.bleedConfig.bleedMode === 'precision' ? job.bleedConfig.bleedOffsetMm : 0;
    const effGap = Math.max(gapMm, bleedPad * 2);

    const candidateRots =
      forceRotationDeg !== null
        ? [forceRotationDeg]
        : job.order.allowRotate
        ? [0, 90]
        : [0];

    for (const rot of candidateRots) {
      const boxW = rot === 90 || rot === 270 ? th : tw;
      const boxH = rot === 90 || rot === 270 ? tw : th;
      if (boxW > availW + 1e-6 || boxH > availH + 1e-6) continue;

      // Try existing shelves first
      for (const shelf of sheetState.shelves) {
        if (boxH <= shelf.height + 1e-6 && shelf.curX + boxW <= maxX + 1e-6) {
          const xMm = shelf.curX;
          const yMm = shelf.y;
          shelf.curX = r4(shelf.curX + boxW + effGap);
          return { xMm, yMm, rot, tw, th };
        }
      }

      // Open a new shelf
      const lastShelf = sheetState.shelves[sheetState.shelves.length - 1];
      const nextY = lastShelf ? r4(lastShelf.y + lastShelf.height + effGap) : startY;
      if (nextY + boxH <= maxY + 1e-6 && startX + boxW <= maxX + 1e-6) {
        const newShelf = { y: nextY, height: boxH, curX: r4(startX + boxW + effGap) };
        sheetState.shelves.push(newShelf);
        return { xMm: startX, yMm: nextY, rot, tw, th };
      }
    }
    return null;
  };

  for (const item of copies) {
    let placed = null;
    let targetSheetIdx = -1;
    for (let sIdx = 0; sIdx < rawSheets.length; sIdx++) {
      placed = tryPlaceOnSheet(rawSheets[sIdx], item);
      if (placed) {
        targetSheetIdx = sIdx;
        break;
      }
    }
    if (!placed) {
      const fresh = createSheetState();
      placed = tryPlaceOnSheet(fresh, item);
      if (!placed) {
        throw new ImpositionError({
          code: 'ITEM_TOO_LARGE',
          jobId: item.job.jobId,
          message: `Job ${item.job.jobId} (${item.job.order.targetSizeMm.w}×${item.job.order.targetSizeMm.h} mm) lớn hơn vùng in khả dụng (${r4(availW)}×${r4(availH)} mm)`,
        });
      }
      rawSheets.push(fresh);
      targetSheetIdx = rawSheets.length - 1;
    }

    const { job, copyIndex } = item;
    const rigidMatrixMm = buildRigidMatrixMm(placed.xMm, placed.yMm, placed.tw, placed.th, placed.rot);
    rawSheets[targetSheetIdx].placements.push({
      placementId: `${job.jobId}#${copyIndex}`,
      jobId: job.jobId,
      copyIndex,
      jobRevision: job.jobRevision,
      cutRevision: job.canonicalCut.cutRevision,
      productionGeometryRevision: job.productionGeometry.productionGeometryRevision,
      targetSizeMm: { w: placed.tw, h: placed.th },
      sheetIndex: targetSheetIdx + 1,
      xMm: r4(placed.xMm),
      yMm: r4(placed.yMm),
      rotationDeg: placed.rot,
      rigidMatrixMm,
    });
  }

  const sharedMarks = buildRegistrationMarksMm(widthMm, heightMm, normProfile);
  const sheets = rawSheets.map((sh, idx) => ({
    sheetIndex: idx + 1,
    widthMm,
    heightMm,
    placements: sh.placements,
    registrationMarks: sharedMarks.map((m) => ({ ...m })),
  }));

  const includedJobRevisions = {};
  const jobSnapshots = {};
  for (const job of sortedJobs) {
    includedJobRevisions[job.jobId] = job.jobRevision;
    jobSnapshots[job.jobId] = buildJobSnapshot(job);
  }

  const plan = {
    schemaVersion: V1_SCHEMA_VERSION,
    planId: existingPlan?.planId || createPlanId(),
    planRevision: nextPlanRevision(existingPlan?.planRevision ?? 0),
    planHash,
    sheetConfig: normSheet,
    productionProfile: normProfile,
    includedJobRevisions,
    jobSnapshots,
    totalPlacedCopies: copies.length,
    sheets,
  };

  validateImpositionPlanV1(plan);
  assertNoBinaryInState(plan, 'impositionPlan');
  return { cacheHit: false, plan };
}

/**
 * Validate that an ImpositionPlanV1 is still fresh against current jobs, sheetConfig & productionProfile.
 * Throws ImpositionError(STALE_PLAN) if ANY snapshot mismatches — NEVER silently rebuilds!
 */
export function assertPlanFreshness(plan, currentJobs, currentSheetConfig = null, currentProfile = null) {
  if (!plan || !plan.jobSnapshots) {
    throw new ImpositionError({ code: 'STALE_PLAN', message: 'ImpositionPlan không hợp lệ hoặc thiếu snapshot' });
  }
  const jobMap = new Map(currentJobs.map((j) => [j.jobId, j]));
  const activeIds = new Set(currentJobs.filter((j) => j.order?.included && j.order?.quantity > 0).map((j) => j.jobId));
  const planIds = new Set(Object.keys(plan.jobSnapshots));

  if (activeIds.size !== planIds.size) {
    throw new ImpositionError({
      code: 'STALE_PLAN',
      planId: plan.planId,
      message: `STALE_PLAN: Số lượng Job hợp lệ thay đổi (plan=${planIds.size}, current=${activeIds.size})`,
    });
  }

  for (const [jobId, snap] of Object.entries(plan.jobSnapshots)) {
    const cur = jobMap.get(jobId);
    if (!cur) {
      throw new ImpositionError({ code: 'STALE_PLAN', planId: plan.planId, jobId, message: `STALE_PLAN: Job ${jobId} không còn tồn tại` });
    }
    const mismatch =
      cur.jobRevision !== snap.jobRevision ||
      cur.canonicalCut?.cutRevision !== snap.cutRevision ||
      cur.productionGeometry?.productionGeometryRevision !== snap.productionGeometryRevision ||
      cur.order.targetSizeMm.w !== snap.targetSizeMm.w ||
      cur.order.targetSizeMm.h !== snap.targetSizeMm.h ||
      cur.order.quantity !== snap.quantity ||
      cur.order.included !== snap.included ||
      cur.order.allowRotate !== snap.allowRotate;
    if (mismatch) {
      throw new ImpositionError({
        code: 'STALE_PLAN',
        planId: plan.planId,
        jobId,
        message: `STALE_PLAN: Job ${jobId} đã thay đổi sau khi tạo plan (plan rev=${snap.jobRevision}, current rev=${cur.jobRevision})`,
      });
    }
  }

  if (currentSheetConfig) {
    const normCur = normalizeSheetConfig(currentSheetConfig);
    if (canonicalStringify(normCur) !== canonicalStringify(plan.sheetConfig)) {
      throw new ImpositionError({ code: 'STALE_PLAN', planId: plan.planId, message: 'STALE_PLAN: sheetConfig đã thay đổi' });
    }
  }
  if (currentProfile) {
    const normProf = normalizeProfile(currentProfile, plan.sheetConfig);
    if (canonicalStringify(normProf) !== canonicalStringify(plan.productionProfile)) {
      throw new ImpositionError({ code: 'STALE_PLAN', planId: plan.planId, message: 'STALE_PLAN: productionProfile đã thay đổi' });
    }
  }

  return true;
}
