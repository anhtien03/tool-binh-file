/**
 * PrintKit Architecture V1 — Checkpoint H.2 Production Planning Integration Adapter
 *
 * Bridges:
 *   StickerJobV1[] + H.1 Production Planning (productionPlanningH1.js) + Grid Packing (gridPackingH2.js)
 *     -> ONE authoritative Shared ImpositionPlanV1 (unique physical SheetTemplates, NO runCount flattening)
 *     -> ProductionBatchH2 + ProductionOrderManifest (with explicit RunCount & freshness hash)
 *     -> LOCKED PRINT/CUT Export (productionOutput.js) & Final Validator (finalProductionValidator.js)
 *
 * ZERO edits to any LOCKED B–G or H.1 file.
 */

import {
  V1_SCHEMA_VERSION,
  createPlanId,
  canonicalStringify,
  nextPlanRevision,
  validateImpositionPlanV1,
  assertNoBinaryInState,
} from './v1Schema.js';
import {
  buildProductionRunPlan,
  ProductionPlanningError,
} from './productionPlanningH1.js';
import {
  PRODUCTION_PROFILES,
  buildRegistrationMarksMm,
  ImpositionError,
} from './batchImpositionAdapter.js';
import { exportProductionOutputs } from './productionOutput.js';
import { finalProductionCheck } from './finalProductionValidator.js';
import { packSheetTemplateGrid } from './gridPackingH2.js';
import {
  validateTemplateContoursH2,
  assertBatchFreshnessH2,
  computeBatchFreshnessHashH2,
  ProductionPlanValidationError,
} from './productionPlanValidatorH2.js';

export const PLANNING_ADAPTER_H2_VERSION = 'H2.2';

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('productionPlanningAdapterH2: crypto.subtle.digest is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function assertJobEligibleH2(job, allowWarnings) {
  if (!job || !job.jobId) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', message: 'Invalid job object in H.2 batch input' });
  }
  const rv = job.validation?.readinessValidation;
  const gv = job.validation?.geometryValidation;
  if (!job.canonicalCut || !job.productionGeometry) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', jobId: job.jobId, message: `Job ${job.jobId} missing CanonicalCut or ProductionGeometry` });
  }
  if (!rv || !gv || !gv.geometryValid) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', jobId: job.jobId, message: `Job ${job.jobId} failed geometry validation` });
  }
  if (rv.status === 'BLOCKED' || !rv.productionReady) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', jobId: job.jobId, message: `Job ${job.jobId} is BLOCKED or not productionReady` });
  }
  if (rv.status === 'WARNING' && !allowWarnings) {
    throw new ImpositionError({ code: 'INELIGIBLE_JOB', jobId: job.jobId, message: `Job ${job.jobId} has WARNING while allowWarnings=false` });
  }
}

function normalizeProfileH2(profile) {
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
  return { ...PRODUCTION_PROFILES.GENERIC };
}

