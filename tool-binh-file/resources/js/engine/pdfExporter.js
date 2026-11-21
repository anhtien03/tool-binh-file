import {
  PDFDocument,
  StandardFonts,
  cmyk,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';

/**
 * Inspect MediaBox and TrimBox of each source page WITHOUT destroying Bleed.
 */
function extractSourceBoxes(srcPage, declaredBleedMm) {
  const mediaBox = srcPage.getMediaBox();
  let trimBox = mediaBox;
  let hasExplicitTrim = false;

  try {
    const tb = srcPage.getTrimBox();
    if (
      tb &&
      tb.width > 0 &&
      tb.height > 0 &&
      (Math.abs(tb.width - mediaBox.width) > 0.5 || Math.abs(tb.height - mediaBox.height) > 0.5)
    ) {
      trimBox = tb;
      hasExplicitTrim = true;
    }
  } catch {
    // Fallback to MediaBox
  }

  const bleedPt = Math.max(0, Number(declaredBleedMm) || 0) * MM_TO_PT;
  if (!hasExplicitTrim && bleedPt > 0 && mediaBox.width > 2 * bleedPt && mediaBox.height > 2 * bleedPt) {
    trimBox = {
      x: mediaBox.x + bleedPt,
      y: mediaBox.y + bleedPt,
      width: mediaBox.width - 2 * bleedPt,
      height: mediaBox.height - 2 * bleedPt,
    };
  }

  return {
    mediaBox,
    trimBox,
    // Offset of TrimBox bottom-left inside MediaBox (in pt)
    trimOffsetX: trimBox.x - mediaBox.x,
    trimOffsetY: trimBox.y - mediaBox.y,
    mediaW: mediaBox.width,
    mediaH: mediaBox.height,
    trimW: trimBox.width,
    trimH: trimBox.height,
  };
}

/**
 * Compute pdf-lib drawPage options so that the source page's TrimBox aligns
 * identically with (trimXPt, trimYPt, trimWPt, trimHPt) at 0°, 90°, 180°, or 270°,
 * while keeping full source Bleed intact around it (clipped via Smart Bleed Clip).
 */
function computeDrawPageOptions(placement, boxInfo, sheetHeightPt) {
  const trimXPt = placement.x * MM_TO_PT;
  const trimYPt = sheetHeightPt - (placement.y + placement.trimH) * MM_TO_PT;
  const rot = ((placement.rotate % 360) + 360) % 360;

  const isRotated90 = rot === 90 || rot === 270;
  const targetUnrotW = (isRotated90 ? placement.trimH : placement.trimW) * MM_TO_PT;
  const targetUnrotH = (isRotated90 ? placement.trimW : placement.trimH) * MM_TO_PT;

  const sx = targetUnrotW / Math.max(0.001, boxInfo.trimW);
  const sy = targetUnrotH / Math.max(0.001, boxInfo.trimH);

  const drawW = boxInfo.mediaW * sx;
  const drawH = boxInfo.mediaH * sy;
  const offX = boxInfo.trimOffsetX * sx;
  const offY = boxInfo.trimOffsetY * sy;

  // Map unrotated MediaBox origin (0,0) such that unrotated TrimBox (offX, offY) lands at TrimRect
  if (rot === 0) {
    return {
      x: trimXPt - offX,
      y: trimYPt - offY,
      width: drawW,
      height: drawH,
      rotate: degrees(0),
    };
  }
  if (rot === 90) {
    // 90° CCW around (x,y): unrotated (u,v) -> (x - v, y + u)
    // We want TrimBox [offX, offX+targetUnrotW] x [offY, offY+targetUnrotH]
    // to map to [trimXPt, trimXPt + targetUnrotH] x [trimYPt, trimYPt + targetUnrotW]
    // Wait: u in [offX, offX+targetUnrotW] -> y + u in [trimYPt, trimYPt+targetUnrotW] => y = trimYPt - offX
    // v in [offY, offY+targetUnrotH] -> x - v in [trimXPt, trimXPt+targetUnrotH] => x = trimXPt + targetUnrotH + offY
    return {
      x: trimXPt + targetUnrotH + offY,
      y: trimYPt - offX,
      width: drawW,
      height: drawH,
      rotate: degrees(90),
    };
  }
  if (rot === 180) {
    // 180° around (x,y): (u,v) -> (x - u, y - v)
    return {
      x: trimXPt + targetUnrotW + offX,
      y: trimYPt + targetUnrotH + offY,
      width: drawW,
      height: drawH,
      rotate: degrees(180),
    };
  }
  // 270° CCW (-90° CW): (u,v) -> (x + v, y - u)
  return {
    x: trimXPt - offY,
    y: trimYPt + targetUnrotW + offX,
    width: drawW,
    height: drawH,
    rotate: degrees(270),
  };
}

/**
 * Export Zero-Rasterization Vector PDF using pdf-lib from a computed SheetPlan[]
 * Supports either a single File or an array of { file } / File objects.
 */
export async function exportImposedPdf(sourceFilesInput, plan, config) {
  const fileList = Array.isArray(sourceFilesInput)
    ? sourceFilesInput.map((f) => (f instanceof File ? f : f.file))
    : [sourceFilesInput];

  const destDoc = await PDFDocument.create();
  const srcBoxes = [];
  const embeddedPages = [];

  for (const file of fileList) {
    const pdfBytes = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(pdfBytes);
    const srcPages = srcDoc.getPages();
    srcPages.forEach((p) => srcBoxes.push(extractSourceBoxes(p, config.bleedMm)));
    const embedded = await destDoc.embedPages(srcPages);
    embedded.forEach((ep) => embeddedPages.push(ep));
  }

  const helvetica = await destDoc.embedFont(StandardFonts.Helvetica);

  const sheetWPt = plan.sheetDim.width * MM_TO_PT;
  const sheetHPt = plan.sheetDim.height * MM_TO_PT;

  // Prepress CMYK mark color: K100 (or Registration C100 M100 Y100 K100)
  const markColor = config.registrationColor ? cmyk(1, 1, 1, 1) : cmyk(0, 0, 0, 1);
  const markThickness = Math.max(0.15, Number(config.markThicknessPt) || 0.25);

  for (const sheet of plan.sheets) {
    const destPage = destDoc.addPage([sheetWPt, sheetHPt]);

    // 1. Draw all vector placements with Smart Bleed Clipping
    for (const p of sheet.placements) {
      const embedded = embeddedPages[p.pageIndex];
      const boxInfo = srcBoxes[p.pageIndex];
      if (!embedded || !boxInfo) continue;

      const trimXPt = p.x * MM_TO_PT;
      const trimYPt = sheetHPt - (p.y + p.trimH) * MM_TO_PT;
      const trimWPt = p.trimW * MM_TO_PT;
      const trimHPt = p.trimH * MM_TO_PT;

      const clipX = trimXPt - p.clipBleed.left * MM_TO_PT;
      const clipY = trimYPt - p.clipBleed.bottom * MM_TO_PT;
      const clipW = trimWPt + (p.clipBleed.left + p.clipBleed.right) * MM_TO_PT;
      const clipH = trimHPt + (p.clipBleed.top + p.clipBleed.bottom) * MM_TO_PT;

      destPage.pushOperators(
        pushGraphicsState(),
        rectangle(clipX, clipY, clipW, clipH),
        clip(),
        endPath()
      );

      const drawOpts = computeDrawPageOptions(p, boxInfo, sheetHPt);
      destPage.drawPage(embedded, drawOpts);

      destPage.pushOperators(popGraphicsState());
    }

    // 2. Draw CMYK Crop Marks (Western or Japanese Tonbo)
    for (const line of sheet.marks.lines) {
      destPage.drawLine({
        start: { x: line.x1 * MM_TO_PT, y: sheetHPt - line.y1 * MM_TO_PT },
        end: { x: line.x2 * MM_TO_PT, y: sheetHPt - line.y2 * MM_TO_PT },
        thickness: markThickness,
        color: markColor,
      });
    }

    // 3. Draw 4 Registration Targets (Ốc chồng màu)
    for (const reg of sheet.marks.registrations) {
      const cx = reg.cx * MM_TO_PT;
      const cy = sheetHPt - reg.cy * MM_TO_PT;
      const r = reg.radius * MM_TO_PT;
      const half = (reg.crossLen / 2) * MM_TO_PT;

      destPage.drawCircle({
        x: cx,
        y: cy,
        size: r,
        borderColor: markColor,
        borderWidth: markThickness,
      });
      destPage.drawLine({
        start: { x: cx - half, y: cy },
        end: { x: cx + half, y: cy },
        thickness: markThickness,
        color: markColor,
      });
      destPage.drawLine({
        start: { x: cx, y: cy - half },
        end: { x: cx, y: cy + half },
        thickness: markThickness,
        color: markColor,
      });
    }

    // 4. Draw Slug Line / Sheet Report along bottom edge
    if (sheet.slugText) {
      destPage.drawText(sheet.slugText, {
        x: 6 * MM_TO_PT,
        y: 2.5 * MM_TO_PT,
        size: 6.5,
        font: helvetica,
        color: cmyk(0, 0, 0, 1),
      });
    }
  }

  return await destDoc.save();
}

/**
 * Draw 4 corner optical registration marks (Boong máy bế) onto a pdf-lib page
 */
function drawPontMarksOnPdfPage(page, pontMarks, sheetHPt) {
  const black = cmyk(0, 0, 0, 1);
  for (const pm of pontMarks || []) {
    const cx = pm.cx * MM_TO_PT;
    const cy = sheetHPt - pm.cy * MM_TO_PT;
    const r = (pm.size / 2) * MM_TO_PT;

    if (pm.type === 'circle5mm') {
      page.drawCircle({ x: cx, y: cy, size: r, color: black });
    } else if (pm.type === 'circleHollow') {
      page.drawCircle({ x: cx, y: cy, size: r, borderColor: black, borderWidth: 0.7 });
    } else if (pm.type === 'graphtec') {
      const arm = 10 * MM_TO_PT;
      const sx = pm.corner.includes('L') ? 1 : -1;
      const sy = pm.corner.includes('T') ? -1 : 1;
      page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + sx * arm, y: cy }, thickness: 1.4, color: black });
      page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + sy * arm }, thickness: 1.4, color: black });
    }
  }
}

