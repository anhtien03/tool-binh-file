/**
 * PrintKit Architecture V1 — Checkpoint H.2 Production Plan & Contour Validator
 *
 * Pure, additive validator for:
 *  - Exact contour-based CUT collision & cutGapMm enforcement (NOT bbox-only!).
 *  - Explicit BLEED policy validation ('strict' vs 'allow_overlap' with BLEED_OVERLAP_UNVERIFIED guard).
 *  - RunCount + Template + Job freshness guard (STALE_PLAN on any mutation).
 *  - Quantity ledger integrity (QUANTITY_MISMATCH).
 *
 * ZERO edits to locked B–G / H.1 modules.
 */

import { canonicalStringify } from './v1Schema.js';
import { assertPlanFreshness } from './batchImpositionAdapter.js';
import { transformContourByRigidMatrixMm } from './cutVectorExporter.js';
import { evaluateProductionBleedSafetyH22 } from './productionBleedSafetyH22.js';

export const PLAN_VALIDATOR_H2_VERSION = 'H2.2';

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('productionPlanValidatorH2: crypto.subtle.digest is unavailable');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeBatchFreshnessHashH2(
  { planHash, runCountsByTemplateId, bleedPolicy, bleedClearanceMm, bleedOverlapConfirmed },
  hashTextFn = defaultSha256Text
) {
  return await hashTextFn(
    canonicalStringify({
      planHash,
      runCountsByTemplateId,
      bleedPolicy,
      bleedClearanceMm,
      bleedOverlapConfirmed: Boolean(bleedOverlapConfirmed),
    })
  );
}

export class ProductionPlanValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProductionPlanValidationError';
    this.stage = 'PLAN_VALIDATION_H2';
    this.code = code; // 'CUT_COLLISION' | 'BLEED_STRICT_VIOLATION' | 'BLEED_OVERLAP_UNVERIFIED' | 'QUANTITY_MISMATCH' | 'STALE_PLAN' | 'MISSING_RUN_COUNTS' | 'MANIFEST_HASH_MISMATCH' | 'SCHEMA_INCOMPATIBLE'
    this.details = details;
  }
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

/**
 * Sample a transformed contour (beziersMm) into a dense closed polygon in sheet-mm.
 */
export function sampleContourToPolygonMm(contourMm, curveSteps = 8) {
  const pts = [];
  const cmds = contourMm?.beziersMm || [];
  let cur = [0, 0];
  for (const cmd of cmds) {
    if (cmd.type === 'M' && cmd.to) {
      cur = cmd.to;
      pts.push(cur);
    } else if (cmd.type === 'L' && cmd.to) {
      cur = cmd.to;
      pts.push(cur);
    } else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
      const [x0, y0] = cur;
      const [x1, y1] = cmd.c1;
      const [x2, y2] = cmd.c2;
      const [x3, y3] = cmd.to;
      for (let s = 1; s <= curveSteps; s++) {
        const t = s / curveSteps;
        const u = 1 - t;
        pts.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      cur = cmd.to;
    }
  }
  // Remove closing duplicate if identical to start
  if (pts.length > 2) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) pts.pop();
  }
  return pts;
}

function polygonBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function bboxMinDist(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function pointInPolygon(pt, poly) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function orient2d(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return (
    Math.min(a[0], b[0]) - 1e-9 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(c, d, b)) return true;
  return false;
}

function pointToSegmentDistSq(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return (p[0] - px) ** 2 + (p[1] - py) ** 2;
}

/**
 * Exact minimum Euclidean distance between two closed polygons in mm.
 * Returns 0 if polygons intersect or one contains the other.
 */
export function exactPolygonDistanceMm(polyA, polyB) {
  if (!polyA.length || !polyB.length) return Infinity;
  if (pointInPolygon(polyA[0], polyB) || pointInPolygon(polyB[0], polyA)) return 0;

  let minSq = Infinity;
  const nA = polyA.length;
  const nB = polyB.length;
  for (let i = 0; i < nA; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % nB];
      if (segmentsIntersect(a1, a2, b1, b2)) return 0;
      const d1 = pointToSegmentDistSq(a1, b1, b2);
      if (d1 < minSq) minSq = d1;
      const d2 = pointToSegmentDistSq(b1, a1, a2);
      if (d2 < minSq) minSq = d2;
    }
  }
  return Math.sqrt(minSq);
}

