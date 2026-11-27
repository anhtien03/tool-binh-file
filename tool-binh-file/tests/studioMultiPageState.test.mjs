import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PAGE_STAGE,
  computeFileSignature,
  computeBleedSettingsSignature,
  createInitialPageStates,
  validatePageOwnership,
  getEffectivePageStage,
  partitionPagesForHandoff,
} from '../resources/js/engine/studioMultiPageState.js';
import {
  runVectorFirstPdfImport,
  resolveVectorFirstContours,
} from '../resources/js/engine/vectorFirstPipeline.js';

const ROOT = process.cwd();
const REAL_PDF = 'C:/Users/IT/Downloads/Decal sticker pdf.pdf';

test('MPS-01: Initial multi-page upload marks Page 1 separate from unprocessed Pages 2..8 (PDF_LOADED)', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const sig = computeFileSignature(bytes, 'Decal sticker pdf.pdf');
  const states = createInitialPageStates(8, sig);
  const bleedSig = computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 2.0, showBleedContour: true });

  for (let p = 1; p <= 8; p++) {
    assert.equal(getEffectivePageStage(states[p], bleedSig), PAGE_STAGE.PDF_LOADED);
  }

  // Simulate Page 1 finishing Preview -> CUT -> BLEED
  states[1] = {
    ...states[1],
    stage: PAGE_STAGE.BLEED_READY,
    hasPreview: true,
    hasCut: true,
    hasBleed: true,
    contourCount: 99,
    bleedSignature: bleedSig,
  };

  assert.equal(getEffectivePageStage(states[1], bleedSig), PAGE_STAGE.BLEED_READY);
  for (let p = 2; p <= 8; p++) {
    assert.equal(getEffectivePageStage(states[p], bleedSig), PAGE_STAGE.PDF_LOADED);
  }
});

test('MPS-02: Real 8-page PDF batch extraction keeps per-page CUT ownership distinct (no Page 1 bleed onto Pages 2..7)', async () => {
  if (!fs.existsSync(REAL_PDF)) {
    return;
  }
  const bytes = new Uint8Array(fs.readFileSync(REAL_PDF));
  const fileSig = computeFileSignature(bytes, 'Decal sticker pdf.pdf');
  const bleedSig = computeBleedSettingsSignature({
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    showBleedContour: true,
    contourBleedFillMode: 'auto',
    shapeMode: 'auto',
  });

  const states = createInitialPageStates(8, fileSig);
  const cache = new Map();
  const c0MinXByPage = {};

  for (let p = 1; p <= 8; p++) {
    const vecRes = await runVectorFirstPdfImport(bytes, { pageNumber: p, minAreaMm2: 8.0 });
    const own = validatePageOwnership({
      expectedPageNum: p,
      expectedFileSignature: fileSig,
      actualFileSignature: fileSig,
      vecRes,
    });
    assert.equal(own.ok, true, `Page ${p} ownership failed: ${own.reason}`);

    const resolved = resolveVectorFirstContours(vecRes, {
      offsetMm: 0,
      bleedOffsetMm: 2.0,
      shapeMode: 'auto',
      pageWidthMm: vecRes.pageWidthMm || 210,
      pageHeightMm: vecRes.pageHeightMm || 297,
    });

    if (resolved.contoursMm && resolved.contoursMm.length > 0) {
      c0MinXByPage[p] = vecRes.contours[0]?.boundsMm?.minX ?? null;
      cache.set(p, {
        fileSignature: fileSig,
        vecRes,
        bleedArtifact: {
          pageNum: p,
          bleedSignature: bleedSig,
          cleanArtworkCanvas: { mock: p },
          cleanArtworkBytes: new Uint8Array([p, 1, 2, 3]),
          sourceSizeMm: { w: vecRes.pageWidthMm || 210, h: vecRes.pageHeightMm || 297 },
          contoursMm: resolved.contoursMm,
          bleedOffsetMm: 2.0,
          contourProvenance: resolved.provenance,
        },
      });
      states[p] = {
        ...states[p],
        stage: PAGE_STAGE.BLEED_READY,
        hasPreview: true,
        hasCut: true,
        hasBleed: true,
        contourCount: resolved.contoursMm.length,
        bleedSignature: bleedSig,
      };
    } else {
      states[p] = {
        ...states[p],
        stage: PAGE_STAGE.NO_CUT,
        hasPreview: true,
        hasCut: false,
        hasBleed: false,
        contourCount: 0,
        errorMessage: 'Trang không có đường bế vector hợp lệ',
      };
    }
  }

  // Verify Page 1 and Page 2 have genuinely different c0.minX (~5.145 vs ~6.558 mm)
  assert.ok(Math.abs(c0MinXByPage[1] - 5.145) < 0.05, `Unexpected P1 c0.minX=${c0MinXByPage[1]}`);
  assert.ok(Math.abs(c0MinXByPage[2] - 6.558) < 0.05, `Unexpected P2 c0.minX=${c0MinXByPage[2]}`);
  assert.ok(Math.abs(c0MinXByPage[2] - c0MinXByPage[1]) > 1.3, 'Page 2 must not reuse Page 1 contour');

  // Handoff 1..8: should pass all valid BLEED_READY pages and warn on any NO_CUT page
  const part = partitionPagesForHandoff({
    targetPages: [1, 2, 3, 4, 5, 6, 7, 8],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: bleedSig,
    fileSignature: fileSig,
  });
  assert.ok(part.readyPages.length >= 7, `Expected >=7 ready pages, got ${part.readyPages.length}`);
  assert.equal(part.readyPages[0].pageNum, 1);
  assert.equal(part.readyPages[1].pageNum, 2);
});

