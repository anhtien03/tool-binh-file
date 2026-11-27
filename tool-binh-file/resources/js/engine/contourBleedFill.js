/**
 * PrintKit — Contour Bleed Color Fill / Edge-Extend Helper (Additive UI/Preview & Export Helper)
 *
 * Fills the outward BLEED contour zone (Layer 3 equivalent) with each sticker's actual outer-rim
 * color (auto-sampled inward from the artwork edge) or a user-selected solid color, then composites
 * the sticker artwork cleanly on top with exterior white paper knocked out via edge flood-fill.
 *
 * ZERO edits to any LOCKED engine file.
 */

export function traceContourPathOnCtx(ctx, poly, padMm, scaleX, scaleY = scaleX) {
  if (!poly || poly.length < 2) return false;
  ctx.beginPath();
  if (poly.beziersMm && poly.beziersMm.length >= 2) {
    for (const cmd of poly.beziersMm) {
      if (cmd.type === 'M' && cmd.to) {
        ctx.moveTo((padMm + cmd.to[0]) * scaleX, (padMm + cmd.to[1]) * scaleY);
      } else if (cmd.type === 'L' && cmd.to) {
        ctx.lineTo((padMm + cmd.to[0]) * scaleX, (padMm + cmd.to[1]) * scaleY);
      } else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
        ctx.bezierCurveTo(
          (padMm + cmd.c1[0]) * scaleX,
          (padMm + cmd.c1[1]) * scaleY,
          (padMm + cmd.c2[0]) * scaleX,
          (padMm + cmd.c2[1]) * scaleY,
          (padMm + cmd.to[0]) * scaleX,
          (padMm + cmd.to[1]) * scaleY
        );
      }
    }
  } else {
    for (let i = 0; i < poly.length; i++) {
      const vx = (padMm + poly[i][0]) * scaleX;
      const vy = (padMm + poly[i][1]) * scaleY;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
  }
  ctx.closePath();
  return true;
}

/**
 * Create a copy of `sourceCanvas` where exterior near-white paper background pixels
 * (4-connected from the canvas borders) are made transparent (alpha = 0), while interior
 * white design elements inside stickers remain 100% opaque.
 */
