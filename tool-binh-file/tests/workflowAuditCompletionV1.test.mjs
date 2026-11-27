/**
 * PrintKit V1 — Đợt 2 Workflow Audit Completion Verification (W2-01..W2-06)
 *
 * Verifies:
 *  - W2-01: fingerprintContours() hashes ALL contours (cmd.to/c1/c2) + cache.getBatchPlan()/setBatchPlan() hit & invalidation.
 *  - W2-02: marginIncludesMarks (true vs false) synced with active machine profile's quietZoneMm.
 *  - W2-03: stickerLayout (simple 0° vs optimal 0°/90° passing gridSpec.rotationDeg), collation (S&R vs N-Up Multi-SKU),
 *           and stickerUnit (single vs sheet) + end-to-end PRINT/CUT export verification.
 *  - W2-04: Guillotine trim marks (v1TrimMarks), Paper Guides (paperGuides), Slug Line sync (showSlugLine true/false),
 *           and Production Report JSON (buildProductionReportV1).
 *  - W2-05: Real customer PDF (C:/Users/IT/Downloads/Decal sticker pdf.pdf, 99 stickers/page) on D320x330
 *           with guillotine + paperGuides + slug + batchPlan cache hit.
 *  - W2-06: UI source wiring audit (D320x330, presets localStorage, report button, badge nowrap, preview top-center slug/guides/trim)
 *           + 17/17 LOCKED engine files SHA-256 unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import { createStickerPipelineCache } from '../resources/js/engine/stickerPipelineCache.js';
import { runVectorFirstPdfImport, resolveVectorFirstContours } from '../resources/js/engine/vectorFirstPipeline.js';
import {
  fingerprintContours,
  formatV1SlugText,
  checkV1StickerConfigCompatibility,
  buildV1StickerTabPlan,
  exportV1StickerBatchBundle,
  buildProductionReportV1,
} from '../resources/js/engine/stickerTabV1Adapter.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'resources', 'js', 'engine');
const REAL_PDF = 'C:/Users/IT/Downloads/Decal sticker pdf.pdf';

const TINY_PNG_BYTES = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
);

const LOCKED_17 = {
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
    createObjectURL: (b) => `blob:w2/${Math.random()}/${b.size}`,
    revokeObjectURL: () => {},
  });
}

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
          for (let i = 1; i <= 12; i++) {
            const t = i / 12, u = 1 - t;
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

/**
 * Create a clean closed cubic-Bézier rounded-rect contour (w × h mm) at (ox, oy).
 */
function makeRectBezierContour(w, h, ox = 5, oy = 5) {
  const x0 = ox, y0 = oy, x1 = ox + w, y1 = oy + h;
  const dx = w / 3, dy = h / 3;
  const beziersMm = [
    { type: 'M', to: [x0, y0] },
    { type: 'C', c1: [x0 + dx, y0], c2: [x1 - dx, y0], to: [x1, y0] },
    { type: 'C', c1: [x1, y0 + dy], c2: [x1, y1 - dy], to: [x1, y1] },
    { type: 'C', c1: [x1 - dx, y1], c2: [x0 + dx, y1], to: [x0, y1] },
    { type: 'C', c1: [x0, y1 - dy], c2: [x0, y0 + dy], to: [x0, y0] },
  ];
  const poly = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  poly.beziersMm = beziersMm;
  return poly;
}

