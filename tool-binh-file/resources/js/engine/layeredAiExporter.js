/**
 * PrintKit V1 — Layered PDF-Compatible `.ai` Exporter (Additive, 0 Locked Files Modified)
 *
 * Exports per-page `.ai` files (PDF 1.5+ with real Optional Content Groups / OCG Layers)
 * so operators opening the file in Adobe Illustrator see clearly separated layers:
 *   1. RegMark  — 4 corner registration marks (Die-Cut 5mm or Graphtec Type 1/2, CMYK K=100%)
 *   2. CutLine  — Original cubic Bézier CUT contours (stroke-only, 0 fill, Spot Color CutContour, ZERO simplify)
 *   3. Crease   — Crease layer structure (when crease paths are present, or clean empty layer)
 *   4. Bleed    — Exact BLEED boundary (+2.0mm) in Cyan hairline dashed stroke for visual inspection
 *   5. Design   — Embedded print artwork page aligned to 0.000mm with CutLine & Bleed
 */

import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRawStream, PDFNumber } from 'pdf-lib';
import { transformContourByRigidMatrixMm } from './cutVectorExporter.js';
import { LAYER_ROLES } from './machineCompatibilityProfiles.js';

const MM_TO_PT = 72 / 25.4;

function fmt(n) {
  return Number(n).toFixed(4);
}

/**
 * Register `/Separation /CutContour /DeviceCMYK` Spot Color in a page's Resources/ColorSpace
 * (CMYK alternate Magenta 0 1 0 0 so Illustrator renders CutContour in crisp magenta).
 */
export function ensureSpotCutContourColorSpace(doc, page, spotName = 'CutContour') {
  const ctx = doc.context;
  const tintFn = ctx.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0, 1, 0, 0], // 100% Magenta alternate for CutContour
    N: 1,
  });
  const tintFnRef = ctx.register(tintFn);
  const sepArr = ctx.obj([
    PDFName.of('Separation'),
    PDFName.of(spotName),
    PDFName.of('DeviceCMYK'),
    tintFnRef,
  ]);
  const sepRef = ctx.register(sepArr);

  const res = page.node.Resources();
  let csDict = res.lookup(PDFName.of('ColorSpace'));
  if (!csDict) {
    csDict = ctx.obj({});
    res.set(PDFName.of('ColorSpace'), csDict);
  }
  csDict.set(PDFName.of('CS_CutContour'), sepRef);
  return 'CS_CutContour';
}

function registerOcgLayers(doc, page, layerNames) {
  const ctx = doc.context;
  const ocgRefs = [];
  const tagByName = {};

  const res = page.node.Resources();
  let props = res.lookup(PDFName.of('Properties'));
  if (!props) {
    props = ctx.obj({});
    res.set(PDFName.of('Properties'), props);
  }

  for (let i = 0; i < layerNames.length; i++) {
    const name = layerNames[i];
    const tag = `OC_${i}`;
    const ocgDict = ctx.obj({
      Type: PDFName.of('OCG'),
      Name: PDFString.of(name),
    });
    const ocgRef = ctx.register(ocgDict);
    ocgRefs.push(ocgRef);
    props.set(PDFName.of(tag), ocgRef);
    tagByName[name] = tag;
  }

  const ocgsArr = PDFArray.withContext(ctx);
  const orderArr = PDFArray.withContext(ctx);
  const onArr = PDFArray.withContext(ctx);
  for (const ref of ocgRefs) {
    ocgsArr.push(ref);
    orderArr.push(ref);
    onArr.push(ref);
  }

  const defaultConfig = ctx.obj({
    Name: PDFString.of('Default'),
    BaseState: PDFName.of('ON'),
    ON: onArr,
    Order: orderArr,
  });

  const ocProps = ctx.obj({
    OCGs: ocgsArr,
    D: defaultConfig,
  });
  doc.catalog.set(PDFName.of('OCProperties'), ocProps);
  return tagByName;
}

