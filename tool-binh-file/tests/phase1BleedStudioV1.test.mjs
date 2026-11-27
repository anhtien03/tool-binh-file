import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DIELINE_MODES,
  mapSliderControlsToTracerParams,
  preprocessCanvasForTracing,
  applyCornerRoundingMm,
  mergeSelectedContours,
  hitTestStickerAtMm,
  resolveDielineModeContours,
  filterContoursByScope,
} from '../resources/js/engine/contourEditHelpers.js';
import {
  PAGE_STAGE,
  computeFileSignature,
  computeGlobalBleedSettingsSignature,
  computePageEditSignature,
  computeBleedSettingsSignature,
  createInitialPageStates,
  validatePageOwnership,
  getEffectivePageStage,
  partitionPagesForHandoff,
} from '../resources/js/engine/studioMultiPageState.js';
import {
  runVectorFirstPdfImport,
  resolveVectorFirstContours,
  CONTOUR_PROVENANCE,
} from '../resources/js/engine/vectorFirstPipeline.js';

const ROOT = process.cwd();
const REAL_PDF = 'C:/Users/IT/Downloads/Decal sticker pdf.pdf';

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

function makeRectPoly(x0, y0, w, h, compIdx = 0) {
  const poly = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
  poly.compIdx = compIdx;
  poly.closed = true;
  poly.provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL;
  poly.beziersMm = [
    { type: 'M', to: [x0, y0] },
    { type: 'L', to: [x0 + w, y0] },
    { type: 'L', to: [x0 + w, y0 + h] },
    { type: 'L', to: [x0, y0 + h] },
    { type: 'L', to: [x0, y0] },
  ];
  return poly;
}

test('P1-01: Direct canvas hit-test (point-in-polygon, nested preference, bbox fallback, miss & edge cases)', () => {
  const c0 = makeRectPoly(10, 10, 20, 20, 0);
  const c1 = makeRectPoly(50, 10, 20, 20, 1);
  const inner = makeRectPoly(15, 15, 6, 6, 2);
  const contours = [c0, c1, inner];

  // Exact polygon hit on outer c0 (outside inner)
  const hitOuter = hitTestStickerAtMm(contours, 12, 12);
  assert.deepEqual(hitOuter, { index: 0, compIdx: 0, hitType: 'polygon' });

  // Nested hit prefers smaller inner sticker
  const hitInner = hitTestStickerAtMm(contours, 18, 18);
  assert.deepEqual(hitInner, { index: 2, compIdx: 2, hitType: 'polygon' });

  // Second sticker exact hit
  const hit1 = hitTestStickerAtMm(contours, 60, 20);
  assert.deepEqual(hit1, { index: 1, compIdx: 1, hitType: 'polygon' });

  // Padded bbox fallback just outside c1 within tolerance
  const hitBbox = hitTestStickerAtMm(contours, 70.8, 20, 1.5);
  assert.deepEqual(hitBbox, { index: 1, compIdx: 1, hitType: 'bbox' });

  // Far away miss & invalid inputs
  assert.equal(hitTestStickerAtMm(contours, 200, 200, 1.5), null);
  assert.equal(hitTestStickerAtMm([], 10, 10), null);
  assert.equal(hitTestStickerAtMm(contours, NaN, 10), null);
});

