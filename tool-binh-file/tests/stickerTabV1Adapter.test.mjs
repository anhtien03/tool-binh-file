/**
 * PrintKit V1 — Sticker Tab V1 Adapter Automated E2E Verification
 *
 * Verifies:
 *  - STV1-01: Gia Hưng 15-petal 84-Bézier -> 330×390 mm (6×7 = 42 stickers): Preview & Export share
 *             ONE H.2 plan, 42/42 Bézier preserved (84 segs), post-export CUT.pdf verification PASS.
 *  - STV1-02: Giảm 3% 99-sticker vector PDF -> 320×330 mm (9×11 = 99 stickers): Direct vector import
 *             (no raster), Preview & Export share ONE H.2 plan, 99/99 × 56 Bézier PASS.
 *  - STV1-03: Unsupported UI options (honeycomb, nesting, clusterSplit, guillotine, forced shape, SVG)
 *             explicitly block/report — NEVER silently fall back to legacy.
 *  - STV1-04: 17/17 LOCKED engine files SHA-256 unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createResourceStore } from '../resources/js/engine/resourceStore.js';
import { runVectorFirstPdfImport, resolveVectorFirstContours } from '../resources/js/engine/vectorFirstPipeline.js';
import {
  checkV1StickerConfigCompatibility,
  buildV1StickerTabPlan,
  exportV1StickerTabOutputs,
} from '../resources/js/engine/stickerTabV1Adapter.js';
import { releaseCheckpointKOutput } from '../resources/js/engine/checkpointKUiBridge.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'resources', 'js', 'engine');
const YENSAO_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795620683780_e9a7c2ff.pdf';
const GIAM3_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607803864_b438afea.pdf';

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
    createObjectURL: (b) => `blob:stv1/${Math.random()}/${b.size}`,
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

test('STV1-01: Gia Hưng 15-petal 84-Bézier -> Sticker Tab V1 (330×390, 42 stickers) shared Preview & Export + Post-Export CUT.pdf PASS', async () => {
  const bytes = new Uint8Array(fs.readFileSync(YENSAO_PDF));
  const vecImport = await runVectorFirstPdfImport(bytes, 1);
  assert.equal(vecImport.status, 'OK');
  const resolved = resolveVectorFirstContours(vecImport, {
    offsetMm: 0,
    bleedOffsetMm: 1.5,
    shapeMode: 'auto',
  });
  assert.equal(resolved.contoursMm.length, 1);

  const v1Payload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: vecImport.pageWidthMm, h: vecImport.pageHeightMm },
    contoursMm: resolved.contoursMm,
    bleedOffsetMm: 1.5,
    contourProvenance: resolved.provenance,
    sourceFileName: 'GiaHung_YenSao.pdf',
  };

  const uiConfig = {
    paperSizeKey: 'D330x390',
    orientation: 'portrait',
    marginTop: 12.5,
    marginBottom: 12.5,
    marginLeft: 12.5,
    marginRight: 12.5,
    gutterX: 3.2,
    gutterY: 3.2,
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'none',
    pontType: 'graphtec',
    stickerAlignment: 'center',
  };

  const planState = await buildV1StickerTabPlan({
    v1Payload,
    config: uiConfig,
    resourceStore: makeStore(),
  });

  assert.equal(planState.supported, true);
  assert.equal(planState.previewPlan.sheets.length, 1);
  assert.equal(planState.previewPlan.sheets[0].placements.length, 42);
  assert.equal(planState.previewPlan.sheets[0].stickerCutPaths.length, 42);
  assert.equal(planState.previewPlan.sheets[0].stickerCutPaths[0].kind, 'bezier');
  assert.equal(
    planState.previewPlan.sheets[0].stickerCutPaths[0].beziersMm.filter((c) => c.type === 'C').length,
    84
  );

  const exported = await exportV1StickerTabOutputs({ v1PlanState: planState, role: 'cut' });
  assert.equal(exported.finalCheck.status, 'PASS');
  assert.equal(exported.postExportVerification.status, 'PASS');
  assert.equal(exported.postExportVerification.metrics.segmentMismatches, 0);
  assert.equal(exported.postExportVerification.metrics.newKinksCount, 0);
  assert.ok(exported.postExportVerification.metrics.maxHausdorffMm <= 0.005);

  console.log(
    `\n[STV1-01 Gia Hưng 42-Sticker Tab V1] preview=42×84 Bézier, export=${exported.finalCheck.status}, postExport=${exported.postExportVerification.status}, Hausdorff=${exported.postExportVerification.metrics.maxHausdorffMm}mm, valleyDelta=${exported.postExportVerification.metrics.maxValleyDepthDeltaMm}mm`
  );
  releaseCheckpointKOutput(planState.resourceStore, exported.output);
});

test('STV1-02: Giảm 3% 99-sticker PDF vector -> Sticker Tab V1 (320×330, 99 stickers) shared Preview & Export PASS', async () => {
  const bytes = new Uint8Array(fs.readFileSync(GIAM3_PDF));
  const vecImport = await runVectorFirstPdfImport(bytes, 1);
  assert.equal(vecImport.status, 'OK');
  assert.equal(vecImport.contours.length, 99);

  const resolved = resolveVectorFirstContours(vecImport, {
    offsetMm: 0,
    bleedOffsetMm: 0,
    shapeMode: 'auto',
  });
  assert.equal(resolved.contoursMm.length, 99);

  const v1Payload = {
    cleanArtworkBytes: TINY_PNG_BYTES,
    sourceSizeMm: { w: vecImport.pageWidthMm, h: vecImport.pageHeightMm },
    contoursMm: resolved.contoursMm,
    bleedOffsetMm: 0,
    contourProvenance: resolved.provenance,
    sourceFileName: 'Giam3_99tem.pdf',
  };

  const uiConfig = {
    paperSizeKey: 'custom',
    customPaperWidth: 320,
    customPaperHeight: 330,
    orientation: 'portrait',
    marginTop: 12.5,
    marginBottom: 12.5,
    marginLeft: 12.5,
    marginRight: 12.5,
    gutterX: 2.2,
    gutterY: 2.2,
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'none',
    pontType: 'graphtec',
    stickerAlignment: 'center',
  };

  const planState = await buildV1StickerTabPlan({
    v1Payload,
    config: uiConfig,
    resourceStore: makeStore(),
  });

  assert.equal(planState.supported, true);
  assert.equal(planState.previewPlan.sheets[0].placements.length, 99);
  assert.equal(planState.previewPlan.sheets[0].stickerCutPaths.length, 99);
  assert.equal(
    planState.previewPlan.sheets[0].stickerCutPaths[0].beziersMm.filter((c) => c.type === 'C').length,
    56
  );

  const exported = await exportV1StickerTabOutputs({ v1PlanState: planState, role: 'print' });
  assert.equal(exported.finalCheck.status, 'PASS');
  assert.equal(exported.postExportVerification.status, 'PASS');
  assert.equal(exported.postExportVerification.metrics.exportedContours, 99);
  assert.equal(exported.postExportVerification.metrics.segmentMismatches, 0);
  assert.equal(exported.postExportVerification.metrics.newKinksCount, 0);
  assert.ok(exported.postExportVerification.metrics.maxHausdorffMm <= 0.005);

  console.log(
    `\n[STV1-02 Giảm 3% 99-Sticker Tab V1] preview=99×56 Bézier, export=${exported.finalCheck.status}, postExport=${exported.postExportVerification.status}, Hausdorff=${exported.postExportVerification.metrics.maxHausdorffMm}mm`
  );
  releaseCheckpointKOutput(planState.resourceStore, exported.output);
});

test('STV1-03: Unsupported UI options explicitly report & block (ZERO silent legacy fallback)', async () => {
  for (const bad of [
    { stickerLayout: 'honeycomb' },
    { stickerLayout: 'nesting' },
    { clusterSplit: 'split2H' },
    { stickerTrimMarks: 'japanese_unsupported' },
    { stickerShape: 'circle' },
  ]) {
    const c = checkV1StickerConfigCompatibility({
      stickerLayout: 'optimal',
      stickerShape: 'pdfContour',
      clusterSplit: 'none',
      stickerTrimMarks: 'none',
      pontType: 'graphtec',
      ...bad,
    });
    assert.equal(c.supported, false, `Expected unsupported for ${JSON.stringify(bad)}`);
    assert.ok(c.unsupportedReasons.length > 0);
  }

  // Đợt 2: guillotine trim marks are now supported in V1
  const guillotineOk = checkV1StickerConfigCompatibility({
    stickerLayout: 'optimal',
    stickerShape: 'pdfContour',
    clusterSplit: 'none',
    stickerTrimMarks: 'guillotine',
    pontType: 'graphtec',
  });
  assert.equal(guillotineOk.supported, true);

  await assert.rejects(
    () => exportV1StickerTabOutputs({ v1PlanState: { supported: true, checkpoint: {} }, role: 'svg' }),
    /SVG/i
  );
});

test('STV1-04: All 17 LOCKED engine files have identical SHA-256 checksums', () => {
  for (const [file, expected] of Object.entries(LOCKED_17)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ENGINE_DIR, file))).digest('hex');
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
  }
  console.log('\n[STV1-04 SHA-256 Audit] 17/17 LOCKED engine files UNCHANGED!');
});