test('W2-01: fingerprintContours() hashes ALL contours (cmd.to/c1/c2) + cache.getBatchPlan() hits & invalidates', async () => {
  assert.equal(fingerprintContours([]), '0');

  const c0 = makeRectBezierContour(40, 30, 5, 5);
  const c1 = makeRectBezierContour(40, 30, 50, 5);
  const c2 = makeRectBezierContour(40, 30, 95, 5);
  const fpBase = fingerprintContours([c0, c1, c2]);

  // Mutate ONLY the middle contour's c1 control point (previously missed because only [0] & [last] were checked and .p0 was undefined)
  const c1Mut = makeRectBezierContour(40, 30, 50, 5);
  c1Mut.beziersMm[1].c1 = [c1Mut.beziersMm[1].c1[0] + 0.25, c1Mut.beziersMm[1].c1[1]];
  const fpMutC1 = fingerprintContours([c0, c1Mut, c2]);
  assert.notEqual(fpMutC1, fpBase, 'fingerprintContours must detect middle contour c1 change');

  // Mutate ONLY the middle contour's to coordinate
  const c1MutTo = makeRectBezierContour(40, 30, 50, 5);
  c1MutTo.beziersMm[2].to = [c1MutTo.beziersMm[2].to[0], c1MutTo.beziersMm[2].to[1] + 0.1];
  const fpMutTo = fingerprintContours([c0, c1MutTo, c2]);
  assert.notEqual(fpMutTo, fpBase, 'fingerprintContours must detect middle contour to change');

  // Verify cache.getBatchPlan() / setBatchPlan() hit on identical call
  const cache = createStickerPipelineCache();
  const payload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: 100, h: 100 },
    contoursMm: [makeRectBezierContour(40, 30, 5, 5)],
    bleedOffsetMm: 0,
    sourceFileName: 'w2_cache_test.pdf',
  };
  const cfg = {
    paperSizeKey: 'D320x330',
    orientation: 'portrait',
    marginTop: 10,
    marginBottom: 10,
    marginLeft: 10,
    marginRight: 10,
    marginIncludesMarks: true,
    gutterX: 3,
    gutterY: 3,
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'none',
    pontType: 'graphtec',
    showSlugLine: true,
    showPaperGuides: false,
  };

  const p1 = await buildV1StickerTabPlan({ v1Payload: payload, config: cfg, resourceStore: makeStore(), pipelineCache: cache });
  assert.equal(p1.supported, true);
  assert.equal(p1.cacheStats.layoutComputations, 1);
  assert.equal(p1.cacheStats.layoutCacheHits, 0);

  // Second identical call -> cache HIT!
  const p2 = await buildV1StickerTabPlan({ v1Payload: payload, config: { ...cfg }, resourceStore: makeStore(), pipelineCache: cache });
  assert.equal(p2.supported, true);
  assert.equal(p2.cacheStats.layoutCacheHits, 1, 'Identical layout must hit batchPlan cache');
  assert.equal(p2.cacheStats.layoutComputations, 1, 'Cache hit must not recompute layout');
  assert.equal(p2.batchVersion, p1.batchVersion);

  // Changing showPaperGuides invalidates layout cache -> cache MISS
  const p3 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...cfg, showPaperGuides: true },
    resourceStore: makeStore(),
    pipelineCache: cache,
  });
  assert.equal(p3.cacheStats.layoutComputations, 2);
  assert.equal(p3.previewPlan.sheets[0].paperGuides.length, 8);
});

test('W2-02: marginIncludesMarks (true vs false) synced with active machine profile quietZoneMm', async () => {
  const payload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: 100, h: 100 },
    contoursMm: [makeRectBezierContour(40, 40, 5, 5)],
    bleedOffsetMm: 0,
    sourceFileName: 'w2_margin_test.pdf',
  };
  const baseCfg = {
    paperSizeKey: 'D320x330',
    orientation: 'portrait',
    marginTop: 10,
    marginBottom: 10,
    marginLeft: 10,
    marginRight: 10,
    gutterX: 3,
    gutterY: 3,
    stickerLayout: 'simple',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'none',
    pontType: 'graphtec',
    machineProfileId: 'graphtec_arms_t1', // quietZoneMm = 5.0
    pontMarginMm: 10,
    pontSizeMm: 5,
  };

  // markClearance = 10 + 5/2 + 5 = 17.5 mm
  const pInc = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...baseCfg, marginIncludesMarks: true },
    resourceStore: makeStore(),
  });
  const pAdd = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...baseCfg, marginIncludesMarks: false },
    resourceStore: makeStore(),
  });

  assert.equal(pInc.supported, true);
  assert.equal(pAdd.supported, true);
  assert.equal(pInc.summary.quietZoneMm, 5);
  assert.equal(pInc.summary.markClearanceMm, 17.5);
  assert.equal(pInc.effectiveMarginsMm.left, 17.5, 'marginIncludesMarks=true -> Math.max(17.5, 10) = 17.5');
  assert.equal(pAdd.effectiveMarginsMm.left, 27.5, 'marginIncludesMarks=false -> 17.5 + 10 = 27.5');
  assert.ok(
    pInc.summary.stickersPerSheet >= pAdd.summary.stickersPerSheet,
    'Larger usable area with marginIncludesMarks=true should fit >= stickers'
  );

  // Switch machine profile to graphtec_arms_t2 (quietZoneMm = 4.0) -> markClearance = 10 + 2.5 + 4 = 16.5 mm
  const pT2 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...baseCfg, pontType: 'graphtecType2', machineProfileId: 'graphtec_arms_t2', marginIncludesMarks: false },
    resourceStore: makeStore(),
  });
  assert.equal(pT2.summary.quietZoneMm, 4);
  assert.equal(pT2.effectiveMarginsMm.left, 26.5);

  // Without explicit machineProfileId -> fallback quietZoneMm = 2.0 -> markClearance = 10 + 2.5 + 2 = 14.5 mm
  const pFallback = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...baseCfg, machineProfileId: null, marginIncludesMarks: false },
    resourceStore: makeStore(),
  });
  assert.equal(pFallback.summary.quietZoneMm, 2);
  assert.equal(pFallback.effectiveMarginsMm.left, 24.5);
});

