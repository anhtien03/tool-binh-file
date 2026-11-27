import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

import {
  PAIR_VIEW_MODES,
  PARITY_STATUS,
  computeSyncedScrollPosition,
  computeSyncedZoom,
  analyzeArtworkCutOverlay,
  buildPairThumbnailsModel,
  computePreviewPlanParitySignature,
  checkPreviewVsExportParity,
} from '../resources/js/engine/pairPreviewEngine.js';
import {
  ROTATION_MODES,
  CLUSTER_MODES,
  clusterStickerItems,
  generateSmartImpositionOptions,
} from '../resources/js/engine/smartImpositionPlanner.js';
import {
  buildV1StickerTabPlan,
  exportV1StickerBatchBundle,
  buildProductionReportV1,
} from '../resources/js/engine/stickerTabV1Adapter.js';
import { createStickerPipelineCache } from '../resources/js/engine/stickerPipelineCache.js';

const ROOT = process.cwd();

const LOCKED_17_BASELINES = {
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

const TINY_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAFklEQVR4nGP8z8DAwMDAwMSABRgZGAARJgEB5vN28QAAAABJRU5ErkJggg==',
    'base64'
  )
);

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
      let pts = [];
      let cur = [0, 0];
      return {
        fillStyle: '#000',
        clearRect() { self._data.fill(0); },
        getImageData(x, y, w, h) { return { data: self._data, width: w, height: h }; },
        beginPath() { pts = []; },
        moveTo(x, y) { cur = [x, y]; pts.push(cur); },
        lineTo(x, y) { cur = [x, y]; pts.push(cur); },
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
          const [p0x, p0y] = cur;
          for (let s = 1; s <= 12; s++) {
            const t = s / 12;
            const u = 1 - t;
            pts.push([
              u * u * u * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
              u * u * u * p0y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
            ]);
          }
          cur = [x, y];
        },
        closePath() {},
        fill() {
          const w = self._w;
          const h = self._h;
          const n = pts.length;
          if (n < 3) return;
          let minY = h, maxY = 0;
          for (let i = 0; i < n; i++) {
            if (pts[i][1] < minY) minY = pts[i][1];
            if (pts[i][1] > maxY) maxY = pts[i][1];
          }
          const yStart = Math.max(0, Math.floor(minY));
          const yEnd = Math.min(h - 1, Math.ceil(maxY));
          for (let y = yStart; y <= yEnd; y++) {
            const py = y + 0.5;
            const xs = [];
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const yi = pts[i][1], yj = pts[j][1];
              if ((yi > py) !== (yj > py)) {
                xs.push(pts[j][0] + ((py - yj) / (yi - yj)) * (pts[i][0] - pts[j][0]));
              }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
              const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
              for (let x = x0; x <= x1; x++) {
                self._data[(y * w + x) * 4 + 3] = 255;
              }
            }
          }
        },
      };
    },
  };
}
if (!globalThis.document) {
  globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeMockCanvas(0, 0) : {}) };
}

function makeRectStickerContour(x0, y0, w, h) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const dx = w / 3;
  const dy = h / 3;
  const poly = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  poly.closed = true;
  poly.beziersMm = [
    { type: 'M', to: [x0, y0] },
    { type: 'C', c1: [x0 + dx, y0], c2: [x1 - dx, y0], to: [x1, y0] },
    { type: 'C', c1: [x1, y0 + dy], c2: [x1, y1 - dy], to: [x1, y1] },
    { type: 'C', c1: [x1 - dx, y1], c2: [x0 + dx, y1], to: [x0, y1] },
    { type: 'C', c1: [x0, y1 - dy], c2: [x0, y0 + dy], to: [x0, y0] },
  ];
  return poly;
}

function makeSyntheticPage(pageNum, wMm, hMm, bleedOffsetMm = 1.5) {
  const pad = 5;
  return {
    pageNum,
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: wMm + pad * 2, h: hMm + pad * 2 },
    contoursMm: [makeRectStickerContour(pad, pad, wMm, hMm)],
    bleedOffsetMm,
    contourProvenance: { badge: 'PDF VECTOR — ORIGINAL' },
  };
}