function buildJobSnapshotH2(job) {
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
 * Build a complete H.2 ProductionBatch + ONE Shared ImpositionPlanV1 from:
 *  - StickerJobV1[]
 *  - SheetTemplate definitions (each with explicit confirmed `runCount`, `gridSpec`, `items`)
 *  - Explicit CUT gap & BLEED policy
 *
 * NEVER expands `runCount` into duplicate physical placements inside ImpositionPlanV1.
 * NEVER infers `runCount` from filenames.
 */
export async function buildProductionBatchPlanH2({
  batchId = null,
  jobs,
  sheetTemplates,
  spacingPolicy = {},
  bleedPolicy = 'strict', // 'strict' | 'allow_overlap'
  bleedClearanceMm = 0,
  bleedOverlapConfirmed = false,
  bleedOverlapJustification = null,
  bleedColorByJobId = null,
  flatnessMm = undefined,
  productionProfile = PRODUCTION_PROFILES.GENERIC,
  allowWarnings = true,
  allowQuantityMismatch = false,
  existingBatchPlan = null,
  hashTextFn = defaultSha256Text,
}) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new ProductionPlanValidationError('SCHEMA_INCOMPATIBLE', 'jobs must be a non-empty array of StickerJobV1');
  }
  if (!Array.isArray(sheetTemplates) || sheetTemplates.length === 0) {
    throw new ProductionPlanValidationError('SCHEMA_INCOMPATIBLE', 'sheetTemplates must be a non-empty array');
  }

  // 1. Validate active StickerJobV1 eligibility
  const activeJobs = jobs.filter((j) => j.order?.included && j.order?.quantity > 0);
  if (activeJobs.length === 0) {
    throw new ProductionPlanValidationError('SCHEMA_INCOMPATIBLE', 'No included jobs with quantity > 0');
  }
  for (const job of activeJobs) {
    assertJobEligibleH2(job, allowWarnings);
  }
  const jobMap = new Map(activeJobs.map((j) => [j.jobId, j]));

  // 2. Delegate pure quantity ledger & SheetTemplate validation to LOCKED Checkpoint H.1
  const h1JobsCatalog = activeJobs.map((j) => ({
    jobId: j.jobId,
    requestedQuantity: j.order.quantity,
  }));

  const h1Templates = sheetTemplates.map((tpl, tIdx) => {
    if (!Number.isSafeInteger(tpl?.runCount) || tpl.runCount < 1) {
      throw new ProductionPlanningError('INVALID_QUANTITY', `sheetTemplates[${tIdx}].runCount must be an explicitly confirmed positive integer (never inferred from filename)`);
    }
    const rawItems = tpl.items || tpl.placements;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new ProductionPlanningError('INVALID_CONFIG', `sheetTemplates[${tIdx}] requires non-empty items/placements`);
    }
    return {
      templateId: tpl.templateId,
      sheetWidthMm: tpl.sheetWidthMm,
      sheetHeightMm: tpl.sheetHeightMm,
      marginsMm: tpl.marginsMm ?? { top: 0, right: 0, bottom: 0, left: 0 },
      runCount: tpl.runCount,
      placements: rawItems.map((it, pIdx) => ({
        placementId: it.placementId || `${tpl.templateId}-ITEM-${pIdx + 1}`,
        jobId: it.jobId,
        copiesPerRun: it.copiesPerRun ?? 1,
      })),
    };
  });

  const h1SpacingInput = {
    cutGapMm: spacingPolicy.cutGapMm ?? 2,
    bleedOutsetMm: spacingPolicy.bleedOutsetMm ?? 1.5,
    bleedClearanceMm,
    bleedPolicy: bleedPolicy === 'allow_overlap' ? 'allow_overlap' : 'enforce_clearance',
  };

  const h1RunPlan = buildProductionRunPlan({
    jobs: h1JobsCatalog,
    sheetTemplates: h1Templates,
    spacingPolicy: h1SpacingInput,
  });

  if (!allowQuantityMismatch && h1RunPlan.status !== 'QUANTITY_MATCH') {
    const bad = h1RunPlan.ledger.filter((r) => r.status !== 'EXACT');
    throw new ProductionPlanValidationError(
      'QUANTITY_MISMATCH',
      `Quantity mismatch in H.1 ledger: ${bad.map((b) => `${b.jobId}(req=${b.requestedQuantity}, prod=${b.producedQuantity}, ${b.status})`).join(', ')}`,
      { ledger: h1RunPlan.ledger }
    );
  }

  // 3. Deterministic Grid Packing for every unique SheetTemplate (NO runCount placement duplication!)
  const normProfile = normalizeProfileH2(productionProfile);
  const nextCopyIndexByJobId = new Map();
  const sheets = [];
  const templateMetaList = [];
  const contourValidations = [];
  const allWarnings = [];
  const runCountsByTemplateId = {};
  const templateSnapshots = [];

  for (let idx = 0; idx < sheetTemplates.length; idx++) {
    const tpl = sheetTemplates[idx];
    const sheetIndex = idx + 1;
    const rawItems = tpl.items || tpl.placements;

    const packed = packSheetTemplateGrid({
      templateId: tpl.templateId,
      sheetIndex,
      sheetWidthMm: tpl.sheetWidthMm,
      sheetHeightMm: tpl.sheetHeightMm,
      marginsMm: tpl.marginsMm ?? { top: 0, right: 0, bottom: 0, left: 0 },
      safeAreaMm: tpl.safeAreaMm ?? null,
      productionProfile: normProfile,
      gridSpec: {
        ...(tpl.gridSpec || {}),
        cutGapMm: h1SpacingInput.cutGapMm,
      },
      items: rawItems,
      jobMap,
      nextCopyIndexByJobId,
    });

    const sharedMarks = buildRegistrationMarksMm(tpl.sheetWidthMm, tpl.sheetHeightMm, normProfile);
    const sheet = {
      sheetIndex,
      templateId: tpl.templateId,
      widthMm: tpl.sheetWidthMm,
      heightMm: tpl.sheetHeightMm,
      placements: packed.placements,
      registrationMarks: sharedMarks.map((m) => ({ ...m })),
    };

    // 4. Real contour-based CUT collision, two-way BLEED-CUT intrusion & BLEED overlap/color safety (H.2.2)
    const contourCheck = validateTemplateContoursH2({
      templateId: tpl.templateId,
      sheet,
      jobMap,
      cutGapMm: h1SpacingInput.cutGapMm,
      bleedPolicy,
      bleedClearanceMm,
      bleedOverlapConfirmed,
      bleedOverlapJustification,
      bleedColorByJobId,
      flatnessMm,
    });
    if (!contourCheck.valid) {
      const firstErr = contourCheck.errors[0];
      throw new ProductionPlanValidationError(firstErr.code, firstErr.message, {
        templateId: tpl.templateId,
        errors: contourCheck.errors,
      });
    }
    contourValidations.push(contourCheck);
    allWarnings.push(...contourCheck.warnings);

    sheets.push(sheet);
    runCountsByTemplateId[tpl.templateId] = tpl.runCount;
    templateMetaList.push({
      templateId: tpl.templateId,
      sheetIndex,
      widthMm: tpl.sheetWidthMm,
      heightMm: tpl.sheetHeightMm,
      runCount: tpl.runCount,
      uniquePlacements: packed.placementCount,
      expectedFinishedStickers: packed.placementCount * tpl.runCount,
      grid: {
        rows: packed.rows,
        columns: packed.columns,
        pitchXmm: packed.pitchXmm,
        pitchYmm: packed.pitchYmm,
        originXmm: packed.originXmm,
        originYmm: packed.originYmm,
      },
    });
    templateSnapshots.push({
      templateId: tpl.templateId,
      sheetWidthMm: tpl.sheetWidthMm,
      sheetHeightMm: tpl.sheetHeightMm,
      runCount: tpl.runCount,
      marginsMm: tpl.marginsMm ?? null,
      gridSpec: tpl.gridSpec ?? null,
      items: rawItems.map((p) => ({ jobId: p.jobId, copiesPerRun: p.copiesPerRun ?? 1 })),
    });
  }

  // 5. Build ONE authoritative Shared ImpositionPlanV1 compatible with LOCKED F & G
  const sortedActiveJobs = [...activeJobs].sort((a, b) => a.jobId.localeCompare(b.jobId));
  const includedJobRevisions = {};
  const jobSnapshots = {};
  for (const job of sortedActiveJobs) {
    includedJobRevisions[job.jobId] = job.jobRevision;
    jobSnapshots[job.jobId] = buildJobSnapshotH2(job);
  }

  const firstTpl = sheetTemplates[0];
  const representativeSheetConfig = {
    widthMm: firstTpl.sheetWidthMm,
    heightMm: firstTpl.sheetHeightMm,
    marginsMm: {
      top: Number(firstTpl.marginsMm?.top ?? 0),
      right: Number(firstTpl.marginsMm?.right ?? 0),
      bottom: Number(firstTpl.marginsMm?.bottom ?? 0),
      left: Number(firstTpl.marginsMm?.left ?? 0),
    },
    gapMm: h1SpacingInput.cutGapMm,
    registrationMarks: normProfile.markMode !== 'none',
  };

  const uniquePhysicalPlacements = sheets.reduce((sum, sh) => sum + sh.placements.length, 0);
  const expectedFinishedQuantity = h1RunPlan.ledger.reduce((sum, r) => sum + r.producedQuantity, 0);

  const planHash = await hashTextFn(
    canonicalStringify({
      version: PLANNING_ADAPTER_H2_VERSION,
      sheetConfig: representativeSheetConfig,
      productionProfile: normProfile,
      templates: templateSnapshots.map(({ runCount: _ignored, ...geomOnly }) => geomOnly),
      jobs: sortedActiveJobs.map(buildJobSnapshotH2),
    })
  );

  const batchFreshnessHash = await computeBatchFreshnessHashH2(
    {
      planHash,
      runCountsByTemplateId,
      bleedPolicy,
      bleedClearanceMm,
      bleedOverlapConfirmed,
    },
    hashTextFn
  );

  const hasColorUnverifiedOverlap = contourValidations.some(
    (cv) => cv.policyStatus === 'POLICY_ACCEPTED_COLOR_UNVERIFIED' || cv.colorStatus === 'GEOMETRY_SAFE_COLOR_UNVERIFIED'
  );
  const hasColorVerifiedOverlap =
    !hasColorUnverifiedOverlap &&
    contourValidations.some((cv) => cv.colorStatus === 'GEOMETRY_SAFE_COLOR_VERIFIED');
  const aggregatedBleedPolicyStatus = hasColorUnverifiedOverlap
    ? 'POLICY_ACCEPTED_COLOR_UNVERIFIED'
    : hasColorVerifiedOverlap
    ? 'GEOMETRY_SAFE_COLOR_VERIFIED'
    : bleedPolicy === 'allow_overlap'
    ? 'NO_OVERLAP'
    : 'STRICT_VERIFIED';
  const aggregatedColorStatus = hasColorUnverifiedOverlap
    ? 'GEOMETRY_SAFE_COLOR_UNVERIFIED'
    : hasColorVerifiedOverlap
    ? 'GEOMETRY_SAFE_COLOR_VERIFIED'
    : bleedPolicy === 'allow_overlap'
    ? 'NO_OVERLAP'
    : 'STRICT_VERIFIED';
  const aggregatedArtworkColorVerified = hasColorUnverifiedOverlap
    ? false
    : hasColorVerifiedOverlap
    ? true
    : null;
  const aggregatedGeometryStatus = 'GEOMETRY_SAFE';
  const aggregatedProductionStatus = allWarnings.length > 0 ? 'WARNING' : 'PASS';

  const planId = existingBatchPlan?.impositionPlan?.planId || createPlanId();
  const planRevision = nextPlanRevision(existingBatchPlan?.impositionPlan?.planRevision ?? 0);

  const impositionPlan = {
    schemaVersion: V1_SCHEMA_VERSION,
    planId,
    planRevision,
    planHash,
    sheetConfig: representativeSheetConfig,
    productionProfile: normProfile,
    includedJobRevisions,
    jobSnapshots,
    totalPlacedCopies: uniquePhysicalPlacements,
    sheets,
  };

  // Strict compatibility verification with LOCKED v1Schema.js
  validateImpositionPlanV1(impositionPlan);
  assertNoBinaryInState(impositionPlan, 'impositionPlanH2');

  const resolvedBatchId = batchId || existingBatchPlan?.batchId || `BATCH-${planId.slice(-8)}`;
  const productionOrderManifest = {
    schemaVersion: PLANNING_ADAPTER_H2_VERSION,
    batchId: resolvedBatchId,
    planId,
    planRevision,
    planHash,
    batchFreshnessHash,
    templateCount: sheets.length,
    uniquePhysicalPlacements,
    physicalSheetCount: h1RunPlan.physicalSheetCount,
    expectedFinishedQuantity,
    runCountsByTemplateId,
    templates: templateMetaList,
    quantityLedger: h1RunPlan.ledger,
    bleedPolicy: {
      policy: bleedPolicy,
      geometryStatus: aggregatedGeometryStatus,
      colorStatus: aggregatedColorStatus,
      policyStatus: aggregatedBleedPolicyStatus,
      productionStatus: aggregatedProductionStatus,
      artworkColorVerified: aggregatedArtworkColorVerified,
      cutGapMm: h1SpacingInput.cutGapMm,
      bleedClearanceMm,
      bleedOverlapConfirmed: Boolean(bleedOverlapConfirmed),
      bleedOverlapJustification: bleedOverlapJustification ?? null,
    },
    warnings: [...allWarnings],
    measurementType: 'SERIALIZED_GEOMETRY_DELTA',
  };

  const result = {
    schemaVersion: PLANNING_ADAPTER_H2_VERSION,
    batchId: resolvedBatchId,
    h1RunPlan,
    impositionPlan,
    productionBatch: {
      batchId: resolvedBatchId,
      templateCount: sheets.length,
      physicalSheetCount: h1RunPlan.physicalSheetCount,
      uniquePhysicalPlacements,
      expectedFinishedQuantity,
      templates: templateMetaList,
    },
    productionOrderManifest,
    templateSnapshots,
    validation: {
      valid: true,
      contourVerified: true,
      geometryStatus: aggregatedGeometryStatus,
      colorStatus: aggregatedColorStatus,
      policyStatus: aggregatedBleedPolicyStatus,
      productionStatus: aggregatedProductionStatus,
      artworkColorVerified: aggregatedArtworkColorVerified,
      templates: contourValidations,
      warnings: [...allWarnings],
    },
  };

  assertNoBinaryInState(result, 'productionBatchPlanH2');
  return result;
}