test('P1-02: Selection scope toggle ("Đối tượng đang chọn" vs "Toàn trang") filters contours & bleeds cleanly', () => {
  const contours = [makeRectPoly(0, 0, 10, 10, 0), makeRectPoly(20, 0, 10, 10, 1), makeRectPoly(40, 0, 10, 10, 2)];
  contours.bleedContoursMm = [
    makeRectPoly(-1.5, -1.5, 13, 13, 0),
    makeRectPoly(18.5, -1.5, 13, 13, 1),
    makeRectPoly(38.5, -1.5, 13, 13, 2),
  ];
  contours.provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL;

  const full = filterContoursByScope(contours, { selectionScope: 'all', selectedIndices: [1] });
  assert.equal(full.length, 3);

  const selectedOnly = filterContoursByScope(contours, { selectionScope: 'selected', selectedIndices: [0, 2] });
  assert.equal(selectedOnly.length, 2);
  assert.deepEqual(selectedOnly.map((p) => p.compIdx), [0, 2]);
  assert.equal(selectedOnly.bleedContoursMm.length, 2);
  assert.equal(selectedOnly.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);

  // Empty selection falls back safely to full list
  const emptySel = filterContoursByScope(contours, { selectionScope: 'selected', selectedIndices: [] });
  assert.equal(emptySel.length, 3);

  // Regression: after merging [0, 1] out of [0, 1, 2, 3], compIdx values are [0, 2, 3] at array indices [0, 1, 2].
  // Selecting compIdx=2 MUST match ONLY compIdx=2 (1 sticker), NEVER array index 2 (compIdx=3)!
  const four = [
    makeRectPoly(0, 0, 10, 10, 0),
    makeRectPoly(15, 0, 10, 10, 1),
    makeRectPoly(35, 0, 10, 10, 2),
    makeRectPoly(55, 0, 10, 10, 3),
  ];
  const afterMerge = mergeSelectedContours(four, [0, 1]);
  assert.deepEqual(afterMerge.map((p) => p.compIdx), [0, 2, 3]);
  const onlyComp2 = filterContoursByScope(afterMerge, { selectionScope: 'selected', selectedIndices: [2] });
  assert.equal(onlyComp2.length, 1);
  assert.equal(onlyComp2[0].compIdx, 2);

  // Merging [0, 2] on [0, 2, 3] MUST merge only compIdx 0 and 2, leaving compIdx 3 untouched
  const afterSecondMerge = mergeSelectedContours(afterMerge, [0, 2]);
  assert.equal(afterSecondMerge.length, 2);
  assert.deepEqual(afterSecondMerge.map((p) => p.compIdx), [0, 3]);
});

test('P1-03: All 4 Dieline modes (original, png_alpha, bleed_edge, none) resolve accurately', () => {
  const cut0 = makeRectPoly(10, 10, 20, 20, 0);
  const bleed0 = makeRectPoly(8.5, 8.5, 23, 23, 0);
  const base = [cut0];
  base.bleedContoursMm = [bleed0];
  base.provenance = CONTOUR_PROVENANCE.VECTOR_ORIGINAL;

  // 1. original: exact Bézier reference preserved
  const orig = resolveDielineModeContours(base, DIELINE_MODES.ORIGINAL, 1.5);
  assert.equal(orig.length, 1);
  assert.strictEqual(orig[0], cut0);
  assert.equal(orig.dielineSuppressed, false);

  // 2. png_alpha: tags mode cleanly
  const pngAlpha = resolveDielineModeContours(base, DIELINE_MODES.PNG_ALPHA, 1.5);
  assert.equal(pngAlpha.length, 1);
  assert.equal(pngAlpha.dielineMode, DIELINE_MODES.PNG_ALPHA);

  // 3. bleed_edge: promotes bleedContoursMm[0] to active CUT
  const bleedEdge = resolveDielineModeContours(base, DIELINE_MODES.BLEED_EDGE, 1.5);
  assert.equal(bleedEdge.length, 1);
  assert.equal(bleedEdge[0][0][0], 8.5);
  assert.equal(bleedEdge[0][0][1], 8.5);
  assert.equal(bleedEdge[0].sourceMeta?.promotedFromBleed, true);

  // 4. none: suppresses CUT contours cleanly while keeping metadata
  const none = resolveDielineModeContours(base, DIELINE_MODES.NONE, 1.5);
  assert.equal(none.length, 0);
  assert.equal(none.dielineSuppressed, true);
  assert.equal(none.dielineMode, DIELINE_MODES.NONE);
});