// =============================================================================
// GIAI ĐOẠN 3 — XEM KẾT QUẢ IN/BẾ THEO CẶP
// =============================================================================

test('P3-01: Synchronized scroll & zoom math (1:1 parity, ratio sync, bounds clamping)', () => {
  assert.equal(PAIR_VIEW_MODES.SIDE_BY_SIDE, 'sideBySide');
  assert.equal(PAIR_VIEW_MODES.OVERLAY, 'overlay');
  assert.equal(PAIR_VIEW_MODES.SINGLE, 'single');

  // Exact 1:1 sync when viewports match
  const exact = computeSyncedScrollPosition({
    sourceScrollLeft: 145,
    sourceScrollTop: 280,
    sourceMaxX: 500,
    sourceMaxY: 800,
    targetMaxX: 500,
    targetMaxY: 800,
  });
  assert.deepEqual(exact, { scrollLeft: 145, scrollTop: 280 });

  // Ratio sync when panes differ
  const ratio = computeSyncedScrollPosition({
    sourceScrollLeft: 250,
    sourceScrollTop: 400,
    sourceMaxX: 500,
    sourceMaxY: 800,
    targetMaxX: 1000,
    targetMaxY: 400,
  });
  assert.deepEqual(ratio, { scrollLeft: 500, scrollTop: 200 });

  // Clamping & zero max scroll edge cases
  const clamped = computeSyncedScrollPosition({
    sourceScrollLeft: -50,
    sourceScrollTop: 9999,
    sourceMaxX: 0,
    sourceMaxY: 300,
    targetMaxX: 0,
    targetMaxY: 300,
  });
  assert.deepEqual(clamped, { scrollLeft: 0, scrollTop: 300 });

  // Zoom stepping & clamping
  assert.equal(computeSyncedZoom(1.0, 1), 1.15);
  assert.equal(computeSyncedZoom(1.0, -1), 0.85);
  assert.equal(computeSyncedZoom(0.35, -5), 0.35);
  assert.equal(computeSyncedZoom(9.9, 5), 10.0);
});