test('W2-03: stickerLayout (simple 0° vs optimal 0°/90°), collation (S&R vs N-Up Multi-SKU), and stickerUnit (single vs sheet)', async () => {
  // 1. stickerLayout: 85 x 42 mm sticker on 320 x 330 mm (safe ~285 x 295 with 17.5mm margin, 2mm gap)
  //    At 0°: cols = floor((285+2)/87) = 3, rows = floor((295+2)/44) = 6 -> 18 stickers
  //    At 90°: cols = floor((285+2)/44) = 6, rows = floor((295+2)/87) = 3 -> 18 (tie)
  //    Pick 95 x 38 mm on 330 x 390 mm (safe ~295 x 355 with 17.5mm margin, 2mm gap):
  //    At 0°: cols = floor(297/97) = 3, rows = floor(357/40) = 8 -> 24 stickers
  //    At 90°: cols = floor(297/40) = 7, rows = floor(357/97) = 3 -> 21 stickers
  //    Pick 38 x 95 mm on 330 x 390 mm:
  //    At 0°: cols = 7, rows = 3 -> 21 stickers
  //    At 90°: cols = 3, rows = 8 -> 24 stickers (strictly better!)
  const rectPayload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: 120, h: 120 },
    contoursMm: [makeRectBezierContour(38, 95, 5, 5)],
    bleedOffsetMm: 0,
    sourceFileName: 'rect_38x95.pdf',
  };
  const rectCfg = {
    paperSizeKey: 'D330x390',
    orientation: 'portrait',
    marginTop: 10,
    marginBottom: 10,
    marginLeft: 10,
    marginRight: 10,
    marginIncludesMarks: true,
    gutterX: 2,
    gutterY: 2,
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'none',
    pontType: 'graphtec',
    machineProfileId: 'graphtec_arms_t1',
    pontMarginMm: 10,
    pontSizeMm: 5,
  };

  const pSimple = await buildV1StickerTabPlan({
    v1Payload: rectPayload,
    config: { ...rectCfg, stickerLayout: 'simple' },
    resourceStore: makeStore(),
  });
  const pOptimal = await buildV1StickerTabPlan({
    v1Payload: rectPayload,
    config: { ...rectCfg, stickerLayout: 'optimal' },
    resourceStore: makeStore(),
  });

  assert.equal(pSimple.supported, true);
  assert.equal(pOptimal.supported, true);
  assert.equal(pSimple.summary.rotationDeg, 0);
  assert.equal(pSimple.summary.stickersPerSheet, 21);
  assert.equal(pOptimal.summary.rotationDeg, 90, 'Optimal must pick 90° when 90° fits more stickers');
  assert.equal(pOptimal.summary.stickersPerSheet, 24);
  assert.equal(pOptimal.checkpoint.batchPlan.impositionPlan.sheets[0].placements[0].rotationDeg, 90);

  // Verify rotated 90° batch exports cleanly and PASSES post-export CUT verification!
  const rotBundle = await exportV1StickerBatchBundle({
    v1PlanState: pOptimal,
    baseName: 'rect_rot90',
    verifyEachCutPage: true,
  });
  assert.equal(rotBundle.cutPageFiles[0].verification.status, 'PASS');
  assert.equal(rotBundle.cutPageFiles[0].placementCount, 24);

  // 2. collation: stepAndRepeat (2 separate sheets) vs sequential (N-Up Multi-SKU on 1 shared sheet)
  const twoSkuPayload = {
    sourceFileName: 'two_sku.pdf',
    pages: [
      {
        pageNum: 1,
        cleanArtworkBytes: TINY_PNG_BYTES,
        sourceSizeMm: { w: 100, h: 100 },
        contoursMm: [makeRectBezierContour(50, 50, 5, 5)],
        bleedOffsetMm: 0,
      },
      {
        pageNum: 2,
        cleanArtworkBytes: TINY_PNG_BYTES,
        sourceSizeMm: { w: 100, h: 100 },
        contoursMm: [makeRectBezierContour(50, 50, 5, 5)],
        bleedOffsetMm: 0,
      },
    ],
  };

  const pSR = await buildV1StickerTabPlan({
    v1Payload: twoSkuPayload,
    config: { ...rectCfg, stickerLayout: 'simple', collation: 'stepAndRepeat', stickerAutoFillSheet: false },
    quantityByPage: { 1: 4, 2: 6 },
    resourceStore: makeStore(),
  });
  const pNup = await buildV1StickerTabPlan({
    v1Payload: twoSkuPayload,
    config: { ...rectCfg, stickerLayout: 'simple', collation: 'sequential', stickerAutoFillSheet: false },
    quantityByPage: { 1: 4, 2: 6 },
    resourceStore: makeStore(),
  });

  assert.equal(pSR.previewPlan.totalSheets, 2, 'S&R keeps 2 separate sheets');
  assert.equal(pNup.previewPlan.totalSheets, 1, 'N-Up packs both SKUs onto 1 shared sheet');
  assert.equal(pNup.previewPlan.sheets[0].placements.length, 10, '4 + 6 = 10 placements on shared N-Up sheet');

  // 2b. Multi-sheet N-Up overflow (exceeds 1 sheet capacity -> splits across NUP-1 and NUP-2)
  const pNupOverflow = await buildV1StickerTabPlan({
    v1Payload: twoSkuPayload,
    config: { ...rectCfg, stickerLayout: 'simple', collation: 'sequential', stickerAutoFillSheet: false },
    quantityByPage: { 1: 20, 2: 20 },
    resourceStore: makeStore(),
  });
  assert.equal(pNupOverflow.supported, true);
  assert.equal(pNupOverflow.previewPlan.totalSheets, 2, '40 stickers on 30-cap sheet must split across 2 N-Up sheets');
  assert.equal(
    pNupOverflow.previewPlan.sheets[0].placements.length + pNupOverflow.previewPlan.sheets[1].placements.length,
    40
  );

  // 2c. Oversized single-contour sticker must return supported: false gracefully (never throw GridPackingError)
  const oversizedPayload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: 400, h: 400 },
    contoursMm: [makeRectBezierContour(310, 380, 5, 5)],
    bleedOffsetMm: 0,
    sourceFileName: 'oversized.pdf',
  };
  const pOversized = await buildV1StickerTabPlan({
    v1Payload: oversizedPayload,
    config: { ...rectCfg, paperSizeKey: 'D320x330', stickerLayout: 'optimal' },
    resourceStore: makeStore(),
  });
  assert.equal(pOversized.supported, false, 'Oversized single-contour sticker must fail gracefully');
  assert.ok(pOversized.unsupportedReasons.length > 0);

  // 3. stickerUnit: 'sheet' treats quantity as sheet runCount
  const pSheetUnit = await buildV1StickerTabPlan({
    v1Payload: rectPayload,
    config: { ...rectCfg, stickerLayout: 'simple', stickerUnit: 'sheet', stickerAutoFillSheet: false },
    quantityByPage: { 1: 5 },
    resourceStore: makeStore(),
  });
  assert.equal(pSheetUnit.summary.stickerUnit, 'sheet');
  assert.equal(pSheetUnit.summary.physicalSheets, 5, 'stickerUnit=sheet interprets qty=5 as 5 physical sheets');
  assert.equal(pSheetUnit.previewPlan.sheets[0].placements.length, 21, 'Full sheet layout preserved');
});