test('P1-04: Manual region helpers (non-destructive preprocess, shadow removal, erase/keep mask, merge, corner rounding)', () => {
  // 4x1 RGBA buffer:
  // px0: opaque red sticker (220, 20, 20, 255)
  // px1: soft alpha shadow (100, 100, 100, 90)
  // px2: transparent bg (255, 255, 255, 0)
  // px3: opaque blue sticker (20, 40, 220, 255)
  const originalData = new Uint8ClampedArray([
    220, 20, 20, 255,
    100, 100, 100, 90,
    255, 255, 255, 0,
    20, 40, 220, 255,
  ]);
  const snapshotBefore = new Uint8ClampedArray(originalData);
  const srcBuf = { width: 4, height: 1, data: originalData };

  // Mask: erase px3 (red), keep px2 (green)
  const maskBuf = {
    width: 4,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 220, 0, 255, // green -> keep
      220, 0, 0, 255, // red -> erase
    ]),
  };

  const out = preprocessCanvasForTracing(srcBuf, {
    shadowRemovalMode: 'auto',
    forcePngAlpha: false,
    manualMaskCanvas: maskBuf,
  });

  // Original artwork buffer MUST remain 100% untouched!
  assert.deepEqual(Array.from(srcBuf.data), Array.from(snapshotBefore));

  // px0 kept opaque
  assert.equal(out.data[3], 255);
  // px1 soft shadow stripped to alpha=0
  assert.equal(out.data[7], 0);
  // px2 kept by green manual mask -> alpha=255
  assert.equal(out.data[11], 255);
  // px3 erased by red manual mask -> alpha=0
  assert.equal(out.data[15], 0);

  // Merge selected contours
  const c0 = makeRectPoly(0, 0, 10, 10, 0);
  const c1 = makeRectPoly(15, 0, 10, 10, 1);
  const c2 = makeRectPoly(40, 0, 10, 10, 2);
  const merged = mergeSelectedContours([c0, c1, c2], [0, 1]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].mergedFrom, [0, 1]);
  assert.equal(merged[0].closed, true);
  assert.ok(merged[0].beziersMm.length >= 4);

  // Corner rounding: r=0 preserves exact reference; r=2 creates cubic fillets
  const untouched = applyCornerRoundingMm(c0, 0);
  assert.strictEqual(untouched, c0);

  const rounded = applyCornerRoundingMm(c0, 2.0);
  assert.notStrictEqual(rounded, c0);
  assert.equal(rounded.closed, true);
  assert.ok(rounded.beziersMm.some((cmd) => cmd.type === 'C'), 'Expected cubic Bézier corner fillets');
  assert.equal(rounded.sourceMeta?.cornerRadiusMm, 2.0);

  // Slider mapping clamping
  const mapped = mapSliderControlsToTracerParams({ antiAliasPct: 100, fidelityPct: 100, minAreaMm2: 2.5 });
  assert.equal(mapped.smoothLevel, 3);
  assert.equal(mapped.simplifyMm, 0.05);
  assert.equal(mapped.cornerAngleDeg, 150);
  assert.equal(mapped.minAreaMm2, 2.5);
});

test('P1-05: Extended computeBleedSettingsSignature invalidates on Dieline, shadow, corner, overrides, mask, and scope changes', () => {
  const base = computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5 });
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, dielineMode: DIELINE_MODES.BLEED_EDGE }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, shadowRemovalMode: 'auto' }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, cornerRadiusMm: 1.5 }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, manualMaskRevision: 1 }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, perStickerOverrides: { 0: { offsetMm: 1 } } }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, mergedGroups: [[0, 1]] }));
  assert.notEqual(base, computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, selectionScope: 'selected', selectedIndices: [0, 2] }));

  // Regression: dielineMode='none' (0 CUT contours) must remain BLEED_READY and pass partitionPagesForHandoff
  const noDieSig = computeBleedSettingsSignature({ offsetMm: 0, bleedOffsetMm: 1.5, dielineMode: DIELINE_MODES.NONE });
  const fileSig = 'test-none.pdf|100|1|2|3';
  const noDieStates = {
    1: {
      pageNum: 1,
      fileSignature: fileSig,
      stage: PAGE_STAGE.BLEED_READY,
      hasPreview: true,
      hasCut: true,
      hasBleed: true,
      contourCount: 0,
      dielineMode: DIELINE_MODES.NONE,
      bleedSignature: noDieSig,
      errorMessage: null,
    },
  };
  assert.equal(getEffectivePageStage(noDieStates[1], noDieSig), PAGE_STAGE.BLEED_READY);
  const suppressedContours = resolveDielineModeContours([makeRectPoly(0, 0, 10, 10, 0)], DIELINE_MODES.NONE, 1.5);
  const noDieCache = new Map([
    [
      1,
      {
        fileSignature: fileSig,
        vecRes: { pageNumber: 1 },
        bleedArtifact: {
          pageNum: 1,
          bleedSignature: noDieSig,
          cleanArtworkCanvas: { page: 1 },
          cleanArtworkBytes: new Uint8Array([1, 2, 3]),
          sourceSizeMm: { w: 100, h: 100 },
          contoursMm: suppressedContours,
          bleedOffsetMm: 1.5,
          contourProvenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
          dielineMode: DIELINE_MODES.NONE,
        },
      },
    ],
  ]);
  const noDiePart = partitionPagesForHandoff({
    targetPages: [1],
    pageStates: noDieStates,
    pageCacheMap: noDieCache,
    currentBleedSignature: noDieSig,
    fileSignature: fileSig,
  });
  assert.equal(noDiePart.readyPages.length, 1);
  assert.equal(noDiePart.staleBleedPages.length, 0);
});