export function buildPaperTransparentCanvas(sourceCanvas, whiteThreshold = 242) {
  if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) return sourceCanvas;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const srcCtx = sourceCanvas.getContext('2d');
  const imgData = srcCtx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Fast check: if corners are already transparent (e.g. PNG with alpha), return as-is
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
  if (corners.every((idx) => d[idx + 3] < 200)) {
    return sourceCanvas;
  }

  const isNearWhite = (pIdx) => {
    const i = pIdx * 4;
    return d[i + 3] < 30 || (d[i] >= whiteThreshold && d[i + 1] >= whiteThreshold && d[i + 2] >= whiteThreshold);
  };

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const trySeed = (x, y) => {
    const p = y * w + x;
    if (!visited[p] && isNearWhite(p)) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) {
      const np = p - 1;
      if (!visited[np] && isNearWhite(np)) { visited[np] = 1; queue[tail++] = np; }
    }
    if (x + 1 < w) {
      const np = p + 1;
      if (!visited[np] && isNearWhite(np)) { visited[np] = 1; queue[tail++] = np; }
    }
    if (y > 0) {
      const np = p - w;
      if (!visited[np] && isNearWhite(np)) { visited[np] = 1; queue[tail++] = np; }
    }
    if (y + 1 < h) {
      const np = p + w;
      if (!visited[np] && isNearWhite(np)) { visited[np] = 1; queue[tail++] = np; }
    }
  }

  // Knock out exterior paper
  for (let p = 0; p < w * h; p++) {
    if (visited[p]) {
      d[p * 4 + 3] = 0;
    }
  }

  // Smart 3-pass 8-connected anti-alias / WebP white-fringe removal along the exterior paper boundary:
  // Compares each border pixel's luminance against its inward artwork neighbor (3px away from paper)
  // so dark stickers (e.g. dark green) lose 100% of their bright white-blended halo even in deep
  // concave valleys, while light stickers (e.g. cream) are never over-eroded.
  let curMask = visited;
  for (let pass = 0; pass < 3; pass++) {
    const nextMask = new Uint8Array(curMask);
    for (let y = 3; y < h - 3; y++) {
      for (let x = 3; x < w - 3; x++) {
        const p = y * w + x;
        if (curMask[p]) continue;
        const nL = curMask[p - 1], nR = curMask[p + 1], nU = curMask[p - w], nD = curMask[p + w];
        const nUL = curMask[p - w - 1], nUR = curMask[p - w + 1], nDL = curMask[p + w - 1], nDR = curMask[p + w + 1];
        if (!nL && !nR && !nU && !nD && !nUL && !nUR && !nDL && !nDR) continue;

        const i = p * 4;
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

        // Probe 3px inward away from exterior paper (using 8-neighbor gradient direction)
        const gx = (nL || nUL || nDL ? 1 : 0) - (nR || nUR || nDR ? 1 : 0);
        const gy = (nU || nUL || nUR ? 1 : 0) - (nD || nDL || nDR ? 1 : 0);
        const ip = (y + gy * 3) * w + (x + gx * 3);
        const ii = ip * 4;
        const inLum = curMask[ip] ? lum : 0.299 * d[ii] + 0.587 * d[ii + 1] + 0.114 * d[ii + 2];

        const lumDiff = lum - inLum;
        if ((d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) || lumDiff > 18) {
          d[i + 3] = 0;
          nextMask[p] = 1;
        } else if (lumDiff > 7) {
          const factor = Math.max(0, Math.min(1, 1 - (lumDiff - 7) / 12));
          d[i + 3] = Math.round(d[i + 3] * factor);
        }
      }
    }
    curMask = nextMask;
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(imgData, 0, 0);
  return out;
}

/**
 * Sample the dominant/median non-white outer rim color of a sticker by probing inward
 * from its CUT contour perimeter toward its centroid.
 */
export function sampleStickerEdgeColor(sourceCanvas, cutPolyMm, totalWmm, totalHmm, fallbackHex = '#ffffff') {
  if (!sourceCanvas || !cutPolyMm || cutPolyMm.length < 3 || !totalWmm || !totalHmm) return fallbackHex;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const pxPerMmX = w / totalWmm;
  const pxPerMmY = h / totalHmm;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cutPolyMm) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const maxProbeMm = Math.max(1.5, Math.min(4.0, Math.min(maxX - minX, maxY - minY) * 0.22));

  // Read only the sticker's local bounding box for speed
  const bx0 = Math.max(0, Math.floor(minX * pxPerMmX));
  const by0 = Math.max(0, Math.floor(minY * pxPerMmY));
  const bx1 = Math.min(w - 1, Math.ceil(maxX * pxPerMmX));
  const by1 = Math.min(h - 1, Math.ceil(maxY * pxPerMmY));
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  if (bw <= 0 || bh <= 0) return fallbackHex;

  const data = sourceCanvas.getContext('2d').getImageData(bx0, by0, bw, bh).data;
  const rs = [];
  const gs = [];
  const bs = [];

  const sampleCount = Math.min(48, cutPolyMm.length);
  const step = Math.max(1, Math.floor(cutPolyMm.length / sampleCount));
  const probeSteps = [0.25, 0.55, 0.9, 1.35, 1.85, maxProbeMm];

  for (let i = 0; i < cutPolyMm.length; i += step) {
    const [px, py] = cutPolyMm[i];
    const dx = cx - px;
    const dy = cy - py;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.2) continue;
    const ux = dx / dist;
    const uy = dy / dist;

    // Walk inward until hitting the first solid non-white artwork rim pixel
    for (const dMm of probeSteps) {
      if (dMm >= dist * 0.85) break;
      const sx = Math.round((px + ux * dMm) * pxPerMmX) - bx0;
      const sy = Math.round((py + uy * dMm) * pxPerMmY) - by0;
      if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) continue;
      const idx = (sy * bw + sx) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      if (a >= 200 && !(r >= 242 && g >= 242 && b >= 242)) {
        rs.push(r);
        gs.push(g);
        bs.push(b);
        break;
      }
    }
  }

  if (rs.length === 0) return fallbackHex;
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = Math.floor(rs.length / 2);
  return `rgb(${rs[mid]}, ${gs[mid]}, ${bs[mid]})`;
}

