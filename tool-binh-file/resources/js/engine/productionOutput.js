/**
 * PrintKit Architecture V1 — Atomic PRINT + CUT Production Output (Checkpoint F)
 *
 * Renders PRINT.pdf and CUT.(pdf|svg|ai) strictly from ONE ImpositionPlanV1 & ONE CutMasterV1:
 *  - Validates plan freshness FIRST (blocks STALE_PLAN before any rendering).
 *  - Uses the EXACT SAME placement.rigidMatrixMm for PRINT artwork & CUT vector paths.
 *  - Stores outputs as ephemeral resources in ResourceStore (zero Blob/Uint8Array in returned state).
 *  - Atomic PRINT + CUT pair: if CUT fails after PRINT succeeded, PRINT resource is released immediately.
 *  - Emits JSON-safe shared manifest for Checkpoint G (3.1.3 Final Validator).
 */

import {
  PDFDocument,
  cmyk,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  clip,
  endPath,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import {
  applyRigidMatrixMm,
  assertPlanFreshness,
} from './batchImpositionAdapter.js';
import {
  buildCutMasterV1,
  exportCutMaster,
  resolveSelectedSheets,
} from './cutVectorExporter.js';
import { assertNoBinaryInState } from './v1Schema.js';

/**
 * Convert a 2D target-local -> sheet-mm rigidMatrixMm into a PDF CTM [a, b, c, d, e, f]
 * that maps the source image's unit square [0..1]x[0..1] (pdf-lib drawImage space) so that
 * `cropBoxMm` inside `sourcePageSizeMm` lands with exact 0.000mm alignment onto `targetSizeMm`
 * in PDF Y-up points at 0°/90°/180°/270°.
 *
 * Uses applyRigidMatrixMm() on the 3 canonical source-image corners (BL, BR, TL) so PRINT artwork
 * and CUT vector paths share the EXACT same mathematical transform.
 */
export function computePdfImageMatrixFromRigidMm(
  rigidMatrixMm,
  targetWmm,
  targetHmm,
  sheetHPt,
  sourceMapping = null
) {
  let blLocal, brLocal, tlLocal;
  if (sourceMapping && sourceMapping.cropBoxMm && sourceMapping.sourcePageSizeMm) {
    const { x: cx, y: cy, w: cw, h: ch } = sourceMapping.cropBoxMm;
    const { w: sw, h: sh } = sourceMapping.sourcePageSizeMm;
    const sx = targetWmm / cw;
    const sy = targetHmm / ch;
    blLocal = [-cx * sx, (sh - cy) * sy];
    brLocal = [(sw - cx) * sx, (sh - cy) * sy];
    tlLocal = [-cx * sx, -cy * sy];
  } else {
    // Full-image 1:1 mapping when artwork occupies the full source image (0, 0, targetW, targetH)
    blLocal = [0, targetHmm];
    brLocal = [targetWmm, targetHmm];
    tlLocal = [0, 0];
  }

  const blMm = applyRigidMatrixMm(rigidMatrixMm, blLocal);
  const brMm = applyRigidMatrixMm(rigidMatrixMm, brLocal);
  const tlMm = applyRigidMatrixMm(rigidMatrixMm, tlLocal);

  const blPt = [blMm[0] * MM_TO_PT, sheetHPt - blMm[1] * MM_TO_PT];
  const brPt = [brMm[0] * MM_TO_PT, sheetHPt - brMm[1] * MM_TO_PT];
  const tlPt = [tlMm[0] * MM_TO_PT, sheetHPt - tlMm[1] * MM_TO_PT];

  return [
    brPt[0] - blPt[0], // a
    brPt[1] - blPt[1], // b
    tlPt[0] - blPt[0], // c
    tlPt[1] - blPt[1], // d
    blPt[0],           // e
    blPt[1],           // f
  ];
}

function pushClipContourOnPdfPage(page, contourTargetMm, rigidMatrixMm, sheetHPt) {
  const ops = [];
  if (Array.isArray(contourTargetMm?.beziersMm) && contourTargetMm.beziersMm.length > 0) {
    for (const cmd of contourTargetMm.beziersMm) {
      if (cmd.type === 'M') {
        const [x, y] = applyRigidMatrixMm(rigidMatrixMm, cmd.to);
        ops.push(moveTo(x * MM_TO_PT, sheetHPt - y * MM_TO_PT));
      } else if (cmd.type === 'L') {
        const [x, y] = applyRigidMatrixMm(rigidMatrixMm, cmd.to);
        ops.push(lineTo(x * MM_TO_PT, sheetHPt - y * MM_TO_PT));
      } else if (cmd.type === 'C') {
        const [x1, y1] = applyRigidMatrixMm(rigidMatrixMm, cmd.c1);
        const [x2, y2] = applyRigidMatrixMm(rigidMatrixMm, cmd.c2);
        const [x3, y3] = applyRigidMatrixMm(rigidMatrixMm, cmd.to);
        ops.push(
          appendBezierCurve(
            x1 * MM_TO_PT,
            sheetHPt - y1 * MM_TO_PT,
            x2 * MM_TO_PT,
            sheetHPt - y2 * MM_TO_PT,
            x3 * MM_TO_PT,
            sheetHPt - y3 * MM_TO_PT
          )
        );
      }
    }
  }
  if (ops.length > 0) {
    ops.push(closePath(), clip(), endPath());
    page.pushOperators(...ops);
  }
}

function drawMarksOnPrintPage(page, marks, sheetHPt) {
  const black = cmyk(0, 0, 0, 1);
  for (const m of marks) {
    page.drawRectangle({
      x: m.xMm * MM_TO_PT,
      y: sheetHPt - (m.yMm + m.sizeMm) * MM_TO_PT,
      width: m.sizeMm * MM_TO_PT,
      height: m.sizeMm * MM_TO_PT,
      color: black,
    });
  }
}

async function renderPrintArtworkOnPage(
  doc,
  page,
  sheet,
  jobMap,
  assetMap,
  resourceStore,
  embeddedCache,
  imageBytesResolver
) {
  const hPt = sheet.heightMm * MM_TO_PT;

  for (const pl of sheet.placements) {
    const job = jobMap.get(pl.jobId);
    if (!job) throw new Error(`PRINT renderer: missing job ${pl.jobId}`);

    let embeddedImg = embeddedCache.get(job.artworkRef.resourceId);
    if (!embeddedImg) {
      let pngBytes;
      if (typeof imageBytesResolver === 'function') {
        pngBytes = await imageBytesResolver(job, resourceStore);
      } else {
        const blob = resourceStore.getBlob(job.artworkRef.resourceId);
        pngBytes = new Uint8Array(await blob.arrayBuffer());
      }
      // Embed PNG or JPG cleanly
      const isPng = pngBytes.length >= 4 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50;
      embeddedImg = isPng ? await doc.embedPng(pngBytes) : await doc.embedJpg(pngBytes);
      embeddedCache.set(job.artworkRef.resourceId, embeddedImg);
    }

    let sourceMapping = null;
    const cropBoxMm = job.artworkRef.cropBoxMm;
    if (cropBoxMm) {
      const asset = assetMap ? assetMap.get(job.origin.sourceAssetId) : null;
      if (asset?.naturalSizeMm) {
        sourceMapping = { cropBoxMm, sourcePageSizeMm: asset.naturalSizeMm };
      } else if (cropBoxMm.x > 1e-4 || cropBoxMm.y > 1e-4) {
        throw new Error(
          `PRINT renderer: SourceAsset(${job.origin.sourceAssetId}).naturalSizeMm is required to map non-zero cropBoxMm`
        );
      }
    }

    const clipContour = job.productionGeometry.bleedTargetMm || job.productionGeometry.cutTargetMm;
    const [a, b, c, d, e, f] = computePdfImageMatrixFromRigidMm(
      pl.rigidMatrixMm,
      pl.targetSizeMm.w,
      pl.targetSizeMm.h,
      hPt,
      sourceMapping
    );

    page.pushOperators(pushGraphicsState());
    if (clipContour) {
      pushClipContourOnPdfPage(page, clipContour, pl.rigidMatrixMm, hPt);
    }
    page.pushOperators(concatTransformationMatrix(a, b, c, d, e, f));
    page.drawImage(embeddedImg, { x: 0, y: 0, width: 1, height: 1 });
    page.pushOperators(popGraphicsState());
  }
}

/**
 * Render PRINT.pdf directly from ImpositionPlanV1 (never runs a separate layout engine).
 */
export async function renderPrintPdfFromPlan(
  plan,
  jobs,
  resourceStore,
  { assets = null, sheetSelection = 'ALL', imageBytesResolver = null } = {}
) {
  const jobMap = new Map(jobs.map((j) => [j.jobId, j]));
  const assetMap = assets instanceof Map ? assets : Array.isArray(assets) ? new Map(assets.map((a) => [a.assetId, a])) : null;
  const fakeCutMaster = { planId: plan.planId, sheets: plan.sheets };
  const { indices, sheets } = resolveSelectedSheets(fakeCutMaster, sheetSelection);

  const doc = await PDFDocument.create();
  const embeddedCache = new Map();
  const includeMarks = Boolean(plan.productionProfile?.includeMarksInPrint);

  for (const sh of sheets) {
    const wPt = sh.widthMm * MM_TO_PT;
    const hPt = sh.heightMm * MM_TO_PT;
    const page = doc.addPage([wPt, hPt]);
    page.setCropBox(0, 0, wPt, hPt);
    page.setBleedBox(0, 0, wPt, hPt);
    page.setTrimBox(0, 0, wPt, hPt);

    await renderPrintArtworkOnPage(doc, page, sh, jobMap, assetMap, resourceStore, embeddedCache, imageBytesResolver);
    if (includeMarks && sh.registrationMarks.length > 0) {
      drawMarksOnPrintPage(page, sh.registrationMarks, hPt);
    }
  }

  return {
    format: 'PDF',
    mimeType: 'application/pdf',
    exportedSheetIndices: indices,
    bytes: await doc.save(),
  };
}

/**
 * Atomic Production Pair Exporter (PRINT PDF + CUT PDF/SVG/AI).
 *  - Rejects STALE_PLAN before rendering.
 *  - Stores outputs in ResourceStore as ephemeral resources (zero binary in returned object).
 *  - Atomic cleanup: if CUT fails after PRINT succeeded, releases PRINT resource immediately.
 */
export async function exportProductionOutputs({
  plan,
  jobs,
  assets = null,
  resourceStore,
  print = true,
  cut = { format: 'PDF', scope: 'CUT_ONLY', sheetSelection: 'ALL' },
  sheetConfig = null,
  productionProfile = null,
  imageBytesResolver = null,
  cutExporterOverride = null,
}) {
  if (!resourceStore) throw new TypeError('exportProductionOutputs: resourceStore is required');

  // 1. Strict STALE_PLAN guard BEFORE rendering anything
  assertPlanFreshness(plan, jobs, sheetConfig, productionProfile);

  const sheetSelection = cut?.sheetSelection ?? 'ALL';
  const cutFormat = cut?.format ?? 'PDF';
  const cutScope = cut?.scope ?? 'CUT_ONLY';

  // 2. Build authoritative CutMasterV1 ONCE from ImpositionPlanV1
  const cutMaster = buildCutMasterV1(plan, jobs);
  const { indices: exportedSheetIndices, sheets: selectedSheets } = resolveSelectedSheets(cutMaster, sheetSelection);

  let printMeta = null;
  let cutMeta = null;

  try {
    // 3. Render PRINT PDF if requested
    if (print) {
      const printOut = await renderPrintPdfFromPlan(plan, jobs, resourceStore, {
        assets,
        sheetSelection,
        imageBytesResolver,
      });
      printMeta = await resourceStore.acquire(printOut.bytes, {
        kind: 'pdf_output',
        mimeType: printOut.mimeType,
        ephemeral: true,
      });
    }

    // 4. Export CUT from the SAME CutMasterV1
    const jobMap = new Map(jobs.map((j) => [j.jobId, j]));
    const assetMap = assets instanceof Map ? assets : Array.isArray(assets) ? new Map(assets.map((a) => [a.assetId, a])) : null;
    const embeddedOverlayCache = new Map();
    const cutExportFn = typeof cutExporterOverride === 'function' ? cutExporterOverride : exportCutMaster;
    const cutOut = await cutExportFn(cutMaster, {
      format: cutFormat,
      scope: cutScope,
      sheetSelection,
      printOverlayRenderer:
        cutScope === 'CUT_PLUS_PRINT'
          ? async (doc, page, sh) => {
              await renderPrintArtworkOnPage(doc, page, sh, jobMap, assetMap, resourceStore, embeddedOverlayCache, imageBytesResolver);
            }
          : null,
    });
    cutMeta = await resourceStore.acquire(cutOut.bytes, {
      kind: 'pdf_output',
      mimeType: cutOut.mimeType,
      ephemeral: true,
    });
  } catch (err) {
    // Atomic rollback: if PRINT succeeded but CUT failed, release PRINT immediately (no leak, no half-pair)
    if (printMeta && resourceStore.has(printMeta.resourceId)) {
      resourceStore.release(printMeta.resourceId);
    }
    if (cutMeta && resourceStore.has(cutMeta.resourceId)) {
      resourceStore.release(cutMeta.resourceId);
    }
    throw err;
  }

  // 5. Build JSON-safe shared manifest for Checkpoint G
  const manifestPlacements = [];
  const manifestSheets = selectedSheets.map((sh) => {
    const placementIds = sh.placements.map((pl) => {
      manifestPlacements.push({
        placementId: pl.placementId,
        jobId: pl.jobId,
        copyIndex: pl.copyIndex,
        jobRevision: pl.jobRevision,
        cutRevision: pl.cutRevision,
        productionGeometryRevision: pl.productionGeometryRevision,
        sheetIndex: sh.sheetIndex,
        rotationDeg: pl.rotationDeg,
        rigidMatrixMm: [...pl.rigidMatrixMm],
      });
      return pl.placementId;
    });
    return {
      sheetIndex: sh.sheetIndex,
      widthMm: sh.widthMm,
      heightMm: sh.heightMm,
      placementIds,
      registrationMarks: sh.registrationMarks.map((m) => ({ ...m })),
    };
  });

  const output = {
    planId: plan.planId,
    planRevision: plan.planRevision,
    cutMaster,
    print: printMeta
      ? {
          format: 'PDF',
          mimeType: printMeta.mimeType,
          resourceId: printMeta.resourceId,
          sha256: printMeta.sha256,
          byteLength: printMeta.byteLength,
        }
      : null,
    cut: cutMeta
      ? {
          format: cutFormat,
          mimeType: cutMeta.mimeType,
          resourceId: cutMeta.resourceId,
          sha256: cutMeta.sha256,
          byteLength: cutMeta.byteLength,
        }
      : null,
    manifest: {
      planId: plan.planId,
      planRevision: plan.planRevision,
      printFormat: print ? 'PDF' : null,
      cutFormat,
      scope: cutScope,
      productionProfileId: plan.productionProfile.profileId,
      sheetCount: selectedSheets.length,
      exportedSheetIndices,
      sheets: manifestSheets,
      placements: manifestPlacements,
    },
  };

  assertNoBinaryInState(output, 'productionOutput');
  return output;
}