function contourToPdfPathOps(beziersMm, sheetHeightMm) {
  if (!Array.isArray(beziersMm) || beziersMm.length < 2) return '';
  const lines = [];
  for (const cmd of beziersMm) {
    if (cmd.type === 'M' && cmd.to) {
      lines.push(`${fmt(cmd.to[0] * MM_TO_PT)} ${fmt((sheetHeightMm - cmd.to[1]) * MM_TO_PT)} m`);
    } else if (cmd.type === 'L' && cmd.to) {
      lines.push(`${fmt(cmd.to[0] * MM_TO_PT)} ${fmt((sheetHeightMm - cmd.to[1]) * MM_TO_PT)} l`);
    } else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
      lines.push(
        `${fmt(cmd.c1[0] * MM_TO_PT)} ${fmt((sheetHeightMm - cmd.c1[1]) * MM_TO_PT)} ` +
          `${fmt(cmd.c2[0] * MM_TO_PT)} ${fmt((sheetHeightMm - cmd.c2[1]) * MM_TO_PT)} ` +
          `${fmt(cmd.to[0] * MM_TO_PT)} ${fmt((sheetHeightMm - cmd.to[1]) * MM_TO_PT)} c`
      );
    }
  }
  lines.push('h');
  return lines.join('\n');
}

function buildCirclePathOps(cxPt, cyPt, rPt) {
  const k = rPt * 0.5522847498;
  return [
    `${fmt(cxPt + rPt)} ${fmt(cyPt)} m`,
    `${fmt(cxPt + rPt)} ${fmt(cyPt + k)} ${fmt(cxPt + k)} ${fmt(cyPt + rPt)} ${fmt(cxPt)} ${fmt(cyPt + rPt)} c`,
    `${fmt(cxPt - k)} ${fmt(cyPt + rPt)} ${fmt(cxPt - rPt)} ${fmt(cyPt + k)} ${fmt(cxPt - rPt)} ${fmt(cyPt)} c`,
    `${fmt(cxPt - rPt)} ${fmt(cyPt - k)} ${fmt(cxPt - k)} ${fmt(cyPt - rPt)} ${fmt(cxPt)} ${fmt(cyPt - rPt)} c`,
    `${fmt(cxPt + k)} ${fmt(cyPt - rPt)} ${fmt(cxPt + rPt)} ${fmt(cyPt - k)} ${fmt(cxPt + rPt)} ${fmt(cyPt)} c`,
    'h',
  ].join('\n');
}

function buildRegMarksStreamOps({ sheetWidthMm, sheetHeightMm, markInsetMm, markSizeMm, pontType }) {
  if (!pontType || pontType === 'none') return '';
  const corners = [
    { cx: markInsetMm, cy: markInsetMm, corner: 'TL' },
    { cx: sheetWidthMm - markInsetMm, cy: markInsetMm, corner: 'TR' },
    { cx: markInsetMm, cy: sheetHeightMm - markInsetMm, corner: 'BL' },
    { cx: sheetWidthMm - markInsetMm, cy: sheetHeightMm - markInsetMm, corner: 'BR' },
  ];
  const ops = ['q', '0 0 0 1 k', '0 0 0 1 K'];

  if (pontType === 'circle5mm' || pontType === 'circleHollow') {
    const rPt = (markSizeMm / 2) * MM_TO_PT;
    if (pontType === 'circleHollow') ops.push(`${fmt(0.45 * MM_TO_PT)} w`);
    for (const c of corners) {
      const cxPt = c.cx * MM_TO_PT;
      const cyPt = (sheetHeightMm - c.cy) * MM_TO_PT;
      ops.push(buildCirclePathOps(cxPt, cyPt, rPt));
      ops.push(pontType === 'circleHollow' ? 'S' : 'f');
    }
  } else if (pontType === 'graphtec' || pontType === 'graphtecType2') {
    const isType2 = pontType === 'graphtecType2';
    const rawArmMm = Math.max(5, markSizeMm * 1.8);
    const effArmMm = isType2 ? Math.min(rawArmMm, Math.max(3, markInsetMm - 1.2)) : rawArmMm;
    const armPt = effArmMm * MM_TO_PT;
    const strokePt = 0.6 * MM_TO_PT;
    ops.push(`${fmt(strokePt)} w`, '0 j', '2 J');
    for (const c of corners) {
      const cxPt = c.cx * MM_TO_PT;
      const cyPt = (sheetHeightMm - c.cy) * MM_TO_PT;
      const sx = (c.corner.includes('L') ? 1 : -1) * (isType2 ? -1 : 1);
      const syPdf = (c.corner.includes('T') ? -1 : 1) * (isType2 ? -1 : 1);
      ops.push(
        `${fmt(cxPt + sx * armPt)} ${fmt(cyPt)} m`,
        `${fmt(cxPt)} ${fmt(cyPt)} l`,
        `${fmt(cxPt)} ${fmt(cyPt + syPdf * armPt)} l`,
        'S'
      );
    }
  }
  ops.push('Q');
  return ops.join('\n');
}

