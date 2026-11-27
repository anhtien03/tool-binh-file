import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';
import { contourBoundsMm, PRECISION_BLEED_BUDGET } from './bleedContourEngine.js';

/**
 * Cutline Engine 3.1.3 — Post-Export PDF Production Validator.
 * Reads actual exported PDF bytes back via pdf-lib and verifies:
 *  1. Page / Sticker count matches expected (no silently dropped stickers)
 *  2. 4-Box physical hierarchy: TrimBox <= BleedBox <= CropBox <= MediaBox, finite & positive
 *  3. Physical mm dimensions match expected CUT bounds (no scale/unit drift)
 *  4. All vector coordinates (m/l/c) stay inside MediaBox & CropBox (no cropped BLEED)
 *  5. Artwork XObject + closed Magenta CUT + closed Cyan BLEED pairing matches 1:1
 *  6. Zero NaN/Infinity tokens in raw PDF content streams
 *  7. CUT vector bounds align with TrimBox (no Artwork <-> Cutline shift)
 */

const PT_TO_MM = 1 / MM_TO_PT;
const BOX_EPS_PT = 0.15; // ~0.05 mm rounding tolerance
const COORD_EPS_PT = 0.55; // allows half of 0.35pt stroke + float rounding

function r3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function isValidBox(box) {
  return (
    box &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

function boxContains(outer, inner, eps = BOX_EPS_PT) {
  if (!isValidBox(outer) || !isValidBox(inner)) return false;
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

function decodePageContentStream(page) {
  const contents = page.node.get(PDFName.of('Contents'));
  if (!contents) return '';
  const context = page.doc.context;
  const decodeOne = (refOrStream) => {
    const obj = context.lookup(refOrStream);
    if (!(obj instanceof PDFRawStream)) return '';
    try {
      const decoded = decodePDFRawStream(obj).decode();
      let str = '';
      for (let i = 0; i < decoded.length; i++) str += String.fromCharCode(decoded[i]);
      return str;
    } catch {
      const raw = obj.contents;
      let str = '';
      for (let i = 0; i < raw.length; i++) str += String.fromCharCode(raw[i]);
      return str;
    }
  };
  if (contents instanceof PDFArray) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) out += '\n' + decodeOne(contents.get(i));
    return out;
  }
  return decodeOne(contents);
}

function countPageXObjects(page) {
  const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
  if (!resources) return 0;
  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return 0;
  return xObjects.entries().length;
}

function parseVectorStream(streamText, mediaBox, cropBox) {
  const lines = streamText.split(/\r?\n/);
  let hasNonFiniteToken = false;
  let currentColor = 'other'; // 'cut' (0 1 0 0 K) | 'bleed' (1 0 0 0 K) | 'other'
  let curPathHasCoords = false;
  let curPathClosed = false;
  let cutPathCount = 0;
  let bleedPathCount = 0;
  let cutClosedCount = 0;
  let bleedClosedCount = 0;
  let doOpCount = 0;
  let totalVectorOps = 0;
  let outOfMediaBoxCount = 0;
  let outOfCropBoxCount = 0;
  let minMarginPt = Infinity;

  const cutBoundsPt = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const bleedBoundsPt = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  const recordCoord = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      hasNonFiniteToken = true;
      return;
    }
    const mX = Math.min(x - mediaBox.x, mediaBox.x + mediaBox.width - x);
    const mY = Math.min(y - mediaBox.y, mediaBox.y + mediaBox.height - y);
    const margin = Math.min(mX, mY);
    if (margin < minMarginPt) minMarginPt = margin;

    if (
      x < mediaBox.x - COORD_EPS_PT ||
      x > mediaBox.x + mediaBox.width + COORD_EPS_PT ||
      y < mediaBox.y - COORD_EPS_PT ||
      y > mediaBox.y + mediaBox.height + COORD_EPS_PT
    ) {
      outOfMediaBoxCount++;
    }
    if (
      x < cropBox.x - COORD_EPS_PT ||
      x > cropBox.x + cropBox.width + COORD_EPS_PT ||
      y < cropBox.y - COORD_EPS_PT ||
      y > cropBox.y + cropBox.height + COORD_EPS_PT
    ) {
      outOfCropBoxCount++;
    }
    if (currentColor === 'cut') {
      if (x < cutBoundsPt.minX) cutBoundsPt.minX = x;
      if (y < cutBoundsPt.minY) cutBoundsPt.minY = y;
      if (x > cutBoundsPt.maxX) cutBoundsPt.maxX = x;
      if (y > cutBoundsPt.maxY) cutBoundsPt.maxY = y;
    } else if (currentColor === 'bleed') {
      if (x < bleedBoundsPt.minX) bleedBoundsPt.minX = x;
      if (y < bleedBoundsPt.minY) bleedBoundsPt.minY = y;
      if (x > bleedBoundsPt.maxX) bleedBoundsPt.maxX = x;
      if (y > bleedBoundsPt.maxY) bleedBoundsPt.maxY = y;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\b(NaN|Infinity|-Infinity)\b/.test(line)) {
      hasNonFiniteToken = true;
    }
    if (line === 'q' || line === 'Q') {
      if (line === 'Q') currentColor = 'other';
      continue;
    }

    // CMYK stroke color: "c m y k K"
    const cmykMatch = line.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+K$/);
    if (cmykMatch) {
      const c = parseFloat(cmykMatch[1]);
      const m = parseFloat(cmykMatch[2]);
      const y = parseFloat(cmykMatch[3]);
      const k = parseFloat(cmykMatch[4]);
      if (m > 0.8 && c < 0.2 && y < 0.2 && k < 0.2) currentColor = 'cut';
      else if (c > 0.8 && m < 0.2 && y < 0.2 && k < 0.2) currentColor = 'bleed';
      else currentColor = 'other';
      continue;
    }

    // XObject draw operator
    if (/^\/\S+\s+Do$/.test(line)) {
      doOpCount++;
      continue;
    }

    // MoveTo / LineTo
    const mlMatch = line.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+([ml])$/);
    if (mlMatch) {
      totalVectorOps++;
      curPathHasCoords = true;
      recordCoord(parseFloat(mlMatch[1]), parseFloat(mlMatch[2]));
      continue;
    }

    // Cubic Bézier curveTo (check anchor endpoint x3,y3 strictly; also validate control points finite)
    const cMatch = line.match(
      /^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+c$/
    );
    if (cMatch) {
      totalVectorOps++;
      curPathHasCoords = true;
      const x1 = parseFloat(cMatch[1]);
      const y1 = parseFloat(cMatch[2]);
      const x2 = parseFloat(cMatch[3]);
      const y2 = parseFloat(cMatch[4]);
      const x3 = parseFloat(cMatch[5]);
      const y3 = parseFloat(cMatch[6]);
      if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
        hasNonFiniteToken = true;
      }
      recordCoord(x3, y3);
      continue;
    }

    if (line === 'h') {
      curPathClosed = true;
      continue;
    }
    if (line === 'S' || line === 's' || line === 'B' || line === 'b') {
      if (line === 's' || line === 'b') curPathClosed = true;
      if (curPathHasCoords) {
        if (currentColor === 'cut') {
          cutPathCount++;
          if (curPathClosed) cutClosedCount++;
        } else if (currentColor === 'bleed') {
          bleedPathCount++;
          if (curPathClosed) bleedClosedCount++;
        }
      }
      curPathHasCoords = false;
      curPathClosed = false;
    }
  }

  return {
    hasNonFiniteToken,
    cutPathCount,
    bleedPathCount,
    cutClosedCount,
    bleedClosedCount,
    doOpCount,
    totalVectorOps,
    outOfMediaBoxCount,
    outOfCropBoxCount,
    minMarginMm: Number.isFinite(minMarginPt) ? r3(minMarginPt * PT_TO_MM) : null,
    cutBoundsPt: Number.isFinite(cutBoundsPt.minX) ? cutBoundsPt : null,
    bleedBoundsPt: Number.isFinite(bleedBoundsPt.minX) ? bleedBoundsPt : null,
  };
}

