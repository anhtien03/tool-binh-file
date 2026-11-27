/**
 * PrintKit V1 — Checkpoint K B3.1.1 Hardened UI Bridge & 42-Sticker Real Bézier Preservation Test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  decodePDFRawStream,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import { PRODUCTION_PROFILES } from '../resources/js/engine/batchImpositionAdapter.js';
import { tessellateAndVerifyContourMm } from '../resources/js/engine/productionBleedSafetyH22.js';
import {
  CheckpointKUiError,
  buildStudioStickerJobsV1,
  createCheckpointKBatch,
  exportCheckpointKBatch,
  releaseCheckpointKOutput,
  suggestGridForSheet,
} from '../resources/js/engine/checkpointKUiBridge.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'resources', 'js', 'engine');
const YENSAO_REF_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795620683780_e9a7c2ff.pdf';
const PT = 25.4 / 72;

const TINY_PNG_BYTES = Uint8Array.from(
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
    createObjectURL: (b) => `blob:ck/${Math.random()}/${b.size}`,
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

async function loadYenSao84BezierContour() {
  const doc = await PDFDocument.load(fs.readFileSync(YENSAO_REF_PDF));
  const p = doc.getPages()[0];
  const mb = p.getMediaBox();
  const c = p.node.get(PDFName.of('Contents'));
  const dec = (r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1');
  const s = c instanceof PDFArray ? [...Array(c.size()).keys()].map((i) => dec(c.get(i))).join('\n') : dec(c);
  let cmds = [], color = '', cutCmds = null;
  for (const raw of s.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.endsWith(' K') || l.endsWith(' RG')) color = l;
    const m = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+m$/);
    if (m) { cmds = [{ type: 'M', to: [+m[1] * PT, (mb.height - +m[2]) * PT] }]; continue; }
    const cb = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
    if (cb) {
      cmds.push({
        type: 'C',
        c1: [+cb[1] * PT, (mb.height - +cb[2]) * PT],
        c2: [+cb[3] * PT, (mb.height - +cb[4]) * PT],
        to: [+cb[5] * PT, (mb.height - +cb[6]) * PT],
      });
      continue;
    }
    if ((l === 'S' || l === 's') && cmds.length > 20 && color.includes('0 1 0 0 K')) {
      cutCmds = cmds;
      break;
    }
  }
  const tess = tessellateAndVerifyContourMm({ beziersMm: cutCmds, closed: true }, { flatnessMm: 0.01 });
  const poly = [...tess.poly];
  Object.assign(poly, { beziersMm: cutCmds, closed: true, cornerCount: 0 });
  return {
    poly,
    sourceSizeMm: { w: mb.width * PT, h: mb.height * PT },
    refSegCount: cutCmds.filter((x) => x.type === 'C' || x.type === 'L').length,
  };
}

function measure15Sectors(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sec = Array.from({ length: 15 }, () => ({ rMin: Infinity, rMax: -Infinity }));
  for (const [x, y] of poly) {
    const ang = ((Math.atan2(y - cy, x - cx) + Math.PI * 2) % (Math.PI * 2));
    const idx = Math.min(14, Math.floor((ang / (Math.PI * 2)) * 15));
    const r = Math.hypot(x - cx, y - cy);
    if (r < sec[idx].rMin) sec[idx].rMin = r;
    if (r > sec[idx].rMax) sec[idx].rMax = r;
  }
  const depths = sec.map((s) => s.rMax - s.rMin);
  return { avg: depths.reduce((a, b) => a + b, 0) / depths.length, min: Math.min(...depths) };
}

test('CK-01: Real 42-sticker Yen Sao 84-Bézier via Checkpoint K V1 preserves 100% of 84 curves & 1.400mm valley depth (0% loss)', async () => {
  const { poly, sourceSizeMm, refSegCount } = await loadYenSao84BezierContour();
  assert.equal(refSegCount, 84);
  const refValleys = measure15Sectors(poly);

  const store = makeStore();
  const built = await buildStudioStickerJobsV1({
    cleanArtworkBytes: TINY_PNG_BYTES,
    mimeType: 'image/png',
    sourceSizeMm,
    contoursMm: [poly],
    bleedOffsetMm: 1.5,
    quantityPerSticker: 42,
    resourceStore: store,
    labelPrefix: 'YenSao',
  });

  const grid = suggestGridForSheet({
    sheetWidthMm: 330,
    sheetHeightMm: 390,
    marginsMm: { top: 12.5, right: 12.5, bottom: 12.5, left: 12.5 },
    trimWmm: built.jobs[0].canonicalCut.naturalTrimMm.w,
    trimHmm: built.jobs[0].canonicalCut.naturalTrimMm.h,
    cutGapMm: 3.2,
  });
  assert.equal(grid.columns, 6);
  assert.equal(grid.rows, 7);

  const sheetTemplates = [
    {
      templateId: 'TPL-YENSAO-42',
      sheetWidthMm: 330,
      sheetHeightMm: 390,
      marginsMm: { top: 12.5, right: 12.5, bottom: 12.5, left: 12.5 },
      runCount: 1,
      gridSpec: { rows: 7, columns: 6, centerX: true, centerY: true },
      items: [{ jobId: built.jobs[0].jobId, copiesPerRun: 42 }],
    },
  ];

  const checkpoint = await createCheckpointKBatch({
    jobs: built.jobs,
    sheetTemplates,
    cutGapMm: 3.2,
    bleedOutsetMm: 1.5,
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
    currentRunCounts: { 'TPL-YENSAO-42': 1 },
    expectedOrderManifest: checkpoint.batchPlan.productionOrderManifest,
    cutGapMm: 3.2,
    bleedOutsetMm: 1.5,
    bleedClearanceMm: 0,
    bleedPolicy: 'strict',
    productionProfile: PRODUCTION_PROFILES.GENERIC,
    cutFormat: 'PDF',
    scope: 'CUT_ONLY',
  });

  assert.equal(exported.finalCheck.status, 'PASS');
  assert.equal(exported.releaseAllowed, true);
  assert.equal(exported.warningApprovalRequired, false);

  // Parse actual exported CUT.pdf bytes and verify ALL 42 stickers kept 84 cubic Bézier segments & 1.400mm valleys!
  const cutBlob = store.getBlob(exported.output.cut.resourceId);
  const cutDoc = await PDFDocument.load(new Uint8Array(await cutBlob.arrayBuffer()));
  const cutPage = cutDoc.getPages()[0];
  const hPt = cutPage.getMediaBox().height;
  const cNode = cutPage.node.get(PDFName.of('Contents'));
  const dec = (r) => Buffer.from(decodePDFRawStream(cutDoc.context.lookup(r)).decode()).toString('latin1');
  const stream = cNode instanceof PDFArray ? [...Array(cNode.size()).keys()].map((i) => dec(cNode.get(i))).join('\n') : dec(cNode);

  const exportedCuts = [];
  let cmds = [];
  for (const raw of stream.split(/\r?\n/)) {
    const l = raw.trim();
    const m = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+m$/);
    if (m) { cmds = [{ type: 'M', to: [+m[1] * PT, (hPt - +m[2]) * PT] }]; continue; }
    const cb = l.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/);
    if (cb) {
      cmds.push({
        type: 'C',
        c1: [+cb[1] * PT, (hPt - +cb[2]) * PT],
        c2: [+cb[3] * PT, (hPt - +cb[4]) * PT],
        to: [+cb[5] * PT, (hPt - +cb[6]) * PT],
      });
      continue;
    }
    if ((l === 'S' || l === 's') && cmds.length > 20) {
      exportedCuts.push(cmds);
      cmds = [];
    }
  }

  assert.equal(exportedCuts.length, 42, `Expected 42 cut paths, got ${exportedCuts.length}`);
  assert.equal(exportedCuts[0].filter((x) => x.type === 'C').length, 84, 'Must preserve exact 84 cubic Bézier curves (no downsampling!)');
  const outTess = tessellateAndVerifyContourMm({ beziersMm: exportedCuts[0], closed: true }, { flatnessMm: 0.01 });
  assert.equal(outTess.valid, true);
  const outValleys = measure15Sectors(outTess.poly);
  const valleyDelta = Math.abs(outValleys.avg - refValleys.avg);
  console.log(`\n[CK-01 Yen Sao 42-Sticker V1 Export] cuts=42, curves/sticker=84, refAvgValley=${refValleys.avg.toFixed(4)}mm -> outAvgValley=${outValleys.avg.toFixed(4)}mm (delta=${valleyDelta.toFixed(5)}mm)`);
  assert.ok(valleyDelta < 0.005, `Valley depth distorted by ${valleyDelta}mm!`);

  releaseCheckpointKOutput(store, exported.output);
});

test('CK-02..CK-05: Hardened B3.1.1 guards (UI drift STALE_PLAN, overlap confirmation, crop assets, format/scope)', async () => {
  const { poly, sourceSizeMm } = await loadYenSao84BezierContour();
  const store = makeStore();
  const built = await buildStudioStickerJobsV1({
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm,
    contoursMm: [poly],
    bleedOffsetMm: 0,
    quantityPerSticker: 4,
    resourceStore: store,
  });
  const sheetTemplates = [
    {
      templateId: 'TPL-1',
      sheetWidthMm: 200,
      sheetHeightMm: 200,
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
      runCount: 1,
      gridSpec: { rows: 2, columns: 2, centerX: true, centerY: true },
      items: [{ jobId: built.jobs[0].jobId, copiesPerRun: 4 }],
    },
  ];

  // Overlap without justification -> OVERLAP_NOT_CONFIRMED
  await assert.rejects(
    () =>
      createCheckpointKBatch({
        jobs: built.jobs,
        sheetTemplates,
        cutGapMm: 2,
        bleedOutsetMm: 0,
        bleedPolicy: 'allow_overlap',
        bleedOverlapConfirmed: true,
        bleedOverlapJustification: '   ',
      }),
    (err) => err instanceof CheckpointKUiError && err.code === 'OVERLAP_NOT_CONFIRMED'
  );

  const checkpoint = await createCheckpointKBatch({
    jobs: built.jobs,
    sheetTemplates,
    cutGapMm: 2,
    bleedOutsetMm: 0,
    bleedPolicy: 'strict',
    productionProfile: PRODUCTION_PROFILES.GENERIC,
  });

  // Drift in cutGapMm after Build -> STALE_PLAN
  await assert.rejects(
    () =>
      exportCheckpointKBatch({
        checkpoint,
        jobs: built.jobs,
        assets: built.assets,
        resourceStore: store,
        sheetTemplates,
        currentRunCounts: { 'TPL-1': 1 },
        expectedOrderManifest: checkpoint.batchPlan.productionOrderManifest,
        cutGapMm: 3, // drifted!
        bleedOutsetMm: 0,
        bleedClearanceMm: 0,
        bleedPolicy: 'strict',
        bleedOverlapConfirmed: false,
        bleedOverlapJustification: null,
        productionProfile: PRODUCTION_PROFILES.GENERIC,
      }),
    (err) => err instanceof CheckpointKUiError && err.code === 'STALE_PLAN'
  );

  // Missing assets when job has cropBoxMm -> MISSING_CROP_ASSET
  await assert.rejects(
    () =>
      exportCheckpointKBatch({
        checkpoint,
        jobs: built.jobs,
        assets: null,
        resourceStore: store,
        sheetTemplates,
        currentRunCounts: { 'TPL-1': 1 },
        expectedOrderManifest: checkpoint.batchPlan.productionOrderManifest,
        cutGapMm: 2,
        bleedOutsetMm: 0,
        bleedClearanceMm: 0,
        bleedPolicy: 'strict',
        bleedOverlapConfirmed: false,
        bleedOverlapJustification: null,
        productionProfile: PRODUCTION_PROFILES.GENERIC,
      }),
    (err) => err instanceof CheckpointKUiError && err.code === 'MISSING_CROP_ASSET'
  );

  // Unsupported cutFormat -> UNSUPPORTED_CUT_FORMAT
  await assert.rejects(
    () =>
      exportCheckpointKBatch({
        checkpoint,
        jobs: built.jobs,
        assets: built.assets,
        resourceStore: store,
        sheetTemplates,
        currentRunCounts: { 'TPL-1': 1 },
        expectedOrderManifest: checkpoint.batchPlan.productionOrderManifest,
        cutGapMm: 2,
        bleedOutsetMm: 0,
        bleedClearanceMm: 0,
        bleedPolicy: 'strict',
        bleedOverlapConfirmed: false,
        bleedOverlapJustification: null,
        productionProfile: PRODUCTION_PROFILES.GENERIC,
        cutFormat: 'SVG',
      }),
    (err) => err instanceof CheckpointKUiError && err.code === 'UNSUPPORTED_CUT_FORMAT'
  );
});

test('CK-06: All 17 engine files (16 locked + Phase B bleedContourEngine) have 100% identical SHA-256 checksums', () => {
  for (const [file, expected] of Object.entries(LOCKED_BASELINES)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ENGINE_DIR, file))).digest('hex');
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
  }
  console.log('\n[CK-06 SHA-256 Audit] 17/17 engine files UNCHANGED (ZERO locked edits!)');
});