/**
 * Update RunCount on an existing H.2 BatchPlan WITHOUT altering physical template coordinates,
 * while invalidating the previous `batchFreshnessHash` and `productionOrderManifest`.
 */
export async function updateBatchRunCountsH2(
  batchPlan,
  nextRunCountsByTemplateId,
  hashTextFn = defaultSha256Text
) {
  const updatedTemplates = batchPlan.productionOrderManifest.templates.map((t) => {
    const nextRun = nextRunCountsByTemplateId[t.templateId] ?? t.runCount;
    if (!Number.isSafeInteger(nextRun) || nextRun < 1) {
      throw new ProductionPlanningError('INVALID_QUANTITY', `Invalid runCount for ${t.templateId}: ${nextRun}`);
    }
    return {
      ...t,
      runCount: nextRun,
      expectedFinishedStickers: t.uniquePlacements * nextRun,
    };
  });

  const nextRunsMap = {};
  let physicalSheetCount = 0;
  let expectedFinishedQuantity = 0;
  for (const t of updatedTemplates) {
    nextRunsMap[t.templateId] = t.runCount;
    physicalSheetCount += t.runCount;
    expectedFinishedQuantity += t.expectedFinishedStickers;
  }

  const nextBatchFreshnessHash = await computeBatchFreshnessHashH2(
    {
      planHash: batchPlan.impositionPlan.planHash,
      runCountsByTemplateId: nextRunsMap,
      bleedPolicy: batchPlan.productionOrderManifest.bleedPolicy.policy,
      bleedClearanceMm: batchPlan.productionOrderManifest.bleedPolicy.bleedClearanceMm,
      bleedOverlapConfirmed: batchPlan.productionOrderManifest.bleedPolicy.bleedOverlapConfirmed,
    },
    hashTextFn
  );

  const nextSnapshots = batchPlan.templateSnapshots.map((s) => ({
    ...s,
    runCount: nextRunsMap[s.templateId] ?? s.runCount,
  }));

  return {
    ...batchPlan,
    // Physical coordinates in impositionPlan.sheets remain 100% IDENTICAL!
    impositionPlan: batchPlan.impositionPlan,
    productionBatch: {
      ...batchPlan.productionBatch,
      physicalSheetCount,
      expectedFinishedQuantity,
      templates: updatedTemplates,
    },
    productionOrderManifest: {
      ...batchPlan.productionOrderManifest,
      batchFreshnessHash: nextBatchFreshnessHash,
      physicalSheetCount,
      expectedFinishedQuantity,
      runCountsByTemplateId: nextRunsMap,
      templates: updatedTemplates,
    },
    templateSnapshots: nextSnapshots,
  };
}