/**
 * Validate an exported production PDF (Uint8Array / ArrayBuffer) against expected sticker/sheet specs.
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {object} expectedSpec
 * @param {'split'|'sheet'} [expectedSpec.mode='split']
 * @param {number} [expectedSpec.expectedStickerCount]
 * @param {Array} [expectedSpec.contoursMm]
 * @param {boolean} [expectedSpec.expectBleed=true]
 * @param {boolean} [expectedSpec.expectArtwork=true]
 * @param {number} [expectedSpec.expectedSheetWidthMm]
 * @param {number} [expectedSpec.expectedSheetHeightMm]
 * @param {number} [expectedSpec.dimToleranceMm=0.15]
 */
export async function validateProductionPdf(pdfBytes, expectedSpec = {}) {
  const {
    mode = 'split',
    expectedStickerCount = null,
    contoursMm = null,
    expectBleed = true,
    expectArtwork = true,
    expectedSheetWidthMm = null,
    expectedSheetHeightMm = null,
    dimToleranceMm = 0.15,
  } = expectedSpec;

  const errors = [];
  const warnings = [];
  const perPage = [];

  if (!pdfBytes || pdfBytes.byteLength === 0) {
    return {
      valid: false,
      productionReady: false,
      mode,
      pageCount: 0,
      expectedCount: expectedStickerCount ?? (Array.isArray(contoursMm) ? contoursMm.length : null),
      totalCutPaths: 0,
      totalBleedPaths: 0,
      totalArtworkXObjects: 0,
      perPage,
      errors: ['PDF đầu ra rỗng hoặc không tồn tại'],
      warnings,
    };
  }

  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes);
  } catch (err) {
    return {
      valid: false,
      productionReady: false,
      mode,
      pageCount: 0,
      expectedCount: expectedStickerCount ?? (Array.isArray(contoursMm) ? contoursMm.length : null),
      totalCutPaths: 0,
      totalBleedPaths: 0,
      totalArtworkXObjects: 0,
      perPage,
      errors: [`Không thể giải mã cấu trúc PDF: ${err?.message || String(err)}`],
      warnings,
    };
  }

  const pages = doc.getPages();
  const pageCount = pages.length;
  const expectedCount =
    expectedStickerCount !== null
      ? expectedStickerCount
      : Array.isArray(contoursMm)
      ? contoursMm.length
      : null;

  if (pageCount === 0) {
    errors.push('PDF không có trang nào');
  } else if (mode === 'split' && expectedCount !== null && pageCount !== expectedCount) {
    errors.push(`Sai số trang PDF tách tem: thực tế ${pageCount} trang, kỳ vọng ${expectedCount} tem (có thể đã mất tem)`);
  } else if (mode === 'sheet' && pageCount !== 1) {
    errors.push(`PDF cả tờ phải có đúng 1 trang (thực tế ${pageCount} trang)`);
  }

  let totalCutPaths = 0;
  let totalBleedPaths = 0;
  let totalArtworkXObjects = 0;

  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    const page = pages[i];
    const pageErrors = [];
    const pageWarnings = [];

    const mediaBox = page.getMediaBox();
    const cropBox = page.getCropBox();
    const bleedBox = page.getBleedBox();
    const trimBox = page.getTrimBox();

    const boxesValid =
      isValidBox(mediaBox) && isValidBox(cropBox) && isValidBox(bleedBox) && isValidBox(trimBox);
    if (!boxesValid) {
      pageErrors.push('Một trong các box (MediaBox/CropBox/BleedBox/TrimBox) không hợp lệ hoặc chứa NaN/Infinity');
    } else {
      if (!boxContains(mediaBox, cropBox)) pageErrors.push('CropBox vượt ra ngoài MediaBox');
      if (!boxContains(cropBox, bleedBox)) pageErrors.push('BleedBox vượt ra ngoài CropBox');
      if (!boxContains(bleedBox, trimBox)) pageErrors.push('TrimBox vượt ra ngoài BleedBox');
    }

    const mediaWMm = r3((mediaBox?.width || 0) * PT_TO_MM);
    const mediaHMm = r3((mediaBox?.height || 0) * PT_TO_MM);
    const trimWMm = r3((trimBox?.width || 0) * PT_TO_MM);
    const trimHMm = r3((trimBox?.height || 0) * PT_TO_MM);

    if (
      mediaWMm < PRECISION_BLEED_BUDGET.minStickerSizeMm ||
      mediaHMm < PRECISION_BLEED_BUDGET.minStickerSizeMm ||
      mediaWMm > PRECISION_BLEED_BUDGET.maxStickerSizeMm ||
      mediaHMm > PRECISION_BLEED_BUDGET.maxStickerSizeMm
    ) {
      pageErrors.push(`Kích thước trang vật lý bất thường (${mediaWMm}×${mediaHMm} mm)`);
    }

    // Scale / Physical mm verification
    if (mode === 'split' && Array.isArray(contoursMm) && contoursMm[i]) {
      const expectedBounds = contourBoundsMm(contoursMm[i]);
      if (expectedBounds.valid) {
        const dw = Math.abs(trimWMm - expectedBounds.width);
        const dh = Math.abs(trimHMm - expectedBounds.height);
        if (dw > dimToleranceMm || dh > dimToleranceMm) {
          pageErrors.push(
            `Sai tỷ lệ/kích thước TrimBox: thực tế ${trimWMm}×${trimHMm} mm, kỳ vọng ${r3(expectedBounds.width)}×${r3(expectedBounds.height)} mm (lệch ${r3(Math.max(dw, dh))} mm)`
          );
        }
      }
    } else if (mode === 'sheet' && expectedSheetWidthMm && expectedSheetHeightMm) {
      const dw = Math.abs(trimWMm - expectedSheetWidthMm);
      const dh = Math.abs(trimHMm - expectedSheetHeightMm);
      if (dw > dimToleranceMm || dh > dimToleranceMm) {
        pageErrors.push(
          `Sai kích thước tờ TrimBox: thực tế ${trimWMm}×${trimHMm} mm, kỳ vọng ${expectedSheetWidthMm}×${expectedSheetHeightMm} mm`
        );
      }
    }

    // Decode & audit vector + artwork stream
    const stream = decodePageContentStream(page);
    const xObjCount = countPageXObjects(page);
    totalArtworkXObjects += xObjCount;

    if (!stream || stream.trim().length === 0) {
      pageErrors.push('Content stream trang PDF rỗng');
    }

    const parsed = parseVectorStream(
      stream,
      isValidBox(mediaBox) ? mediaBox : { x: 0, y: 0, width: 0, height: 0 },
      isValidBox(cropBox) ? cropBox : { x: 0, y: 0, width: 0, height: 0 }
    );
    totalCutPaths += parsed.cutPathCount;
    totalBleedPaths += parsed.bleedPathCount;

    if (parsed.hasNonFiniteToken) {
      pageErrors.push('Content stream chứa tọa độ NaN/Infinity');
    }
    if (parsed.outOfMediaBoxCount > 0) {
      pageErrors.push(`Có ${parsed.outOfMediaBoxCount} tọa độ vector vượt ngoài MediaBox (bị crop)`);
    }
    if (parsed.outOfCropBoxCount > 0) {
      pageErrors.push(`Có ${parsed.outOfCropBoxCount} tọa độ vector vượt ngoài CropBox (bị crop)`);
    }
    if (expectArtwork && (xObjCount === 0 || parsed.doOpCount === 0)) {
      pageErrors.push('Thiếu Artwork (không tìm thấy Image/Form XObject được vẽ trên trang)');
    }

    const expectedCutOnPage = mode === 'split' ? 1 : expectedCount;
    if (expectedCutOnPage !== null && parsed.cutPathCount !== expectedCutOnPage) {
      pageErrors.push(`Sai số đường CUT Magenta: thực tế ${parsed.cutPathCount}, kỳ vọng ${expectedCutOnPage}`);
    }
    if (parsed.cutPathCount > 0 && parsed.cutClosedCount !== parsed.cutPathCount) {
      pageErrors.push(`Có đường CUT không khép kín (${parsed.cutClosedCount}/${parsed.cutPathCount} khép kín)`);
    }

    if (expectBleed) {
      const expectedBleedOnPage = mode === 'split' ? 1 : expectedCount;
      if (expectedBleedOnPage !== null && parsed.bleedPathCount !== expectedBleedOnPage) {
        pageErrors.push(`Sai số đường BLEED Cyan: thực tế ${parsed.bleedPathCount}, kỳ vọng ${expectedBleedOnPage}`);
      }
      if (parsed.bleedPathCount > 0 && parsed.bleedClosedCount !== parsed.bleedPathCount) {
        pageErrors.push(`Có đường BLEED không khép kín (${parsed.bleedClosedCount}/${parsed.bleedPathCount} khép kín)`);
      }
    }

    // Verify CUT vector bounds align with TrimBox on split pages (no Artwork <-> Cutline offset shift)
    if (mode === 'split' && parsed.cutBoundsPt && isValidBox(trimBox)) {
      const shiftX = Math.abs(parsed.cutBoundsPt.minX - trimBox.x) * PT_TO_MM;
      const shiftY = Math.abs(parsed.cutBoundsPt.minY - trimBox.y) * PT_TO_MM;
      const shiftR = Math.abs(parsed.cutBoundsPt.maxX - (trimBox.x + trimBox.width)) * PT_TO_MM;
      const shiftT = Math.abs(parsed.cutBoundsPt.maxY - (trimBox.y + trimBox.height)) * PT_TO_MM;
      const maxShiftMm = Math.max(shiftX, shiftY, shiftR, shiftT);
      if (maxShiftMm > 0.6) {
        pageErrors.push(`Đường CUT bị lệch vị trí so với TrimBox/Artwork (${r3(maxShiftMm)} mm)`);
      }
    }

    for (const e of pageErrors) errors.push(`Trang #${pageNum}: ${e}`);
    for (const w of pageWarnings) warnings.push(`Trang #${pageNum}: ${w}`);

    perPage.push({
      page: pageNum,
      valid: pageErrors.length === 0,
      mediaMm: { w: mediaWMm, h: mediaHMm },
      trimMm: { w: trimWMm, h: trimHMm },
      xObjectCount: xObjCount,
      doOpCount: parsed.doOpCount,
      cutPathCount: parsed.cutPathCount,
      bleedPathCount: parsed.bleedPathCount,
      totalVectorOps: parsed.totalVectorOps,
      outOfMediaBoxCount: parsed.outOfMediaBoxCount,
      outOfCropBoxCount: parsed.outOfCropBoxCount,
      minMarginMm: parsed.minMarginMm,
      errors: pageErrors,
      warnings: pageWarnings,
    });
  }

  const valid = pageCount > 0 && errors.length === 0;
  return {
    valid,
    productionReady: valid,
    mode,
    pageCount,
    expectedCount,
    totalCutPaths,
    totalBleedPaths,
    totalArtworkXObjects,
    perPage,
    errors,
    warnings,
  };
}
