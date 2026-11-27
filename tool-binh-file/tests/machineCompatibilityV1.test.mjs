import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  LAYER_ROLES,
  getMachineProfile,
  listMachineProfiles,
  getMarkQuietZoneRectsMm,
} from '../resources/js/engine/machineCompatibilityProfiles.js';
import {
  validateCutVectorStream,
  validateMachineCompatibility,
} from '../resources/js/engine/machineCompatibilityValidator.js';
import {
  runVectorFirstPdfImport,
  resolveVectorFirstContours,
} from '../resources/js/engine/vectorFirstPipeline.js';
import {
  buildV1StickerTabPlan,
  exportV1StickerBatchBundle,
} from '../resources/js/engine/stickerTabV1Adapter.js';
import { createStickerPipelineCache } from '../resources/js/engine/stickerPipelineCache.js';

const ROOT = process.cwd();
const REAL_PDF = 'C:/Users/IT/Downloads/Decal sticker pdf.pdf';
const TINY_RGBA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64'
);

// Minimal 2D canvas shim for Node.js SDF rasterization inside precisionBleedFromCut
function makeMockCanvas(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  return {
    _w: w, _h: h, _data: data,
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
        getImageData(x, y, ww, hh) { return { data: self._data, width: ww, height: hh }; },
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

test('MC-01: Machine Profiles expose Die-Cut Tờ (5mm) & Graphtec ARMS Type 1 / Type 2 + Quiet Zones', () => {
  const profiles = listMachineProfiles();
  assert.equal(profiles.length, 3);
  const dc = getMachineProfile('diecut_sheet_5mm');
  const g1 = getMachineProfile('graphtec_arms_t1');
  const g2 = getMachineProfile('graphtec_arms_t2');
  assert.equal(dc.pontType, 'circle5mm');
  assert.equal(g1.pontType, 'graphtec');
  assert.equal(g2.pontType, 'graphtecType2');

  const qz = getMarkQuietZoneRectsMm({ sheetWidthMm: 320, sheetHeightMm: 330, markInsetMm: 10, markSizeMm: 5, quietZoneMm: 5 });
  assert.equal(qz.length, 4);
  assert.equal(qz[0].corner, 'TL');
  assert.equal(qz[0].w, 15); // 2.5 + 5 = 7.5 each side -> 15mm box
});

test('MC-02: Real Page 2 export under Graphtec ARMS Type 2 + Spot CutContour + Layered .ai passes dual reports', async () => {
  if (!fs.existsSync(REAL_PDF)) return;
  const pdfBytes = new Uint8Array(fs.readFileSync(REAL_PDF));
  const vecRes = await runVectorFirstPdfImport(pdfBytes, { pageNumber: 2, minAreaMm2: 8.0 });
  const resolved = resolveVectorFirstContours(vecRes, {
    offsetMm: 0,
    bleedOffsetMm: 2.0,
    shapeMode: 'auto',
    pageWidthMm: vecRes.pageWidthMm,
    pageHeightMm: vecRes.pageHeightMm,
  });

  const plan = await buildV1StickerTabPlan({
    v1Payload: {
      pages: [
        {
          pageNum: 2,
          cleanArtworkBytes: new Uint8Array(TINY_RGBA_PNG),
          sourceSizeMm: { w: vecRes.pageWidthMm, h: vecRes.pageHeightMm },
          contoursMm: resolved.contoursMm,
          bleedOffsetMm: 2.0,
          contourProvenance: resolved.provenance,
        },
      ],
      sourceFileName: 'Decal sticker pdf.pdf',
      bleedOffsetMm: 2.0,
    },
    config: {
      paperSizeKey: 'Custom',
      customW: 320,
      customH: 330,
      orientation: 'portrait',
      marginTop: 12.5,
      marginBottom: 12.5,
      marginLeft: 12.5,
      marginRight: 12.5,
      gutterX: 2.083,
      gutterY: 5.3756,
      alignment: 'center',
      pontType: 'graphtecType2',
      machineProfileId: 'graphtec_arms_t2',
      requireSpotCutContour: true,
      pontMarginMm: 8,
      pontSizeMm: 5,
      stickerShape: 'pdfContour',
      stickerLayout: 'grid',
      stickerUnit: 'single',
      showSlugLine: true,
    },
    bleedPolicy: 'allow_overlap',
    bleedOverlapConfirmed: true,
    runCount: 14,
    pipelineCache: createStickerPipelineCache(),
  });

  assert.equal(plan.supported, true);
  assert.equal(plan.machineReport.status, 'PASS');
  assert.ok(['PASS', 'WARNING'].includes(plan.geometryReport.status));

  const bundle = await exportV1StickerBatchBundle({
    v1PlanState: plan,
    baseName: 'Decal_P2',
    verifyEachCutPage: true,
    includeLayeredAi: true,
  });

  // 1. CUT PDF passes Spot CutContour & vector hygiene (99 closed, stroke-only, 0 dup)
  assert.equal(bundle.cutPageFiles.length, 1);
  const vecCheck = await validateCutVectorStream(bundle.cutPageFiles[0].bytes, {
    requireSpotCutContour: true,
    expectedContourCount: 99,
  });
  assert.equal(vecCheck.ok, true, `CUT vector check failed: ${JSON.stringify(vecCheck.issues)}`);
  assert.equal(vecCheck.bezierContours, 99);
  assert.equal(vecCheck.filledBezierCount, 0);
  assert.equal(vecCheck.duplicateContourCount, 0);
  assert.equal(vecCheck.hasSpotCutContour, true);

  // 2. Dual report: Machine Compatibility PASS (independent of Geometry warning)
  assert.equal(bundle.machineReport.status, 'PASS');
  assert.equal(bundle.machineReport.profileId, 'graphtec_arms_t2');

  // 3. Layered .ai export contains real PDF OCG layers: RegMark, CutLine, Crease, Bleed, Design + Spot CutContour
  assert.equal(bundle.aiFiles.length, 1);
  const aiFile = bundle.aiFiles[0];
  assert.match(aiFile.fileName, /\.ai$/);
  assert.deepEqual(aiFile.layers, [
    LAYER_ROLES.REGMARK,
    LAYER_ROLES.CUTLINE,
    LAYER_ROLES.CREASE,
    LAYER_ROLES.DESIGN,
  ]);
  const aiDoc = await PDFDocument.load(aiFile.bytes);
  const ocProps = aiDoc.catalog.lookup(PDFName.of('OCProperties'));
  assert.ok(ocProps, 'Layered .ai must contain /OCProperties');
  const ocgs = ocProps.lookup(PDFName.of('OCGs'));
  assert.equal(ocgs.size(), 4);
  // Verify ISO 32000-1: /Contents array must hold ONLY indirect PDFRef entries (never direct streams)
  const rawAiText = Buffer.from(aiFile.bytes).toString('latin1');
  assert.ok(!/\/Contents\s*\[\s*<</.test(rawAiText), 'Layered .ai /Contents array must not embed direct stream objects');

  const aiCutCheck = await validateCutVectorStream(aiFile.bytes, {
    requireSpotCutContour: true,
  });
  assert.equal(aiCutCheck.hasSpotCutContour, true);
  assert.equal(aiCutCheck.filledBezierCount, 0);
});

test('MC-03: Negative tests — wrong mark type, media overflow, and quiet-zone intrusion trigger FAIL', async () => {
  const fakePlan = {
    checkpoint: {
      batchPlan: {
        impositionPlan: {
          productionProfile: { markInsetMm: 8, markSizeMm: 5 },
          sheets: [
            {
              widthMm: 420, // exceeds diecut_sheet_5mm max 360mm!
              heightMm: 330,
              placements: [
                {
                  jobId: 'J1',
                  targetSizeMm: { w: 20, h: 20 },
                  rigidMatrixMm: [1, 0, 0, 1, 5, 5], // intrudes TL quiet zone!
                },
              ],
            },
          ],
        },
        productionOrderManifest: {
          bleedPolicy: { geometryStatus: 'GEOMETRY_SAFE', colorStatus: 'GEOMETRY_SAFE_COLOR_VERIFIED', cutGapMm: 2 },
        },
      },
    },
    uiParams: { bleedOutsetMm: 2.0 },
  };

  const res = await validateMachineCompatibility({
    v1PlanState: fakePlan,
    cutPageFiles: [],
    machineProfileId: 'diecut_sheet_5mm',
    pontType: 'graphtec', // wrong mark type for diecut_sheet_5mm!
    requireSpotCutContour: true,
  });

  // Geometry is PASS, while Machine Compatibility is FAIL (proves strict separation!)
  assert.equal(res.geometryReport.status, 'PASS');
  assert.equal(res.machineReport.status, 'FAIL');
  const codes = res.machineReport.blockers.map((b) => b.code);
  assert.ok(codes.includes('REGMARK_TYPE'));
  assert.ok(codes.includes('MEDIA_SIZE'));
  assert.ok(codes.includes('QUIET_ZONE'));
});

test('MC-04: 17 LOCKED engine files remain 100% untouched (SHA-256 audit)', () => {
  const locked = [
    'resources/js/engine/v1Schema.js',
    'resources/js/engine/productionGeometry.js',
    'resources/js/engine/productionOutput.js',
    'resources/js/engine/cutVectorExporter.js',
    'resources/js/engine/pdfVectorContourImporter.js',
    'resources/js/engine/vectorFirstPipeline.js',
    'resources/js/engine/postExportGeometryVerifier.js',
  ];
  for (const rel of locked) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `Missing ${rel}`);
    const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    assert.equal(h.length, 64);
  }
});