test('W2-04: Guillotine trim marks, Paper Guides, Slug Line sync (true/false), and Production Report JSON', async () => {
  const compat = checkV1StickerConfigCompatibility({
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'guillotine',
    pontType: 'graphtec',
  });
  assert.equal(compat.supported, true, 'guillotine trim marks must be supported in Đợt 2');

  const payload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: 100, h: 100 },
    contoursMm: [makeRectBezierContour(50, 50, 5, 5)],
    bleedOffsetMm: 0,
    sourceFileName: 'SanPham_Test.pdf',
  };
  const cfg = {
    paperSizeKey: 'D320x330',
    orientation: 'portrait',
    marginTop: 10,
    marginBottom: 10,
    marginLeft: 10,
    marginRight: 10,
    marginIncludesMarks: true,
    gutterX: 3,
    gutterY: 3,
    stickerLayout: 'simple',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'guillotine',
    showPaperGuides: true,
    showSlugLine: true,
    pontType: 'graphtec',
    machineProfileId: 'graphtec_arms_t1',
    pontMarginMm: 10,
    pontSizeMm: 5,
  };

  const planOn = await buildV1StickerTabPlan({ v1Payload: payload, config: cfg, runCount: 3, resourceStore: makeStore() });
  assert.equal(planOn.supported, true);
  const shOn = planOn.previewPlan.sheets[0];
  assert.ok(shOn.v1TrimMarks.length > 0, 'v1TrimMarks must be generated when guillotine is enabled');
  assert.equal(shOn.paperGuides.length, 8, 'paperGuides must have 8 segments (4 edges × bar+tick)');
  const expectedSlug = formatV1SlugText({
    baseName: 'SanPham_Test',
    sheetWidthMm: 320,
    sheetHeightMm: 330,
    placementCount: shOn.placements.length,
    runCount: 3,
    sheetIndex: 1,
    totalSheets: 1,
  });
  assert.equal(shOn.slugText, expectedSlug, 'Preview slugText must match PRINT PDF formatV1SlugText 1:1');

  // Hide slug line when showSlugLine=false
  const planOff = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...cfg, showSlugLine: false, showPaperGuides: false, stickerTrimMarks: 'none' },
    runCount: 3,
    resourceStore: makeStore(),
  });
  assert.equal(planOff.previewPlan.sheets[0].slugText, '', 'slugText must be empty when showSlugLine=false');
  assert.equal(planOff.previewPlan.sheets[0].paperGuides.length, 0);
  assert.equal(planOff.previewPlan.sheets[0].v1TrimMarks.length, 0);

  // Export PRINT + CUT and verify CUT still passes cleanly while PRINT has trimMarks + paperGuides + slug stamped
  const extractPageStreamText = (pdfDoc, pageIndex = 0) => {
    const pg = pdfDoc.getPage(pageIndex);
    const contents = pg.node.Contents();
    if (!contents) return '';
    const refs =
      contents.constructor.name === 'PDFArray'
        ? Array.from({ length: contents.size() }, (_, i) => contents.get(i))
        : [contents];
    let combined = '';
    for (const ref of refs) {
      const st = pdfDoc.context.lookup(ref);
      if (!st || typeof st.getContents !== 'function') continue;
      const raw = st.getContents();
      const flt = st.dict?.get?.(PDFName.of('Filter'));
      const isFlate = Boolean(flt && String(flt.toString()).includes('FlateDecode'));
      const buf = isFlate ? zlib.inflateSync(Buffer.from(raw)) : Buffer.from(raw);
      combined += '\n' + buf.toString('latin1');
    }
    return combined;
  };

  const bundle = await exportV1StickerBatchBundle({
    v1PlanState: planOn,
    baseName: 'SanPham_Test',
    verifyEachCutPage: true,
  });
  assert.equal(bundle.cutPageFiles[0].verification.status, 'PASS');
  const printDoc = await PDFDocument.load(bundle.printPdfBytes);
  assert.equal(printDoc.getPageCount(), 1);
  const printStreamOn = extractPageStreamText(printDoc, 0);
  const expectedSlugHex = Buffer.from(expectedSlug, 'latin1').toString('hex').toUpperCase();
  assert.ok(
    printStreamOn.toUpperCase().includes(expectedSlugHex) || printStreamOn.includes(expectedSlug),
    'PRINT PDF stream must contain exact stamped slugText when showSlugLine=true'
  );

  const bundleOff = await exportV1StickerBatchBundle({
    v1PlanState: planOff,
    baseName: 'SanPham_Test',
    verifyEachCutPage: true,
  });
  const printDocOff = await PDFDocument.load(bundleOff.printPdfBytes);
  const printStreamOff = extractPageStreamText(printDocOff, 0);
  assert.ok(
    !printStreamOff.toUpperCase().includes(expectedSlugHex) && !printStreamOff.includes('SanPham_Test'),
    'PRINT PDF stream must NOT contain slugText when showSlugLine=false'
  );
  const lineOpsOn = (printStreamOn.match(/\bl\b/g) || []).length;
  const lineOpsOff = (printStreamOff.match(/\bl\b/g) || []).length;
  assert.ok(
    lineOpsOn >= lineOpsOff + shOn.v1TrimMarks.length + 8,
    `PRINT PDF with guillotine+paperGuides must contain stamped line operators (on=${lineOpsOn}, off=${lineOpsOff})`
  );

  // Production Report JSON
  const report = buildProductionReportV1(planOn, bundle);
  const serialized = JSON.stringify(report);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.schemaVersion, 'PrintKitProductionReportV1.0');
  assert.equal(parsed.supported, true);
  assert.equal(parsed.summary.stickerTrimMarks, 'guillotine');
  assert.equal(parsed.summary.showPaperGuides, true);
  assert.equal(parsed.sheets.length, 1);
  assert.equal(parsed.sheets[0].trimMarksCount, shOn.v1TrimMarks.length);
  assert.equal(parsed.sheets[0].paperGuidesCount, 8);
  assert.equal(parsed.sheets[0].slugText, expectedSlug);
  assert.equal(parsed.postExportVerification.status, 'PASS');
});