test('P3-02: Artwork/CUT Overlay Deviation Inspection (PASS on shared plan + FAIL on injected shift/count/mark faults)', async () => {
  const payload = {
    sourceFileName: 'overlay_check.pdf',
    pages: [makeSyntheticPage(1, 50, 35, 1.5)],
  };
  const planState = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: {
      paperSizeKey: 'D330x390',
      orientation: 'portrait',
      marginTop: 15,
      marginBottom: 15,
      marginLeft: 15,
      marginRight: 15,
      gutterX: 4,
      gutterY: 4,
      pontType: 'graphtec',
      machineProfileId: 'graphtec_arms_t1',
      stickerLayout: 'optimal',
      collation: 'stepAndRepeat',
    },
    bleedPolicy: 'strict',
    runCount: 1,
    pipelineCache: createStickerPipelineCache(),
  });

  assert.equal(planState.supported, true);
  const sheet = planState.previewPlan.sheets[0];
  const passRes = analyzeArtworkCutOverlay(sheet);
  assert.equal(passRes.status, 'PASS');
  assert.equal(passRes.matchedCutPaths, sheet.placements.length);
  assert.ok(passRes.maxCenterDeltaMm <= 0.01, `Expected <=0.01mm, got ${passRes.maxCenterDeltaMm}`);
  assert.ok(passRes.maxBoundsDeltaMm <= 0.01, `Expected <=0.01mm, got ${passRes.maxBoundsDeltaMm}`);
  assert.equal(passRes.maxMarkDeltaMm, 0);
  assert.ok(passRes.minBleedMarginMm > 0.5);

  // Fault 1: Inject +0.35mm X-shift into first CUT contour
  const shiftedSheet = {
    ...sheet,
    stickerCutPaths: sheet.stickerCutPaths.map((cp, idx) =>
      idx === 0
        ? {
            ...cp,
            beziersMm: cp.beziersMm.map((cmd) => ({
              ...cmd,
              to: cmd.to ? [cmd.to[0] + 0.35, cmd.to[1]] : cmd.to,
              c1: cmd.c1 ? [cmd.c1[0] + 0.35, cmd.c1[1]] : cmd.c1,
              c2: cmd.c2 ? [cmd.c2[0] + 0.35, cmd.c2[1]] : cmd.c2,
            })),
          }
        : cp
    ),
  };
  const shiftRes = analyzeArtworkCutOverlay(shiftedSheet);
  assert.equal(shiftRes.status, 'FAIL');
  assert.ok(shiftRes.maxCenterDeltaMm >= 0.34);
  assert.ok(shiftRes.issues.some((i) => i.code === 'ALIGNMENT_DEVIATION'));

  // Fault 2: Missing CUT path
  const missingCutRes = analyzeArtworkCutOverlay({
    ...sheet,
    stickerCutPaths: sheet.stickerCutPaths.slice(1),
  });
  assert.equal(missingCutRes.status, 'FAIL');
  assert.ok(missingCutRes.issues.some((i) => i.code === 'CUT_COUNT_MISMATCH'));

  // Fault 3: Shifted registration mark between PRINT and CUT
  const badMarkRes = analyzeArtworkCutOverlay({
    ...sheet,
    stickerPontMarks: sheet.pontMarks.map((m, idx) => (idx === 0 ? { ...m, cx: m.cx + 0.5 } : m)),
  });
  assert.equal(badMarkRes.status, 'FAIL');
  assert.ok(badMarkRes.maxMarkDeltaMm >= 0.49);
  assert.ok(badMarkRes.issues.some((i) => i.code === 'MARK_PARITY_MISMATCH'));

  // Fault 4: Empty sheet (0 placements) must warn, never falsely PASS
  const emptySheetRes = analyzeArtworkCutOverlay({ placements: [], stickerCutPaths: [] });
  assert.equal(emptySheetRes.status, 'WARNING');
  assert.ok(emptySheetRes.issues.some((i) => i.code === 'EMPTY_SHEET'));

  // Fault 5: Null/corrupt CUT path must FAIL with INVALID_CUT_PATH, never silently skip
  const corruptCutRes = analyzeArtworkCutOverlay({
    ...sheet,
    placements: [sheet.placements[0]],
    stickerCutPaths: [null],
  });
  assert.equal(corruptCutRes.status, 'FAIL');
  assert.equal(corruptCutRes.matchedCutPaths, 0);
  assert.ok(corruptCutRes.issues.some((i) => i.code === 'INVALID_CUT_PATH'));
});

test('P3-03: Pair Thumbnails model generates mini PRINT rects + mini CUT SVG vector paths per sheet pair', async () => {
  const payload = {
    sourceFileName: 'pair_thumbs.pdf',
    pages: [makeSyntheticPage(1, 50, 40, 1.5), makeSyntheticPage(2, 45, 45, 1.5)],
  };
  const planState = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: {
      paperSizeKey: 'D330x390',
      orientation: 'portrait',
      marginTop: 15,
      marginBottom: 15,
      marginLeft: 15,
      marginRight: 15,
      gutterX: 4,
      gutterY: 4,
      pontType: 'graphtec',
      collation: 'stepAndRepeat',
    },
    runCountByPage: { 1: 3, 2: 5 },
    pipelineCache: createStickerPipelineCache(),
  });

  const thumbs = buildPairThumbnailsModel(planState.previewPlan);
  assert.equal(thumbs.length, 2);
  assert.equal(thumbs[0].sheetNumber, 1);
  assert.equal(thumbs[0].runCount, 3);
  assert.equal(thumbs[1].sheetNumber, 2);
  assert.equal(thumbs[1].runCount, 5);
  assert.ok(thumbs[0].cutSvgPaths.length > 0);
  assert.ok(thumbs[0].cutSvgPaths[0].startsWith('M'));
  assert.ok(thumbs[0].cutSvgPaths[0].endsWith('Z'));
  assert.equal(thumbs[0].overlayStatus, 'PASS');
  assert.equal(thumbs[0].markCount, 4);
});