/**
 * Export Sticker Print PDF (artwork + 4 boong marks, NO cut paths)
 * OR Sticker Cut PDF (4 boong marks + CutContour vector paths only)
 */
export async function exportStickerPdf(sourceFilesInput, plan, config, exportRole = 'print') {
  const fileList = Array.isArray(sourceFilesInput)
    ? sourceFilesInput.map((f) => (f instanceof File ? f : f.file))
    : [sourceFilesInput];

  const destDoc = await PDFDocument.create();
  const srcBoxes = [];
  const embeddedPages = [];

  if (exportRole === 'print') {
    for (const file of fileList) {
      const pdfBytes = await file.arrayBuffer();
      const srcDoc = await PDFDocument.load(pdfBytes);
      const srcPages = srcDoc.getPages();
      srcPages.forEach((p) => srcBoxes.push(extractSourceBoxes(p, config.bleedMm)));
      const embedded = await destDoc.embedPages(srcPages);
      embedded.forEach((ep) => embeddedPages.push(ep));
    }
  }

  const helvetica = await destDoc.embedFont(StandardFonts.Helvetica);
  const sheetWPt = plan.sheetDim.width * MM_TO_PT;
  const sheetHPt = plan.sheetDim.height * MM_TO_PT;
  const cutMagenta = cmyk(0, 1, 0, 0);

  for (const sheet of plan.sheets) {
    const destPage = destDoc.addPage([sheetWPt, sheetHPt]);

    if (exportRole === 'print') {
      for (const p of sheet.placements) {
        const embedded = embeddedPages[p.pageIndex];
        const boxInfo = srcBoxes[p.pageIndex];
        if (!embedded || !boxInfo) continue;

        const trimXPt = p.x * MM_TO_PT;
        const trimYPt = sheetHPt - (p.y + p.trimH) * MM_TO_PT;
        const trimWPt = p.trimW * MM_TO_PT;
        const trimHPt = p.trimH * MM_TO_PT;

        const clipX = trimXPt - p.clipBleed.left * MM_TO_PT;
        const clipY = trimYPt - p.clipBleed.bottom * MM_TO_PT;
        const clipW = trimWPt + (p.clipBleed.left + p.clipBleed.right) * MM_TO_PT;
        const clipH = trimHPt + (p.clipBleed.top + p.clipBleed.bottom) * MM_TO_PT;

        destPage.pushOperators(pushGraphicsState(), rectangle(clipX, clipY, clipW, clipH), clip(), endPath());
        destPage.drawPage(embedded, computeDrawPageOptions(p, boxInfo, sheetHPt));
        destPage.pushOperators(popGraphicsState());
      }
    } else {
      for (const cp of sheet.stickerCutPaths || []) {
        if (cp.kind === 'line') {
          destPage.drawLine({
            start: { x: cp.x1 * MM_TO_PT, y: sheetHPt - cp.y1 * MM_TO_PT },
            end: { x: cp.x2 * MM_TO_PT, y: sheetHPt - cp.y2 * MM_TO_PT },
            thickness: 0.25,
            color: cutMagenta,
          });
        } else if (cp.kind === 'ellipse') {
          destPage.drawEllipse({
            x: cp.cx * MM_TO_PT,
            y: sheetHPt - cp.cy * MM_TO_PT,
            xScale: cp.rx * MM_TO_PT,
            yScale: cp.ry * MM_TO_PT,
            borderColor: cutMagenta,
            borderWidth: 0.25,
          });
        } else if (cp.kind === 'rect') {
          destPage.drawRectangle({
            x: cp.x * MM_TO_PT,
            y: sheetHPt - (cp.y + cp.h) * MM_TO_PT,
            width: cp.w * MM_TO_PT,
            height: cp.h * MM_TO_PT,
            borderColor: cutMagenta,
            borderWidth: 0.25,
          });
        }
      }
    }

    drawPontMarksOnPdfPage(destPage, sheet.pontMarks, sheetHPt);

    if (sheet.slugText) {
      destPage.drawText(`${sheet.slugText} [${exportRole === 'print' ? 'FILE IN' : 'FILE BE'}]`, {
        x: 6 * MM_TO_PT,
        y: 2.5 * MM_TO_PT,
        size: 6.5,
        font: helvetica,
        color: cmyk(0, 0, 0, 1),
      });
    }
  }

  return await destDoc.save();
}

