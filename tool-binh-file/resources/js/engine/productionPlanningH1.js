/**
 * Checkpoint H.1 — pure, additive production planning.
 * No mutation of B–G locked modules. Units: physical millimetres.
 * This module DOES NOT emit an ImpositionPlanV1 or claim machine readiness.
 */
export const H1_PLANNING_VERSION = 'H1.1';

export class ProductionPlanningError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProductionPlanningError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new ProductionPlanningError(code, message, details); };
const finitePositive = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('INVALID_CONFIG', `${field} must be a finite number > 0`);
  return value;
};
const finiteNonnegative = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_CONFIG', `${field} must be a finite number >= 0`);
  return value;
};
const positiveInt = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_QUANTITY', `${field} must be a positive safe integer`);
  return value;
};
const nonnegativeInt = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_QUANTITY', `${field} must be a nonnegative safe integer`);
  return value;
};
const safeAdd = (a, b) => {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail('QUANTITY_OVERFLOW', 'Produced quantity exceeds safe integer range');
  return result;
};
const safeMultiply = (a, b) => {
  const result = a * b;
  if (!Number.isSafeInteger(result)) fail('QUANTITY_OVERFLOW', 'Produced quantity exceeds safe integer range');
  return result;
};
const requireId = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_CONFIG', `${field} must be a nonempty string`);
  return value;
};

/** CUT gap and BLEED clearance are distinct constraints.
 * `allow_overlap` allows BLEED overlap, but NEVER relaxes CUT gap.
 * `enforce_clearance` requires bbox separation of 2*bleedOutset + clearance.
 * Actual contour-based clearance is deferred to geometric validator.
 */
export function normalizeSpacingPolicy(input = {}) {
  const cutGapMm = finiteNonnegative(input.cutGapMm ?? 2, 'cutGapMm');
  const bleedOutsetMm = finiteNonnegative(input.bleedOutsetMm ?? 1.5, 'bleedOutsetMm');
  const bleedClearanceMm = finiteNonnegative(input.bleedClearanceMm ?? 0, 'bleedClearanceMm');
  const bleedPolicy = input.bleedPolicy ?? 'allow_overlap';
  if (!['allow_overlap', 'enforce_clearance'].includes(bleedPolicy)) fail('INVALID_CONFIG', 'Unknown bleedPolicy');
  const conservativeBboxGapMm = bleedPolicy === 'enforce_clearance'
    ? Math.max(cutGapMm, 2 * bleedOutsetMm + bleedClearanceMm)
    : cutGapMm;
  return Object.freeze({ cutGapMm, bleedOutsetMm, bleedClearanceMm, bleedPolicy, conservativeBboxGapMm,
    needsContourValidation: true });
}

export function normalizeSheetTemplate(input) {
  if (!input || typeof input !== 'object') fail('INVALID_CONFIG', 'SheetTemplate required');
  const templateId = requireId(input.templateId, 'templateId');
  const sheetWidthMm = finitePositive(input.sheetWidthMm, 'sheetWidthMm');
  const sheetHeightMm = finitePositive(input.sheetHeightMm, 'sheetHeightMm');
  const runCount = positiveInt(input.runCount ?? 1, 'runCount');
  const m = input.marginsMm ?? {};
  const marginsMm = Object.freeze({
    top: finiteNonnegative(m.top ?? 0, 'marginsMm.top'),
    right: finiteNonnegative(m.right ?? 0, 'marginsMm.right'),
    bottom: finiteNonnegative(m.bottom ?? 0, 'marginsMm.bottom'),
    left: finiteNonnegative(m.left ?? 0, 'marginsMm.left'),
  });
  if (marginsMm.left + marginsMm.right >= sheetWidthMm || marginsMm.top + marginsMm.bottom >= sheetHeightMm)
    fail('INVALID_CONFIG', 'Sheet margins leave no usable area', { templateId });
  const placements = input.placements;
  if (!Array.isArray(placements) || !placements.length) fail('INVALID_CONFIG', 'SheetTemplate requires placements');
  const seen = new Set();
  const normalized = placements.map((p, i) => {
    if (!p || typeof p !== 'object') fail('INVALID_CONFIG', `placements[${i}] invalid`);
    const placementId = requireId(p.placementId, `placements[${i}].placementId`);
    const jobId = requireId(p.jobId, `placements[${i}].jobId`);
    if (seen.has(placementId)) fail('DUPLICATE_PLACEMENT', `Duplicate placementId: ${placementId}`);
    seen.add(placementId);
    const copiesPerRun = positiveInt(p.copiesPerRun ?? 1, `placements[${i}].copiesPerRun`);
    return Object.freeze({ placementId, jobId, copiesPerRun });
  });
  return Object.freeze({ templateId, sheetWidthMm, sheetHeightMm, marginsMm, runCount,
    placements: Object.freeze(normalized) });
}

