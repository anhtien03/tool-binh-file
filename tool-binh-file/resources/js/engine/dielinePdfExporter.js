import { PDFDocument, StandardFonts, cmyk } from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine';

/**
 * Export true 1:1 Vector Dieline PDF (CutContour = Magenta, Crease = Cyan dashed)
 * Optionally embeds uploaded artwork dataUrl aligned to the dieline bounds.
 */
export async function exportDielinePdf(dieline, artworkDataUrl = null) {
  const doc = await PDFDocument.create();
  const marginMm = 12;
  const sheetW = (dieline.bounds.width + marginMm * 2) * MM_TO_PT;
  const sheetH = (dieline.bounds.height + marginMm * 2) * MM_TO_PT;

  const page = doc.addPage([sheetW, sheetH]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const toPdfX = (xMm) => (marginMm + xMm) * MM_TO_PT;
  const toPdfY = (yMm) => sheetH - (marginMm + yMm) * MM_TO_PT;

  // Optional Artwork background aligned 1:1 to dieline bounding box
  if (artworkDataUrl) {
    try {
      const res = await fetch(artworkDataUrl);
      const imgBytes = await res.arrayBuffer();
      const isPng = artworkDataUrl.startsWith('data:image/png');
      const img = isPng ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
      page.drawImage(img, {
        x: toPdfX(0),
        y: toPdfY(dieline.bounds.height),
        width: dieline.bounds.width * MM_TO_PT,
        height: dieline.bounds.height * MM_TO_PT,
      });
    } catch (err) {
      console.warn('Could not embed artwork into dieline PDF:', err);
    }
  }

  // Draw Crease lines (CMYK Cyan dashed)
  const creaseColor = cmyk(1, 0, 0, 0);
  for (const [a, b] of dieline.creaseSegments) {
    page.drawLine({
      start: { x: toPdfX(a[0]), y: toPdfY(a[1]) },
      end: { x: toPdfX(b[0]), y: toPdfY(b[1]) },
      thickness: 0.5,
      color: creaseColor,
      dashArray: [4, 3],
    });
  }

  // Draw CutContour lines (CMYK Magenta solid)
  const cutColor = cmyk(0, 1, 0, 0);
  for (const [a, b] of dieline.cutSegments) {
    page.drawLine({
      start: { x: toPdfX(a[0]), y: toPdfY(a[1]) },
      end: { x: toPdfX(b[0]), y: toPdfY(b[1]) },
      thickness: 0.5,
      color: cutColor,
    });
  }

  // Technical legend & dimensions
  const { L, W, H, thickness } = dieline.params;
  const legend = `Khuon Be 1:1 (${dieline.templateId.toUpperCase()}) | L:${L} x W:${W} x H:${H} mm (Giay ${thickness}mm) | Ban trai: ${dieline.bounds.width} x ${dieline.bounds.height} mm | Do=Cat(Cut) Xanh=Can(Crease)`;
  page.drawText(legend, {
    x: 8 * MM_TO_PT,
    y: 4 * MM_TO_PT,
    size: 7,
    font,
    color: cmyk(0, 0, 0, 1),
  });

  return await doc.save();
}

/**
 * Export 1:1 Imposed Dieline Sheet PDF (multiple box blanks nested onto a Press/Offset sheet)
 */
export async function exportImposedDielinePdf(dieline, sheetDim, placements) {
  const doc = await PDFDocument.create();
  const sheetWPt = sheetDim.width * MM_TO_PT;
  const sheetHPt = sheetDim.height * MM_TO_PT;
  const page = doc.addPage([sheetWPt, sheetHPt]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const creaseColor = cmyk(1, 0, 0, 0);
  const cutColor = cmyk(0, 1, 0, 0);
  const bw = dieline.bounds.width;
  const bh = dieline.bounds.height;

  const transformPoint = (px, py, p) => {
    let lx = px;
    let ly = py;
    if (p.rotate === 90) {
      lx = bh - py;
      ly = px;
    } else if (p.rotate === 180) {
      lx = bw - px;
      ly = bh - py;
    } else if (p.rotate === 270) {
      lx = py;
      ly = bw - px;
    }
    return [(p.x + lx) * MM_TO_PT, sheetHPt - (p.y + ly) * MM_TO_PT];
  };

  for (const p of placements) {
    for (const [a, b] of dieline.creaseSegments) {
      const [x1, y1] = transformPoint(a[0], a[1], p);
      const [x2, y2] = transformPoint(b[0], b[1], p);
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: 0.45,
        color: creaseColor,
        dashArray: [4, 3],
      });
    }
    for (const [a, b] of dieline.cutSegments) {
      const [x1, y1] = transformPoint(a[0], a[1], p);
      const [x2, y2] = transformPoint(b[0], b[1], p);
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: 0.45,
        color: cutColor,
      });
    }
  }

  const { L, W, H, thickness } = dieline.params;
  const slug = `Toolbinhfile | Binh Khuon ${dieline.code} (${L}x${W}x${H}mm, CAL ${thickness}) | ${placements.length} khuon/to | Kho giay ${sheetDim.width}x${sheetDim.height}mm`;
  page.drawText(slug, {
    x: 6 * MM_TO_PT,
    y: 3 * MM_TO_PT,
    size: 6.5,
    font,
    color: cmyk(0, 0, 0, 1),
  });

  return await doc.save();
}