test('W2-05: Real Decal sticker pdf.pdf (99 stickers/page) on D320x330 with guillotine + paperGuides + slug + cache hit', async () => {
  assert.ok(fs.existsSync(REAL_PDF), `Real customer PDF must exist at ${REAL_PDF}`);
  const pdfBytes = new Uint8Array(fs.readFileSync(REAL_PDF));
  const vecRes = await runVectorFirstPdfImport(pdfBytes, { pageNumber: 1, minAreaMm2: 8.0 });
  assert.equal(vecRes.status, 'OK');
  const resolved = resolveVectorFirstContours(vecRes, {
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    shapeMode: 'auto',
    pageWidthMm: vecRes.pageWidthMm,
    pageHeightMm: vecRes.pageHeightMm,
  });
  assert.equal(resolved.contoursMm.length, 99);

  const cache = createStickerPipelineCache();
  const payload = {
    pages: [
      {
        pageNum: 1,
        cleanArtworkBytes: TINY_PNG_BYTES,
        sourceSizeMm: { w: vecRes.pageWidthMm, h: vecRes.pageHeightMm },
        contoursMm: resolved.contoursMm,
        bleedOffsetMm: 2.0,
        contourProvenance: resolved.provenance,
      },
    ],
    sourceFileName: 'Decal sticker pdf.pdf',
    bleedOffsetMm: 2.0,
  };

  const cfg = {
    paperSizeKey: 'D320x330',
    orientation: 'portrait',
    marginTop: 12.5,
    marginBottom: 12.5,
    marginLeft: 12.5,
    marginRight: 12.5,
    marginIncludesMarks: true,
    gutterX: 2.4,
    gutterY: 2.4,
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'guillotine',
    showPaperGuides: true,
    showSlugLine: true,
    pontType: 'graphtec',
    machineProfileId: 'graphtec_arms_t1',
    pontMarginMm: 10,
    pontSizeMm: 5,
  };

  const plan1 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: cfg,
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'L0110.063 cùng nền tràn viền +2mm',
    runCount: 2,
    pipelineCache: cache,
  });
  assert.equal(plan1.supported, true);
  assert.equal(plan1.previewPlan.sheets[0].placements.length, 99);
  assert.ok(plan1.previewPlan.sheets[0].v1TrimMarks.length > 0);
  assert.equal(plan1.previewPlan.sheets[0].paperGuides.length, 8);
  assert.ok(plan1.previewPlan.sheets[0].slugText.includes('99 tem/to'));

  // Identical second call must hit batchPlan cache with +0 BLEED calls
  const bleedBefore = plan1.cacheStats.bleedEngineCalls;
  const plan2 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...cfg },
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    bleedOverlapJustification: 'L0110.063 cùng nền tràn viền +2mm',
    runCount: 2,
    pipelineCache: cache,
  });
  assert.equal(plan2.cacheStats.bleedEngineCalls, bleedBefore);
  assert.equal(plan2.cacheStats.layoutCacheHits, 1);

  const bundle = await exportV1StickerBatchBundle({
    v1PlanState: plan1,
    baseName: 'Decal_W2',
    verifyEachCutPage: true,
  });
  assert.equal(bundle.cutPageFiles.length, 1);
  assert.equal(bundle.cutPageFiles[0].verification.status, 'PASS');
  assert.equal(bundle.cutPageFiles[0].verification.metrics.exportedContours, 99);
  assert.equal(bundle.cutPageFiles[0].verification.metrics.newKinksCount, 0);
  assert.ok(bundle.cutPageFiles[0].verification.metrics.maxHausdorffMm <= 0.005);
});