/**
 * Pure quantity ledger: each placement's copiesPerRun is multiplied by the
 * number of physical prints of its sheet template. No 14,400-placement expansion.
 * `jobs` is an explicit catalog; unknown and omitted jobs are errors.
 */
export function buildProductionRunPlan({ jobs, sheetTemplates, spacingPolicy = {} }) {
  if (!Array.isArray(jobs) || !jobs.length) fail('INVALID_CONFIG', 'jobs catalog must be nonempty');
  if (!Array.isArray(sheetTemplates) || !sheetTemplates.length) fail('INVALID_CONFIG', 'sheetTemplates must be nonempty');
  const catalog = new Map();
  for (const job of jobs) {
    const jobId = requireId(job?.jobId, 'jobId');
    if (catalog.has(jobId)) fail('DUPLICATE_JOB', `Duplicate jobId: ${jobId}`);
    catalog.set(jobId, { requestedQuantity: nonnegativeInt(job.requestedQuantity, `${jobId}.requestedQuantity`) });
  }
  const spacing = normalizeSpacingPolicy(spacingPolicy);
  const templates = sheetTemplates.map(normalizeSheetTemplate);
  const templateIds = new Set();
  const totals = new Map([...catalog].map(([id]) => [id, 0]));
  let physicalSheetCount = 0;
  for (const template of templates) {
    if (templateIds.has(template.templateId)) fail('DUPLICATE_TEMPLATE', `Duplicate templateId: ${template.templateId}`);
    templateIds.add(template.templateId);
    physicalSheetCount = safeAdd(physicalSheetCount, template.runCount);
    for (const placement of template.placements) {
      if (!catalog.has(placement.jobId)) fail('UNKNOWN_JOB', `Unknown jobId ${placement.jobId} in ${template.templateId}`);
      totals.set(placement.jobId, safeAdd(totals.get(placement.jobId), safeMultiply(placement.copiesPerRun, template.runCount)));
    }
  }
  const ledger = [...catalog].sort(([a], [b]) => a.localeCompare(b)).map(([jobId, info]) => {
    const producedQuantity = totals.get(jobId);
    const deltaQuantity = producedQuantity - info.requestedQuantity;
    return Object.freeze({ jobId, requestedQuantity: info.requestedQuantity, producedQuantity, deltaQuantity,
      status: deltaQuantity === 0 ? 'EXACT' : deltaQuantity < 0 ? 'SHORT' : 'EXCESS' });
  });
  const status = ledger.every((r) => r.status === 'EXACT') ? 'QUANTITY_MATCH' : 'QUANTITY_MISMATCH';
  return Object.freeze({ schemaVersion: H1_PLANNING_VERSION, status, physicalSheetCount,
    spacingPolicy: spacing, sheetTemplates: Object.freeze(templates), ledger: Object.freeze(ledger),
    geometryValidated: false, outputValidated: false, machineVerified: false });
}

/** Conservative rectangular capacity estimate only; not a nesting guarantee. */
export function estimateUniformGridCapacity({ sheetWidthMm, sheetHeightMm, itemWidthMm, itemHeightMm, marginsMm = {}, spacingPolicy = {}, allowRotate = false }) {
  const w = finitePositive(sheetWidthMm, 'sheetWidthMm');
  const h = finitePositive(sheetHeightMm, 'sheetHeightMm');
  const iw = finitePositive(itemWidthMm, 'itemWidthMm');
  const ih = finitePositive(itemHeightMm, 'itemHeightMm');
  const m = { left: finiteNonnegative(marginsMm.left ?? 0, 'left'), right: finiteNonnegative(marginsMm.right ?? 0, 'right'), top: finiteNonnegative(marginsMm.top ?? 0, 'top'), bottom: finiteNonnegative(marginsMm.bottom ?? 0, 'bottom') };
  const availableW = w - m.left - m.right, availableH = h - m.top - m.bottom;
  if (availableW <= 0 || availableH <= 0) fail('INVALID_CONFIG', 'No usable area');
  const gap = normalizeSpacingPolicy(spacingPolicy).conservativeBboxGapMm;
  const fit = (sw, sh, rotationDeg) => {
    const columns = Math.max(0, Math.floor((availableW + gap + 1e-9) / (sw + gap)));
    const rows = Math.max(0, Math.floor((availableH + gap + 1e-9) / (sh + gap)));
    return { columns, rows, capacity: safeMultiply(columns, rows), rotationDeg };
  };
  const normal = fit(iw, ih, 0);
  const rotated = allowRotate ? fit(ih, iw, 90) : null;
  const best = rotated && rotated.capacity > normal.capacity ? rotated : normal;
  return Object.freeze({ ...best, method: 'RECTANGULAR_GRID_ESTIMATE', geometryValidated: false });
}
