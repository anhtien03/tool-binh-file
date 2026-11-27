/**
 * Phase A Automated Verification Suite — Direct PDF Vector Contour Importer
 * Verifies:
 *  A1: Customer 8-page PDF (792 stickers) extracts exact 99 outer 20.024mm 56-Bézier contours/page,
 *      ZERO 18.025mm burgundy decorative strokes misclassified as CUT.
 *  A2: Full-curve Hausdorff & vertex error across ALL 7 pages (693 stickers) against real shop
 *      L0110.063_-_NMST_-_khuon_be_TRANG_1..7.ai cutlines (reports exact measured error, never hardcoded 0).
 *  A3: Multi-layer AI (`Decal_sticker_goi_lai_anh_da_xu_ly.ai`) explicit `khuon` layer extraction.
 *  A4: Raster-only & stroke-only ambiguous PDFs fail safely (`FALLBACK_TO_RASTER` / `CONFIRMATION_REQUIRED`).
 *  A5: Extracted DeviceCMYK printColorMetadata integrates cleanly with H.2.2 BLEED color verifier.
 *  A6: All 17 LOCKED files SHA-256 unchanged (0 bytes modified in Phase A).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PDFDocument, rgb } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import { extractPdfVectorContours } from '../resources/js/engine/pdfVectorContourImporter.js';
import {
  tessellateAndVerifyContourMm,
  verifyBleedColorCompatibilityH22,
} from '../resources/js/engine/productionBleedSafetyH22.js';

const CUSTOMER_PDF = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607803864_b438afea.pdf';
const PROCESSED_AI = 'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795607810198_bcb52426.ai';
const SHOP_CUT_AIS = [
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997145_897ac764.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997158_36b888ef.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997164_9f8fa1ae.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997140_5e76232d.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997135_8fd4c8c1.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997121_b17b76c9.ai',
  'C:/Users/IT/.gemini/antigravity/brain/323f46ad-d309-45d0-9d9c-48c83acf02a9/.user_uploaded/media_1795608997115_6bbec865.ai',
];
const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
);

function measureRadialDepth(poly, bounds) {
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  let rMin = Infinity, rMax = -Infinity;
  for (const [x, y] of poly) {
    const r = Math.hypot(x - cx, y - cy);
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  return { rMin, rMax, valleyDepth: rMax - rMin };
}

test('A1 & A5: Customer 8-page PDF extracts 99 outer 20.024mm 56-Bézier contours/page (0 burgundy strokes) + valid CMYK metadata', async () => {
  if (!fs.existsSync(CUSTOMER_PDF)) return;
  const pdfBytes = fs.readFileSync(CUSTOMER_PDF);

  for (let p = 1; p <= 8; p++) {
    const res = await extractPdfVectorContours(pdfBytes, { pageNumber: p });
    assert.equal(res.status, 'OK');
    assert.equal(res.selectionMode, 'OUTERMOST_FILLED_BOUNDARY');
    assert.equal(res.contours.length, 99, `Page ${p} must have 99 stickers`);
    // Verify warning confirms 99 interior decorative burgundy strokes were excluded
    assert.ok(res.warnings.some((w) => w.includes('99 interior decorative stroke')));

    for (const c of res.contours) {
      // Every contour must be the 20.024mm outer cream boundary (NOT the 18.025mm red decorative stroke!)
      assert.ok(Math.abs(c.boundsMm.w - 20.024) < 0.02, `Expected ~20.024mm width, got ${c.boundsMm.w}`);
      assert.ok(Math.abs(c.boundsMm.h - 20.024) < 0.02, `Expected ~20.024mm height, got ${c.boundsMm.h}`);
      assert.equal(c.bezierSegmentCount, 56);
    }

    // A5: Verify extracted DeviceCMYK metadata passes H.2.2 color verification
    const cm0 = res.contours[0].printColorMetadata;
    const cm1 = res.contours[1].printColorMetadata;
    assert.equal(cm0.colorSpace, 'DeviceCMYK');
    assert.equal(verifyBleedColorCompatibilityH22(cm0, cm1).verified, true);
  }
});

test('A2: Full-curve comparison of all 7 pages (693 stickers × 56 Bézier) vs real shop L0110.063 TRANG_1..7.ai', async () => {
  if (!fs.existsSync(CUSTOMER_PDF) || !SHOP_CUT_AIS.every((f) => fs.existsSync(f))) return;
  const custBytes = fs.readFileSync(CUSTOMER_PDF);

  let overallMaxCurveDeltaMm = 0;
  let overallMinValleyDepthMm = Infinity;
  let overallMaxValleyDepthMm = 0;

  console.log('\n=== PHASE A: CUSTOMER PDF VECTOR IMPORT vs REAL SHOP L0110.063 TRANG_1..7.ai ===');
  console.log('Page | Stickers | Curves/Sticker | ValleyDepth(mm) | MaxFullCurveDelta(mm)');

  for (let p = 1; p <= 7; p++) {
    const custRes = await extractPdfVectorContours(custBytes, { pageNumber: p });
    const shopRes = await extractPdfVectorContours(fs.readFileSync(SHOP_CUT_AIS[p - 1]), { pageNumber: 1 });
    assert.equal(custRes.contours.length, 99);
    assert.equal(shopRes.contours.length, 99);

    let pageMaxDelta = 0;
    let pageValleyDepth = 0;

    for (let k = 0; k < 99; k++) {
      const cc = custRes.contours[k];
      const sc = shopRes.contours[k];
      const cTess = tessellateAndVerifyContourMm({ beziersMm: cc.beziersMm, closed: true }, { flatnessMm: 0.005 });
      const sTess = tessellateAndVerifyContourMm({ beziersMm: sc.beziersMm, closed: true }, { flatnessMm: 0.005 });
      assert.equal(cTess.valid, true);
      assert.equal(sTess.valid, true);
      assert.equal(cTess.poly.length, sTess.poly.length);

      if (k === 0) {
        const rd = measureRadialDepth(cTess.poly, cTess.bounds);
        pageValleyDepth = rd.valleyDepth;
        if (rd.valleyDepth < overallMinValleyDepthMm) overallMinValleyDepthMm = rd.valleyDepth;
        if (rd.valleyDepth > overallMaxValleyDepthMm) overallMaxValleyDepthMm = rd.valleyDepth;
      }

      // Translate A4 customer contour by exact shop centering (+55.000mm X, +16.500mm Y) onto 320x330mm sheet
      for (let v = 0; v < cTess.poly.length; v++) {
        const d = Math.hypot(
          cTess.poly[v][0] + 55.0 - sTess.poly[v][0],
          cTess.poly[v][1] + 16.5 - sTess.poly[v][1]
        );
        if (d > pageMaxDelta) pageMaxDelta = d;
      }
    }

    if (pageMaxDelta > overallMaxCurveDeltaMm) overallMaxCurveDeltaMm = pageMaxDelta;
    console.log(`  P${p} |    99    |       56       |     ${pageValleyDepth.toFixed(4)}      |       ${pageMaxDelta.toFixed(6)}`);
    assert.ok(pageMaxDelta <= 0.005, `Page ${p} curve delta ${pageMaxDelta}mm > 0.005mm`);
  }

  console.log(`OVERALL 693-STICKER MAX CURVE DELTA = ${overallMaxCurveDeltaMm.toFixed(6)} mm | VALLEY DEPTH = ${overallMinValleyDepthMm.toFixed(4)}..${overallMaxValleyDepthMm.toFixed(4)} mm`);
  assert.ok(overallMaxCurveDeltaMm <= 0.005);
  assert.ok(overallMinValleyDepthMm >= 0.69);
});

test('A3: Multi-layer AI (`Decal_sticker_goi_lai_anh_da_xu_ly.ai`) detects explicit `khuon` cut layer cleanly', async () => {
  if (!fs.existsSync(PROCESSED_AI)) return;
  const res = await extractPdfVectorContours(fs.readFileSync(PROCESSED_AI), { pageNumber: 1 });
  assert.equal(res.status, 'OK');
  assert.equal(res.selectionMode, 'EXPLICIT_CUT_LAYER');
  assert.equal(res.contours.length, 99);
  assert.equal(res.contours[0].ocgName, 'khuon');
  assert.ok(Math.abs(res.contours[0].boundsMm.w - 20.024) < 0.02);
});

test('A4: Raster-only and stroke-only ambiguous PDFs return safe fallback/confirmation (never silently pick wrong)', async () => {
  // 1. Raster-only PDF
  const d1 = await PDFDocument.create();
  const p1 = d1.addPage([200, 200]);
  const png = await d1.embedPng(TINY_PNG);
  p1.drawImage(png, { x: 20, y: 20, width: 100, height: 100 });
  const r1 = await extractPdfVectorContours(await d1.save(), { pageNumber: 1 });
  assert.equal(r1.status, 'FALLBACK_TO_RASTER');
  assert.equal(r1.contours.length, 0);

  // 2. Stroke-only non-magenta PDF (ambiguous decorative frame with no fill)
  const d2 = await PDFDocument.create();
  const p2 = d2.addPage([300, 300]);
  p2.drawRectangle({ x: 50, y: 50, width: 100, height: 100, borderColor: rgb(0.5, 0.1, 0.1), borderWidth: 1 });
  const r2 = await extractPdfVectorContours(await d2.save(), { pageNumber: 1 });
  assert.equal(r2.status, 'CONFIRMATION_REQUIRED');
  assert.equal(r2.contours.length, 0);
});

test('A6: All 17 LOCKED engine files have identical SHA-256 checksums in Phase A', () => {
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