/**
 * Export 1:1 Sticker Cut File as SVG (for Illustrator / Corel / FineCut / Cutting Master)
 */
export function exportStickerCutSvg(plan, sheetIndex = 0) {
  const sheet = plan.sheets[sheetIndex];
  if (!sheet) return '';
  const { width, height } = plan.sheetDim;

  const marksSvg = (sheet.pontMarks || [])
    .map((pm) => {
      if (pm.type === 'circle5mm') return `<circle cx="${pm.cx}" cy="${pm.cy}" r="${pm.size / 2}" fill="#000000" />`;
      if (pm.type === 'circleHollow') return `<circle cx="${pm.cx}" cy="${pm.cy}" r="${pm.size / 2}" fill="none" stroke="#000000" stroke-width="0.3" />`;
      const arm = 10;
      const sx = pm.corner.includes('L') ? 1 : -1;
      const sy = pm.corner.includes('T') ? 1 : -1;
      return `<path d="M ${pm.cx + sx * arm} ${pm.cy} L ${pm.cx} ${pm.cy} L ${pm.cx} ${pm.cy + sy * arm}" fill="none" stroke="#000000" stroke-width="0.5" />`;
    })
    .join('\n    ');

  const cutsSvg = (sheet.stickerCutPaths || [])
    .map((cp) => {
      if (cp.kind === 'line') return `<line x1="${cp.x1}" y1="${cp.y1}" x2="${cp.x2}" y2="${cp.y2}" stroke="#ec008c" stroke-width="0.2" />`;
      if (cp.kind === 'ellipse') return `<ellipse cx="${cp.cx}" cy="${cp.cy}" rx="${cp.rx}" ry="${cp.ry}" fill="none" stroke="#ec008c" stroke-width="0.2" />`;
      return `<rect x="${cp.x}" y="${cp.y}" width="${cp.w}" height="${cp.h}" rx="${cp.r || 0}" ry="${cp.r || 0}" fill="none" stroke="#ec008c" stroke-width="0.2" />`;
    })
    .join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
  <g id="Marks_Model_">
    ${marksSvg}
  </g>
  <g id="CutContour">
    ${cutsSvg}
  </g>
</svg>`;
}