/**
 * Optional deterministic expansion of unique SheetTemplates × RunCount into materialized physical sheets
 * ONLY when a downstream exporter or workflow explicitly requests all physical pages (e.g. 7 × 14 = 98).
 */
export function expandPhysicalSheetsH2(batchPlan) {
  const expanded = [];
  let physicalSheetNumber = 1;
  for (let i = 0; i < batchPlan.impositionPlan.sheets.length; i++) {
    const sheet = batchPlan.impositionPlan.sheets[i];
    const meta = batchPlan.productionOrderManifest.templates[i];
    for (let runInstance = 1; runInstance <= meta.runCount; runInstance++) {
      expanded.push({
        physicalSheetNumber: physicalSheetNumber++,
        templateId: meta.templateId,
        templateSheetIndex: sheet.sheetIndex,
        runInstance,
        totalRunsForTemplate: meta.runCount,
        sheet,
      });
    }
  }
  return expanded;
}

/**
 * End-to-end H.2 -> LOCKED F (PRINT/CUT Export) -> LOCKED G (Final Validator) integration entry point.
 */
export async function exportAndValidateBatchH2({
  batchPlan,
  jobs,
  assets = null,
  resourceStore,
  currentRunCounts = null,
  runCountsByTemplateId = null,
  sheetTemplates = null,
  expectedOrderManifest = null,
  cutFormat = 'PDF',
  scope = 'CUT_ONLY',
  cutSvgBytes = null,
  hashTextFn = defaultSha256Text,
}) {
  // 1. FAIL-CLOSED H.2 freshness & batchFreshnessHash check (jobs + templates + runCounts + manifest)
  const freshness = await assertBatchFreshnessH2({
    batchPlan,
    jobs,
    currentRunCounts,
    runCountsByTemplateId,
    sheetTemplates,
    expectedOrderManifest,
    sheetConfig: batchPlan.impositionPlan.sheetConfig,
    productionProfile: batchPlan.impositionPlan.productionProfile,
    hashTextFn,
  });

  // 2. LOCKED Checkpoint F atomic PRINT + CUT export from ONE ImpositionPlanV1
  const output = await exportProductionOutputs({
    plan: batchPlan.impositionPlan,
    jobs,
    assets,
    resourceStore,
    print: true,
    cut: { format: cutFormat, scope, sheetSelection: 'ALL' },
    sheetConfig: batchPlan.impositionPlan.sheetConfig,
    productionProfile: batchPlan.impositionPlan.productionProfile,
  });

  // 3. LOCKED Checkpoint G Final Production Validator (3.1.3 + Pair Integrity + SHA-256)
  const rawFinalCheck = await finalProductionCheck({
    plan: batchPlan.impositionPlan,
    jobs,
    output,
    resourceStore,
    sheetConfig: batchPlan.impositionPlan.sheetConfig,
    productionProfile: batchPlan.impositionPlan.productionProfile,
    cutSvgBytes,
  });

  // 4. Preserve H.2 non-blocking warnings (e.g. POLICY_ACCEPTED_COLOR_UNVERIFIED) in final report!
  const h2Warnings = batchPlan.productionOrderManifest.warnings || [];
  const mergedWarnings = [...(rawFinalCheck.warnings || []), ...h2Warnings];
  const mergedStatus =
    rawFinalCheck.errors.length > 0 ? 'BLOCK' : mergedWarnings.length > 0 ? 'WARNING' : 'PASS';
  const finalCheck = {
    ...rawFinalCheck,
    status: mergedStatus,
    warnings: mergedWarnings,
    h2Freshness: freshness,
    geometryStatus: batchPlan.productionOrderManifest.bleedPolicy.geometryStatus,
    colorStatus: batchPlan.productionOrderManifest.bleedPolicy.colorStatus,
    bleedPolicyStatus: batchPlan.productionOrderManifest.bleedPolicy.policyStatus,
    artworkColorVerified: batchPlan.productionOrderManifest.bleedPolicy.artworkColorVerified,
  };

  return {
    output,
    finalCheck,
    productionOrderManifest: batchPlan.productionOrderManifest,
  };
}