test('P3-04: Preview-vs-Export Parity catches STALE_EXPORT_VS_PREVIEW, SHEET_SIZE_MISMATCH & PAGE/PLACEMENT mismatch', async () => {
  const payload = {
    sourceFileName: 'parity_test.pdf',
    pages: [makeSyntheticPage(1, 60, 40, 1.5)],
  };
  const cache = createStickerPipelineCache();
  const baseCfg = {
    paperSizeKey: 'D330x390',
    orientation: 'portrait',
    marginTop: 15,
    marginBottom: 15,
    marginLeft: 15,
    marginRight: 15,
    gutterX: 4,
    gutterY: 4,
    pontType: 'graphtec',
    machineProfileId: 'graphtec_arms_t1',
    stickerLayout: 'optimal',
    collation: 'stepAndRepeat',
  };

  const plan1 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: baseCfg,
    bleedPolicy: 'strict',
    runCount: 2,
    pipelineCache: cache,
  });
  const sig1 = computePreviewPlanParitySignature(plan1);
  assert.ok(sig1 && sig1.startsWith('PRV-1-'));

  // 1. Export real PRINT.pdf + CUT_TRANG_1.pdf -> VERIFIED
  const bundle = await exportV1StickerBatchBundle({
    v1PlanState: plan1,
    baseName: 'parity_test',
    verifyEachCutPage: true,
  });
  assert.equal(bundle.previewParity.status, PARITY_STATUS.VERIFIED);
  assert.equal(bundle.previewParity.inSync, true);
  assert.equal(bundle.previewParity.discrepancies.length, 0);

  // 2. Edit Preview (change gutterX 4 -> 6) without re-exporting -> STALE_EXPORT_VS_PREVIEW
  const plan2 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: { ...baseCfg, gutterX: 6 },
    bleedPolicy: 'strict',
    runCount: 2,
    pipelineCache: cache,
  });
  assert.notEqual(plan2.previewParitySignature, plan1.previewParitySignature);
  const staleCheck = await checkPreviewVsExportParity({
    v1PlanState: plan2,
    lastExport: {
      status: bundle.finalCheck.status,
      previewParitySignature: bundle.previewParitySignature,
    },
  });
  assert.equal(staleCheck.status, PARITY_STATUS.WARNING);
  assert.equal(staleCheck.inSync, false);
  assert.ok(staleCheck.discrepancies.some((d) => d.code === 'STALE_EXPORT_VS_PREVIEW'));

  // 3. Tamper exported PRINT.pdf MediaBox (+5mm) -> SHEET_SIZE_MISMATCH
  const tamperedDoc = await PDFDocument.load(bundle.printPdfBytes);
  const pg0 = tamperedDoc.getPage(0);
  const mb = pg0.getMediaBox();
  pg0.setMediaBox(mb.x, mb.y, mb.width + (5 * 72) / 25.4, mb.height);
  const tamperedBytes = await tamperedDoc.save();

  const sizeMismatch = await checkPreviewVsExportParity({
    v1PlanState: plan1,
    lastExport: { status: 'PASS', previewParitySignature: bundle.previewParitySignature },
    exportedPrintPdfBytes: tamperedBytes,
    exportedCutPageFiles: bundle.cutPageFiles,
  });
  assert.equal(sizeMismatch.status, PARITY_STATUS.MISMATCH);
  assert.ok(sizeMismatch.discrepancies.some((d) => d.code === 'SHEET_SIZE_MISMATCH'));

  // 4. Tamper CUT placementCount -> PLACEMENT_COUNT_MISMATCH
  const countMismatch = await checkPreviewVsExportParity({
    v1PlanState: plan1,
    lastExport: { status: 'PASS', previewParitySignature: bundle.previewParitySignature },
    exportedPrintPdfBytes: bundle.printPdfBytes,
    exportedCutPageFiles: [{ ...bundle.cutPageFiles[0], placementCount: 1 }],
  });
  assert.equal(countMismatch.status, PARITY_STATUS.MISMATCH);
  assert.ok(countMismatch.discrepancies.some((d) => d.code === 'PLACEMENT_COUNT_MISMATCH'));
});