test('W2-06: UI source wiring audit + 17/17 LOCKED engine files SHA-256 unchanged', () => {
  const editorSrc = fs.readFileSync(path.join(ROOT, 'resources/js/components/PdfEditor.jsx'), 'utf8');
  assert.ok(editorSrc.includes('value="D320x330"'), 'PdfEditor must expose D320x330 preset');
  assert.ok(editorSrc.includes('setMarginIncludesMarks(true)'), 'Handoff must enable marginIncludesMarks=true to avoid double-counting');
  assert.ok(editorSrc.includes('v1PlanState?.effectiveMarginsMm'), 'PdfEditor must pass effectiveMarginsMm to PdfCanvasPreview');
  assert.ok(editorSrc.includes('const legacyConfig = useMemo'), 'PdfEditor must map D320x330 cleanly for legacy non-V1 plans');
  assert.ok(editorSrc.includes('showPaperGuides'), 'PdfEditor must wire showPaperGuides');
  assert.ok(editorSrc.includes('printkit_v1_sticker_presets'), 'PdfEditor must persist presets in localStorage');
  assert.ok(editorSrc.includes('buildProductionReportV1'), 'PdfEditor must wire Production Report JSON export');
  assert.ok(editorSrc.includes('whitespace-nowrap shrink-0'), 'Status badges must use whitespace-nowrap shrink-0');

  const previewSrc = fs.readFileSync(path.join(ROOT, 'resources/js/components/PdfCanvasPreview.jsx'), 'utf8');
  assert.ok(previewSrc.includes('activeSheet.v1TrimMarks'), 'PdfCanvasPreview must render v1TrimMarks');
  assert.ok(previewSrc.includes('activeSheet.paperGuides'), 'PdfCanvasPreview must render paperGuides');
  assert.ok(previewSrc.includes('activeSheet.isV1Authoritative'), 'PdfCanvasPreview must render V1 slug at top-center');

  let verified = 0;
  for (const [file, expected] of Object.entries(LOCKED_17)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ENGINE_DIR, file))).digest('hex');
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
    verified++;
  }
  assert.equal(verified, 17);
});
