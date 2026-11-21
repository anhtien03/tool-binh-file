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
import { MM_TO_PT } from './impositionEngine';

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