// =============================================================================
// GIAI ĐOẠN 4 — BÌNH TEM THÔNG MINH
// =============================================================================

test('P4-01: Smart multi-option ranking + 0°/90°/180° rotation modes + real 180° PRINT/CUT export PASS', async () => {
  // Asymmetric sticker 95x40mm on 330x390mm (safe 300x360):
  // 0°: cols = floor(304/99)=3, rows = floor(364/44)=8 -> 24/sheet
  // 90° (40x95): cols = floor(304/44)=6, rows = floor(364/99)=3 -> 18/sheet
  // Try 42x96mm on 330x390 (safe 300x360):
  // 0°: cols=floor(304/46)=6, rows=floor(364/100)=3 -> 18/sheet
  // 90° (96x42): cols=floor(304/100)=3, rows=floor(364/46)=7 -> 21/sheet (90° WINS!)
  const items = [{ id: 'PG-1', pageNum: 1, jobId: 'J1', modelKey: 'M1', widthMm: 42, heightMm: 96, quantity: 40 }];
  const margins = { top: 15, right: 15, bottom: 15, left: 15 };

  const noneRes = generateSmartImpositionOptions({
    items,
    sheetWidthMm: 330,
    sheetHeightMm: 390,
    marginsMm: margins,
    cutGapXMm: 4,
    cutGapYMm: 4,
    allowRotationMode: ROTATION_MODES.NONE,
  });
  assert.equal(noneRes.options.length, 1);
  assert.equal(noneRes.options[0].rotationDegSummary, '0°');
  assert.equal(noneRes.options[0].metrics.stickersPerSheet, 18);

  const allRotRes = generateSmartImpositionOptions({
    items,
    sheetWidthMm: 330,
    sheetHeightMm: 390,
    marginsMm: margins,
    cutGapXMm: 4,
    cutGapYMm: 4,
    allowRotationMode: ROTATION_MODES.ROT_90_180,
  });
  assert.ok(allRotRes.options.length >= 3, `Expected >=3 options (90°, 0°, 180°), got ${allRotRes.options.length}`);
  assert.equal(allRotRes.options[0].recommended, true);
  assert.equal(allRotRes.options[0].rotationDegSummary, '90°');
  assert.equal(allRotRes.options[0].metrics.stickersPerSheet, 21);
  assert.equal(allRotRes.options[0].metrics.physicalSheetsNeeded, 2); // ceil(40/21)=2 vs ceil(40/18)=3!
  assert.ok(allRotRes.options.some((o) => o.rotationDegSummary === '180°'));

  // Real end-to-end build & export with 180° rotation option selected!
  const payload = {
    sourceFileName: 'rot180_test.pdf',
    pages: [makeSyntheticPage(1, 42, 96, 1.5)],
  };
  const plan180 = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: {
      paperSizeKey: 'D330x390',
      orientation: 'portrait',
      marginTop: 15,
      marginBottom: 15,
      marginLeft: 15,
      marginRight: 15,
      gutterX: 4,
      gutterY: 4,
      pontType: 'graphtec',
      allowRotationMode: ROTATION_MODES.ROT_90_180,
      selectedImpositionOptionId: 'OPT-FORCE-180',
    },
    quantityByPage: { 1: 40 },
    pipelineCache: createStickerPipelineCache(),
  });

  assert.equal(plan180.supported, true);
  assert.equal(plan180.summary.rotationDeg, 180);
  assert.equal(plan180.previewPlan.sheets[0].placements[0].rotate, 180);

  const bundle180 = await exportV1StickerBatchBundle({
    v1PlanState: plan180,
    baseName: 'rot180_test',
    verifyEachCutPage: true,
  });
  assert.equal(bundle180.finalCheck.status, 'PASS');
  assert.equal(bundle180.postExportVerification.status, 'PASS');
  assert.equal(bundle180.previewParity.status, PARITY_STATUS.VERIFIED);
});