function appendRawContentStream(doc, page, streamStr) {
  const bytes = new TextEncoder().encode(streamStr);
  const stream = PDFRawStream.of(doc.context.obj({ Length: PDFNumber.of(bytes.length) }), bytes);
  const streamRef = doc.context.register(stream);
  // IMPORTANT: Use page.node.get(Contents) (NOT page.node.Contents()) so we preserve indirect PDFRef!
  // PDF spec (ISO 32000-1 §7.3.8.1) forbids direct stream objects inside a /Contents array
  // (Acrobat/Illustrator rejects direct streams with "Expected a dict object").
  const existingRaw = page.node.get(PDFName.of('Contents'));
  if (!existingRaw) {
    page.node.set(PDFName.of('Contents'), streamRef);
  } else {
    const resolved = doc.context.lookup(existingRaw);
    if (resolved instanceof PDFArray) {
      resolved.push(streamRef);
    } else {
      const arr = PDFArray.withContext(doc.context);
      arr.push(existingRaw);
      arr.push(streamRef);
      page.node.set(PDFName.of('Contents'), arr);
    }
  }
}

/**
 * Export per-page layered `.ai` files (PDF-compatible with Illustrator OCG layers):
 *   RegMark | CutLine (Spot CutContour) | Crease | Bleed | Design
 */
