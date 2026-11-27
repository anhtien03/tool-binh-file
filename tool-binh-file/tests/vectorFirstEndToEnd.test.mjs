/**
 * PrintKit Architecture V1 — Phases V1-A1..V1-A5 End-to-End Verification Suite
 *
 * Tests all 5 tightened engineering points (A, B, C, D, E):
 *  - E2E-01: Zero Node Buffer dependency in browser-facing importer & post-export verifier.
 *  - E2E-02: Point A & E — Strict vector discrimination & 4-state provenance taxonomy
 *            (VECTOR_ORIGINAL, VECTOR_TRANSFORMED, RASTER_DERIVED, VECTOR_IMPORT_REJECTED).
 *  - E2E-03: Point B & C — Controlled vector offset (no silent raster fallback), CUT immutability
 *            during BLEED derivation, and full CanonicalCutV1 contract preservation.
 *  - E2E-04: V1-A4 & V1-A5 — Real 99-sticker `Giảm 3%` end-to-end pipeline:
 *            PDF Input -> Vector First -> 99 StickerJobV1 -> H.2 9×11 Imposition -> PRINT+CUT Export
 *            -> Independent Post-Export CUT.pdf Geometry Verification (Hausdorff, valley depth, kinks, gap, BLEED).
 *  - E2E-05: Point D — Adversarial tamper test proving Post-Export Verifier BLOCKS distorted CUT.pdf.
 *  - E2E-06: 17/17 LOCKED engine files SHA-256 unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PDFDocument,
  rgb,
  cmyk,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  fill,
  setLineWidth,
  setStrokingColor,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import { PRODUCTION_PROFILES, buildRigidMatrixMm } from '../resources/js/engine/batchImpositionAdapter.js';
import { MM_TO_PT } from '../resources/js/engine/impositionEngine.js';
import {
  extractPdfVectorContours,
  CONTOUR_PROVENANCE,
} from '../resources/js/engine/pdfVectorContourImporter.js';
import {
  runVectorFirstPdfImport,
  resolveVectorFirstContours,
  buildCanonicalCutsFromVectorResult,
} from '../resources/js/engine/vectorFirstPipeline.js';
import {
  buildStudioStickerJobsV1,
  createCheckpointKBatch,
  exportCheckpointKBatch,
  releaseCheckpointKOutput,
} from '../resources/js/engine/checkpointKUiBridge.js';
import { verifyExportedCutPdfGeometry } from '../resources/js/engine/postExportGeometryVerifier.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'resources', 'js', 'engine');
const CUSTOMER_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607803864_b438afea.pdf';
const PROCESSED_AI = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607810198_bcb52426.ai';
const GIAHUNG_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795620683780_e9a7c2ff.pdf';

const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
);

const LOCKED_BASELINES = {
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
  'bleedContourEngine.js': '4ac146dab4e1701faf02fedb2fba1462d7d4a0bdc0c62dead47ed19f37a17c6a',
};

function makeStore() {
  return createResourceStore({
    createObjectURL: (b) => `blob:v1e2e/${Math.random()}/${b.size}`,
    revokeObjectURL: () => {},
  });
}

// Minimal mock canvas for locked precisionBleedFromCut's raster distance field in Node
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
      let pts = [], cur = [0, 0];
      return {
        fillStyle: '#000',
        clearRect() { self._data.fill(0); },
        getImageData(x, y, w, h) { return { data: self._data, width: w, height: h }; },
        beginPath() { pts = []; },
        moveTo(x, y) { cur = [x, y]; pts.push(cur); },
        lineTo(x, y) { cur = [x, y]; pts.push(cur); },
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
          const [p0x, p0y] = cur;
          const steps = 16;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps, u = 1 - t;
            pts.push([
              u ** 3 * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * x,
              u ** 3 * p0y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * y,
            ]);
          }
          cur = [x, y];
        },
        closePath() {},
        fill() {
          const n = pts.length;
          if (n < 3) return;
          const cw = self._w, ch = self._h, d = self._data;
          let minY = ch, maxY = 0;
          for (const [, py] of pts) { if (py < minY) minY = py; if (py > maxY) maxY = py; }
          for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(ch - 1, Math.ceil(maxY)); y++) {
            const sy = y + 0.5, xs = [];
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const [x1, y1] = pts[j], [x2, y2] = pts[i];
              if ((y1 > sy) !== (y2 > sy)) xs.push(x1 + ((sy - y1) * (x2 - x1)) / (y2 - y1));
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(cw - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
                d[(y * cw + x) * 4 + 3] = 255;
              }
            }
          }
        },
      };
    },
  };
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeMockCanvas(0, 0) : {}) };

test('E2E-01 (V1-A1): Browser compatibility — ZERO Node Buffer dependency in importer, pipeline & post-export verifier', async () => {
  for (const file of ['pdfVectorContourImporter.js', 'vectorFirstPipeline.js', 'postExportGeometryVerifier.js']) {
    const src = fs.readFileSync(path.join(ENGINE_DIR, file), 'utf8');
    assert.equal(/\bBuffer\./.test(src), false, `${file} must NOT reference Node Buffer`);
  }

  // Runtime check with globalThis.Buffer temporarily undefined
  const savedBuffer = globalThis.Buffer;
  try {
    const pdfBytes = fs.existsSync(CUSTOMER_PDF)
      ? new Uint8Array(fs.readFileSync(CUSTOMER_PDF))
      : await (async () => {
          const d = await PDFDocument.create();
          const p = d.addPage([200, 200]);
          p.drawRectangle({ x: 30, y: 30, width: 60, height: 60, color: rgb(0.9, 0.8, 0.7) });
          return await d.save();
        })();
    globalThis.Buffer = undefined;
    const res = await extractPdfVectorContours(pdfBytes, { pageNumber: 1 });
    assert.equal(res.status, 'OK');
    assert.equal(res.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);
    assert.ok(res.contours.length >= 1);
  } finally {
    globalThis.Buffer = savedBuffer;
  }
});

test('E2E-02 (Point A & E): Strict vector discrimination rejects ambiguous mixed/stroke/overlapping PDFs with VECTOR_IMPORT_REJECTED', async () => {
  // 1. Mixed Raster + Vector without explicit CutContour -> VECTOR_IMPORT_REJECTED
  const dMix = await PDFDocument.create();
  const pMix = dMix.addPage([300, 300]);
  const png = await dMix.embedPng(TINY_PNG);
  pMix.drawImage(png, { x: 40, y: 40, width: 100, height: 100 });
  pMix.drawRectangle({ x: 20, y: 20, width: 140, height: 140, color: rgb(0.9, 0.9, 0.9) });
  const rMix = await runVectorFirstPdfImport(await dMix.save(), { pageNumber: 1 });
  assert.equal(rMix.status, 'CONFIRMATION_REQUIRED');
  assert.equal(rMix.provenance, CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED);
  assert.equal(rMix.contours.length, 0);
  assert.ok(rMix.reasons.includes('MIXED_RASTER_VECTOR_NO_CUT_LAYER'));

  // 2. Overlapping decorative filled rectangles without explicit CutContour -> VECTOR_IMPORT_REJECTED
  const dOvl = await PDFDocument.create();
  const pOvl = dOvl.addPage([300, 300]);
  pOvl.drawRectangle({ x: 40, y: 40, width: 100, height: 100, color: rgb(0.8, 0.2, 0.2) });
  pOvl.drawRectangle({ x: 90, y: 90, width: 100, height: 100, color: rgb(0.2, 0.2, 0.8) });
  const rOvl = await runVectorFirstPdfImport(await dOvl.save(), { pageNumber: 1 });
  assert.equal(rOvl.status, 'CONFIRMATION_REQUIRED');
  assert.equal(rOvl.provenance, CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED);
  assert.equal(rOvl.contours.length, 0);
  assert.ok(rOvl.reasons.includes('AMBIGUOUS_OVERLAPPING_ROOTS'));

  // 3. Stroke-only non-magenta PDF -> VECTOR_IMPORT_REJECTED
  const dStr = await PDFDocument.create();
  const pStr = dStr.addPage([300, 300]);
  pStr.drawRectangle({ x: 50, y: 50, width: 100, height: 100, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
  const rStr = await runVectorFirstPdfImport(await dStr.save(), { pageNumber: 1 });
  assert.equal(rStr.status, 'CONFIRMATION_REQUIRED');
  assert.equal(rStr.provenance, CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED);

  // 4. Raster-only PDF -> FALLBACK_TO_RASTER (RASTER_DERIVED)
  const dRas = await PDFDocument.create();
  const pRas = dRas.addPage([200, 200]);
  const png2 = await dRas.embedPng(TINY_PNG);
  pRas.drawImage(png2, { x: 20, y: 20, width: 100, height: 100 });
  const rRas = await runVectorFirstPdfImport(await dRas.save(), { pageNumber: 1 });
  assert.equal(rRas.status, 'FALLBACK_TO_RASTER');
  assert.equal(rRas.provenance, CONTOUR_PROVENANCE.RASTER_DERIVED);

  // 5. Explicit Cut Layer (`khuon`) -> VECTOR_ORIGINAL with confidence 1.0
  if (fs.existsSync(PROCESSED_AI)) {
    const rAi = await runVectorFirstPdfImport(fs.readFileSync(PROCESSED_AI), { pageNumber: 1 });
    assert.equal(rAi.status, 'OK');
    assert.equal(rAi.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);
    assert.equal(rAi.selectionMode, 'EXPLICIT_CUT_LAYER');
    assert.equal(rAi.confidence, 1.0);
    assert.equal(rAi.contours.length, 99);
  }
});

test('E2E-03 (Point B & C): Controlled vector offset (no auto raster fallback), CUT immutability during BLEED, and CanonicalCutV1 contract', async () => {
  if (!fs.existsSync(CUSTOMER_PDF)) return;
  const pdfBytes = fs.readFileSync(CUSTOMER_PDF);
  const vecRes = await runVectorFirstPdfImport(pdfBytes, { pageNumber: 1 });
  assert.equal(vecRes.status, 'OK');
  assert.equal(vecRes.contours.length, 99);

  // Snapshot original Bézier JSON of sticker #1 before BLEED generation
  const origBeziersSnapshot = JSON.stringify(vecRes.contours[0].beziersMm);

  // 1. offsetMm = 0 -> VECTOR_ORIGINAL + BLEED generated WITHOUT mutating CUT
  const resolved0 = resolveVectorFirstContours(vecRes, { offsetMm: 0, bleedOffsetMm: 1.5, shapeMode: 'auto' });
  assert.equal(resolved0.mode, 'VECTOR_ORIGINAL');
  assert.equal(resolved0.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);
  assert.equal(resolved0.contoursMm.length, 99);
  assert.equal(resolved0.contoursMm.bleedContoursMm.length, 99);
  assert.equal(JSON.stringify(resolved0.contoursMm[0].beziersMm), origBeziersSnapshot, 'CUT Bézier must be 100% untouched!');
  assert.equal(JSON.stringify(vecRes.contours[0].beziersMm), origBeziersSnapshot, 'Imported vector contour must never be mutated!');

  // 2. offsetMm = +0.5 -> VECTOR_TRANSFORMED (controlled vector offset, NOT raster fallback!)
  const subsetVec = { ...vecRes, contours: vecRes.contours.slice(0, 3) };
  const resolvedOff = resolveVectorFirstContours(subsetVec, { offsetMm: 0.5, bleedOffsetMm: 1.0, shapeMode: 'auto' });
  assert.equal(resolvedOff.mode, 'VECTOR_TRANSFORMED');
  assert.equal(resolvedOff.provenance, CONTOUR_PROVENANCE.VECTOR_TRANSFORMED);
  assert.equal(resolvedOff.contoursMm.length, 3);
  assert.equal(resolvedOff.requiresUserConfirmation, false);
  assert.equal(resolvedOff.contoursMm[0].sourceMeta.transformMethod, 'CONTROLLED_VECTOR_OFFSET');

  // 3. shapeMode = 'circle' -> CONFIRM_RASTER_FOR_TRANSFORM (does NOT silently drop Bézier!)
  const resolvedShape = resolveVectorFirstContours(subsetVec, { offsetMm: 0, bleedOffsetMm: 1.0, shapeMode: 'circle' });
  assert.equal(resolvedShape.mode, 'CONFIRM_RASTER_FOR_TRANSFORM');
  assert.equal(resolvedShape.requiresUserConfirmation, true);

  // 4. CanonicalCutV1 contract verification (Point C)
  const canonicalEntries = buildCanonicalCutsFromVectorResult({
    vectorImportResult: subsetVec,
    assetId: 'AST-VEC-1',
    pageIndex: 1,
    artworkResourceId: 'RES-ART-1',
    cutInputHash: 'hash-vec-test-001',
  });
  assert.equal(canonicalEntries.length, 3);
  for (let i = 0; i < 3; i++) {
    const e = canonicalEntries[i];
    assert.equal(e.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);
    assert.equal(e.origin.sourceAssetId, 'AST-VEC-1');
    assert.equal(e.origin.sourceStickerIndex, i + 1);
    assert.equal(e.canonicalCut.cutNaturalMm.coordinateSystem, 'JOB_LOCAL_MM_Y_DOWN');
    assert.ok(['CW', 'CCW'].includes(e.canonicalCut.cutNaturalMm.winding));
    assert.equal(e.canonicalCut.cutNaturalMm.closed, true);
    assert.equal(e.canonicalCut.cutNaturalMm.beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length, 56);
  }
});

test('E2E-04 & E2E-05 (V1-A4 + V1-A5 + Point D): Real 99-sticker Giảm 3% full PRINT+CUT export & Post-Export CUT.pdf Verification + Tamper BLOCK', async () => {
  if (!fs.existsSync(CUSTOMER_PDF)) return;
  const pdfBytes = fs.readFileSync(CUSTOMER_PDF);
  const vecRes = await runVectorFirstPdfImport(pdfBytes, { pageNumber: 1 });
  assert.equal(vecRes.status, 'OK');
  assert.equal(vecRes.contours.length, 99);

  const resolved = resolveVectorFirstContours(vecRes, { offsetMm: 0, bleedOffsetMm: 1.0, shapeMode: 'auto' });
  assert.equal(resolved.mode, 'VECTOR_ORIGINAL');
  assert.equal(resolved.contoursMm.length, 99);

  const store = makeStore();
  const built = await buildStudioStickerJobsV1({
    cleanArtworkBytes: TINY_PNG,
    mimeType: 'image/png',
    sourceSizeMm: { w: vecRes.pageWidthMm, h: vecRes.pageHeightMm },
    contoursMm: resolved.contoursMm,
    bleedOffsetMm: 1.0,
    quantityPerSticker: 1,
    resourceStore: store,
    labelPrefix: 'Giam3Pct',
  });
  assert.equal(built.jobs.length, 99);

  // Impose all 99 unique stickers onto 320x330mm sheet (9x11 grid, 2.2mm cut gap, 1.0mm strict bleed)
  const sheetTemplates = [
    {
      templateId: 'TPL-GIAM3-99',
      sheetWidthMm: 320,
      sheetHeightMm: 330,
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      runCount: 1,
      gridSpec: { rows: 11, columns: 9, centerX: true, centerY: true },
      items: built.jobs.map((j) => ({ jobId: j.jobId, copiesPerRun: 1 })),
    },
  ];

  const checkpoint = await createCheckpointKBatch({
    jobs: built.jobs,
    sheetTemplates,
    cutGapMm: 2.2,
    bleedOutsetMm: 1.0,
    bleedClearanceMm: 0,
    bleedPolicy: 'strict',
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });

  const exported = await exportCheckpointKBatch({
    checkpoint,
    jobs: built.jobs,
    assets: built.assets,
    resourceStore: store,
    sheetTemplates,
    currentRunCounts: { 'TPL-GIAM3-99': 1 },
    expectedOrderManifest: checkpoint.batchPlan.productionOrderManifest,
    cutGapMm: 2.2,
    bleedOutsetMm: 1.0,
    bleedClearanceMm: 0,
    bleedPolicy: 'strict',
    productionProfile: PRODUCTION_PROFILES.GENERIC,
    cutFormat: 'PDF',
    scope: 'CUT_PLUS_PRINT',
  });

  assert.equal(exported.finalCheck.status, 'PASS');
  assert.equal(exported.releaseAllowed, true);
  assert.ok(exported.postExportVerification, 'Must include independent postExportVerification');
  assert.equal(exported.postExportVerification.status, 'PASS');
  assert.equal(exported.postExportVerification.passed, true);

  const m = exported.postExportVerification.metrics;
  console.log(
    `\n[E2E-04 Giảm 3% 99-Sticker CUT.pdf Verification] contours=${m.exportedContours}/${m.expectedContours}, segMismatch=${m.segmentMismatches}, maxHausdorff=${m.maxHausdorffMm}mm, mean=${m.meanDeviationMm}mm, valleyDelta=${m.maxValleyDepthDeltaMm}mm, newKinks=${m.newKinksCount}, minGap=${m.minCutGapMm}mm, bleedChecked=${m.bleedCheckedCount}`
  );

  assert.equal(m.expectedContours, 99);
  assert.equal(m.exportedContours, 99);
  assert.equal(m.closedContours, 99);
  assert.equal(m.selfIntersections, 0);
  assert.equal(m.segmentMismatches, 0);
  assert.ok(m.maxHausdorffMm <= 0.005, `Hausdorff ${m.maxHausdorffMm}mm > 0.005mm`);
  assert.ok(m.meanDeviationMm <= 0.002, `Mean deviation ${m.meanDeviationMm}mm > 0.002mm`);
  assert.ok(m.maxValleyDepthDeltaMm <= 0.005, `Valley depth delta ${m.maxValleyDepthDeltaMm}mm > 0.005mm`);
  assert.equal(m.newKinksCount, 0);
  assert.equal(m.cutCollisions, 0);
  assert.ok(m.minCutGapMm >= 2.15, `Min CUT-CUT gap ${m.minCutGapMm}mm < 2.15mm`);
  assert.equal(m.bleedCheckedCount, 99);
  assert.equal(m.bleedInvalidCount, 0);

  // E2E-05: Adversarial tamper test — replace CUT.pdf with a blank/missing-contour PDF -> MUST BLOCK!
  const fakeDoc = await PDFDocument.create();
  const fakePage = fakeDoc.addPage([320 * (72 / 25.4), 330 * (72 / 25.4)]);
  fakePage.drawRectangle({ x: 50, y: 50, width: 60, height: 60, borderColor: rgb(1, 0, 1), borderWidth: 0.5 });
  const tamperedRes = await verifyExportedCutPdfGeometry({
    cutPdfBytes: await fakeDoc.save(),
    impositionPlan: checkpoint.batchPlan.impositionPlan,
    jobs: built.jobs,
    expectedCutGapMm: 2.2,
  });
  assert.equal(tamperedRes.status, 'BLOCK');
  assert.equal(tamperedRes.passed, false);
  assert.ok(tamperedRes.errors.length > 0);

  releaseCheckpointKOutput(store, exported.output);
});

test('E2E-06: All 17 LOCKED engine files have 100% identical SHA-256 checksums', () => {
  for (const [file, expected] of Object.entries(LOCKED_BASELINES)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ENGINE_DIR, file))).digest('hex');
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
  }
  console.log('\n[E2E-06 SHA-256 Audit] 17/17 LOCKED engine files UNCHANGED!');
});

test('E2E-07: Compound path outer preservation, negative vector offset gating, and Gia Hưng 84-Bézier explicit cut import', async () => {
  // 1. Compound path (outer 120x120pt + inner 40x40pt hole in single `f`) must keep ONLY the outer 42.33mm contour
  const dComp = await PDFDocument.create();
  const pComp = dComp.addPage([200, 200]);
  pComp.pushOperators(
    pushGraphicsState(),
    moveTo(20, 20), lineTo(140, 20), lineTo(140, 140), lineTo(20, 140), closePath(),
    moveTo(60, 60), lineTo(100, 60), lineTo(100, 100), lineTo(60, 100), closePath(),
    fill(),
    popGraphicsState()
  );
  const rComp = await extractPdfVectorContours(await dComp.save(), { pageNumber: 1 });
  assert.equal(rComp.status, 'OK');
  assert.equal(rComp.contours.length, 1);
  assert.ok(Math.abs(rComp.contours[0].boundsMm.w - 42.3333) < 0.05, `Expected outer ~42.33mm, got ${rComp.contours[0].boundsMm.w}`);
  assert.ok(Math.abs(rComp.contours[0].boundsMm.h - 42.3333) < 0.05, `Expected outer ~42.33mm, got ${rComp.contours[0].boundsMm.h}`);

  // 2. Negative inward vector offset: -0.5mm -> VECTOR_TRANSFORMED; excessive -5.0mm -> CONFIRM_RASTER_FOR_TRANSFORM
  if (fs.existsSync(CUSTOMER_PDF)) {
    const rG3 = await extractPdfVectorContours(fs.readFileSync(CUSTOMER_PDF), { pageNumber: 1 });
    const sub = { ...rG3, contours: rG3.contours.slice(0, 2) };
    const negOk = resolveVectorFirstContours(sub, { offsetMm: -0.5, bleedOffsetMm: 1.0, shapeMode: 'auto' });
    assert.equal(negOk.mode, 'VECTOR_TRANSFORMED');
    assert.equal(negOk.provenance, CONTOUR_PROVENANCE.VECTOR_TRANSFORMED);
    assert.equal(negOk.contoursMm.length, 2);

    const negFail = resolveVectorFirstContours(sub, { offsetMm: -5.0, bleedOffsetMm: 1.0, shapeMode: 'auto' });
    assert.equal(negFail.mode, 'CONFIRM_RASTER_FOR_TRANSFORM');
    assert.equal(negFail.requiresUserConfirmation, true);
    assert.ok(negFail.reasons.includes('VECTOR_OFFSET_UNSUPPORTED'));
  }

  // 3. Gia Hưng 15-petal 84-Bézier reference PDF
  if (fs.existsSync(GIAHUNG_PDF)) {
    const rGH = await extractPdfVectorContours(fs.readFileSync(GIAHUNG_PDF), { pageNumber: 1 });
    assert.equal(rGH.status, 'OK');
    assert.equal(rGH.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);
    assert.equal(rGH.selectionMode, 'EXPLICIT_CUT_LAYER');
    assert.equal(rGH.contours.length, 1);
  }
});

test('E2E-08 (Point D Hardening): Post-export verifier catches new kinks on cornered shapes, overlapping CUTs, and verifies 90/180/270° rotations', async () => {
  async function makeCutPdf(pathsMm, wMm = 100, hMm = 100) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([wMm * MM_TO_PT, hMm * MM_TO_PT]);
    const hPt = hMm * MM_TO_PT;
    for (const cmds of pathsMm) {
      const ops = [pushGraphicsState(), setStrokingColor(cmyk(0, 1, 0, 0)), setLineWidth(0.3)];
      for (const cmd of cmds) {
        if (cmd.type === 'M') ops.push(moveTo(cmd.to[0] * MM_TO_PT, hPt - cmd.to[1] * MM_TO_PT));
        else if (cmd.type === 'L') ops.push(lineTo(cmd.to[0] * MM_TO_PT, hPt - cmd.to[1] * MM_TO_PT));
        else if (cmd.type === 'C') {
          ops.push(
            appendBezierCurve(
              cmd.c1[0] * MM_TO_PT, hPt - cmd.c1[1] * MM_TO_PT,
              cmd.c2[0] * MM_TO_PT, hPt - cmd.c2[1] * MM_TO_PT,
              cmd.to[0] * MM_TO_PT, hPt - cmd.to[1] * MM_TO_PT
            )
          );
        }
      }
      ops.push(closePath(), stroke(), popGraphicsState());
      page.pushOperators(...ops);
    }
    return await doc.save();
  }

  const applyM = (m, cmds) =>
    cmds.map((c) => {
      const f = ([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
      return {
        type: c.type,
        ...(c.to ? { to: f(c.to) } : {}),
        ...(c.c1 ? { c1: f(c.c1) } : {}),
        ...(c.c2 ? { c2: f(c.c2) } : {}),
      };
    });

  // 1. 44° new kink on a smooth curve of a shape that ALREADY has 90° sharp corners -> MUST BLOCK
  const origCornered = [
    { type: 'M', to: [0, 0] },
    { type: 'L', to: [20, 0] },
    { type: 'L', to: [20, 20] },
    { type: 'C', c1: [16.66, 20], c2: [13.33, 20], to: [10, 20] },
    { type: 'C', c1: [6.66, 20], c2: [3.33, 20], to: [0, 20] },
    { type: 'L', to: [0, 0] },
  ];
  const kinkedCornered = [
    { type: 'M', to: [0, 0] },
    { type: 'L', to: [20, 0] },
    { type: 'L', to: [20, 20] },
    { type: 'C', c1: [16.66, 20], c2: [10.05, 19.98], to: [10, 20] },
    { type: 'C', c1: [9.95, 19.98], c2: [3.33, 20], to: [0, 20] },
    { type: 'L', to: [0, 0] },
  ];
  const m0 = buildRigidMatrixMm(10, 10, 20, 20, 0);
  const resKink = await verifyExportedCutPdfGeometry({
    cutPdfBytes: await makeCutPdf([applyM(m0, kinkedCornered)]),
    impositionPlan: {
      sheets: [{ sheetIndex: 0, widthMm: 100, heightMm: 100, placements: [{ placementId: 'P1', jobId: 'J1', rigidMatrixMm: m0 }] }],
    },
    jobs: [{ jobId: 'J1', productionGeometry: { cutTargetMm: { beziersMm: origCornered } } }],
  });
  assert.equal(resKink.status, 'BLOCK', 'New 44° kink on shape with 90° corner MUST BLOCK');
  assert.ok(resKink.metrics.newKinksCount >= 1);
  assert.ok(resKink.errors.some((e) => e.includes('TANGENT_KINKS_DETECTED')));

  // 2. Overlapping CUT squares (50% overlap) -> MUST BLOCK with cutCollisions >= 1 & minCutGapMm === 0
  const sq = [
    { type: 'M', to: [0, 0] },
    { type: 'L', to: [20, 0] },
    { type: 'L', to: [20, 20] },
    { type: 'L', to: [0, 20] },
    { type: 'L', to: [0, 0] },
  ];
  const mA = buildRigidMatrixMm(10, 10, 20, 20, 0);
  const mB = buildRigidMatrixMm(20, 20, 20, 20, 0);
  const resOvl = await verifyExportedCutPdfGeometry({
    cutPdfBytes: await makeCutPdf([applyM(mA, sq), applyM(mB, sq)]),
    impositionPlan: {
      sheets: [
        {
          sheetIndex: 0,
          widthMm: 100,
          heightMm: 100,
          placements: [
            { placementId: 'P1', jobId: 'J1', rigidMatrixMm: mA },
            { placementId: 'P2', jobId: 'J1', rigidMatrixMm: mB },
          ],
        },
      ],
    },
    jobs: [{ jobId: 'J1', productionGeometry: { cutTargetMm: { beziersMm: sq } } }],
  });
  assert.equal(resOvl.status, 'BLOCK', 'Overlapping CUT contours MUST BLOCK');
  assert.ok(resOvl.metrics.cutCollisions >= 1);
  assert.equal(resOvl.metrics.minCutGapMm, 0);
  assert.ok(resOvl.errors.some((e) => e.includes('CUT_CUT_COLLISION')));

  // 3. 90°, 180°, 270° rotated placements -> MUST PASS with 0.000mm Hausdorff
  const rect = [
    { type: 'M', to: [0, 0] },
    { type: 'L', to: [20, 0] },
    { type: 'L', to: [20, 10] },
    { type: 'L', to: [0, 10] },
    { type: 'L', to: [0, 0] },
  ];
  const m90 = buildRigidMatrixMm(10, 10, 20, 10, 90);
  const m180 = buildRigidMatrixMm(30, 10, 20, 10, 180);
  const m270 = buildRigidMatrixMm(60, 10, 20, 10, 270);
  const resRot = await verifyExportedCutPdfGeometry({
    cutPdfBytes: await makeCutPdf([applyM(m90, rect), applyM(m180, rect), applyM(m270, rect)]),
    impositionPlan: {
      sheets: [
        {
          sheetIndex: 0,
          widthMm: 100,
          heightMm: 100,
          placements: [
            { placementId: 'P90', jobId: 'J1', rigidMatrixMm: m90 },
            { placementId: 'P180', jobId: 'J1', rigidMatrixMm: m180 },
            { placementId: 'P270', jobId: 'J1', rigidMatrixMm: m270 },
          ],
        },
      ],
    },
    jobs: [{ jobId: 'J1', productionGeometry: { cutTargetMm: { beziersMm: rect } } }],
  });
  assert.equal(resRot.status, 'PASS');
  assert.ok(resRot.metrics.maxHausdorffMm <= 0.001);
});