test('P4-02: Mixed S&R + N-Up multi-model imposition minimizes sheets & computes exact waste/utilization metrics', async () => {
  // 3 models of 55x55mm on 330x390 (safe 300x360, gap 4 -> pitch 59 -> 5x6 = 30/sheet)
  // Quantities: M1=75 (2 full S&R sheets=60 + 15 rem), M2=10, M3=5 -> total rem=30 -> 1 shared N-Up sheet!
  // Mixed S&R+N-Up = 3 physical sheets (2 S&R + 1 N-Up, 0 overrun!)
  // Pure S&R = ceil(75/30)+1+1 = 5 physical sheets!
  const payload = {
    sourceFileName: 'mixed_sr_nup.pdf',
    pages: [
      makeSyntheticPage(1, 55, 55, 1.5),
      makeSyntheticPage(2, 55, 55, 1.5),
      makeSyntheticPage(3, 55, 55, 1.5),
    ],
  };

  const planMixed = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: {
      paperSizeKey: 'D330x390',
      orientation: 'portrait',
      marginTop: 15,
      marginBottom: 15,
      marginLeft: 15,
      marginRight: 15,
      gutterX: 4,
      gutterY: 4,
      pontType: 'graphtec',
      collation: 'mixed',
      allowRotationMode: ROTATION_MODES.ROT_90_180,
    },
    quantityByPage: { 1: 75, 2: 10, 3: 5 },
    pipelineCache: createStickerPipelineCache(),
  });

  assert.equal(planMixed.supported, true);
  assert.equal(planMixed.summary.physicalSheets, 3);
  assert.equal(planMixed.summary.totalSheets, 2); // 1 S&R template (runCount=2) + 1 N-Up template (runCount=1)
  assert.equal(planMixed.summary.totalStickers, 90);
  assert.equal(planMixed.wasteMetrics.overrunStickers, 0);
  assert.ok(planMixed.wasteMetrics.utilizationPct > 65);
  assert.ok(planMixed.wasteMetrics.wasteAreaCm2 > 0);
  assert.ok(Math.abs(planMixed.wasteMetrics.utilizationPct + planMixed.wasteMetrics.wastePct - 100) <= 0.05);

  const srOpt = planMixed.smartOptions.find((o) => o.strategy === 'sr_per_model');
  assert.ok(srOpt, 'Expected S&R option for comparison');
  assert.equal(srOpt.metrics.physicalSheetsNeeded, 5);
  assert.ok(planMixed.summary.physicalSheets < srOpt.metrics.physicalSheetsNeeded);

  const bundle = await exportV1StickerBatchBundle({
    v1PlanState: planMixed,
    baseName: 'mixed_sr_nup',
    verifyEachCutPage: true,
  });
  assert.equal(bundle.finalCheck.status, 'PASS');
  assert.equal(bundle.cutPageFiles.length, 2);
  assert.equal(bundle.previewParity.status, PARITY_STATUS.VERIFIED);
});

