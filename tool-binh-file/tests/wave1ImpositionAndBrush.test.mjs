import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';

import {
  preprocessCanvasForTracing,
} from '../resources/js/engine/contourEditHelpers.js';
import {
  DUPLEX_MIRROR_AXES,
  mirrorPlacementsForBackSheet,
  buildDuplexMirrorStickerPdf,
} from '../resources/js/engine/duplexStickerExtension.js';
import {
  QUICK_IMPOSITION_PRESETS,
  computeSheetwiseLayout,
  splitSheetwisePlatesPdf,
} from '../resources/js/engine/quickImpositionPresets.js';
import {
  calculateSpineThicknessMm,
  computeSmythSewnSignatures,
  exportBookletCoverSpreadPdf,
  exportBackToBack180Pdf,
} from '../resources/js/engine/bookletCoverExtension.js';

const MM_TO_PT = 72 / 25.4;

async function makeSamplePdfBytes(pageCount = 4, wMm = 148, hMm = 210) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([wMm * MM_TO_PT, hMm * MM_TO_PT]);
    p.drawRectangle({
      x: 10 * MM_TO_PT,
      y: 10 * MM_TO_PT,
      width: (wMm - 20) * MM_TO_PT,
      height: (hMm - 20) * MM_TO_PT,
      color: rgb(0.1 + i * 0.1, 0.5, 0.4),
    });
  }
  return await doc.save();
}

test('W1-01 (Card 12): preprocessCanvasForTracing supports manual whiteThreshold & red/green brush mask', () => {
  // 4x1 RGBA buffer: [near-white 242, dark-art 20, erased-by-red 30, kept-by-green 250]
  const src = {
    width: 4,
    height: 1,
    data: new Uint8ClampedArray([
      242, 242, 242, 255, // px0: near-white -> cleared by whiteThreshold=235
      20, 40, 60, 255,    // px1: solid artwork -> untouched
      30, 30, 30, 255,    // px2: erased by red brush stroke -> becomes 255,255,255
      250, 250, 250, 255, // px3: kept by green brush stroke -> becomes dark <= 40
    ]),
  };
  const mask = {
    width: 4,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 0,
      0, 0, 0, 0,
      239, 68, 68, 255,  // Red erase
      34, 197, 94, 255,  // Green keep
    ]),
  };

  const out = preprocessCanvasForTracing(src, {
    shadowRemovalMode: 'keep',
    manualMaskCanvas: mask,
    whiteThreshold: 235,
  });

  // px0 cleared to pure white
  assert.equal(out.data[0], 255);
  assert.equal(out.data[1], 255);
  assert.equal(out.data[2], 255);
  // px1 untouched
  assert.equal(out.data[4], 20);
  // px2 erased to pure white
  assert.equal(out.data[8], 255);
  assert.equal(out.data[9], 255);
  // px3 forced foreground (dark <= 40)
  assert.ok(out.data[12] <= 40 && out.data[15] === 255);
});

test('W1-02 (Card 13): Duplex Mirror Sticker symmetry & PDF reflection matrix export', async () => {
  const placements = [
    { xMm: 15, yMm: 20, wMm: 40, hMm: 30 },
    { xMm: 60, yMm: 20, wMm: 40, hMm: 30 },
  ];
  const mirroredH = mirrorPlacementsForBackSheet(placements, 320, 330, DUPLEX_MIRROR_AXES.HORIZONTAL);
  assert.equal(mirroredH[0].xMm, 265); // 320 - 15 - 40 = 265
  assert.equal(mirroredH[0].yMm, 20);
  const mirroredV = mirrorPlacementsForBackSheet(placements, 320, 330, DUPLEX_MIRROR_AXES.VERTICAL);
  assert.equal(mirroredV[0].xMm, 15);
  assert.equal(mirroredV[0].yMm, 280); // 330 - 20 - 30 = 280

  const frontBytes = await makeSamplePdfBytes(2, 320, 330);
  const res = await buildDuplexMirrorStickerPdf({
    frontPdfBytes: frontBytes,
    mirrorAxis: DUPLEX_MIRROR_AXES.HORIZONTAL,
  });
  assert.equal(res.pairs, 2);
  assert.equal(res.pageCount, 4); // 2 Front + 2 Mirrored Back
  const outDoc = await PDFDocument.load(res.pdfBytes);
  assert.equal(outDoc.getPageCount(), 4);
  const { width, height } = outDoc.getPage(1).getSize();
  assert.ok(Math.abs(width / MM_TO_PT - 320) < 0.05);
  assert.ok(Math.abs(height / MM_TO_PT - 330) < 0.05);
});