/**
 * Validate CUT gap / collision, two-way BLEED-CUT intrusion, and BLEED overlap/color policy
 * by delegating to the H.2.2 flatness-controlled Bézier safety engine.
 */
export function validateTemplateContoursH2({
  templateId,
  sheet,
  jobMap,
  cutGapMm = 2,
  bleedPolicy = 'strict', // 'strict' | 'enforce_clearance' | 'allow_overlap'
  bleedClearanceMm = 0,
  bleedOverlapConfirmed = false,
  bleedOverlapJustification = null,
  bleedColorByJobId = null,
  flatnessMm,
}) {
  return evaluateProductionBleedSafetyH22({
    templateId,
    sheet,
    jobMap,
    cutGapMm,
    bleedPolicy,
    bleedClearanceMm,
    bleedOverlapConfirmed,
    bleedOverlapJustification,
    bleedColorByJobId,
    flatnessMm,
  });
}

/**
 * Verify H.2 ProductionBatch freshness against current jobs, runCounts, templates & order manifest.
 * FAIL-CLOSED:
 *  - Missing currentRunCounts (and no sheetTemplates to derive from) -> BLOCK (MISSING_RUN_COUNTS).
 *  - Any runCount change (e.g. 14 -> 20) -> BLOCK (STALE_PLAN).
 *  - Recomputed batchFreshnessHash != manifest.batchFreshnessHash -> BLOCK (MANIFEST_HASH_MISMATCH).
 *  - Stale expectedOrderManifest -> BLOCK (STALE_PLAN).
 */
