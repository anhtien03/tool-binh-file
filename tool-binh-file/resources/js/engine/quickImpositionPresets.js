import { PDFDocument } from 'pdf-lib';

/**
 * 1-Click Quick Imposition Presets for Tab Bình Cắt Xén (Card 14):
 * - Bình nhanh R4 (4-up chuẩn khổ in nhanh 325x430 / 330x480 / SRA3)
 * - Bình nhanh Lưới cắt xén (Namecard, Tờ rơi A5/A6, Voucher, Thẻ treo)
 */
export const QUICK_IMPOSITION_PRESETS = [
  {
    id: 'quick_r4',
    group: 'r4',
    label: 'Bình nhanh R4 (4-Up)',
    shortLabel: 'Bình nhanh R4',
    description: 'Xếp 2×2 (4 con/tờ) chuẩn khổ in nhanh 325×430mm, tự xoay tối ưu + dấu xén',
    settings: {
      paperSizeKey: 'D325x430',
      orientation: 'landscape',
      layoutType: 'optimal',
      cols: 2,
      rows: 2,
      gutterX: 3,
      gutterY: 3,
      bleedMm: 2,
      marginTop: 8,
      marginBottom: 8,
      marginLeft: 8,
      marginRight: 8,
      finishedSizePreset: 'auto',
      collation: 'stepAndRepeat',
    },
  },
  {
    id: 'grid_namecard_90x54',
    group: 'grid',
    label: 'Lưới Namecard (90×54)',
    shortLabel: 'Namecard 90×54',
    description: '20–24 card/tờ 325×430mm, bleed 1.5mm, rãnh cắt 2mm',
    settings: {
      paperSizeKey: 'D325x430',
      orientation: 'landscape',
      layoutType: 'optimal',
      finishedSizePreset: '90x54',
      targetTrimW: '90',
      targetTrimH: '54',
      gutterX: 2,
      gutterY: 2,
      bleedMm: 1.5,
      marginTop: 7,
      marginBottom: 7,
      marginLeft: 7,
      marginRight: 7,
      collation: 'stepAndRepeat',
    },
  },
  {
    id: 'grid_flyer_a5',
    group: 'grid',
    label: 'Lưới Tờ rơi A5 (148×210)',
    shortLabel: 'Tờ rơi A5',
    description: '4 tờ A5 trên khổ 325×430mm, bleed 2mm',
    settings: {
      paperSizeKey: 'D325x430',
      orientation: 'landscape',
      layoutType: 'optimal',
      finishedSizePreset: 'custom',
      targetTrimW: '148',
      targetTrimH: '210',
      gutterX: 3,
      gutterY: 3,
      bleedMm: 2,
      marginTop: 8,
      marginBottom: 8,
      marginLeft: 8,
      marginRight: 8,
      collation: 'stepAndRepeat',
    },
  },
  {
    id: 'grid_voucher_dl',
    group: 'grid',
    label: 'Lưới Voucher (70×180)',
    shortLabel: 'Voucher 70×180',
    description: 'Xếp tối ưu Voucher / Vé mời trên 325×430mm, bleed 2mm',
    settings: {
      paperSizeKey: 'D325x430',
      orientation: 'landscape',
      layoutType: 'optimal',
      finishedSizePreset: 'custom',
      targetTrimW: '70',
      targetTrimH: '180',
      gutterX: 2,
      gutterY: 2,
      bleedMm: 2,
      marginTop: 8,
      marginBottom: 8,
      marginLeft: 8,
      marginRight: 8,
      collation: 'stepAndRepeat',
    },
  },
];

/**
 * Compute Sheetwise (2-plate) Front & Back sheet pairings for duplex offset/digital printing.
 * Plate A (Front) receives odd source pages [0, 2, 4, ...].
 * Plate B (Back) receives even source pages [1, 3, 5, ...] with columns mirrored left↔right
 * in each row so front & back align when flipping the sheet horizontally on press.
 *
 * @param {number} totalPages
 * @param {number} cols
 * @param {number} rows
 * @returns {{ sheets: Array<{ sheetNumber: number, side: 'front'|'back', plate: 'A'|'B', pageIndices: (number|null)[] }>, plateACount: number, plateBCount: number }}
 */
export function computeSheetwiseLayout(totalPages, cols = 2, rows = 2) {
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const r = Math.max(1, Math.floor(Number(rows) || 1));
  const slotsPerSheet = c * r;
  const totalPairs = Math.max(1, Math.ceil(totalPages / 2));
  const sheetPairs = Math.max(1, Math.ceil(totalPairs / slotsPerSheet));

  const sheets = [];
  for (let s = 0; s < sheetPairs; s++) {
    const frontIndices = [];
    const backIndicesRaw = [];

    for (let slot = 0; slot < slotsPerSheet; slot++) {
      const pairIdx = s * slotsPerSheet + slot;
      const frontPg = pairIdx * 2 < totalPages ? pairIdx * 2 : null;
      const backPg = pairIdx * 2 + 1 < totalPages ? pairIdx * 2 + 1 : null;
      frontIndices.push(frontPg);
      backIndicesRaw.push(backPg);
    }

    // Mirror each row left ↔ right on Plate B (Back) for standard Sheetwise flip
    const backIndicesMirrored = [];
    for (let row = 0; row < r; row++) {
      const rowSlice = backIndicesRaw.slice(row * c, (row + 1) * c).reverse();
      backIndicesMirrored.push(...rowSlice);
    }

    sheets.push({
      sheetNumber: s + 1,
      side: 'front',
      plate: 'A',
      pageIndices: frontIndices,
    });
    sheets.push({
      sheetNumber: s + 1,
      side: 'back',
      plate: 'B',
      pageIndices: backIndicesMirrored,
    });
  }

  return {
    sheets,
    plateACount: sheetPairs,
    plateBCount: sheetPairs,
  };
}

/**
 * Split an imposed duplex PDF (alternating Front / Back pages) into separate Plate A (Front)
 * and Plate B (Back) PDFs for Sheetwise 2-plate offset printing.
 *
 * @param {Uint8Array} imposedDuplexPdfBytes
 * @returns {Promise<{ plateABytes: Uint8Array, plateBBytes: Uint8Array, plateAPages: number, plateBPages: number }>}
 */
export async function splitSheetwisePlatesPdf(imposedDuplexPdfBytes) {
  if (!imposedDuplexPdfBytes || imposedDuplexPdfBytes.length === 0) {
    throw new Error('Thiếu dữ liệu PDF bình bài để tách 2 kẽm Sheetwise.');
  }
  const srcDoc = await PDFDocument.load(imposedDuplexPdfBytes);
  const total = srcDoc.getPageCount();
  const plateADoc = await PDFDocument.create();
  const plateBDoc = await PDFDocument.create();

  for (let i = 0; i < total; i++) {
    const target = i % 2 === 0 ? plateADoc : plateBDoc;
    const [copied] = await target.copyPages(srcDoc, [i]);
    target.addPage(copied);
  }

  // If single-page PDF was provided, duplicate into Plate B cleanly or keep empty guard
  if (plateBDoc.getPageCount() === 0 && total > 0) {
    const [copied] = await plateBDoc.copyPages(srcDoc, [0]);
    plateBDoc.addPage(copied);
  }

  return {
    plateABytes: await plateADoc.save(),
    plateBBytes: await plateBDoc.save(),
    plateAPages: plateADoc.getPageCount(),
    plateBPages: plateBDoc.getPageCount(),
  };
}
