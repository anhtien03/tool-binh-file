import { PDFDocument, cmyk, degrees } from 'pdf-lib';

const MM_TO_PT = 72 / 25.4;

/**
 * Calculate exact spine thickness (mm) for Perfect Bound / Smyth-Sewn books.
 *
 * @param {object} opts
 * @param {number} opts.interiorPageCount Total interior pages (e.g. 120)
 * @param {number} [opts.paperThicknessMm=0.1] Single sheet caliper in mm (e.g. Ford 80gsm ≈ 0.10mm, Couche 150gsm ≈ 0.12mm)
 * @param {number} [opts.glueAllowanceMm=0.6] Hot-melt / PUR glue & cover fold allowance (mm)
 * @returns {{ leaves: number, rawPaperMm: number, spineMm: number }}
 */
export function calculateSpineThicknessMm({
  interiorPageCount,
  paperThicknessMm = 0.1,
  glueAllowanceMm = 0.6,
}) {
  const pages = Math.max(2, Math.floor(Number(interiorPageCount) || 2));
  const leaves = Math.ceil(pages / 2);
  const caliper = Math.max(0.04, Number(paperThicknessMm) || 0.1);
  const glue = Math.max(0, Number(glueAllowanceMm) || 0);
  const rawPaperMm = Number((leaves * caliper).toFixed(2));
  const spineMm = Number((rawPaperMm + glue).toFixed(2));
  return { leaves, rawPaperMm, spineMm };
}

/**
 * Compute Smyth-Sewn (Khâu chỉ chia tép) signatures with stepping collation marks
 * along the spine so bindery operators can verify signature order at a glance.
 *
 * @param {number} totalPages
 * @param {4|8|16|32} [pagesPerSignature=16]
 * @returns {{ signatureCount: number, paddedPages: number, signatures: Array<{ index: number, startPage: number, endPage: number, collationMarkYmm: number }> }}
 */
export function computeSmythSewnSignatures(totalPages, pagesPerSignature = 16) {
  const validSizes = [4, 8, 16, 32];
  const pps = validSizes.includes(Number(pagesPerSignature)) ? Number(pagesPerSignature) : 16;
  const pages = Math.max(4, Math.floor(Number(totalPages) || 4));
  const signatureCount = Math.ceil(pages / pps);
  const paddedPages = signatureCount * pps;
  const signatures = [];
  for (let i = 0; i < signatureCount; i++) {
    signatures.push({
      index: i + 1,
      startPage: i * pps + 1,
      endPage: Math.min((i + 1) * pps, pages),
      // Step collation mark 4mm down per signature (wrapping every 25 signatures)
      collationMarkYmm: 20 + (i % 25) * 4,
    });
  }
  return { signatureCount, paddedPages, signatures };
}

/**
 * Export a 1:1 Production Cover Spread PDF (Back Cover + Spine + Front Cover)
 * with 4 Cyan dashed crease/score lines (2 spine scores + 2 side hinge scores at ±hingeOffsetMm)
 * and exact Bleed margins.
 *
 * @param {object} opts
 * @param {Uint8Array} opts.sourcePdfBytes
 * @param {number} [opts.frontCoverPageIdx=0] 0-based page index for Front Cover (Bìa 1)
 * @param {number} [opts.backCoverPageIdx=-1] 0-based page index for Back Cover (Bìa 4; -1 = last page)
 * @param {number} opts.spineMm Calculated spine width in mm
 * @param {number} [opts.bleedMm=3] Outer bleed in mm
 * @param {number} [opts.hingeOffsetMm=6] Side hinge crease distance from spine (mm)
 * @returns {Promise<{ pdfBytes: Uint8Array, spreadWidthMm: number, spreadHeightMm: number, spineMm: number, creasePositionsMm: number[] }>}
 */