export async function assertBatchFreshnessH2({
  batchPlan,
  jobs,
  currentRunCounts = null,
  runCountsByTemplateId = null, // alias for currentRunCounts
  sheetTemplates = null,
  expectedOrderManifest = null,
  sheetConfig = null,
  productionProfile = null,
  hashTextFn = defaultSha256Text,
}) {
  if (!batchPlan || !batchPlan.impositionPlan || !batchPlan.productionOrderManifest) {
    throw new ProductionPlanValidationError('STALE_PLAN', 'Invalid or missing H.2 batchPlan');
  }

  // 1. Delegate base ImpositionPlanV1 freshness to LOCKED batchImpositionAdapter.js
  try {
    assertPlanFreshness(batchPlan.impositionPlan, jobs, sheetConfig, productionProfile);
  } catch (err) {
    throw new ProductionPlanValidationError(err?.code || 'STALE_PLAN', err?.message || 'Base ImpositionPlan is stale', {
      cause: err?.code,
    });
  }

  // 2. FAIL-CLOSED: Require explicit trustworthy currentRunCounts (or derive strictly from provided sheetTemplates)
  let resolvedRuns = currentRunCounts ?? runCountsByTemplateId ?? null;
  if (!resolvedRuns && Array.isArray(sheetTemplates) && sheetTemplates.length > 0) {
    resolvedRuns = {};
    for (const t of sheetTemplates) {
      if (!t?.templateId || !Number.isSafeInteger(t.runCount) || t.runCount < 1) {
        throw new ProductionPlanValidationError(
          'MISSING_RUN_COUNTS',
          'sheetTemplates contains invalid or missing runCount'
        );
      }
      resolvedRuns[t.templateId] = t.runCount;
    }
  }
  if (!resolvedRuns || typeof resolvedRuns !== 'object' || Object.keys(resolvedRuns).length === 0) {
    throw new ProductionPlanValidationError(
      'MISSING_RUN_COUNTS',
      'MISSING_RUN_COUNTS: currentRunCounts (or sheetTemplates with confirmed runCount) is REQUIRED before export; null/omitted cannot bypass freshness check'
    );
  }

  // 3. Verify every template runCount matches batchPlan.productionOrderManifest.runCountsByTemplateId
  const manifest = batchPlan.productionOrderManifest;
  const manifestRuns = manifest.runCountsByTemplateId || {};
  const manifestKeys = Object.keys(manifestRuns).sort();
  const currentKeys = Object.keys(resolvedRuns).sort();
  if (canonicalStringify(currentKeys) !== canonicalStringify(manifestKeys)) {
    throw new ProductionPlanValidationError(
      'STALE_PLAN',
      'STALE_PLAN: Template set in currentRunCounts does not match productionOrderManifest',
      { expectedTemplates: manifestKeys, currentTemplates: currentKeys }
    );
  }
  for (const tid of manifestKeys) {
    const val = resolvedRuns[tid];
    if (!Number.isSafeInteger(val) || val < 1) {
      throw new ProductionPlanValidationError('MISSING_RUN_COUNTS', `Invalid current runCount for ${tid}: ${val}`);
    }
    if (val !== manifestRuns[tid]) {
      throw new ProductionPlanValidationError(
        'STALE_PLAN',
        `STALE_PLAN: runCount for ${tid} changed (${manifestRuns[tid]} -> ${val}); old productionOrderManifest is stale`,
        { templateId: tid, manifestRunCount: manifestRuns[tid], currentRunCount: val }
      );
    }
  }

  // 4. Recompute authoritative batchFreshnessHash and verify manifest integrity (catches tampered/stale manifests)
  const recomputedHash = await computeBatchFreshnessHashH2(
    {
      planHash: batchPlan.impositionPlan.planHash,
      runCountsByTemplateId: resolvedRuns,
      bleedPolicy: manifest.bleedPolicy?.policy,
      bleedClearanceMm: manifest.bleedPolicy?.bleedClearanceMm,
      bleedOverlapConfirmed: manifest.bleedPolicy?.bleedOverlapConfirmed,
    },
    hashTextFn
  );
  if (recomputedHash !== manifest.batchFreshnessHash) {
    throw new ProductionPlanValidationError(
      'MANIFEST_HASH_MISMATCH',
      `MANIFEST_HASH_MISMATCH: recomputed batchFreshnessHash (${recomputedHash.slice(0, 12)}) != manifest (${String(manifest.batchFreshnessHash).slice(0, 12)})`
    );
  }

  // 5. If caller supplied an external order manifest (e.g. cached manifest from 14 copies vs 20 copies), enforce exact hash match
  if (expectedOrderManifest) {
    if (expectedOrderManifest.batchFreshnessHash !== recomputedHash) {
      throw new ProductionPlanValidationError(
        'STALE_PLAN',
        'STALE_PLAN: Provided expectedOrderManifest.batchFreshnessHash does not match current production order',
        {
          expectedManifestHash: expectedOrderManifest.batchFreshnessHash,
          currentHash: recomputedHash,
        }
      );
    }
  }

  // 6. Check sheetTemplates snapshot (template layout / gridSpec / runCount / items) when supplied
  if (Array.isArray(sheetTemplates)) {
    const curSnap = sheetTemplates.map((t) => ({
      templateId: t.templateId,
      sheetWidthMm: t.sheetWidthMm,
      sheetHeightMm: t.sheetHeightMm,
      runCount: t.runCount,
      marginsMm: t.marginsMm ?? null,
      gridSpec: t.gridSpec ?? null,
      items: (t.items || t.placements || []).map((p) => ({ jobId: p.jobId, copiesPerRun: p.copiesPerRun ?? 1 })),
    }));
    if (canonicalStringify(curSnap) !== canonicalStringify(batchPlan.templateSnapshots)) {
      throw new ProductionPlanValidationError(
        'STALE_PLAN',
        'STALE_PLAN: SheetTemplate configuration or runCount changed after batch plan creation'
      );
    }
  }

  return Object.freeze({
    fresh: true,
    verifiedBatchFreshnessHash: recomputedHash,
    verifiedRunCounts: { ...resolvedRuns },
  });
}