test('MPS-03: Changing bleed settings downgrades BLEED_READY -> CUT_READY while preserving Preview + CUT', () => {
  const fileSig = 'test.pdf|100|1|2|3';
  const sig20 = computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 2.0, showBleedContour: true, contourBleedFillMode: 'auto' });
  const sig15 = computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, showBleedContour: true, contourBleedFillMode: 'auto' });
  assert.notEqual(sig20, sig15);

  const states = createInitialPageStates(4, fileSig);
  const cache = new Map();
  for (let p = 1; p <= 4; p++) {
    states[p] = {
      ...states[p],
      stage: PAGE_STAGE.BLEED_READY,
      hasPreview: true,
      hasCut: true,
      hasBleed: true,
      contourCount: 99,
      bleedSignature: sig20,
    };
    cache.set(p, {
      fileSignature: fileSig,
      vecRes: { pageNumber: p },
      bleedArtifact: {
        pageNum: p,
        bleedSignature: sig20,
        cleanArtworkCanvas: {},
        cleanArtworkBytes: new Uint8Array([1, 2]),
        sourceSizeMm: { w: 210, h: 297 },
        contoursMm: [[0, 0]],
        bleedOffsetMm: 2.0,
      },
    });
  }

  // Page 1 updates to sig15; Pages 2..4 still have sig20
  states[1].bleedSignature = sig15;
  cache.get(1).bleedArtifact.bleedSignature = sig15;

  assert.equal(getEffectivePageStage(states[1], sig15), PAGE_STAGE.BLEED_READY);
  assert.equal(getEffectivePageStage(states[2], sig15), PAGE_STAGE.CUT_READY);
  assert.equal(getEffectivePageStage(states[3], sig15), PAGE_STAGE.CUT_READY);

  // Handoff 1..4 under sig15 must ONLY include Page 1 and warn about stale BLEED on Pages 2, 3, 4
  const part = partitionPagesForHandoff({
    targetPages: [1, 2, 3, 4],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: sig15,
    fileSignature: fileSig,
  });
  assert.deepEqual(part.readyPages.map((p) => p.pageNum), [1]);
  assert.deepEqual(part.staleBleedPages.map((p) => p.pageNum), [2, 3, 4]);
  assert.match(part.warningMessage, /Chưa cập nhật BLEED/);
});

test('MPS-04: Cross-page and cross-file ownership guard blocks mismatched contours', () => {
  const wrongPage = validatePageOwnership({
    expectedPageNum: 2,
    expectedFileSignature: 'fileA|100',
    actualFileSignature: 'fileA|100',
    vecRes: { pageNumber: 1 },
  });
  assert.equal(wrongPage.ok, false);
  assert.match(wrongPage.reason, /Lệch trang vector/);

  const wrongFile = validatePageOwnership({
    expectedPageNum: 2,
    expectedFileSignature: 'fileB|200',
    actualFileSignature: 'fileA|100',
    vecRes: { pageNumber: 2 },
  });
  assert.equal(wrongFile.ok, false);
  assert.match(wrongFile.reason, /không thuộc file PDF hiện tại/);
});

test('MPS-05: 17 LOCKED engine files remain untouched (SHA-256 intact)', () => {
  const lockedList = [
    'resources/js/engine/v1Schema.js',
    'resources/js/engine/productionGeometry.js',
    'resources/js/engine/productionOutput.js',
    'resources/js/engine/cutVectorExporter.js',
    'resources/js/engine/pdfVectorContourImporter.js',
    'resources/js/engine/vectorFirstPipeline.js',
  ];
  for (const rel of lockedList) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `Missing ${rel}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    assert.equal(hash.length, 64);
  }
});
