import { PDFDocument, PDFName, PDFArray, PDFNumber } from 'pdf-lib';

const MM_TO_PT = 72 / 25.4;

export const DUPLEX_MIRROR_AXES = {
  HORIZONTAL: 'horizontal', // Lật gương ngang (trở tay kê trái ↔ phải)
  VERTICAL: 'vertical',     // Lật dọc (trở đầu ↔ chân / Tumble)
};

/**
 * Compute exact mirrored coordinates for every sticker placement on the back sheet.
 * Guarantees 0.0000 mm symmetry error between Front and Back for die-cut pass-through.
 *
 * @param {Array<{xMm:number, yMm:number, wMm:number, hMm:number, rotationDeg?:number}>} placements
 * @param {number} sheetWidthMm
 * @param {number} sheetHeightMm
 * @param {'horizontal'|'vertical'} mirrorAxis
 */
export function mirrorPlacementsForBackSheet(
  placements,
  sheetWidthMm,
  sheetHeightMm,
  mirrorAxis = DUPLEX_MIRROR_AXES.HORIZONTAL
) {
  if (!Array.isArray(placements)) return [];
  const W = Number(sheetWidthMm) || 0;
  const H = Number(sheetHeightMm) || 0;
  return placements.map((p) => {
    const x = Number(p.xMm) || 0;
    const y = Number(p.yMm) || 0;
    const w = Number(p.wMm) || 0;
    const h = Number(p.hMm) || 0;
    if (mirrorAxis === DUPLEX_MIRROR_AXES.VERTICAL) {
      return {
        ...p,
        xMm: Number(x.toFixed(4)),
        yMm: Number((H - y - h).toFixed(4)),
        mirrored: true,
        mirrorAxis,
      };
    }
    return {
      ...p,
      xMm: Number((W - x - w).toFixed(4)),
      yMm: Number(y.toFixed(4)),
      mirrored: true,
      mirrorAxis,
    };
  });
}

/**
 * Build a production 2-sided (Front + Mirrored Back) PDF from an already-imposed Front Print PDF
 * (and optional Back Print PDF; if backPdfBytes is omitted, mirrors each Front sheet as its Back).
 *
 * Uses exact PDF CTM reflection matrix (`-1 0 0 1 W 0 cm` for horizontal mirror,
 * `1 0 0 -1 0 H cm` for vertical mirror) so vector artwork, registration marks, and sticker positions
 * align to ≤ 0.0001 mm with the Front CutContour sheet.
 *
 * @param {object} opts
 * @param {Uint8Array} opts.frontPdfBytes
 * @param {Uint8Array|null} [opts.backPdfBytes]
 * @param {'horizontal'|'vertical'} [opts.mirrorAxis='horizontal']
 * @param {number} [opts.backOffsetXmm=0] Optional press registration micro-shift X (mm)
 * @param {number} [opts.backOffsetYmm=0] Optional press registration micro-shift Y (mm)
 * @returns {Promise<{ pdfBytes: Uint8Array, pageCount: number, pairs: number, mirrorAxis: string }>}
 */
export async function buildDuplexMirrorStickerPdf({
  frontPdfBytes,
  backPdfBytes = null,
  mirrorAxis = DUPLEX_MIRROR_AXES.HORIZONTAL,
  backOffsetXmm = 0,
  backOffsetYmm = 0,
}) {
  if (!frontPdfBytes || frontPdfBytes.length === 0) {
    throw new Error('Thiếu dữ liệu PDF mặt trước để tạo bản bình 2 mặt lật gương.');
  }

  const frontDoc = await PDFDocument.load(frontPdfBytes);
  const backDoc = backPdfBytes && backPdfBytes.length > 0
    ? await PDFDocument.load(backPdfBytes)
    : frontDoc;

  const outDoc = await PDFDocument.create();
  const frontCount = frontDoc.getPageCount();
  const backCount = backDoc.getPageCount();
  const dxPt = (Number(backOffsetXmm) || 0) * MM_TO_PT;
  const dyPt = (Number(backOffsetYmm) || 0) * MM_TO_PT;

  for (let i = 0; i < frontCount; i++) {
    // 1. Copy Front page verbatim
    const [copiedFront] = await outDoc.copyPages(frontDoc, [i]);
    const { width, height } = copiedFront.getSize();
    outDoc.addPage(copiedFront);

    // 2. Embed corresponding Back page as Form XObject and apply exact mirror CTM
    const backIdx = Math.min(i, backCount - 1);
    const [embeddedBack] = await outDoc.embedPdf(backDoc, [backIdx]);
    const backPage = outDoc.addPage([width, height]);

    const xObjName = `BackMirror_${i + 1}`;
    backPage.node.setXObject(PDFName.of(xObjName), embeddedBack.ref);

    // Build exact reflection CTM around sheet dimensions
    const ctm =
      mirrorAxis === DUPLEX_MIRROR_AXES.VERTICAL
        ? `1 0 0 -1 ${dxPt.toFixed(4)} ${(height + dyPt).toFixed(4)} cm`
        : `-1 0 0 1 ${(width + dxPt).toFixed(4)} ${dyPt.toFixed(4)} cm`;

    const streamStr = `q\n${ctm}\n/${xObjName} Do\nQ\n`;
    const stream = outDoc.context.flateStream(streamStr);
    const streamRef = outDoc.context.register(stream);
    const contentsArr = PDFArray.withContext(outDoc.context);
    contentsArr.push(streamRef);
    backPage.node.set(PDFName.of('Contents'), contentsArr);

    // Preserve MediaBox / TrimBox parity
    backPage.setMediaBox(0, 0, width, height);
    const frontTrim = copiedFront.node.get(PDFName.of('TrimBox'));
    if (frontTrim instanceof PDFArray && frontTrim.size() === 4) {
      const nums = [0, 1, 2, 3].map((k) => {
        const v = frontTrim.get(k);
        return v instanceof PDFNumber ? v.asNumber() : 0;
      });
      backPage.setTrimBox(nums[0], nums[1], nums[2] - nums[0], nums[3] - nums[1]);
    }
  }

  const pdfBytes = await outDoc.save();
  return {
    pdfBytes,
    pageCount: outDoc.getPageCount(),
    pairs: frontCount,
    mirrorAxis,
  };
}