export async function exportBookletCoverSpreadPdf({
  sourcePdfBytes,
  frontCoverPageIdx = 0,
  backCoverPageIdx = -1,
  spineMm = 8,
  bleedMm = 3,
  hingeOffsetMm = 6,
}) {
  if (!sourcePdfBytes || sourcePdfBytes.length === 0) {
    throw new Error('Thiếu file PDF nguồn để tách Spread Bìa.');
  }
  const srcDoc = await PDFDocument.load(sourcePdfBytes);
  const count = srcDoc.getPageCount();
  const fIdx = Math.max(0, Math.min(count - 1, Number(frontCoverPageIdx) || 0));
  const bIdx =
    backCoverPageIdx < 0
      ? Math.max(0, count - 1)
      : Math.max(0, Math.min(count - 1, Number(backCoverPageIdx)));

  const frontPage = srcDoc.getPage(fIdx);
  const { width: pageWpt, height: pageHpt } = frontPage.getSize();
  const pageWmm = pageWpt / MM_TO_PT;
  const pageHmm = pageHpt / MM_TO_PT;

  const spine = Math.max(1, Number(spineMm) || 5);
  const bleed = Math.max(0, Number(bleedMm) || 0);
  const hinge = Math.max(0, Number(hingeOffsetMm) || 0);

  const spreadWidthMm = Number((pageWmm * 2 + spine + bleed * 2).toFixed(2));
  const spreadHeightMm = Number((pageHmm + bleed * 2).toFixed(2));

  const outDoc = await PDFDocument.create();
  const spreadPage = outDoc.addPage([spreadWidthMm * MM_TO_PT, spreadHeightMm * MM_TO_PT]);

  const [embBack, embFront] = await outDoc.embedPdf(srcDoc, [bIdx, fIdx]);

  // Draw Back Cover (left) and Front Cover (right)
  spreadPage.drawPage(embBack, {
    x: bleed * MM_TO_PT,
    y: bleed * MM_TO_PT,
    width: pageWpt,
    height: pageHpt,
  });
  spreadPage.drawPage(embFront, {
    x: (bleed + pageWmm + spine) * MM_TO_PT,
    y: bleed * MM_TO_PT,
    width: pageWpt,
    height: pageHpt,
  });

  // Set accurate TrimBox (excluding outer bleed)
  spreadPage.setTrimBox(
    bleed * MM_TO_PT,
    bleed * MM_TO_PT,
    (pageWmm * 2 + spine) * MM_TO_PT,
    pageHmm * MM_TO_PT
  );

  // Draw 4 Cyan dashed crease/score tick marks outside trim area (top & bottom)
  const spineLeftMm = bleed + pageWmm;
  const spineRightMm = bleed + pageWmm + spine;
  const creasePositionsMm = [
    Number((spineLeftMm - hinge).toFixed(2)),
    Number(spineLeftMm.toFixed(2)),
    Number(spineRightMm.toFixed(2)),
    Number((spineRightMm + hinge).toFixed(2)),
  ];

  const tickLenPt = Math.max(2.5, bleed) * MM_TO_PT;
  const totalHpt = spreadHeightMm * MM_TO_PT;
  const cyanCmyk = cmyk(1, 0, 0, 0);

  for (const xMm of creasePositionsMm) {
    const xPt = xMm * MM_TO_PT;
    // Bottom crease tick
    spreadPage.drawLine({
      start: { x: xPt, y: 0 },
      end: { x: xPt, y: tickLenPt },
      thickness: 0.4,
      color: cyanCmyk,
      dashArray: [2, 1.5],
    });
    // Top crease tick
    spreadPage.drawLine({
      start: { x: xPt, y: totalHpt - tickLenPt },
      end: { x: xPt, y: totalHpt },
      thickness: 0.4,
      color: cyanCmyk,
      dashArray: [2, 1.5],
    });
  }

  return {
    pdfBytes: await outDoc.save(),
    spreadWidthMm,
    spreadHeightMm,
    spineMm: spine,
    creasePositionsMm,
  };
}

/**
 * Apply Back-to-Back 180° rotation (Dán đối lưng 180° / Layflat) to every even/back sheet
 * of an imposed PDF so opposing pages align head-to-head when folded & glued back-to-back.
 *
 * @param {Uint8Array} imposedPdfBytes
 * @returns {Promise<{ pdfBytes: Uint8Array, pageCount: number, rotatedPages: number[] }>}
 */
export async function exportBackToBack180Pdf(imposedPdfBytes) {
  if (!imposedPdfBytes || imposedPdfBytes.length === 0) {
    throw new Error('Thiếu dữ liệu PDF để áp dụng Dán đối lưng 180°.');
  }
  const doc = await PDFDocument.load(imposedPdfBytes);
  const count = doc.getPageCount();
  const rotatedPages = [];

  for (let i = 0; i < count; i++) {
    if (i % 2 === 1) {
      const page = doc.getPage(i);
      const curAngle = page.getRotation().angle || 0;
      page.setRotation(degrees((curAngle + 180) % 360));
      rotatedPages.push(i + 1);
    }
  }

  return {
    pdfBytes: await doc.save(),
    pageCount: count,
    rotatedPages,
  };
}