/**
 * Draw bleed-filled stickers onto a preview canvas context, compositing transparent artwork on top.
 */
export function drawContourBleedFillPreview(
  ctx,
  { rawCanvas, transparentCanvas, sizeMm, contoursMm, padMm, scale, mode = 'auto', solidColorHex = '#f2ead3' }
) {
  const x0 = padMm * scale;
  const y0 = padMm * scale;
  const w0 = sizeMm.w * scale;
  const h0 = sizeMm.h * scale;
  const bleedList = contoursMm?.bleedContoursMm || [];

  if (mode === 'off' || bleedList.length === 0) {
    ctx.drawImage(rawCanvas, x0, y0, w0, h0);
    return;
  }

  // 1. Fill each sticker's BLEED contour on the bottom layer
  ctx.save();
  for (let i = 0; i < bleedList.length; i++) {
    const bPoly = bleedList[i];
    if (!bPoly || bPoly.invalid || bPoly.length < 3) continue;
    const fillColor =
      mode === 'solid'
        ? solidColorHex
        : sampleStickerEdgeColor(rawCanvas, contoursMm[i], sizeMm.w, sizeMm.h, solidColorHex);
    ctx.fillStyle = fillColor;
    if (traceContourPathOnCtx(ctx, bPoly, padMm, scale, scale)) {
      ctx.fill();
    }
  }
  ctx.restore();

  // 2. Composite exterior-paper-knocked-out artwork cleanly on top of the bleed fill
  ctx.drawImage(transparentCanvas || rawCanvas, x0, y0, w0, h0);
}

/**
 * Build a full-resolution bleed-filled composite canvas (same dimensions as `rawCanvas`)
 * so exported PDFs include the actual filled bleed color underneath the sticker artwork.
 */
export function buildBleedFilledExportCanvas(
  rawCanvas,
  transparentCanvas,
  sizeMm,
  contoursMm,
  { mode = 'auto', solidColorHex = '#f2ead3' } = {}
) {
  const bleedList = contoursMm?.bleedContoursMm || [];
  if (!rawCanvas || mode === 'off' || bleedList.length === 0) return rawCanvas;

  const out = document.createElement('canvas');
  out.width = rawCanvas.width;
  out.height = rawCanvas.height;
  const ctx = out.getContext('2d');
  // Keep exterior background 100% TRANSPARENT (alpha = 0) so overlapping BLEED clips
  // in V1/H.2 PRINT.pdf NEVER paint opaque white pixels over a neighboring sticker's bleed!
  ctx.clearRect(0, 0, out.width, out.height);

  const scaleX = out.width / sizeMm.w;
  const scaleY = out.height / sizeMm.h;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < bleedList.length; i++) {
    const bPoly = bleedList[i];
    if (!bPoly || bPoly.invalid || bPoly.length < 3) continue;
    const fillColor =
      mode === 'solid'
        ? solidColorHex
        : sampleStickerEdgeColor(rawCanvas, contoursMm[i], sizeMm.w, sizeMm.h, solidColorHex);
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = fillColor;
    // Slight 0.35mm safety stroke ensures zero sub-pixel white gap between studio bleed fill & H.2 bleedTargetMm clip
    ctx.lineWidth = 0.7 * scaleX;
    if (traceContourPathOnCtx(ctx, bPoly, 0, scaleX, scaleY)) {
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.drawImage(transparentCanvas || rawCanvas, 0, 0, out.width, out.height);
  return out;
}