test('P1-06: Real multi-page PDF (Decal sticker pdf.pdf, 99 stickers/page) preserves VECTOR_ORIGINAL Bézier High Detail & per-page cache ownership', async () => {
  if (!fs.existsSync(REAL_PDF)) {
    return;
  }
  const bytes = new Uint8Array(fs.readFileSync(REAL_PDF));
  const fileSig = computeFileSignature(bytes, 'Decal sticker pdf.pdf');
  const bleedSig = computeBleedSettingsSignature({
    offsetMm: 0,
    bleedOffsetMm: 1.5,
    showBleedContour: true,
    dielineMode: DIELINE_MODES.ORIGINAL,
    cornerRadiusMm: 0,
  });

  const states = createInitialPageStates(2, fileSig);
  const cache = new Map();

  for (const p of [1, 2]) {
    const vecRes = await runVectorFirstPdfImport(bytes, { pageNumber: p, minAreaMm2: 1.0 });
    const own = validatePageOwnership({
      expectedPageNum: p,
      expectedFileSignature: fileSig,
      actualFileSignature: fileSig,
      vecRes,
    });
    assert.equal(own.ok, true, `Page ${p} ownership failed: ${own.reason}`);
    assert.equal(vecRes.status, 'OK');
    assert.equal(vecRes.contours.length, 99, `Expected 99 stickers on page ${p}`);

    const resolved = resolveVectorFirstContours(vecRes, {
      offsetMm: 0,
      bleedOffsetMm: 1.5,
      shapeMode: 'auto',
      pageWidthMm: vecRes.pageWidthMm || 210,
      pageHeightMm: vecRes.pageHeightMm || 297,
    });
    assert.equal(resolved.mode, 'VECTOR_ORIGINAL');
    assert.equal(resolved.provenance, CONTOUR_PROVENANCE.VECTOR_ORIGINAL);

    // Passing through Phase 1 post-edit pipeline with cornerRadiusMm=0 & dielineMode=original MUST preserve Bézier references 100%
    const c0BeziersBefore = JSON.stringify(resolved.contoursMm[0].beziersMm);
    const afterRound = applyCornerRoundingMm(resolved.contoursMm[0], 0);
    assert.strictEqual(afterRound, resolved.contoursMm[0]);
    const afterDieline = resolveDielineModeContours(resolved.contoursMm, DIELINE_MODES.ORIGINAL, 1.5);
    assert.equal(JSON.stringify(afterDieline[0].beziersMm), c0BeziersBefore);

    // Direct hit-test on sticker #0 centroid must find compIdx 0
    const pts = afterDieline[0];
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length;
    cy /= pts.length;
    const hit = hitTestStickerAtMm(afterDieline, cx, cy);
    assert.ok(hit && hit.index === 0, `Expected hit on sticker #0 at (${cx.toFixed(2)}, ${cy.toFixed(2)})`);

    cache.set(p, {
      fileSignature: fileSig,
      vecRes,
      perStickerOverrides: p === 1 ? { 0: { offsetMm: 0.5 } } : {},
      bleedArtifact: {
        pageNum: p,
        bleedSignature: bleedSig,
        cleanArtworkCanvas: { page: p },
        cleanArtworkBytes: new Uint8Array([p, 9, 9]),
        sourceSizeMm: { w: vecRes.pageWidthMm || 210, h: vecRes.pageHeightMm || 297 },
        contoursMm: afterDieline,
        bleedOffsetMm: 1.5,
        contourProvenance: resolved.provenance,
      },
    });
    states[p] = {
      ...states[p],
      stage: PAGE_STAGE.BLEED_READY,
      hasPreview: true,
      hasCut: true,
      hasBleed: true,
      contourCount: afterDieline.length,
      bleedSignature: bleedSig,
    };
  }

  // Verify per-page override isolation in cache
  assert.deepEqual(cache.get(1).perStickerOverrides, { 0: { offsetMm: 0.5 } });
  assert.deepEqual(cache.get(2).perStickerOverrides, {});
  assert.equal(getEffectivePageStage(states[1], bleedSig), PAGE_STAGE.BLEED_READY);
  assert.equal(getEffectivePageStage(states[2], bleedSig), PAGE_STAGE.BLEED_READY);

  const part = partitionPagesForHandoff({
    targetPages: [1, 2],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: bleedSig,
    fileSignature: fileSig,
  });
  assert.equal(part.readyPages.length, 2);
  assert.equal(part.readyPages[0].contoursMm.length, 99);
  assert.equal(part.readyPages[1].contoursMm.length, 99);
});