export async function exportLayeredAiFiles({
  v1PlanState,
  printPdfBytes,
  pontType = 'graphtec',
  requireSpotCutContour = true,
  spotColorName = 'CutContour',
  includeBleedOutline = false,
  baseFileName = 'tem',
} = {}) {
  const imp = v1PlanState?.checkpoint?.batchPlan?.impositionPlan;
  const jobs = v1PlanState?.jobs || [];
  if (!imp || !Array.isArray(imp.sheets) || imp.sheets.length === 0) {
    throw new Error('Không có kế hoạch V1/H.2 hợp lệ để xuất file AI phân lớp.');
  }

  const jobMap = new Map(jobs.map((j) => [j.jobId, j]));
  const safeBase = (baseFileName || 'tem').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-. ]+/g, '_');
  const printSrcDoc = printPdfBytes ? await PDFDocument.load(printPdfBytes) : null;
  const markInsetMm = Number(imp.productionProfile?.markInsetMm ?? v1PlanState?.summary?.markInsetMm ?? 10);
  const markSizeMm = Number(imp.productionProfile?.markSizeMm ?? v1PlanState?.summary?.markSizeMm ?? 5);

  const aiFiles = [];

  for (let sIdx = 0; sIdx < imp.sheets.length; sIdx++) {
    const sheet = imp.sheets[sIdx];
    const wPt = sheet.widthMm * MM_TO_PT;
    const hPt = sheet.heightMm * MM_TO_PT;

    const aiDoc = await PDFDocument.create();
    const page = aiDoc.addPage([wPt, hPt]);
    page.setCropBox(0, 0, wPt, hPt);

    const layerNames = includeBleedOutline
      ? [
          LAYER_ROLES.REGMARK,
          LAYER_ROLES.CUTLINE,
          LAYER_ROLES.CREASE,
          LAYER_ROLES.BLEED,
          LAYER_ROLES.DESIGN,
        ]
      : [
          LAYER_ROLES.REGMARK,
          LAYER_ROLES.CUTLINE,
          LAYER_ROLES.CREASE,
          LAYER_ROLES.DESIGN,
        ];
    const tagByName = registerOcgLayers(aiDoc, page, layerNames);
    const spotCsTag = requireSpotCutContour ? ensureSpotCutContourColorSpace(aiDoc, page, spotColorName) : null;

    // 1. Design Layer (bottom-most artwork from PRINT.pdf embedded at 0,0 -> 0.000mm registration)
    if (printSrcDoc && sIdx < printSrcDoc.getPageCount()) {
      const [embeddedPrint] = await aiDoc.embedPages([printSrcDoc.getPage(sIdx)]);
      const xObjName = 'XObj_DesignPage';
      const res = page.node.Resources();
      let xObjDict = res.lookup(PDFName.of('XObject'));
      if (!xObjDict) {
        xObjDict = aiDoc.context.obj({});
        res.set(PDFName.of('XObject'), xObjDict);
      }
      xObjDict.set(PDFName.of(xObjName), embeddedPrint.ref);
      const designOps = [
        `/OC /${tagByName[LAYER_ROLES.DESIGN]} BDC`,
        'q',
        `/${xObjName} Do`,
        'Q',
        'EMC',
      ].join('\n');
      appendRawContentStream(aiDoc, page, designOps);
    }

    // 2. Optional Bleed Outline Layer (OFF by default so cutter software never mistakes it for a cut path)
    if (includeBleedOutline) {
      const bleedOps = [
        `/OC /${tagByName[LAYER_ROLES.BLEED]} BDC`,
        'q',
        '1 0 0 0 K',
        '0.35 w',
        '[2 1.5] 0 d',
      ];
      for (const pl of sheet.placements || []) {
        const job = jobMap.get(pl.jobId);
        const bGeo = job?.productionGeometry?.bleedTargetMm;
        if (!bGeo) continue;
        const bWorld = transformContourByRigidMatrixMm(bGeo, pl.rigidMatrixMm);
        const pathStr = contourToPdfPathOps(bWorld?.beziersMm, sheet.heightMm);
        if (pathStr) bleedOps.push(pathStr, 'S');
      }
      bleedOps.push('Q', 'EMC');
      appendRawContentStream(aiDoc, page, bleedOps.join('\n'));
    }

    // 3. Crease Layer (clean empty layer ready for creasing tools if needed)
    const creaseOps = [
      `/OC /${tagByName[LAYER_ROLES.CREASE]} BDC`,
      'q',
      '0 0.5 1 0 K',
      '0.5 w',
      'Q',
      'EMC',
    ].join('\n');
    appendRawContentStream(aiDoc, page, creaseOps);

    // 4. CutLine Layer (exact original Bézier CUT, stroke-only, 0 fill, Spot Color CutContour)
    const cutOps = [
      `/OC /${tagByName[LAYER_ROLES.CUTLINE]} BDC`,
      'q',
      spotCsTag ? `/${spotCsTag} CS\n1 SCN` : '0 1 0 0 K',
      '0.25 w',
      '[] 0 d',
    ];
    for (const pl of sheet.placements || []) {
      const job = jobMap.get(pl.jobId);
      const cGeo = job?.productionGeometry?.cutTargetMm;
      if (!cGeo) continue;
      const cWorld = transformContourByRigidMatrixMm(cGeo, pl.rigidMatrixMm);
      const pathStr = contourToPdfPathOps(cWorld?.beziersMm, sheet.heightMm);
      if (pathStr) cutOps.push(pathStr, 'S');
    }
    cutOps.push('Q', 'EMC');
    appendRawContentStream(aiDoc, page, cutOps.join('\n'));

    // 5. RegMark Layer (top-most 4 corner marks, CMYK K=100%)
    const markBody = buildRegMarksStreamOps({
      sheetWidthMm: sheet.widthMm,
      sheetHeightMm: sheet.heightMm,
      markInsetMm,
      markSizeMm,
      pontType,
    });
    const regOps = [
      `/OC /${tagByName[LAYER_ROLES.REGMARK]} BDC`,
      markBody,
      'EMC',
    ].join('\n');
    appendRawContentStream(aiDoc, page, regOps);

    const bytes = await aiDoc.save({ useObjectStreams: false });
    aiFiles.push({
      pageNumber: sIdx + 1,
      fileName: `PrintKitV1_KhuonBe_${safeBase}_TRANG_${sIdx + 1}.ai`,
      bytes,
      layers: layerNames,
      hasSpotCutContour: Boolean(spotCsTag),
      placementCount: (sheet.placements || []).length,
    });
  }

  return aiFiles;
}
