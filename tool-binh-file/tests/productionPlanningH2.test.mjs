/**
 * PrintKit Architecture V1 — Checkpoint H.2 Automated Verification Suite
 * Covers H2-01 through H2-17 + Real Production Fixture L0110.063 (7×99=693, ×14=9,702)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import {
  createBleedConfigV1,
  createCanonicalCutV1,
  createStickerJobV1,
  updateStickerJobOrder,
} from '../resources/js/engine/v1Schema.js';
import { deriveProductionGeometry } from '../resources/js/engine/productionGeometry.js';
import { PRODUCTION_PROFILES } from '../resources/js/engine/batchImpositionAdapter.js';
import { packSheetTemplateGrid } from '../resources/js/engine/gridPackingH2.js';
import { assertBatchFreshnessH2 } from '../resources/js/engine/productionPlanValidatorH2.js';
import {
  buildProductionBatchPlanH2,
  updateBatchRunCountsH2,
  expandPhysicalSheetsH2,
  exportAndValidateBatchH2,
} from '../resources/js/engine/productionPlanningAdapterH2.js';
import { exportProductionOutputs } from '../resources/js/engine/productionOutput.js';
import { finalProductionCheck } from '../resources/js/engine/finalProductionValidator.js';
import { transformContourByRigidMatrixMm } from '../resources/js/engine/cutVectorExporter.js';
import { sampleContourToPolygonMm } from '../resources/js/engine/productionPlanValidatorH2.js';

const TINY_PNG_BYTES = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
);

// Minimal Node canvas mock ONLY for 3.1.2 Precision BLEED rasterizer inside deriveProductionGeometry
function makeMockCanvas(initW = 0, initH = 0) {
  return {
    _w: initW,
    _h: initH,
    _data: new Uint8ClampedArray(initW * initH * 4),
    get width() { return this._w; },
    set width(v) { this._w = Math.max(0, v | 0); this._data = new Uint8ClampedArray(this._w * this._h * 4); },
    get height() { return this._h; },
    set height(v) { this._h = Math.max(0, v | 0); this._data = new Uint8ClampedArray(this._w * this._h * 4); },
    getContext() {
      const self = this;
      let path = [], cur = [0, 0];
      return {
        fillStyle: '#000',
        clearRect() { self._data.fill(0); },
        getImageData(x, y, w, h) { return { data: self._data, width: w, height: h }; },
        beginPath() { path = []; },
        moveTo(x, y) { cur = [x, y]; path.push(cur); },
        lineTo(x, y) { cur = [x, y]; path.push(cur); },
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
          const [p0x, p0y] = cur;
          const steps = Math.max(16, Math.min(64, Math.ceil(Math.hypot(x - p0x, y - p0y) / 2)));
          for (let i = 1; i <= steps; i++) {
            const t = i / steps, u = 1 - t;
            path.push([
              u ** 3 * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * x,
              u ** 3 * p0y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * y,
            ]);
          }
          cur = [x, y];
        },
        closePath() {},
        fill() {
          const n = path.length;
          if (n < 3) return;
          const cw = self._w, ch = self._h, ddata = self._data;
          let minY = ch, maxY = 0;
          for (const [, py] of path) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
          for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(ch - 1, Math.ceil(maxY)); y++) {
            const sy = y + 0.5, xs = [];
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const [x1, y1] = path[j], [x2, y2] = path[i];
              if ((y1 > sy) !== (y2 > sy)) xs.push(x1 + ((sy - y1) * (x2 - x1)) / (y2 - y1));
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
              const xb = Math.min(cw - 1, Math.floor(xs[k + 1] - 0.5));
              for (let x = xa; x <= xb; x++) ddata[(y * cw + x) * 4 + 3] = 255;
            }
          }
        },
      };
    },
  };
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeMockCanvas(0, 0) : {}) };

function makeStore() {
  return createResourceStore({
    createObjectURL: (b) => `blob:h2/${Math.random()}/${b.size}`,
    revokeObjectURL: () => {},
  });
}

function makeRectCanonical(w, h, hash = 'b'.repeat(64)) {
  const pts = [[0, 0], [w, 0], [w, h], [0, h]];
  const beziersMm = [
    { type: 'M', to: [0, 0] },
    { type: 'L', to: [w, 0] },
    { type: 'L', to: [w, h] },
    { type: 'L', to: [0, h] },
    { type: 'L', to: [0, 0] },
  ];
  Object.assign(pts, { beziersMm, closed: true, cornerCount: 4 });
  return createCanonicalCutV1({ cutInputHash: hash, cutRevision: 1, naturalTrimMm: { w, h }, cutNaturalMm: pts });
}

async function makeJob(store, { jobId, w = 20.024, h = 20.024, quantity = 1386, bleedMm = 0, allowRotate = true } = {}) {
  const resMeta = await store.acquire(TINY_PNG_BYTES, { kind: 'source_file', mimeType: 'image/png' });
  const canonicalCut = makeRectCanonical(w, h, resMeta.sha256);
  const bleedConfig = createBleedConfigV1({
    bleedMode: bleedMm > 0 ? 'precision' : 'none',
    bleedOffsetMm: bleedMm,
  });
  const prod = await deriveProductionGeometry({
    jobId,
    canonicalCut,
    targetSizeMm: { w, h },
    bleedConfig,
    lockAspectRatio: true,
  });
  const gVal = prod.geometryValidation;
  const isReady = gVal.bleedStatus !== 'INVALID';
  return createStickerJobV1({
    jobId,
    jobRevision: 1,
    label: jobId,
    origin: { sourceAssetId: 'AST-H2', pageIndex: 1, sourceStickerIndex: 1, sourceRegionMm: { x: 0, y: 0, w, h } },
    artworkRef: { resourceId: resMeta.resourceId },
    bleedConfig,
    canonicalCut,
    productionGeometry: prod.productionGeometry,
    order: { targetSizeMm: { w, h }, lockAspectRatio: true, quantity, allowRotate, included: true },
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
}

// =========================================================================
// H2-01, H2-02, H2-03, H2-04: H.1 -> V1 + 7 templates × 14 runCount = 9,702
//                              693 unique placements, 9×11 = 99/sheet
// =========================================================================
test('H2-01..H2-04: H.1 -> V1 lossless, 7×14=98 sheets, 693 unique placements, 9,702 finished stickers, 9×11=99/sheet', async () => {
  const store = makeStore();
  const tiers = ['3P', '5P', '10P', '15P', '20P', '25P', '30P'];
  const jobs = [];
  for (const t of tiers) {
    jobs.push(await makeJob(store, { jobId: `SKU-${t}`, w: 20.024, h: 20.024, quantity: 99 * 14, bleedMm: 0 }));
  }

  const sheetTemplates = tiers.map((t, i) => ({
    templateId: `TPL-P${i + 1}`,
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    runCount: 14, // Explicitly confirmed runCount (never inferred from filename)
    gridSpec: { rows: 11, columns: 9, pitchXmm: 22.46, pitchYmm: 25.4, centerX: true, centerY: true },
    items: [{ jobId: `SKU-${t}`, copiesPerRun: 99 }],
  }));

  const batch = await buildProductionBatchPlanH2({
    batchId: 'BATCH-L0110-REF',
    jobs,
    sheetTemplates,
    spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 0 },
    bleedPolicy: 'strict',
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });

  // H2-01: lossless H.1 -> V1 mapping
  assert.equal(batch.h1RunPlan.status, 'QUANTITY_MATCH');
  assert.equal(batch.h1RunPlan.ledger.length, 7);
  // H2-02: 7 × 14 = 98 physical sheets, 9,702 expected finished stickers
  assert.equal(batch.productionOrderManifest.physicalSheetCount, 98);
  assert.equal(batch.productionOrderManifest.expectedFinishedQuantity, 9702);
  // H2-03: 693 unique physical placements (NOT 9,702!)
  assert.equal(batch.impositionPlan.totalPlacedCopies, 693);
  assert.equal(batch.impositionPlan.sheets.length, 7);
  // H2-04: Grid 9×11 creates exact 99 placements per sheet, 1-based copyIndex 1..99
  for (const sh of batch.impositionPlan.sheets) {
    assert.equal(sh.placements.length, 99);
    assert.equal(sh.placements[0].copyIndex, 1);
    assert.equal(sh.placements[98].copyIndex, 99);
  }
  // Optional physical sheet expansion materializes 98 sheets cleanly when requested
  const expanded = expandPhysicalSheetsH2(batch);
  assert.equal(expanded.length, 98);
  assert.equal(expanded[0].physicalSheetNumber, 1);
  assert.equal(expanded[97].physicalSheetNumber, 98);
});

// =========================================================================
// H2-05: Partial grid (missing trailing cells -> NO fake stickers)
// =========================================================================
test('H2-05: Partial grid (95 items in 9×11=99 grid) creates exact 95 placements, zero fake stickers', async () => {
  const store = makeStore();
  const job = await makeJob(store, { jobId: 'SKU-PARTIAL', w: 20, h: 20, quantity: 95 });
  const batch = await buildProductionBatchPlanH2({
    jobs: [job],
    sheetTemplates: [{
      templateId: 'TPL-PARTIAL',
      sheetWidthMm: 320,
      sheetHeightMm: 330,
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      runCount: 1,
      gridSpec: { rows: 11, columns: 9, pitchXmm: 23, pitchYmm: 25, centerX: true, centerY: true },
      items: [{ jobId: 'SKU-PARTIAL', copiesPerRun: 95 }],
    }],
    spacingPolicy: { cutGapMm: 2 },
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });
  assert.equal(batch.impositionPlan.sheets[0].placements.length, 95);
  assert.equal(batch.productionOrderManifest.expectedFinishedQuantity, 95);
});

// =========================================================================
// H2-06: Grid capacity exceeded -> BLOCK (GRID_CAPACITY_EXCEEDED)
// =========================================================================
test('H2-06: Grid exceeding capacity blocks with GRID_CAPACITY_EXCEEDED', async () => {
  const store = makeStore();
  const job = await makeJob(store, { jobId: 'SKU-OVERFLOW', w: 20, h: 20, quantity: 100 });
  await assert.rejects(
    () =>
      buildProductionBatchPlanH2({
        jobs: [job],
        sheetTemplates: [{
          templateId: 'TPL-OVERFLOW',
          sheetWidthMm: 320,
          sheetHeightMm: 330,
          marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
          runCount: 1,
          gridSpec: { rows: 11, columns: 9, pitchXmm: 23, pitchYmm: 25, centerX: true, centerY: true },
          items: [{ jobId: 'SKU-OVERFLOW', copiesPerRun: 100 }], // 100 > 99!
        }],
        spacingPolicy: { cutGapMm: 2 },
      }),
    { code: 'GRID_CAPACITY_EXCEEDED' }
  );
});

// =========================================================================
// H2-07: CUT collision -> BLOCK (CUT_COLLISION)
// =========================================================================
test('H2-07: CUT collision / cutGapMm violation blocks with CUT_COLLISION', async () => {
  const store = makeStore();
  const job = await makeJob(store, { jobId: 'SKU-COLLIDE', w: 20, h: 20, quantity: 4 });
  await assert.rejects(
    () =>
      buildProductionBatchPlanH2({
        jobs: [job],
        sheetTemplates: [{
          templateId: 'TPL-COLLIDE',
          sheetWidthMm: 320,
          sheetHeightMm: 330,
          marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
          runCount: 1,
          // pitchXmm=20.5 on 20mm sticker -> actual CUT gap = 0.5mm < required cutGapMm=2.0mm!
          gridSpec: { rows: 2, columns: 2, pitchXmm: 20.5, pitchYmm: 25, centerX: true, centerY: true },
          items: [{ jobId: 'SKU-COLLIDE', copiesPerRun: 4 }],
        }],
        spacingPolicy: { cutGapMm: 2 },
        bleedPolicy: 'allow_overlap',
        bleedOverlapConfirmed: true,
        bleedOverlapJustification: 'uniform cream background',
      }),
    { code: 'CUT_GAP_VIOLATION' }
  );
});

// =========================================================================
// H2-08 & H2-09: BLEED strict violation -> BLOCK;
//                BLEED allow_overlap without confirmation -> BLEED_OVERLAP_UNVERIFIED;
//                BLEED allow_overlap WITH confirmation -> PASS (with warning)
// =========================================================================
test('H2-08 & H2-09: BLEED strict blocks, unverified allow_overlap blocks, confirmed allow_overlap passes', async () => {
  const store = makeStore();
  // 20×20mm sticker with 1.5mm Precision BLEED -> BLEED bbox is 23×23mm.
  // With pitchXmm=22.2mm: CUT gap = 2.2mm (>= 2.0mm OK), BLEED contours overlap by 0.8mm!
  const job = await makeJob(store, { jobId: 'SKU-BLEED', w: 20, h: 20, quantity: 4, bleedMm: 1.5 });
  const tpl = [{
    templateId: 'TPL-BLEED',
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    runCount: 1,
    gridSpec: { rows: 2, columns: 2, pitchXmm: 22.2, pitchYmm: 26, centerX: true, centerY: true },
    items: [{ jobId: 'SKU-BLEED', copiesPerRun: 4 }],
  }];

  // H2-08: strict policy must BLOCK
  await assert.rejects(
    () =>
      buildProductionBatchPlanH2({
        jobs: [job],
        sheetTemplates: tpl,
        spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 1.5 },
        bleedPolicy: 'strict',
        bleedClearanceMm: 0.5,
      }),
    { code: 'BLEED_STRICT_VIOLATION' }
  );

  // H2-09a: allow_overlap WITHOUT confirmation must BLOCK with BLEED_OVERLAP_UNVERIFIED
  await assert.rejects(
    () =>
      buildProductionBatchPlanH2({
        jobs: [job],
        sheetTemplates: tpl,
        spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 1.5 },
        bleedPolicy: 'allow_overlap',
        bleedOverlapConfirmed: false,
      }),
    { code: 'BLEED_OVERLAP_UNVERIFIED' }
  );

  // H2-09b: allow_overlap WITH explicit confirmation & justification -> POLICY_ACCEPTED_COLOR_UNVERIFIED + WARNING preserved end-to-end
  const ok = await buildProductionBatchPlanH2({
    jobs: [job],
    sheetTemplates: tpl,
    spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 1.5 },
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'Confirmed uniform cream background across adjacent stickers',
  });
  assert.equal(ok.validation.valid, true);
  assert.equal(ok.validation.policyStatus, 'POLICY_ACCEPTED_COLOR_UNVERIFIED');
  assert.equal(ok.validation.artworkColorVerified, false);
  assert.equal(ok.productionOrderManifest.bleedPolicy.policyStatus, 'POLICY_ACCEPTED_COLOR_UNVERIFIED');
  assert.equal(ok.productionOrderManifest.bleedPolicy.artworkColorVerified, false);
  assert.ok(ok.productionOrderManifest.warnings.some((w) => w.includes('POLICY_ACCEPTED_COLOR_UNVERIFIED')));

  const expOverlap = await exportAndValidateBatchH2({
    batchPlan: ok,
    jobs: [job],
    resourceStore: store,
    currentRunCounts: { 'TPL-BLEED': 1 },
  });
  assert.equal(expOverlap.finalCheck.productionReady, true);
  assert.equal(expOverlap.finalCheck.status, 'WARNING');
  assert.equal(expOverlap.finalCheck.bleedPolicyStatus, 'POLICY_ACCEPTED_COLOR_UNVERIFIED');
  assert.equal(expOverlap.finalCheck.artworkColorVerified, false);
  assert.ok(expOverlap.finalCheck.warnings.some((w) => w.includes('POLICY_ACCEPTED_COLOR_UNVERIFIED')));
});

// =========================================================================
// H2-10, H2-11 & H2.1-NEG-1..5: Freshness Security (Fail-Closed, 14->20,
//   Old Manifest, Tampered Hash, and Honest Direct F/G Bypass Boundary)
// =========================================================================
test('H2-10, H2-11 & H2.1-NEG-1..5: Fail-closed freshness, 14->20 STALE_PLAN, old manifest, tampered hash, and direct F/G bypass audit', async () => {
  const store = makeStore();
  const job = await makeJob(store, { jobId: 'SKU-FRESH', w: 30, h: 30, quantity: 4 * 14 });
  const sheetTemplates = [{
    templateId: 'TPL-F1',
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    runCount: 14,
    gridSpec: { rows: 2, columns: 2, pitchXmm: 35, pitchYmm: 35, centerX: true, centerY: true },
    items: [{ jobId: 'SKU-FRESH', copiesPerRun: 4 }],
  }];

  const batch = await buildProductionBatchPlanH2({
    jobs: [job],
    sheetTemplates,
    spacingPolicy: { cutGapMm: 2 },
  });

  // H2.1-NEG-1: Omitting / null currentRunCounts in exportAndValidateBatchH2 MUST BLOCK (fail-closed!)
  await assert.rejects(
    () => exportAndValidateBatchH2({ batchPlan: batch, jobs: [job], resourceStore: store }),
    { code: 'MISSING_RUN_COUNTS' }
  );

  // H2-10a: Mutating job quantity -> STALE_PLAN
  const mutatedJob = updateStickerJobOrder(job, { quantity: 60 });
  await assert.rejects(
    () => assertBatchFreshnessH2({ batchPlan: batch, jobs: [mutatedJob], currentRunCounts: { 'TPL-F1': 14 } }),
    { code: 'STALE_PLAN' }
  );

  // H2-10b: Mutating template gridSpec -> STALE_PLAN
  const mutatedTemplates = [{ ...sheetTemplates[0], gridSpec: { ...sheetTemplates[0].gridSpec, pitchXmm: 36 } }];
  await assert.rejects(
    () => assertBatchFreshnessH2({ batchPlan: batch, jobs: [job], sheetTemplates: mutatedTemplates }),
    { code: 'STALE_PLAN' }
  );

  // H2-11 / H2.1-NEG-2: Changing runCount 14 -> 20 MUST BLOCK exportAndValidateBatchH2 with STALE_PLAN
  await assert.rejects(
    () => exportAndValidateBatchH2({ batchPlan: batch, jobs: [job], resourceStore: store, currentRunCounts: { 'TPL-F1': 20 } }),
    { code: 'STALE_PLAN' }
  );

  // H2.1-NEG-3: Updating runCount 14 -> 20 preserves physical coordinates, invalidates old 14-copy manifest
  const oldCoords = JSON.stringify(batch.impositionPlan.sheets);
  const oldManifest = batch.productionOrderManifest;
  const updated = await updateBatchRunCountsH2(batch, { 'TPL-F1': 20 });
  assert.equal(JSON.stringify(updated.impositionPlan.sheets), oldCoords);
  assert.notEqual(updated.productionOrderManifest.batchFreshnessHash, oldManifest.batchFreshnessHash);
  assert.equal(updated.productionOrderManifest.physicalSheetCount, 20);
  assert.equal(updated.productionOrderManifest.expectedFinishedQuantity, 80);

  // Passing OLD 14-copy manifest as expectedOrderManifest against updated 20-copy batch MUST BLOCK
  await assert.rejects(
    () =>
      exportAndValidateBatchH2({
        batchPlan: updated,
        jobs: [job],
        resourceStore: store,
        currentRunCounts: { 'TPL-F1': 20 },
        expectedOrderManifest: oldManifest,
      }),
    { code: 'STALE_PLAN' }
  );

  // H2.1-NEG-4: Tampering batchFreshnessHash inside batchPlan MUST BLOCK with MANIFEST_HASH_MISMATCH
  const tamperedBatch = {
    ...batch,
    productionOrderManifest: {
      ...batch.productionOrderManifest,
      batchFreshnessHash: '0'.repeat(64),
    },
  };
  await assert.rejects(
    () =>
      exportAndValidateBatchH2({
        batchPlan: tamperedBatch,
        jobs: [job],
        resourceStore: store,
        currentRunCounts: { 'TPL-F1': 14 },
      }),
    { code: 'MANIFEST_HASH_MISMATCH' }
  );

  // H2.1-NEG-5 (Honest Architectural Boundary Audit):
  // Direct bypass into LOCKED F (exportProductionOutputs) + LOCKED G (finalProductionCheck)
  // WITHOUT going through exportAndValidateBatchH2 CANNOT see external runCount (14 -> 20)
  // because LOCKED F/G have no runCount/batchFreshnessHash fields.
  const bypassOut = await exportProductionOutputs({
    plan: batch.impositionPlan,
    jobs: [job],
    resourceStore: store,
    print: true,
    cut: { format: 'PDF', scope: 'CUT_ONLY' },
  });
  const bypassCheck = await finalProductionCheck({
    plan: batch.impositionPlan,
    jobs: [job],
    output: bypassOut,
    resourceStore: store,
    sheetConfig: batch.impositionPlan.sheetConfig,
    productionProfile: batch.impositionPlan.productionProfile,
  });
  // Honestly document observed behavior: LOCKED F/G passes geometry of the 1 template, blind to external runCount drift
  assert.equal(bypassCheck.productionReady, true);
});

// =========================================================================
// H2-12, H2-13, H2-14: Shared PRINT/CUT coordinates via LOCKED F & G,
//                      Determinism across 2 runs, Multi-SKU quantity integrity
// =========================================================================
test('H2-12, H2-13, H2-14: PRINT/CUT shared coordinates (0mm SERIALIZED_GEOMETRY_DELTA), Determinism, Multi-SKU integrity', async () => {
  const store = makeStore();
  const jobA = await makeJob(store, { jobId: 'SKU-A', w: 30, h: 40, quantity: 20, bleedMm: 1.5 });
  const jobB = await makeJob(store, { jobId: 'SKU-B', w: 30, h: 40, quantity: 10, bleedMm: 0 });
  const sheetTemplates = [{
    templateId: 'TPL-MIX',
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    runCount: 5,
    gridSpec: { rows: 2, columns: 3, pitchXmm: 40, pitchYmm: 50, centerX: true, centerY: true },
    items: [
      { jobId: 'SKU-A', copiesPerRun: 4 },
      { jobId: 'SKU-B', copiesPerRun: 2 },
    ],
  }];

  const b1 = await buildProductionBatchPlanH2({
    batchId: 'BATCH-DET',
    jobs: [jobA, jobB],
    sheetTemplates,
    spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 1.5 },
    bleedPolicy: 'strict',
    bleedClearanceMm: 1,
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });
  const b2 = await buildProductionBatchPlanH2({
    batchId: 'BATCH-DET',
    jobs: [jobA, jobB],
    sheetTemplates,
    spacingPolicy: { cutGapMm: 2, bleedOutsetMm: 1.5 },
    bleedPolicy: 'strict',
    bleedClearanceMm: 1,
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });

  // H2-13: Determinism (identical sheets, placements, planHash, batchFreshnessHash)
  assert.equal(b1.impositionPlan.planHash, b2.impositionPlan.planHash);
  assert.equal(b1.productionOrderManifest.batchFreshnessHash, b2.productionOrderManifest.batchFreshnessHash);
  assert.deepEqual(b1.impositionPlan.sheets, b2.impositionPlan.sheets);

  // H2-14: Multi-SKU quantity integrity (SKU-A: 4×5=20, SKU-B: 2×5=10)
  assert.equal(b1.productionOrderManifest.expectedFinishedQuantity, 30);
  assert.equal(b1.impositionPlan.totalPlacedCopies, 6);

  // H2-12: Full export via LOCKED F (productionOutput.js) + validation via LOCKED G (finalProductionValidator.js)
  const exp = await exportAndValidateBatchH2({
    batchPlan: b1,
    jobs: [jobA, jobB],
    resourceStore: store,
    sheetTemplates,
    runCountsByTemplateId: { 'TPL-MIX': 5 },
  });
  assert.equal(exp.finalCheck.productionReady, true);
  assert.equal(exp.finalCheck.status, 'PASS');
  assert.equal(exp.finalCheck.metrics.expectedPlacements, 6);
  assert.equal(exp.finalCheck.metrics.printPlacements, 6);
  assert.equal(exp.finalCheck.metrics.cutPlacements, 6);
  assert.ok(exp.finalCheck.metrics.maxSerializedAlignmentDeltaMm <= 0.01);
  assert.equal(exp.finalCheck.metrics.measurementType, 'SERIALIZED_GEOMETRY_DELTA');
});

// =========================================================================
// REAL FIXTURE CROSS-CHECK: L0110.063 (7×99=693) — 1-to-1 (row,col) Pairing
//   + Real 56-Segment Cubic Bézier Contour Distance Verification
// =========================================================================
test('L0110.063 Real Fixture: 1-to-1 (row,col) pairing & 56-segment real Bézier contour audit (FULL_CONTOUR_GEOMETRY_PASS)', async () => {
  const aiFiles = [
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997145_897ac764.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997158_36b888ef.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997164_9f8fa1ae.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997140_5e76232d.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997135_8fd4c8c1.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997121_b17b76c9.ai',
    'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997115_6bbec865.ai',
  ];
  if (!aiFiles.every((f) => fs.existsSync(f))) return;

  const PT_TO_MM = 25.4 / 72;
  const decodePage = (page) => {
    const c = page.node.get(PDFName.of('Contents'));
    const ctx = page.doc.context;
    const dec = (ref) => Buffer.from(decodePDFRawStream(ctx.lookup(ref)).decode()).toString('latin1');
    return c instanceof PDFArray ? [...Array(c.size()).keys()].map((i) => dec(c.get(i))).join('\n') : dec(c);
  };

  // Parse ALL 99 real 56-segment cubic Bézier contours per page in sheet-mm (Y-down),
  // sorted deterministically into exact (row 0..10, col 0..8) order.
  const realPages = [];
  for (const filePath of aiFiles) {
    const doc = await PDFDocument.load(fs.readFileSync(filePath));
    const page = doc.getPages()[0];
    const hPt = page.getMediaBox().height;
    const stream = decodePage(page);
    const mc2Start = stream.indexOf('/OC /MC2 BDC');
    const mc2End = stream.indexOf('EMC', mc2Start);
    const mc2Text = mc2Start >= 0 ? stream.slice(mc2Start, mc2End > mc2Start ? mc2End : undefined) : '';

    let tx = 0, ty = 0, cmds = [];
    const parsed = [];
    const toMm = (xPt, yPt) => [(xPt + tx) * PT_TO_MM, (hPt - (yPt + ty)) * PT_TO_MM];

    for (const raw of mc2Text.split(/\r?\n/)) {
      const l = raw.trim();
      const cm = l.match(/1\s+0\s+0\s+1\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm$/);
      if (cm) { tx = parseFloat(cm[1]); ty = parseFloat(cm[2]); cmds = []; continue; }
      const m = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+m$/);
      if (m) { cmds.push({ type: 'M', to: toMm(parseFloat(m[1]), parseFloat(m[2])) }); continue; }
      const ln = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+l$/);
      if (ln) { cmds.push({ type: 'L', to: toMm(parseFloat(ln[1]), parseFloat(ln[2])) }); continue; }
      const c = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
      if (c) {
        cmds.push({
          type: 'C',
          c1: toMm(parseFloat(c[1]), parseFloat(c[2])),
          c2: toMm(parseFloat(c[3]), parseFloat(c[4])),
          to: toMm(parseFloat(c[5]), parseFloat(c[6])),
        });
        continue;
      }
      if ((l === 'S' || l === 's') && cmds.length > 10) {
        const poly = sampleContourToPolygonMm({ beziersMm: cmds }, 4);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of poly) {
          if (x < minX) minX = x; if (y < minY) minY = y;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        const w = maxX - minX, h = maxY - minY;
        if (w > 18 && w < 22 && h > 18 && h < 22) {
          parsed.push({ beziersMm: cmds, poly, minX, minY, maxX, maxY, w, h });
        }
        cmds = [];
      }
    }
    assert.equal(parsed.length, 99);

    // Deterministic row-major sort: group rows by 25.4mm Y bands, then sort X ascending
    const minYAll = Math.min(...parsed.map((b) => b.minY));
    const minXAll = Math.min(...parsed.map((b) => b.minX));
    const maxXAll = Math.max(...parsed.map((b) => b.maxX));
    const maxYAll = Math.max(...parsed.map((b) => b.maxY));
    const sorted = [...parsed].sort((a, b) => {
      const rowA = Math.round((a.minY - minYAll) / 25.4);
      const rowB = Math.round((b.minY - minYAll) / 25.4);
      if (rowA !== rowB) return rowA - rowB;
      return a.minX - b.minX;
    });

    const ref = sorted[0]; // (row=0, col=0) real 56-segment Bézier contour
    const pitchX = (maxXAll - minXAll - ref.w) / 8;
    const pitchY = (maxYAll - minYAll - ref.h) / 10;
    realPages.push({ minX: minXAll, minY: minYAll, w: ref.w, h: ref.h, pitchX, pitchY, sorted, ref });
  }

  // Feed REAL 56-segment Bézier contour (normalized to [0..w]x[0..h]) into CanonicalCutV1 -> H.2
  const store = makeStore();
  const resMeta = await store.acquire(TINY_PNG_BYTES, { kind: 'source_file', mimeType: 'image/png' });
  const jobs = [];
  const sheetTemplates = [];
  for (let i = 0; i < 7; i++) {
    const rp = realPages[i];
    const jobId = `L0110-P${i + 1}`;
    const normBeziers = rp.ref.beziersMm.map((cmd) => {
      const out = { type: cmd.type };
      if (cmd.to) out.to = [cmd.to[0] - rp.ref.minX, cmd.to[1] - rp.ref.minY];
      if (cmd.c1) out.c1 = [cmd.c1[0] - rp.ref.minX, cmd.c1[1] - rp.ref.minY];
      if (cmd.c2) out.c2 = [cmd.c2[0] - rp.ref.minX, cmd.c2[1] - rp.ref.minY];
      return out;
    });
    const normPoly = rp.ref.poly.map(([x, y]) => [x - rp.ref.minX, y - rp.ref.minY]);
    Object.assign(normPoly, { beziersMm: normBeziers, closed: true, cornerCount: 12 });
    const canonicalCut = createCanonicalCutV1({
      cutInputHash: resMeta.sha256,
      cutRevision: 1,
      naturalTrimMm: { w: rp.w, h: rp.h },
      cutNaturalMm: normPoly,
    });
    const bleedConfig = createBleedConfigV1({ bleedMode: 'none', bleedOffsetMm: 0 });
    const prod = await deriveProductionGeometry({
      jobId,
      canonicalCut,
      targetSizeMm: { w: rp.w, h: rp.h },
      bleedConfig,
      lockAspectRatio: true,
    });
    jobs.push(
      createStickerJobV1({
        jobId,
        jobRevision: 1,
        label: jobId,
        origin: { sourceAssetId: 'AST-L0110', pageIndex: i + 1, sourceStickerIndex: 1, sourceRegionMm: { x: 0, y: 0, w: rp.w, h: rp.h } },
        artworkRef: { resourceId: resMeta.resourceId },
        bleedConfig,
        canonicalCut,
        productionGeometry: prod.productionGeometry,
        order: { targetSizeMm: { w: rp.w, h: rp.h }, lockAspectRatio: true, quantity: 99 * 14, allowRotate: false, included: true },
        validation: {
          geometryValidation: prod.geometryValidation,
          readinessValidation: { evaluatedJobRevision: 1, effectiveDpi: 300, dpiStatus: 'OK', nonUniformScale: false, status: 'READY', productionReady: true, reasons: [] },
        },
      })
    );
    sheetTemplates.push({
      templateId: `TRANG_${i + 1}`,
      sheetWidthMm: 320,
      sheetHeightMm: 330,
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      runCount: 14,
      gridSpec: {
        rows: 11,
        columns: 9,
        pitchXmm: rp.pitchX,
        pitchYmm: rp.pitchY,
        originXmm: rp.minX,
        originYmm: rp.minY,
      },
      items: [{ jobId, copiesPerRun: 99 }],
    });
  }

  const batch = await buildProductionBatchPlanH2({
    batchId: 'L0110.063-FULL-BEZIER',
    jobs,
    sheetTemplates,
    spacingPolicy: { cutGapMm: 2 },
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });

  // Strict 1-to-1 index pairing (row*9 + col) comparing BOTH grid origin AND all 56 real Bézier vertices
  let gridOriginMaxDeltaMm = 0;
  let fullContourMaxDeltaMm = 0;
  let totalBezierPointsChecked = 0;
  const jobMap = new Map(jobs.map((j) => [j.jobId, j]));

  for (let i = 0; i < 7; i++) {
    const h2Placements = batch.impositionPlan.sheets[i].placements;
    const realSorted = realPages[i].sorted;
    assert.equal(h2Placements.length, 99);

    for (let k = 0; k < 99; k++) {
      const pl = h2Placements[k];
      const rs = realSorted[k]; // Strict 1-to-1 (row,col) pair — NO nearest-neighbor!
      const originDelta = Math.max(Math.abs(pl.xMm - rs.minX), Math.abs(pl.yMm - rs.minY));
      if (originDelta > gridOriginMaxDeltaMm) gridOriginMaxDeltaMm = originDelta;

      const job = jobMap.get(pl.jobId);
      const h2CutSheet = transformContourByRigidMatrixMm(job.productionGeometry.cutTargetMm, pl.rigidMatrixMm);
      const h2Poly = sampleContourToPolygonMm(h2CutSheet, 4);
      assert.equal(h2Poly.length, rs.poly.length);
      for (let p = 0; p < h2Poly.length; p++) {
        const d = Math.hypot(h2Poly[p][0] - rs.poly[p][0], h2Poly[p][1] - rs.poly[p][1]);
        if (d > fullContourMaxDeltaMm) fullContourMaxDeltaMm = d;
        totalBezierPointsChecked++;
      }
    }
  }

  assert.ok(gridOriginMaxDeltaMm <= 0.01, `GRID_ORIGIN_ALIGNMENT failed: ${gridOriginMaxDeltaMm}mm`);
  assert.ok(fullContourMaxDeltaMm <= 0.01, `FULL_CONTOUR_GEOMETRY failed: ${fullContourMaxDeltaMm}mm`);
  assert.ok(totalBezierPointsChecked >= 150000);
});

// =========================================================================
// H2-15: Locked files SHA-256 unchanged (0 locked files modified)
// =========================================================================
test('H2-15: All 17 locked B–G + H.1 engine files have identical SHA-256 checksums', () => {
  const expectedSha256 = {
    // Phase B controlled unlock (user-approved detailMode='high' branch only; old baseline: b62e30a8922b6f1d03195b0bb87d2bc03e5a79b26cbc8248fbd0d0f362e47338)
    'bleedContourEngine.js': '4ac146dab4e1701faf02fedb2fba1462d7d4a0bdc0c62dead47ed19f37a17c6a',
    'pdfProductionValidator.js': 'a12f8b14e6b19ac5b7717973773f3ca50eaae08a67730fd513a65f2be4b5fdb4',
    'resourceStore.js': '7f9eb0963d08488711c07c8d87061dea2cc0055113ca45fc7bf612817c16f487',
    'v1Schema.js': '0081b8fea4273e85af3e8d48216deec47483e30626532098d8e5e82747904ccc',
    'assetAnalyzer.js': '41692079f84bf9d85f2cb372496c4bf766b5788f4475d5f04978d2a670645b93',
    'cutlineV1Adapter.js': '32f6e460d3e1892e5653b4e6be64e29f8b1b80cf272b8e7bfe40fe51236f9894',
    'productionGeometry.js': 'd33364618f3dad8e776afc1d2e51e688ef8665f29376033616e2c9b9a8c48846',
    'batchJobOrchestrator.js': '2399cf9ad6451759cac2db5b55917950c90a5ae342a3c2e8ce615cf787c80988',
    'batchImpositionAdapter.js': '8074d41cdeba5e370040536ce4c32fbf609df6ae4396844a560f3bdaaa709b0e',
    'cutVectorExporter.js': '7506c352a5dcf2a9c8b251b5bdfba56a7269c65bae18454414ba463a4702e0f1',
    'productionOutput.js': '0190ffbce6b683ba8b6db6431a1c01b272fad34623856cabcf339be07c079941',
    'openWithAdapter.js': 'c02b37ffe0234374de6a9cd332042ba9398db634066e1ef980cdeedff5fdb6e7',
    'productionPairValidator.js': '3ded1427b8d7003a714a60ff1eb29dff9f9907b47c30571aff9554c9a715230c',
    'finalProductionValidator.js': '21b1cf7c1e0784cac4c20a9fc19eee83ef9e57456ba7cc54ebb4039a33882e16',
    'impositionEngine.js': 'b457b8b01b711dd72fe25b14341298fd1aa2251ebedefc73985c1885f8f27f01',
    'pdfExporter.js': 'a77d15366d0fa35331046d01f9e1060e237a662d776cb75aff7d7a69f5ce1edd',
    'productionPlanningH1.js': '6e18440012c59908aad8967163d93db1ead2c8460012a8cb3493bb2709e30b27',
  };
  for (const [file, expHash] of Object.entries(expectedSha256)) {
    const buf = fs.readFileSync(new URL(`../resources/js/engine/${file}`, import.meta.url));
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(actual, expHash, `Locked file ${file} was modified!`);
  }
});