test('P4-03: Production clustering by model, quantity, and order ID propagates to sheets & report', async () => {
  const sampleItems = [
    { id: 'A', modelKey: 'Tem A', orderId: 'DON-01', quantity: 200, widthMm: 50, heightMm: 50 },
    { id: 'B', modelKey: 'Tem B', orderId: 'DON-02', quantity: 180, widthMm: 50, heightMm: 50 },
    { id: 'C', modelKey: 'Tem C', orderId: 'DON-01', quantity: 20, widthMm: 50, heightMm: 50 },
    { id: 'D', modelKey: 'Tem D', orderId: 'DON-02', quantity: 15, widthMm: 50, heightMm: 50 },
  ];

  const byModel = clusterStickerItems(sampleItems, { clusterMode: CLUSTER_MODES.BY_MODEL });
  assert.equal(byModel.length, 4);

  const byQty = clusterStickerItems(sampleItems, { clusterMode: CLUSTER_MODES.BY_QUANTITY });
  assert.equal(byQty.length, 2);
  assert.deepEqual(
    byQty.map((c) => c.items.map((i) => i.id)),
    [
      ['A', 'B'],
      ['C', 'D'],
    ]
  );

  const byOrder = clusterStickerItems(sampleItems, { clusterMode: CLUSTER_MODES.BY_ORDER });
  assert.equal(byOrder.length, 2);
  assert.equal(byOrder[0].groupKey, 'DON-01');
  assert.deepEqual(
    byOrder[0].items.map((i) => i.id),
    ['A', 'C']
  );
  assert.equal(byOrder[1].groupKey, 'DON-02');
  assert.deepEqual(
    byOrder[1].items.map((i) => i.id),
    ['B', 'D']
  );

  // Full V1 adapter integration with BY_ORDER clustering
  const payload = {
    sourceFileName: 'order_cluster.pdf',
    pages: [
      makeSyntheticPage(1, 55, 55, 1.5),
      makeSyntheticPage(2, 55, 55, 1.5),
      makeSyntheticPage(3, 55, 55, 1.5),
    ],
  };
  const planOrder = await buildV1StickerTabPlan({
    v1Payload: payload,
    config: {
      paperSizeKey: 'D330x390',
      orientation: 'portrait',
      marginTop: 15,
      marginBottom: 15,
      marginLeft: 15,
      marginRight: 15,
      gutterX: 4,
      gutterY: 4,
      pontType: 'graphtec',
      collation: 'mixed',
      smartClusterMode: CLUSTER_MODES.BY_ORDER,
      orderIdByPage: { 1: 'DON-ALPHA', 2: 'DON-BETA', 3: 'DON-ALPHA' },
    },
    quantityByPage: { 1: 12, 2: 10, 3: 10 },
    pipelineCache: createStickerPipelineCache(),
  });

  assert.equal(planOrder.supported, true);
  assert.equal(planOrder.clusters.length, 2);
  assert.equal(planOrder.previewPlan.sheets.length, 2);
  assert.equal(planOrder.previewPlan.sheets[0].clusterLabel, 'Đơn hàng: DON-ALPHA');
  assert.equal(planOrder.previewPlan.sheets[1].clusterLabel, 'Đơn hàng: DON-BETA');

  const report = buildProductionReportV1(planOrder);
  assert.equal(report.clusters.length, 2);
  assert.ok(report.wasteMetrics.utilizationPct > 0);
  assert.ok(report.previewParitySignature);
});