test('P1-07: All 17/17 LOCKED engine files match exact SHA-256 baseline (ZERO locked edits)', () => {
  for (const [file, expected] of Object.entries(LOCKED_17_BASELINES)) {
    const abs = path.join(ROOT, 'resources', 'js', 'engine', file);
    assert.ok(fs.existsSync(abs), `Missing LOCKED file: ${file}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    assert.equal(actual, expected, `LOCKED FILE MODIFIED: ${file}`);
  }
});

test('P1-08: Per-page vs global bleed signature isolation (editing Page 1 then switching to Page 2 keeps both BLEED_READY; global bleedOffsetMm change still downgrades Page 1 to CUT_READY)', () => {
  const fileSig = 'multi-isolated.pdf|2048|10|20|30';
  const globalSig20 = computeGlobalBleedSettingsSignature({
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    showBleedContour: true,
    contourBleedFillMode: 'auto',
    dielineMode: DIELINE_MODES.ORIGINAL,
  });
  const globalSig15 = computeGlobalBleedSettingsSignature({
    offsetMm: 0,
    bleedOffsetMm: 1.5,
    showBleedContour: true,
    contourBleedFillMode: 'auto',
    dielineMode: DIELINE_MODES.ORIGINAL,
  });
  assert.notEqual(globalSig20, globalSig15);

  // Global signature MUST be invariant to per-page edits
  assert.equal(
    globalSig20,
    computeGlobalBleedSettingsSignature({
      offsetMm: 0,
      bleedOffsetMm: 2.0,
      showBleedContour: true,
      contourBleedFillMode: 'auto',
      dielineMode: DIELINE_MODES.ORIGINAL,
      perStickerOverrides: { 0: { hidden: true } },
      manualMaskRevision: 3,
      mergedGroups: [[0, 1]],
      selectionScope: 'selected',
      selectedIndices: [0, 1],
    })
  );

  const defaultEditSig = computePageEditSignature();
  const p1EditedOverrides = { 0: { hidden: true, offsetMm: 0.8 } };
  const p1EditedGroups = [[1, 2]];
  const p1EditSig = computePageEditSignature({
    perStickerOverrides: p1EditedOverrides,
    mergedGroups: p1EditedGroups,
    manualMaskRevision: 0,
    selectionScope: 'all',
    selectedIndices: [],
  });
  assert.notEqual(p1EditSig, defaultEditSig);

  // Clicking a sticker while selectionScope='all' must NOT change pageEditSignature
  assert.equal(
    defaultEditSig,
    computePageEditSignature({ selectionScope: 'all', selectedIndices: [0, 2] })
  );
  // Toggling selectionScope='selected' with indices MUST change pageEditSignature
  assert.notEqual(
    defaultEditSig,
    computePageEditSignature({ selectionScope: 'selected', selectedIndices: [0, 2] })
  );

  // Canonical edge cases: empty inner merged group or non-finite selectedIndices must normalize cleanly
  assert.equal(defaultEditSig, computePageEditSignature({ mergedGroups: [[]] }));
  assert.equal(
    computePageEditSignature({ selectionScope: 'selected', selectedIndices: [] }),
    computePageEditSignature({ selectionScope: 'selected', selectedIndices: [NaN, undefined] })
  );

  // Start with both Page 1 and Page 2 BLEED_READY under globalSig20 + defaultEditSig
  const states = createInitialPageStates(2, fileSig);
  const cache = new Map();
  for (const p of [1, 2]) {
    const contours = [makeRectPoly(10, 10, 20, 20, 0), makeRectPoly(40, 10, 20, 20, 1), makeRectPoly(70, 10, 20, 20, 2)];
    states[p] = {
      ...states[p],
      stage: PAGE_STAGE.BLEED_READY,
      hasPreview: true,
      hasCut: true,
      hasBleed: true,
      contourCount: contours.length,
      bleedSignature: globalSig20,
      pageEditSignature: defaultEditSig,
    };
    cache.set(p, {
      fileSignature: fileSig,
      vecRes: { pageNumber: p },
      perStickerOverrides: {},
      manualMaskRevision: 0,
      mergedGroups: [],
      selectionScope: 'all',
      selectedStickerIndices: [],
      bleedArtifact: {
        pageNum: p,
        bleedSignature: globalSig20,
        pageEditSignature: defaultEditSig,
        cleanArtworkCanvas: { page: p },
        cleanArtworkBytes: new Uint8Array([p, 1, 2, 3]),
        sourceSizeMm: { w: 210, h: 297 },
        contoursMm: contours,
        bleedOffsetMm: 2.0,
        contourProvenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
      },
    });
  }

  // Step 1: User edits Page 1 (perStickerOverrides + mergedGroups) -> BEFORE Page 1's artifact rebuilds,
  // ONLY Page 1 downgrades to CUT_READY; Page 2 stays BLEED_READY!
  assert.equal(getEffectivePageStage(states[1], globalSig20, p1EditSig), PAGE_STAGE.CUT_READY);
  assert.equal(getEffectivePageStage(states[2], globalSig20, defaultEditSig), PAGE_STAGE.BLEED_READY);

  // Step 2: Page 1 finishes regenerating its bleedArtifact with (globalSig20, p1EditSig)
  cache.get(1).perStickerOverrides = { ...p1EditedOverrides };
  cache.get(1).mergedGroups = p1EditedGroups.map((g) => [...g]);
  cache.get(1).bleedArtifact.pageEditSignature = p1EditSig;
  states[1].pageEditSignature = p1EditSig;
  assert.equal(getEffectivePageStage(states[1], globalSig20, p1EditSig), PAGE_STAGE.BLEED_READY);

  // Step 3: User switches to Page 2 (clean defaults). BOTH Page 1 and Page 2 MUST remain BLEED_READY
  // and pass partitionPagesForHandoff([1, 2])!
  assert.equal(getEffectivePageStage(states[1], globalSig20, p1EditSig), PAGE_STAGE.BLEED_READY);
  assert.equal(getEffectivePageStage(states[2], globalSig20, defaultEditSig), PAGE_STAGE.BLEED_READY);

  const handoffExplicit = partitionPagesForHandoff({
    targetPages: [1, 2],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: globalSig20,
    pageEditSignatures: { 1: p1EditSig, 2: defaultEditSig },
    fileSignature: fileSig,
  });
  assert.deepEqual(handoffExplicit.readyPages.map((p) => p.pageNum), [1, 2]);
  assert.equal(handoffExplicit.staleBleedPages.length, 0);
  assert.equal(handoffExplicit.warningMessage, '');

  // Also verify auto-derived per-page edit signature from cache when pageEditSignatures is omitted
  const handoffAuto = partitionPagesForHandoff({
    targetPages: [1, 2],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: globalSig20,
    fileSignature: fileSig,
  });
  assert.deepEqual(handoffAuto.readyPages.map((p) => p.pageNum), [1, 2]);
  assert.equal(handoffAuto.staleBleedPages.length, 0);

  // Also verify partial Map falls back to cache derivation for omitted pages (detects stale Page 2 edit)
  cache.get(2).perStickerOverrides = { 0: { hidden: true } };
  const handoffPartialMap = partitionPagesForHandoff({
    targetPages: [1, 2],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: globalSig20,
    pageEditSignatures: new Map([[1, p1EditSig]]),
    fileSignature: fileSig,
  });
  assert.deepEqual(handoffPartialMap.readyPages.map((p) => p.pageNum), [1]);
  assert.deepEqual(handoffPartialMap.staleBleedPages.map((p) => p.pageNum), [2]);
  // Restore Page 2 cache to clean defaults before Step 4
  cache.get(2).perStickerOverrides = {};

  // Step 4: User changes GLOBAL bleedOffsetMm (2.0 -> 1.5) while on Page 2.
  // Page 2 rebuilds under globalSig15, while Page 1 STILL has globalSig20 -> Page 1 MUST downgrade to CUT_READY!
  states[2].bleedSignature = globalSig15;
  cache.get(2).bleedArtifact.bleedSignature = globalSig15;

  assert.equal(getEffectivePageStage(states[1], globalSig15, p1EditSig), PAGE_STAGE.CUT_READY);
  assert.equal(getEffectivePageStage(states[2], globalSig15, defaultEditSig), PAGE_STAGE.BLEED_READY);

  const handoffAfterGlobalChange = partitionPagesForHandoff({
    targetPages: [1, 2],
    pageStates: states,
    pageCacheMap: cache,
    currentBleedSignature: globalSig15,
    pageEditSignatures: { 1: p1EditSig, 2: defaultEditSig },
    fileSignature: fileSig,
  });
  assert.deepEqual(handoffAfterGlobalChange.readyPages.map((p) => p.pageNum), [2]);
  assert.deepEqual(handoffAfterGlobalChange.staleBleedPages.map((p) => p.pageNum), [1]);
  assert.match(handoffAfterGlobalChange.warningMessage, /Chưa cập nhật BLEED/);
});

test('P1-09: Prepress "PDF đã có biên" detects explicit TrimBox + BleedBox (+3.0mm) without double-bleeding', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { extractPdfTrimBleedBoxesMm, buildContourFromTrimBoxMm } = await import('../resources/js/engine/contourEditHelpers.js');
  const MM_TO_PT = 72 / 25.4;

  // 1. Prepress PDF: MediaBox 60x60mm, BleedBox 56x56mm (inset 2mm), TrimBox 50x50mm (inset 5mm => +3.0mm existing bleed)
  const doc = await PDFDocument.create();
  const page = doc.addPage([60 * MM_TO_PT, 60 * MM_TO_PT]);
  page.setBleedBox(2 * MM_TO_PT, 2 * MM_TO_PT, 56 * MM_TO_PT, 56 * MM_TO_PT);
  page.setTrimBox(5 * MM_TO_PT, 5 * MM_TO_PT, 50 * MM_TO_PT, 50 * MM_TO_PT);
  const pdfBytes = await doc.save();

  const info = await extractPdfTrimBleedBoxesMm(pdfBytes, 1);
  assert.equal(info.hasExplicitTrimBox, true);
  assert.equal(info.hasExplicitBleedBox, true);
  assert.equal(info.hasExistingBleed, true);
  assert.ok(Math.abs(info.trimRectMm.w - 50) < 0.01);
  assert.ok(Math.abs(info.trimRectMm.h - 50) < 0.01);
  assert.ok(Math.abs(info.trimRectMm.x - 5) < 0.01);
  assert.ok(Math.abs(info.existingBleedMm.min - 3.0) < 0.01);

  const contours = buildContourFromTrimBoxMm(info, { offsetMm: 0, extraBleedMm: 2.0 });
  assert.equal(contours.length, 1);
  assert.equal(contours.fromPdfTrimBox, true);
  assert.equal(contours.hasExistingBleed, true);
  assert.equal(contours.bleedContoursMm.length, 1);
  // Bleed contour preserves existing 56x56mm BleedBox (2..58mm), NOT double-expanded
  const b0 = contours.bleedContoursMm[0];
  assert.ok(Math.abs(b0[0][0] - 2) < 0.01 && Math.abs(b0[1][0] - 58) < 0.01);

  // 2. Plain PDF without TrimBox -> hasExplicitTrimBox must be false
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([100 * MM_TO_PT, 100 * MM_TO_PT]);
  const plainInfo = await extractPdfTrimBleedBoxesMm(await plainDoc.save(), 1);
  assert.equal(plainInfo.hasExplicitTrimBox, false);
  assert.equal(plainInfo.hasExistingBleed, false);
});