test('W1-03 (Card 14): Quick R4/Grid presets & Sheetwise 2-plate layout + PDF split', async () => {
  const r4 = QUICK_IMPOSITION_PRESETS.find((p) => p.id === 'quick_r4');
  assert.ok(r4, 'Bình nhanh R4 preset must exist');
  assert.equal(r4.settings.cols, 2);
  assert.equal(r4.settings.rows, 2);

  // Sheetwise layout: 8 pages on 2x2 grid -> 1 Front plate + 1 Back plate with mirrored columns
  const sw = computeSheetwiseLayout(8, 2, 2);
  assert.equal(sw.plateACount, 1);
  assert.equal(sw.plateBCount, 1);
  assert.deepEqual(sw.sheets[0].pageIndices, [0, 2, 4, 6]);
  // Back row 0 [1, 3] mirrored -> [3, 1]; row 1 [5, 7] mirrored -> [7, 5]
  assert.deepEqual(sw.sheets[1].pageIndices, [3, 1, 7, 5]);

  const duplexBytes = await makeSamplePdfBytes(4, 325, 430);
  const split = await splitSheetwisePlatesPdf(duplexBytes);
  assert.equal(split.plateAPages, 2);
  assert.equal(split.plateBPages, 2);
  const docA = await PDFDocument.load(split.plateABytes);
  const docB = await PDFDocument.load(split.plateBBytes);
  assert.equal(docA.getPageCount(), 2);
  assert.equal(docB.getPageCount(), 2);
});

test('W1-04 (Card 15): Smyth-Sewn signatures, Perfect Bound Cover Spread (4 creases) & Back-to-Back 180°', async () => {
  const spine = calculateSpineThicknessMm({
    interiorPageCount: 120,
    paperThicknessMm: 0.1,
    glueAllowanceMm: 0.6,
  });
  assert.equal(spine.leaves, 60);
  assert.equal(spine.spineMm, 6.6);

  const smyth = computeSmythSewnSignatures(50, 16);
  assert.equal(smyth.signatureCount, 4);
  assert.equal(smyth.paddedPages, 64);
  assert.equal(smyth.signatures[0].collationMarkYmm, 20);
  assert.equal(smyth.signatures[1].collationMarkYmm, 24);

  const bookBytes = await makeSamplePdfBytes(8, 148, 210);
  const cover = await exportBookletCoverSpreadPdf({
    sourcePdfBytes: bookBytes,
    frontCoverPageIdx: 0,
    backCoverPageIdx: -1,
    spineMm: 8,
    bleedMm: 3,
    hingeOffsetMm: 6,
  });
  // Spread width = 148*2 + 8 + 3*2 = 310 mm; height = 210 + 6 = 216 mm
  assert.equal(cover.spreadWidthMm, 310);
  assert.equal(cover.spreadHeightMm, 216);
  assert.deepEqual(cover.creasePositionsMm, [145, 151, 159, 165]);
  const coverDoc = await PDFDocument.load(cover.pdfBytes);
  assert.equal(coverDoc.getPageCount(), 1);

  const rot = await exportBackToBack180Pdf(bookBytes);
  assert.deepEqual(rot.rotatedPages, [2, 4, 6, 8]);
  const rotDoc = await PDFDocument.load(rot.pdfBytes);
  assert.equal(rotDoc.getPage(0).getRotation().angle, 0);
  assert.equal(rotDoc.getPage(1).getRotation().angle, 180);
});
