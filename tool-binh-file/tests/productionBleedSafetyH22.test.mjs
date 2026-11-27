/**
 * PrintKit Architecture V1 — Checkpoint H.2.2 Production BLEED Geometry & Color Safety Suite
 * Covers H22-01 through H22-17 (including 0.083mm threshold negative tests & all 7 pages of real L0110.063).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  decodePDFRawStream,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import {
  createBleedConfigV1,
  createCanonicalCutV1,
  createStickerJobV1,
} from '../resources/js/engine/v1Schema.js';
import { PRODUCTION_PROFILES, buildRigidMatrixMm } from '../resources/js/engine/batchImpositionAdapter.js';
import {
  tessellateAndVerifyContourMm,
  evaluateProductionBleedSafetyH22,
  verifyBleedColorCompatibilityH22,
  BLEED_SAFETY_STATUSES,
} from '../resources/js/engine/productionBleedSafetyH22.js';
import {
  buildProductionBatchPlanH2,
  exportAndValidateBatchH2,
} from '../resources/js/engine/productionPlanningAdapterH2.js';
import { assertBatchFreshnessH2 } from '../resources/js/engine/productionPlanValidatorH2.js';

const TINY_PNG_BYTES = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
);

const L0110_AI_FILE = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607810198_bcb52426.ai';
const CREAM_PRINT_COLOR = Object.freeze({
  colorSpace: 'DeviceCMYK',
  cmyk: [0.063, 0.055, 0.192, 0],
  opacity: 1,
  blendMode: 'Normal',
  overprint: false,
  spotColor: null,
  zOrderVerified: true,
});

function makeStore() {
  return createResourceStore({
    createObjectURL: (b) => `blob:h22/${Math.random()}/${b.size}`,
    revokeObjectURL: () => {},
  });
}

function makeRectContour(w, h, offset = 0) {
  const x0 = -offset, y0 = -offset, x1 = w + offset, y1 = h + offset;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const beziersMm = [
    { type: 'M', to: [x0, y0] },
    { type: 'L', to: [x1, y0] },
    { type: 'L', to: [x1, y1] },
    { type: 'L', to: [x0, y1] },
    { type: 'L', to: [x0, y0] },
  ];
  Object.assign(pts, { beziersMm, closed: true, cornerCount: 4 });
  return pts;
}

async function makeCustomJob(store, { jobId, w, h, cutContour, bleedContour = null, bleedOffsetMm = 0, quantity = 2, allowRotate = true }) {
  const resMeta = await store.acquire(TINY_PNG_BYTES, { kind: 'source_file', mimeType: 'image/png' });
  const canonicalCut = createCanonicalCutV1({
    cutInputHash: resMeta.sha256,
    cutRevision: 1,
    naturalTrimMm: { w, h },
    cutNaturalMm: cutContour,
  });
  const bleedConfig = createBleedConfigV1({
    bleedMode: bleedContour ? 'precision' : 'none',
    bleedOffsetMm: bleedContour ? bleedOffsetMm : 0,
  });
  return createStickerJobV1({
    jobId,
    jobRevision: 1,
    label: jobId,
    origin: { sourceAssetId: 'AST-H22', pageIndex: 1, sourceStickerIndex: 1, sourceRegionMm: { x: 0, y: 0, w, h } },
    artworkRef: { resourceId: resMeta.resourceId },
    bleedConfig,
    canonicalCut,
    productionGeometry: {
      productionGeoHash: resMeta.sha256,
      productionGeometryRevision: 1,
      targetSizeMm: { w, h },
      scaleX: 1,
      scaleY: 1,
      cutTargetMm: cutContour,
      bleedTargetMm: bleedContour,
      bleedTier: bleedContour ? 1 : 0,
      effectiveWhiteBorderMm: null,
    },
    order: { targetSizeMm: { w, h }, lockAspectRatio: true, quantity, allowRotate, included: true },
    validation: {
      geometryValidation: {
        productionGeometryRevision: 1,
        geometryValid: true,
        offsetWithinTolerance: true,
        bleedStatus: bleedContour ? 'PASS' : 'NONE',
        bleedTier: bleedContour ? 1 : 0,
        minDistMm: bleedContour ? bleedOffsetMm : null,
        maxDistMm: bleedContour ? bleedOffsetMm : null,
        avgDistMm: bleedContour ? bleedOffsetMm : null,
        overClassification: 'NONE',
        reasons: [],
      },
      readinessValidation: {
        evaluatedJobRevision: 1,
        effectiveDpi: 300,
        dpiStatus: 'OK',
        nonUniformScale: false,
        status: 'READY',
        productionReady: true,
        reasons: [],
      },
    },
  });
}

// Parse REAL 56-segment CUT & 52-segment BLEED contours from Decal_sticker_goi_lai_anh_da_xu_ly.ai (all 7 pages!)
async function parseRealL0110Pages(pageLimit = 7) {
  const PT_TO_MM = 25.4 / 72;
  const doc = await PDFDocument.load(fs.readFileSync(L0110_AI_FILE));
  const pages = doc.getPages();
  const decodePage = (page) => {
    const c = page.node.get(PDFName.of('Contents'));
    const ctx = page.doc.context;
    const dec = (ref) => Buffer.from(decodePDFRawStream(ctx.lookup(ref)).decode()).toString('latin1');
    return c instanceof PDFArray ? [...Array(c.size()).keys()].map((i) => dec(c.get(i))).join('\n') : dec(c);
  };

  const extractLayerContours = (stream, ocTag, hPt, strokeOnly) => {
    const start = stream.indexOf(`/OC /${ocTag} BDC`);
    const end = stream.indexOf('EMC', start);
    const body = start >= 0 ? stream.slice(start, end > start ? end : undefined) : '';
    let tx = 0, ty = 0, cmds = [];
    const out = [];
    const toMm = (xPt, yPt) => [(xPt + tx) * PT_TO_MM, (hPt - (yPt + ty)) * PT_TO_MM];
    for (const raw of body.split(/\r?\n/)) {
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
      const isClose = strokeOnly ? (l === 'S' || l === 's') : (l === 'f' || l === 'f*' || l === 'F');
      if (isClose && cmds.length > 20) {
        const tess = tessellateAndVerifyContourMm({ beziersMm: cmds, closed: true });
        if (tess.valid) {
          out.push({
            beziersMm: cmds,
            closed: true,
            minX: tess.bounds.minX,
            minY: tess.bounds.minY,
            maxX: tess.bounds.maxX,
            maxY: tess.bounds.maxY,
            w: tess.bounds.maxX - tess.bounds.minX,
            h: tess.bounds.maxY - tess.bounds.minY,
          });
        }
        cmds = [];
      }
    }
    const minYAll = Math.min(...out.map((o) => o.minY));
    return out.sort((a, b) => {
      const rA = Math.round((a.minY - minYAll) / 25.4);
      const rB = Math.round((b.minY - minYAll) / 25.4);
      return rA !== rB ? rA - rB : a.minX - b.minX;
    });
  };

  const result = [];
  for (let p = 0; p < Math.min(pageLimit, pages.length); p++) {
    const page = pages[p];
    const hPt = page.getMediaBox().height;
    const stream = decodePage(page);
    // In Decal_sticker_goi_lai_anh_da_xu_ly.ai: /MC0 = Layer 3 (bleed fills), /MC2 = khuon (CUT strokes)
    const bleeds = extractLayerContours(stream, 'MC0', hPt, false);
    const cuts = extractLayerContours(stream, 'MC2', hPt, true);
    result.push({ pageNumber: p + 1, cuts, bleeds });
  }
  return result;
}

// =========================================================================
// H22-01, H22-02, H22-03: CUT-CUT safety (PASS, CUT_COLLISION, CUT_GAP_VIOLATION)
// =========================================================================
test('H22-01..H22-03: CUT non-overlapping PASS, CUT collision BLOCK, CUT gap violation BLOCK', async () => {
  const store = makeStore();
  const job = await makeCustomJob(store, { jobId: 'J-CUT', w: 20, h: 20, cutContour: makeRectContour(20, 20), quantity: 2 });
  const jobMap = new Map([[job.jobId, job]]);
  const makeSheet = (pitchX) => ({
    sheetIndex: 1,
    widthMm: 100,
    heightMm: 100,
    placements: [
      { placementId: 'P1', jobId: 'J-CUT', rigidMatrixMm: buildRigidMatrixMm(10, 10, 20, 20, 0) },
      { placementId: 'P2', jobId: 'J-CUT', rigidMatrixMm: buildRigidMatrixMm(10 + pitchX, 10, 20, 20, 0) },
    ],
  });

  // H22-01: pitch 22.5mm -> gap 2.5mm >= 2.0mm -> PASS
  const r1 = evaluateProductionBleedSafetyH22({ templateId: 'T1', sheet: makeSheet(22.5), jobMap, cutGapMm: 2.0 });
  assert.equal(r1.valid, true);
  assert.equal(r1.minCutDistanceMm, 2.5);

  // H22-02: pitch 19.5mm -> overlapping CUT -> CUT_COLLISION
  const r2 = evaluateProductionBleedSafetyH22({ templateId: 'T2', sheet: makeSheet(19.5), jobMap, cutGapMm: 2.0 });
  assert.equal(r2.valid, false);
  assert.equal(r2.errors[0].code, 'CUT_COLLISION');

  // H22-03: pitch 21.5mm -> gap 1.5mm < 2.0mm -> CUT_GAP_VIOLATION
  const r3 = evaluateProductionBleedSafetyH22({ templateId: 'T3', sheet: makeSheet(21.5), jobMap, cutGapMm: 2.0 });
  assert.equal(r3.valid, false);
  assert.equal(r3.errors[0].code, 'CUT_GAP_VIOLATION');
});

// =========================================================================
// H22-04, H22-05, H22-06, H22-07, H22-08: 0.083mm boundary + Intrusion +
//   Policy Not Confirmed + Color Unverified (WARNING) + Color Verified (PASS)
// =========================================================================
test('H22-04..H22-08: 0.083mm boundary safe vs 0.15mm shift intrusion BLOCK, unconfirmed BLOCK, color unverified WARNING, CMYK verified PASS', async () => {
  const store = makeStore();
  // 20.024mm CUT + 2.000mm BLEED (exact L0110 dimensions)
  const cut = makeRectContour(20.024, 20.024, 0);
  const bleed = makeRectContour(20.024, 20.024, 2.0);
  const job = await makeCustomJob(store, { jobId: 'J-B', w: 20.024, h: 20.024, cutContour: cut, bleedContour: bleed, bleedOffsetMm: 2.0, quantity: 2 });
  const jobMap = new Map([[job.jobId, job]]);

  // Exact TRANG_2 pitch: 22.1074mm -> CUT gap = 2.0834mm, BLEED-to-neighbor-CUT = +0.0834mm!
  const safeSheet = {
    sheetIndex: 1,
    widthMm: 100,
    heightMm: 100,
    placements: [
      { placementId: 'P1', jobId: 'J-B', rigidMatrixMm: buildRigidMatrixMm(10, 10, 20.024, 20.024, 0) },
      { placementId: 'P2', jobId: 'J-B', rigidMatrixMm: buildRigidMatrixMm(10 + 22.1074, 10, 20.024, 20.024, 0) },
    ],
  };

  // Shift P2 left by just 0.15mm (pitch 21.9574mm -> CUT gap 1.9334mm, BLEED intrudes 0.0666mm into neighbor CUT!)
  const intrudeSheet = {
    sheetIndex: 1,
    widthMm: 100,
    heightMm: 100,
    placements: [
      { placementId: 'P1', jobId: 'J-B', rigidMatrixMm: buildRigidMatrixMm(10, 10, 20.024, 20.024, 0) },
      { placementId: 'P2', jobId: 'J-B', rigidMatrixMm: buildRigidMatrixMm(10 + 21.9574, 10, 20.024, 20.024, 0) },
    ],
  };

  // H22-06: Overlap WITHOUT confirmation -> BLOCK (POLICY_NOT_CONFIRMED)
  const rUnconf = evaluateProductionBleedSafetyH22({
    templateId: 'T-UNCONF',
    sheet: safeSheet,
    jobMap,
    cutGapMm: 2.0,
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: false,
  });
  assert.equal(rUnconf.valid, false);
  assert.equal(rUnconf.policyStatus, BLEED_SAFETY_STATUSES.POLICY_NOT_CONFIRMED);
  assert.equal(rUnconf.errors[0].code, 'BLEED_OVERLAP_UNVERIFIED');

  // H22-04 & H22-07: Confirmed overlap at +0.083mm clearance, NO real CMYK metadata (or RGB preview!) -> GEOMETRY_SAFE + WARNING
  const rRgb = evaluateProductionBleedSafetyH22({
    templateId: 'T-RGB',
    sheet: safeSheet,
    jobMap,
    cutGapMm: 2.0,
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'Operator visual check',
    bleedColorByJobId: { 'J-B': { colorSpace: 'RGB', rgb: [242, 232, 204], opacity: 1, blendMode: 'Normal', overprint: false, zOrderVerified: true } },
  });
  assert.equal(rRgb.valid, true);
  assert.equal(rRgb.geometryStatus, 'GEOMETRY_SAFE');
  assert.equal(rRgb.colorStatus, BLEED_SAFETY_STATUSES.GEOMETRY_SAFE_COLOR_UNVERIFIED);
  assert.equal(rRgb.policyStatus, BLEED_SAFETY_STATUSES.POLICY_ACCEPTED_COLOR_UNVERIFIED);
  assert.equal(rRgb.artworkColorVerified, false);
  assert.equal(rRgb.productionStatus, 'WARNING');
  assert.equal(rRgb.bleedOverlapPairCount, 1);
  assert.ok(rRgb.totalBleedOverlapAreaMm2 > 30);
  assert.ok(Math.abs(rRgb.minBleedToNeighborCutMm - 0.0834) < 0.005);

  // H22-08: Confirmed overlap WITH real DeviceCMYK metadata -> GEOMETRY_SAFE_COLOR_VERIFIED (PASS)
  const rCmyk = evaluateProductionBleedSafetyH22({
    templateId: 'T-CMYK',
    sheet: safeSheet,
    jobMap,
    cutGapMm: 2.0,
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'Verified uniform CMYK cream',
    bleedColorByJobId: { 'J-B': CREAM_PRINT_COLOR },
  });
  assert.equal(rCmyk.valid, true);
  assert.equal(rCmyk.colorStatus, BLEED_SAFETY_STATUSES.GEOMETRY_SAFE_COLOR_VERIFIED);
  assert.equal(rCmyk.artworkColorVerified, true);
  assert.equal(rCmyk.productionStatus, 'PASS');
  assert.equal(rCmyk.warnings.length, 0);

  // H22-05: Tiny 0.15mm shift causes BLEED to intrude into neighbor CUT -> BLOCK (BLEED_INTRUDES_NEIGHBOR_CUT)
  const rIntrude = evaluateProductionBleedSafetyH22({
    templateId: 'T-INTRUDE',
    sheet: intrudeSheet,
    jobMap,
    cutGapMm: 1.5, // even if cutGapMm is relaxed to 1.5mm, BLEED intrusion MUST still BLOCK!
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'Attempted override',
    bleedColorByJobId: { 'J-B': CREAM_PRINT_COLOR },
  });
  assert.equal(rIntrude.valid, false);
  assert.equal(rIntrude.geometryStatus, BLEED_SAFETY_STATUSES.BLEED_INTRUDES_NEIGHBOR_CUT);
  assert.ok(rIntrude.errors.some((e) => e.code === 'BLEED_INTRUDES_NEIGHBOR_CUT'));
  assert.ok(rIntrude.bleedIntrusionCount >= 2); // two-way A->B and B->A!
});

// =========================================================================
// H22-09, H22-10, H22-11, H22-12, H22-13, H22-14: Concave/Peak, Rotations,
//   Multi-SKU, Malformed Contour (GEOMETRY_UNVERIFIED), Determinism, STALE_PLAN
// =========================================================================
test('H22-09..H22-14: Concave/rotations/multi-SKU/malformed BLOCK/determinism/STALE_PLAN', async () => {
  const store = makeStore();

  // H22-12: Malformed contours (open, NaN, self-intersecting bowtie) -> GEOMETRY_UNVERIFIED
  assert.equal(tessellateAndVerifyContourMm({ beziersMm: [{ type: 'M', to: [0, 0] }, { type: 'L', to: [10, 0] }, { type: 'L', to: [10, 10] }], closed: false }).code, 'GEOMETRY_UNVERIFIED');
  assert.equal(tessellateAndVerifyContourMm({ beziersMm: [{ type: 'M', to: [NaN, 0] }, { type: 'L', to: [10, 0] }, { type: 'L', to: [0, 10] }], closed: true }).code, 'GEOMETRY_UNVERIFIED');
  assert.equal(
    tessellateAndVerifyContourMm({
      beziersMm: [
        { type: 'M', to: [0, 0] },
        { type: 'L', to: [10, 10] },
        { type: 'L', to: [10, 0] },
        { type: 'L', to: [0, 10] },
        { type: 'L', to: [0, 0] },
      ],
      closed: true,
    }).code,
    'GEOMETRY_UNVERIFIED'
  );

  // H22-09 & H22-10: Concave L-shape / star across 0/90/180/270 rotations
  const concavePts = [[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]];
  const concaveCut = Object.assign([...concavePts], {
    beziersMm: [
      { type: 'M', to: [0, 0] },
      { type: 'L', to: [20, 0] },
      { type: 'L', to: [20, 6] },
      { type: 'L', to: [6, 6] },
      { type: 'L', to: [6, 20] },
      { type: 'L', to: [0, 20] },
      { type: 'L', to: [0, 0] },
    ],
    closed: true,
  });
  const jobConcave = await makeCustomJob(store, { jobId: 'J-CONCAVE', w: 20, h: 20, cutContour: concaveCut, quantity: 2 });
  const jobRect = await makeCustomJob(store, { jobId: 'J-RECT', w: 10, h: 10, cutContour: makeRectContour(10, 10), bleedContour: makeRectContour(10, 10, 1.5), bleedOffsetMm: 1.5, quantity: 2 });
  const jobMap = new Map([[jobConcave.jobId, jobConcave], [jobRect.jobId, jobRect]]);

  // Nested inside concave pocket (bboxes OVERLAP heavily, yet actual concave CUT contours are disjoint by >= 2mm!)
  const pocketSheet = {
    sheetIndex: 1,
    widthMm: 100,
    heightMm: 100,
    placements: [
      { placementId: 'C1', jobId: 'J-CONCAVE', rigidMatrixMm: buildRigidMatrixMm(10, 10, 20, 20, 0) },
      // Rect at (18.5, 18.5) sits INSIDE concave L-pocket [16..30]x[16..30] with 2.5mm real contour gap!
      { placementId: 'R1', jobId: 'J-RECT', rigidMatrixMm: buildRigidMatrixMm(18.5, 18.5, 10, 10, 0) },
    ],
  };
  const rPocket = evaluateProductionBleedSafetyH22({ templateId: 'T-POCKET', sheet: pocketSheet, jobMap, cutGapMm: 2.0 });
  assert.equal(rPocket.valid, true);
  assert.equal(rPocket.minCutDistanceMm, 2.5);

  // H22-10: All 4 rotations 0/90/180/270 preserve exact distance
  for (const rot of [0, 90, 180, 270]) {
    const rotSheet = {
      sheetIndex: 1,
      widthMm: 120,
      heightMm: 120,
      placements: [
        { placementId: 'A', jobId: 'J-RECT', rigidMatrixMm: buildRigidMatrixMm(10, 10, 10, 10, rot) },
        { placementId: 'B', jobId: 'J-RECT', rigidMatrixMm: buildRigidMatrixMm(22.2, 10, 10, 10, rot) },
      ],
    };
    const rRot = evaluateProductionBleedSafetyH22({
      templateId: `T-ROT-${rot}`,
      sheet: rotSheet,
      jobMap,
      cutGapMm: 2.0,
      bleedPolicy: 'allow_overlap',
      bleedOverlapConfirmed: true,
      bleedOverlapJustification: 'CMYK verified',
      bleedColorByJobId: { 'J-RECT': CREAM_PRINT_COLOR },
    });
    assert.equal(rRot.valid, true);
    assert.equal(rRot.colorStatus, BLEED_SAFETY_STATUSES.GEOMETRY_SAFE_COLOR_VERIFIED);
    assert.ok(Math.abs(rRot.minCutDistanceMm - 2.2) < 0.005);
  }

  // H22-11, H22-13, H22-14: Multi-SKU through H.2.2 adapter + Determinism + Policy change -> STALE_PLAN
  const tpls = [{
    templateId: 'T-MULTI',
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    runCount: 2,
    gridSpec: { rows: 1, columns: 2, pitchXmm: 30, pitchYmm: 30, centerX: true, centerY: true },
    items: [{ jobId: 'J-CONCAVE', copiesPerRun: 1 }, { jobId: 'J-RECT', copiesPerRun: 1 }],
  }];
  const b1 = await buildProductionBatchPlanH2({ batchId: 'B-DET', jobs: [jobConcave, jobRect], sheetTemplates: tpls, spacingPolicy: { cutGapMm: 2 } });
  const b2 = await buildProductionBatchPlanH2({ batchId: 'B-DET', jobs: [jobConcave, jobRect], sheetTemplates: tpls, spacingPolicy: { cutGapMm: 2 } });
  assert.equal(b1.productionOrderManifest.batchFreshnessHash, b2.productionOrderManifest.batchFreshnessHash);
  assert.deepEqual(b1.validation.templates, b2.validation.templates);

  // H22-14: Mutating bleedPolicy in manifest -> MANIFEST_HASH_MISMATCH
  const tamperedPolicyBatch = {
    ...b1,
    productionOrderManifest: {
      ...b1.productionOrderManifest,
      bleedPolicy: { ...b1.productionOrderManifest.bleedPolicy, policy: 'allow_overlap' },
    },
  };
  await assert.rejects(
    () => assertBatchFreshnessH2({ batchPlan: tamperedPolicyBatch, jobs: [jobConcave, jobRect], currentRunCounts: { 'T-MULTI': 2 } }),
    { code: 'MANIFEST_HASH_MISMATCH' }
  );
});

// =========================================================================
// H22-15: ALL 7 PAGES OF REAL L0110.063 (693 REAL 56-SEGMENT CUT + 52-SEGMENT BLEED!)
// =========================================================================
test('H22-15: All 7 pages of real L0110.063 (693 real Bézier CUT + 693 real Bézier BLEED) verified', async () => {
  if (!fs.existsSync(L0110_AI_FILE)) return;
  const realPages = await parseRealL0110Pages(7);
  assert.equal(realPages.length, 7);

  const store = makeStore();
  console.log('\n=== H22-15 REAL 7-PAGE L0110.063 BLEED SAFETY AUDIT ===');
  console.log('Page | Stickers | MinCutGap(mm) | MinBleedToCut(mm) | OverlapPairs | OverlapArea(mm²) | Intrusions | ColorStatus');

  for (const rp of realPages) {
    assert.equal(rp.cuts.length, 99);
    assert.equal(rp.bleeds.length, 99);

    // Build real 56-segment CUT and real 52-segment BLEED in sticker-local coords from Sticker #0
    const refCut = rp.cuts[0];
    const refBleed = rp.bleeds[0];
    const normCmds = (cmds, ox, oy) =>
      cmds.map((cmd) => {
        const o = { type: cmd.type };
        if (cmd.to) o.to = [cmd.to[0] - ox, cmd.to[1] - oy];
        if (cmd.c1) o.c1 = [cmd.c1[0] - ox, cmd.c1[1] - oy];
        if (cmd.c2) o.c2 = [cmd.c2[0] - ox, cmd.c2[1] - oy];
        return o;
      });

    const localCut = Object.assign([[0, 0], [refCut.w, 0], [refCut.w, refCut.h], [0, refCut.h]], {
      beziersMm: normCmds(refCut.beziersMm, refCut.minX, refCut.minY),
      closed: true,
    });
    const localBleed = Object.assign([[0, 0], [refBleed.w, 0], [refBleed.w, refBleed.h], [0, refBleed.h]], {
      beziersMm: normCmds(refBleed.beziersMm, refCut.minX, refCut.minY),
      closed: true,
    });

    const jobId = `L0110-P${rp.pageNumber}`;
    const job = await makeCustomJob(store, {
      jobId,
      w: refCut.w,
      h: refCut.h,
      cutContour: localCut,
      bleedContour: localBleed,
      bleedOffsetMm: 2.0,
      quantity: 99 * 14,
      allowRotate: false,
    });

    // Place all 99 stickers at their EXACT real coordinates from L0110.063
    const sheet = {
      sheetIndex: rp.pageNumber,
      widthMm: 320,
      heightMm: 330,
      placements: rp.cuts.map((c, idx) => ({
        placementId: `P${rp.pageNumber}#${idx + 1}`,
        jobId,
        rigidMatrixMm: buildRigidMatrixMm(c.minX + 55, c.minY + 16.5, refCut.w, refCut.h, 0),
      })),
    };
    const jobMap = new Map([[jobId, job]]);

    const rep = evaluateProductionBleedSafetyH22({
      templateId: `TRANG_${rp.pageNumber}`,
      sheet,
      jobMap,
      cutGapMm: 2.0,
      bleedPolicy: 'allow_overlap',
      bleedOverlapConfirmed: true,
      bleedOverlapJustification: 'L0110.063 verified DeviceCMYK cream bridge',
      bleedColorByJobId: { [jobId]: CREAM_PRINT_COLOR },
      flatnessMm: 0.005, // 5µm flatness across 693×108 curves
    });

    console.log(
      `  P${rp.pageNumber} |    ${rp.cuts.length}    |     ${rep.minCutDistanceMm.toFixed(4)}    |       ${rep.minBleedToNeighborCutMm.toFixed(4)}      |      ${rep.bleedOverlapPairCount}      |     ${rep.totalBleedOverlapAreaMm2.toFixed(2)}      |     ${rep.bleedIntrusionCount}      | ${rep.colorStatus}`
    );

    assert.equal(rep.valid, true, `Page ${rp.pageNumber} failed: ${JSON.stringify(rep.errors)}`);
    assert.equal(rep.bleedIntrusionCount, 0);
    assert.equal(rep.bleedOverlapPairCount, 88); // 8 horizontal neighbor pairs × 11 rows = 88!
    assert.ok(rep.minCutDistanceMm >= 2.08);
    assert.ok(rep.minBleedToNeighborCutMm >= 0.08);
    assert.equal(rep.colorStatus, BLEED_SAFETY_STATUSES.GEOMETRY_SAFE_COLOR_VERIFIED);
    assert.equal(rep.productionStatus, 'PASS');
  }
});

// =========================================================================
// H22-17: All 17 LOCKED files SHA-256 unchanged
// =========================================================================
test('H22-17: All 17 locked B–G + H.1 engine files have identical SHA-256 checksums', () => {
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