test('P4-04: Regression hardening — allowRotationMode=none lock, truthful selectedOptionId, runCountByPage vs quantity, null-qty multi-model ranking', async () => {
  const baseCfg = {
    paperSizeKey: 'D330x390',
    orientation: 'portrait',
    marginTop: 15,
    marginBottom: 15,
    marginLeft: 15,
    marginRight: 15,
    gutterX: 4,
    gutterY: 4,
    pontType: 'graphtec',
    stickerLayout: 'optimal',
  };

  // 1. allowRotationMode='none' MUST keep 0° even when stickerLayout='optimal' and collation='stepAndRepeat'
  const locked0 = await buildV1StickerTabPlan({
    v1Payload: { sourceFileName: 'lock0.pdf', pages: [makeSyntheticPage(1, 42, 96, 1.5)] },
    config: { ...baseCfg, allowRotationMode: ROTATION_MODES.NONE, collation: 'stepAndRepeat' },
    pipelineCache: createStickerPipelineCache(),
  });
  assert.equal(locked0.supported, true);
  assert.equal(locked0.summary.rotationDeg, 0);
  assert.equal(locked0.summary.stickersPerSheet, 18);

  // 2. selectedOptionId MUST match the actual BatchPlan when collation='stepAndRepeat' (never highlight 3-sheet Mixed while rendering 5 sheets)
  const srPlan = await buildV1StickerTabPlan({
    v1Payload: {
      sourceFileName: 'sr_truth.pdf',
      pages: [makeSyntheticPage(1, 55, 55, 1.5), makeSyntheticPage(2, 55, 55, 1.5), makeSyntheticPage(3, 55, 55, 1.5)],
    },
    config: { ...baseCfg, collation: 'stepAndRepeat' },
    quantityByPage: { 1: 75, 2: 10, 3: 5 },
    pipelineCache: createStickerPipelineCache(),
  });
  assert.equal(srPlan.summary.physicalSheets, 5);
  const highlightedOpt = srPlan.smartOptions.find((o) => o.optionId === srPlan.selectedOptionId);
  assert.ok(highlightedOpt, 'Expected selectedOptionId to match S&R option');
  assert.equal(highlightedOpt.metrics.physicalSheetsNeeded, srPlan.summary.physicalSheets);

  // 3. runCountByPage (sheets) must NOT be confused with sticker quantity in smartOptions
  const runPlan = await buildV1StickerTabPlan({
    v1Payload: {
      sourceFileName: 'run_sheets.pdf',
      pages: [makeSyntheticPage(1, 55, 55, 1.5), makeSyntheticPage(2, 55, 55, 1.5)],
    },
    config: { ...baseCfg, collation: 'stepAndRepeat' },
    runCountByPage: { 1: 3, 2: 2 },
    pipelineCache: createStickerPipelineCache(),
  });
  assert.equal(runPlan.summary.physicalSheets, 5);
  assert.equal(runPlan.summary.totalStickers, 150);
  const matchedRunOpt = runPlan.smartOptions.find((o) => o.optionId === runPlan.selectedOptionId);
  assert.ok(matchedRunOpt, 'Expected selectedOptionId to match active 5-sheet S&R option');
  assert.equal(matchedRunOpt.metrics.physicalSheetsNeeded, 5);
  assert.equal(matchedRunOpt.metrics.totalProducedStickers, 150);

  // 4. Null-quantity multi-model batch must NOT recommend a sparse 2-sticker sheet (4.7% utilization) as #1
  const nullQtyPlan = await buildV1StickerTabPlan({
    v1Payload: {
      sourceFileName: 'null_qty.pdf',
      pages: [makeSyntheticPage(1, 55, 55, 1.5), makeSyntheticPage(2, 55, 55, 1.5)],
    },
    config: { ...baseCfg, collation: 'mixed' },
    pipelineCache: createStickerPipelineCache(),
  });
  assert.ok(
    nullQtyPlan.smartOptions[0].metrics.utilizationPct >= 65,
    `Expected high utilization (>=65%), got ${nullQtyPlan.smartOptions[0].metrics.utilizationPct}%`
  );
  assert.ok(nullQtyPlan.smartOptions[0].metrics.stickersPerSheet >= 30);
});

test('P4-05: UI source wiring audit & 17/17 LOCKED engine files SHA-256 unchanged', () => {
  const previewSrc = fs.readFileSync(path.join(ROOT, 'resources/js/components/PdfCanvasPreview.jsx'), 'utf8');
  const editorSrc = fs.readFileSync(path.join(ROOT, 'resources/js/components/PdfEditor.jsx'), 'utf8');

  for (const token of [
    'syncPaneScroll',
    'computeSyncedScrollPosition',
    'analyzeArtworkCutOverlay',
    'parityCheck',
    'PAIR_VIEW_MODES',
  ]) {
    assert.ok(previewSrc.includes(token), `PdfCanvasPreview.jsx missing token: ${token}`);
  }
  // Ensure wheel listener does not attach to both outer viewportRef and inner printPaneRef simultaneously in side-by-side mode
  assert.ok(
    previewSrc.includes('isSideBySide\n      ? [printPaneRef.current, cutPaneRef.current]'),
    'PdfCanvasPreview.jsx must avoid double wheel listener attachment in side-by-side mode'
  );

  for (const token of [
    'pairViewMode',
    'buildPairThumbnailsModel',
    'checkPreviewVsExportParity',
    'allowRotationMode',
    'smartClusterMode',
    'selectedImpositionOptionId',
    'orderIdByPage',
    'smartOptions',
    'wasteMetrics',
  ]) {
    assert.ok(editorSrc.includes(token), `PdfEditor.jsx missing token: ${token}`);
  }

  for (const [file, expectedHash] of Object.entries(LOCKED_17_BASELINES)) {
    const abs = path.join(ROOT, 'resources/js/engine', file);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    assert.equal(actualHash, expectedHash, `LOCKED file modified: ${file}`);
  }
});
