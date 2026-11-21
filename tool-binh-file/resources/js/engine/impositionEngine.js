export const MM_TO_PT = 72 / 25.4;

export const PAPER_SIZES = {
  A4: { name: 'A4 (210 × 297 mm)', width: 210, height: 297, group: 'Digital' },
  A3: { name: 'A3 (297 × 420 mm)', width: 297, height: 420, group: 'Digital' },
  SRA3: { name: 'SRA3 (320 × 450 mm)', width: 320, height: 450, group: 'Digital' },
  D325x430: { name: '325 × 430 mm (In nhanh)', width: 325, height: 430, group: 'Digital' },
  D330x480: { name: '330 × 480 mm (In nhanh)', width: 330, height: 480, group: 'Digital' },
  A2: { name: 'A2 (420 × 594 mm)', width: 420, height: 594, group: 'Offset' },
  K65x86: { name: 'Offset K65 × 86 cm', width: 650, height: 860, group: 'Offset' },
  K79x109: { name: 'Offset K79 × 109 cm', width: 790, height: 1090, group: 'Offset' },
  Letter: { name: 'Letter (216 × 279 mm)', width: 216, height: 279, group: 'US' },
  Tabloid: { name: 'Tabloid (279 × 432 mm)', width: 279, height: 432, group: 'US' },
  Custom: { name: 'Tùy chỉnh...', width: 320, height: 430, group: 'Custom' },
};

export function getSheetDimensionsMm(paperSizeKey, customW, customH, orientation) {
  let w = 297;
  let h = 420;
  if (paperSizeKey === 'Custom') {
    w = Math.max(10, parseFloat(customW) || 320);
    h = Math.max(10, parseFloat(customH) || 430);
  } else {
    const preset = PAPER_SIZES[paperSizeKey] || PAPER_SIZES.A3;
    w = preset.width;
    h = preset.height;
  }
  if (orientation === 'landscape') {
    return { width: Math.max(w, h), height: Math.min(w, h) };
  }
  return { width: Math.min(w, h), height: Math.max(w, h) };
}

function fitCount(avail, size, gap) {
  if (size <= 0 || avail + 0.01 < size) return 0;
  return Math.floor((avail + gap + 0.01) / (size + gap));
}

/**
 * Optimal Mixed Dutch Cut (2-Stage Guillotine Partitioning: 0° + 90°)
 */
export function solveDutchCut(availW, availH, itemW, itemH, gapX, gapY, subBlockGap = Math.max(gapX, gapY)) {
  let best = {
    total: 0,
    splitAxis: 'none',
    primary: { cols: 0, rows: 0, rotate: 0, w: itemW, h: itemH },
    secondary: { cols: 0, rows: 0, rotate: 90, w: itemH, h: itemW },
    usedPrimarySpan: 0,
    subBlockGap,
  };

  // Case 1: Vertical split (Left = 0°, Right = 90°)
  const maxC1 = fitCount(availW, itemW, gapX);
  const r1V = fitCount(availH, itemH, gapY);
  const r2V = fitCount(availH, itemW, gapY);
  for (let c1 = 0; c1 <= maxC1; c1++) {
    const usedW1 = c1 > 0 ? c1 * itemW + (c1 - 1) * gapX : 0;
    const remW = c1 > 0 ? availW - usedW1 - subBlockGap : availW;
    const c2 = fitCount(remW, itemH, gapX);
    const total = c1 * r1V + c2 * r2V;
    const isUniform = c1 === 0 || c2 === 0;
    const bestIsUniform = best.primary.cols === 0 || best.secondary.cols === 0;

    if (total > best.total || (total === best.total && isUniform && !bestIsUniform)) {
      best = {
        total,
        splitAxis: 'vertical',
        primary: { cols: c1, rows: r1V, rotate: 0, w: itemW, h: itemH },
        secondary: { cols: c2, rows: r2V, rotate: 90, w: itemH, h: itemW },
        usedPrimarySpan: usedW1,
        subBlockGap,
      };
    }
  }

  // Case 2: Horizontal split (Top = 0°, Bottom = 90°)
  const maxR1 = fitCount(availH, itemH, gapY);
  const c1H = fitCount(availW, itemW, gapX);
  const c2H = fitCount(availW, itemH, gapX);
  for (let r1 = 0; r1 <= maxR1; r1++) {
    const usedH1 = r1 > 0 ? r1 * itemH + (r1 - 1) * gapY : 0;
    const remH = r1 > 0 ? availH - usedH1 - subBlockGap : availH;
    const r2 = fitCount(remH, itemW, gapY);
    const total = c1H * r1 + c2H * r2;
    const isUniform = r1 === 0 || r2 === 0;
    const bestIsUniform = best.primary.rows === 0 || best.secondary.rows === 0;

    if (total > best.total || (total === best.total && isUniform && !bestIsUniform)) {
      best = {
        total,
        splitAxis: 'horizontal',
        primary: { cols: c1H, rows: r1, rotate: 0, w: itemW, h: itemH },
        secondary: { cols: c2H, rows: r2, rotate: 90, w: itemH, h: itemW },
        usedPrimarySpan: usedH1,
        subBlockGap,
      };
    }
  }

  // Fallback at least 1 item
  if (best.total === 0) {
    best = {
      total: 1,
      splitAxis: 'vertical',
      primary: { cols: 1, rows: 1, rotate: 0, w: itemW, h: itemH },
      secondary: { cols: 0, rows: 0, rotate: 90, w: itemH, h: itemW },
      usedPrimarySpan: itemW,
      subBlockGap: 0,
    };
  }

  return best;
}

/**
 * Simple uniform grid solver (0° vs 90°)
 */
export function solveSimpleGrid(availW, availH, itemW, itemH, gapX, gapY) {
  const c0 = fitCount(availW, itemW, gapX);
  const r0 = fitCount(availH, itemH, gapY);
  const t0 = c0 * r0;

  const c90 = fitCount(availW, itemH, gapX);
  const r90 = fitCount(availH, itemW, gapY);
  const t90 = c90 * r90;

  if (t90 > t0) {
    return {
      total: Math.max(1, t90),
      splitAxis: 'vertical',
      primary: { cols: 0, rows: 0, rotate: 0, w: itemW, h: itemH },
      secondary: { cols: Math.max(1, c90), rows: Math.max(1, r90), rotate: 90, w: itemH, h: itemW },
      usedPrimarySpan: 0,
      subBlockGap: 0,
    };
  }
  return {
    total: Math.max(1, t0),
    splitAxis: 'vertical',
    primary: { cols: Math.max(1, c0), rows: Math.max(1, r0), rotate: 0, w: itemW, h: itemH },
    secondary: { cols: 0, rows: 0, rotate: 90, w: itemH, h: itemW },
    usedPrimarySpan: Math.max(1, c0) * itemW + Math.max(0, c0 - 1) * gapX,
    subBlockGap: 0,
  };
}

/**
 * Compute raw slot geometry (relative to 0,0) for Grid / Dutch Cut
 */
function buildRawSlots(config, availW, availH, trimW, trimH) {
  const { layoutType = 'optimal', cols = 2, rows = 2, gutterX = 0, gutterY = 0, keepOriginalSize = true, inkingAxis = 'none' } = config;
  const gX = Math.max(0, Number(gutterX) || 0);
  const gY = Math.max(0, Number(gutterY) || 0);
  const slots = [];
  let layoutMeta = { primaryCount: 0, secondaryCount: 0, splitAxis: 'none' };

  if (layoutType === 'manual' || !keepOriginalSize) {
    const cCount = Math.max(1, parseInt(cols, 10) || 1);
    const rCount = Math.max(1, parseInt(rows, 10) || 1);
    const cellW = (availW - (cCount - 1) * gX) / cCount;
    const cellH = (availH - (rCount - 1) * gY) / rCount;
    const cellAspect = cellW / Math.max(0.01, cellH);
    const cardAspect = trimW / Math.max(0.01, trimH);
    const shouldRot = (cardAspect > 1 && cellAspect < 1) || (cardAspect < 1 && cellAspect > 1);

    let drawW = shouldRot ? trimH : trimW;
    let drawH = shouldRot ? trimW : trimH;
    let scale = 1;

    if (!keepOriginalSize) {
      const effAspect = drawW / Math.max(0.01, drawH);
      if (effAspect > cellAspect) {
        scale = cellW / drawW;
        drawW = cellW;
        drawH = cellW / effAspect;
      } else {
        scale = cellH / drawH;
        drawH = cellH;
        drawW = cellH * effAspect;
      }
    }

    const baseRot = shouldRot ? 90 : 0;
    for (let r = 0; r < rCount; r++) {
      for (let c = 0; c < cCount; c++) {
        let rot = baseRot;
        if (inkingAxis === 'row' && r % 2 === 1) rot = (rot + 180) % 360;
        if (inkingAxis === 'col' && c % 2 === 1) rot = (rot + 180) % 360;

        const x = keepOriginalSize ? c * (drawW + gX) : c * (cellW + gX) + (cellW - drawW) / 2;
        const y = keepOriginalSize ? r * (drawH + gY) : r * (cellH + gY) + (cellH - drawH) / 2;
        slots.push({
          x,
          y,
          trimW: drawW,
          trimH: drawH,
          rotate: rot,
          scale,
          row: r,
          col: c,
          block: 'primary',
        });
      }
    }
    layoutMeta = { primaryCount: slots.length, secondaryCount: 0, splitAxis: 'manual', cols: cCount, rows: rCount };
    return { slots, layoutMeta };
  }

  const subGap = Math.max(gX, gY);
  const solved =
    layoutType === 'optimal'
      ? solveDutchCut(availW, availH, trimW, trimH, gX, gY, subGap)
      : solveSimpleGrid(availW, availH, trimW, trimH, gX, gY);

  // Primary block (0°)
  for (let r = 0; r < solved.primary.rows; r++) {
    for (let c = 0; c < solved.primary.cols; c++) {
      let rot = 0;
      if (inkingAxis === 'row' && r % 2 === 1) rot = 180;
      if (inkingAxis === 'col' && c % 2 === 1) rot = 180;
      slots.push({
        x: c * (trimW + gX),
        y: r * (trimH + gY),
        trimW,
        trimH,
        rotate: rot,
        scale: 1,
        row: r,
        col: c,
        block: 'primary',
      });
    }
  }

  // Secondary block (90° Dutch Cut)
  const hasPrimary = solved.primary.cols > 0 && solved.primary.rows > 0;
  const offsetX = solved.splitAxis === 'vertical' && hasPrimary ? solved.usedPrimarySpan + solved.subBlockGap : 0;
  const offsetY = solved.splitAxis === 'horizontal' && hasPrimary ? solved.usedPrimarySpan + solved.subBlockGap : 0;

  for (let r = 0; r < solved.secondary.rows; r++) {
    for (let c = 0; c < solved.secondary.cols; c++) {
      // PrynX INKING rule: on 90°-rotated sub-block, swap row/col parity so matching edges touch
      let rot = 90;
      if (inkingAxis === 'row' && c % 2 === 1) rot = 270;
      if (inkingAxis === 'col' && r % 2 === 1) rot = 270;
      slots.push({
        x: offsetX + c * (trimH + gX),
        y: offsetY + r * (trimW + gY),
        trimW: trimH,
        trimH: trimW,
        rotate: rot,
        scale: 1,
        row: r,
        col: c,
        block: 'secondary',
      });
    }
  }

  layoutMeta = {
    primaryCount: solved.primary.cols * solved.primary.rows,
    secondaryCount: solved.secondary.cols * solved.secondary.rows,
    splitAxis: solved.splitAxis,
    cols: solved.primary.cols + (solved.splitAxis === 'vertical' ? solved.secondary.cols : 0),
    rows: solved.primary.rows + (solved.splitAxis === 'horizontal' ? solved.secondary.rows : 0),
  };

  return { slots, layoutMeta };
}

/**
 * Align entire slot group inside sheet margins using 9-point anchor
 */
function alignSlots(slots, sheetW, sheetH, margins, alignment = 'center') {
  if (slots.length === 0) return slots;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of slots) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x + s.trimW > maxX) maxX = s.x + s.trimW;
    if (s.y + s.trimH > maxY) maxY = s.y + s.trimH;
  }
  const groupW = maxX - minX;
  const groupH = maxY - minY;
  const availW = sheetW - margins.left - margins.right;
  const availH = sheetH - margins.top - margins.bottom;

  let dx = margins.left + (availW - groupW) / 2 - minX;
  let dy = margins.top + (availH - groupH) / 2 - minY;

  if (alignment.includes('left')) dx = margins.left - minX;
  if (alignment.includes('right')) dx = sheetW - margins.right - groupW - minX;
  if (alignment.includes('top')) dy = margins.top - minY;
  if (alignment.includes('bottom')) dy = sheetH - margins.bottom - groupH - minY;

  return slots.map((s) => ({
    ...s,
    x: s.x + dx,
    y: s.y + dy,
  }));
}

/**
 * Smart Bleed Clipping:
 * For each edge of each placement, limit bleed to min(bleed, gapToNearestNeighbor / 2).
 * Outer edges keep full bleed.
 */
function applySmartBleedClipping(placements, bleedMm) {
  const b = Math.max(0, Number(bleedMm) || 0);
  if (b === 0) {
    return placements.map((p) => ({
      ...p,
      clipBleed: { top: 0, right: 0, bottom: 0, left: 0 },
    }));
  }

  return placements.map((p, i) => {
    let left = b, right = b, top = b, bottom = b;
    const pLeft = p.x, pRight = p.x + p.trimW;
    const pTop = p.y, pBottom = p.y + p.trimH;

    for (let j = 0; j < placements.length; j++) {
      if (i === j) continue;
      const q = placements[j];
      const qLeft = q.x, qRight = q.x + q.trimW;
      const qTop = q.y, qBottom = q.y + q.trimH;

      // Vertical overlap -> check left/right neighbors
      const vOverlap = Math.min(pBottom, qBottom) - Math.max(pTop, qTop) > -b;
      if (vOverlap) {
        if (qRight <= pLeft + 0.05) {
          const gap = Math.max(0, pLeft - qRight);
          left = Math.min(left, gap / 2);
        }
        if (qLeft >= pRight - 0.05) {
          const gap = Math.max(0, qLeft - pRight);
          right = Math.min(right, gap / 2);
        }
      }

      // Horizontal overlap -> check top/bottom neighbors
      const hOverlap = Math.min(pRight, qRight) - Math.max(pLeft, qLeft) > -b;
      if (hOverlap) {
        if (qBottom <= pTop + 0.05) {
          const gap = Math.max(0, pTop - qBottom);
          top = Math.min(top, gap / 2);
        }
        if (qTop >= pBottom - 0.05) {
          const gap = Math.max(0, qTop - pBottom);
          bottom = Math.min(bottom, gap / 2);
        }
      }
    }

    return {
      ...p,
      clipBleed: {
        top: Math.round(top * 1000) / 1000,
        right: Math.round(right * 1000) / 1000,
        bottom: Math.round(bottom * 1000) / 1000,
        left: Math.round(left * 1000) / 1000,
      },
    };
  });
}

/**
 * Mirror placements for Duplex Back side (Trở nhíp / Trở đít)
 */
function mirrorPlacementsForBack(frontPlacements, sheetW, sheetH, duplexMode, backPageIndices) {
  return frontPlacements
    .map((p, idx) => {
      const pageIndex = backPageIndices[idx];
      if (pageIndex === undefined || pageIndex === null || pageIndex < 0) return null;

      if (duplexMode === 'workAndTumble') {
        return {
          ...p,
          pageIndex,
          x: p.x,
          y: sheetH - (p.y + p.trimH),
          rotate: (p.rotate + 180) % 360,
          clipBleed: {
            top: p.clipBleed.bottom,
            bottom: p.clipBleed.top,
            left: p.clipBleed.right,
            right: p.clipBleed.left,
          },
        };
      }

      // Default: workAndTurn (Trở nhíp — Mirror X)
      return {
        ...p,
        pageIndex,
        x: sheetW - (p.x + p.trimW),
        y: p.y,
        rotate: p.rotate,
        clipBleed: {
          top: p.clipBleed.top,
          bottom: p.clipBleed.bottom,
          left: p.clipBleed.right,
          right: p.clipBleed.left,
        },
      };
    })
    .filter(Boolean);
}

/**
 * Generate Collision-Free Crop Marks (Western 1-line or Japanese Tonbo 2-line)
 * + 4 Registration Targets (Ốc chồng màu)
 */
export function generateSheetMarks(placements, sheetW, sheetH, options = {}) {
  const {
    markStyle = 'western', // 'none' | 'western' | 'tonbo'
    markLength = 5, // mm
    markOffset = 3, // mm
    bleedMm = 0,
    registrationMarks = false,
  } = options;

  const lines = [];
  const registrations = [];
  if (placements.length === 0) return { lines, registrations };

  // Build occupied raw boxes (Trim + ClipBleed) for fast collision avoidance
  const occupied = placements.map((p) => ({
    left: p.x - p.clipBleed.left,
    right: p.x + p.trimW + p.clipBleed.right,
    top: p.y - p.clipBleed.top,
    bottom: p.y + p.trimH + p.clipBleed.bottom,
  }));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of placements) {
    if (p.x < minX) minX = p.x;
    if (p.x + p.trimW > maxX) maxX = p.x + p.trimW;
    if (p.y < minY) minY = p.y;
    if (p.y + p.trimH > maxY) maxY = p.y + p.trimH;
  }

  const seen = new Set();
  const tryAddLine = (x1, y1, x2, y2, selfIdx, kind = 'trim') => {
    const lMinX = Math.min(x1, x2), lMaxX = Math.max(x1, x2);
    const lMinY = Math.min(y1, y2), lMaxY = Math.max(y1, y2);

    // Keep inside sheet bounds
    if (lMaxX < 0 || lMinX > sheetW || lMaxY < 0 || lMinY > sheetH) return;

    // Avoid colliding with any other item's image/bleed area
    for (let j = 0; j < occupied.length; j++) {
      if (j === selfIdx) continue;
      const o = occupied[j];
      if (lMaxX >= o.left - 0.15 && lMinX <= o.right + 0.15 && lMaxY >= o.top - 0.15 && lMinY <= o.bottom + 0.15) {
        return;
      }
    }

    // Deduplicate (order-independent, 0.05mm precision)
    const a = `${Math.round(x1 * 20)},${Math.round(y1 * 20)}`;
    const b = `${Math.round(x2 * 20)},${Math.round(y2 * 20)}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ x1, y1, x2, y2, kind });
  };

  if (markStyle !== 'none') {
    const len = Math.max(1, Number(markLength) || 5);
    const off = Math.max(0.5, Number(markOffset) || 3);
    const b = Math.max(0, Number(bleedMm) || 0);

    placements.forEach((p, idx) => {
      const x1 = p.x, x2 = p.x + p.trimW;
      const y1 = p.y, y2 = p.y + p.trimH;

      // Primary Trim marks (8 corners)
      tryAddLine(x1, y1 - off, x1, y1 - off - len, idx, 'trim');
      tryAddLine(x2, y1 - off, x2, y1 - off - len, idx, 'trim');
      tryAddLine(x1, y2 + off, x1, y2 + off + len, idx, 'trim');
      tryAddLine(x2, y2 + off, x2, y2 + off + len, idx, 'trim');

      tryAddLine(x1 - off, y1, x1 - off - len, y1, idx, 'trim');
      tryAddLine(x1 - off, y2, x1 - off - len, y2, idx, 'trim');
      tryAddLine(x2 + off, y1, x2 + off + len, y1, idx, 'trim');
      tryAddLine(x2 + off, y2, x2 + off + len, y2, idx, 'trim');

      // Japanese Tonbo double-line (Bleed line offset outward by bleedMm)
      if (markStyle === 'tonbo' && b > 0) {
        const bx1 = x1 - b, bx2 = x2 + b, by1 = y1 - b, by2 = y2 + b;
        tryAddLine(bx1, y1 - off, bx1, y1 - off - len, idx, 'bleed');
        tryAddLine(bx2, y1 - off, bx2, y1 - off - len, idx, 'bleed');
        tryAddLine(bx1, y2 + off, bx1, y2 + off + len, idx, 'bleed');
        tryAddLine(bx2, y2 + off, bx2, y2 + off + len, idx, 'bleed');

        tryAddLine(x1 - off, by1, x1 - off - len, by1, idx, 'bleed');
        tryAddLine(x1 - off, by2, x1 - off - len, by2, idx, 'bleed');
        tryAddLine(x2 + off, by1, x2 + off + len, by1, idx, 'bleed');
        tryAddLine(x2 + off, by2, x2 + off + len, by2, idx, 'bleed');
      }
    });
  }

  // 4 Registration targets (Ốc chồng màu) at midpoints of outer trim block
  if (registrationMarks) {
    const off = Math.max(2, Number(markOffset) || 3) + Math.max(2, Number(markLength) || 5) / 2;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const candidates = [
      { cx: minX - off, cy: midY },
      { cx: maxX + off, cy: midY },
      { cx: midX, cy: minY - off },
      { cx: midX, cy: maxY + off },
    ];
    for (const c of candidates) {
      if (c.cx >= 2 && c.cx <= sheetW - 2 && c.cy >= 2 && c.cy <= sheetH - 2) {
        registrations.push({ cx: c.cx, cy: c.cy, radius: 1.5, crossLen: 5 });
      }
    }
  }

  return { lines, registrations };
}

/**
 * Merge overlapping horizontal/vertical segments for 1-Knife Shared-Edge Cut (Dao LETA)
 */
function deduplicateRectCutLines(placements) {
  const horiz = new Map(); // yKey -> [[x1, x2], ...]
  const vert = new Map();  // xKey -> [[y1, y2], ...]

  const addSeg = (map, coord, a, b) => {
    const key = Math.round(coord * 20); // 0.05mm precision
    if (!map.has(key)) map.set(key, { coord, intervals: [] });
    map.get(key).intervals.push([Math.min(a, b), Math.max(a, b)]);
  };

  for (const p of placements) {
    const x1 = p.x, x2 = p.x + p.trimW;
    const y1 = p.y, y2 = p.y + p.trimH;
    addSeg(horiz, y1, x1, x2);
    addSeg(horiz, y2, x1, x2);
    addSeg(vert, x1, y1, y2);
    addSeg(vert, x2, y1, y2);
  }

  const mergeIntervals = (intervals) => {
    if (intervals.length === 0) return [];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = out[out.length - 1];
      const cur = sorted[i];
      if (cur[0] <= prev[1] + 0.05) {
        prev[1] = Math.max(prev[1], cur[1]);
      } else {
        out.push(cur);
      }
    }
    return out;
  };

  const result = [];
  for (const { coord, intervals } of horiz.values()) {
    for (const [a, b] of mergeIntervals(intervals)) {
      result.push({ kind: 'line', x1: a, y1: coord, x2: b, y2: coord });
    }
  }
  for (const { coord, intervals } of vert.values()) {
    for (const [a, b] of mergeIntervals(intervals)) {
      result.push({ kind: 'line', x1: coord, y1: a, x2: coord, y2: b });
    }
  }
  return result;
}

/**
 * Generate 4 Corner Optical Registration Marks (Boong máy bế)
 */
function generatePontMarks(sheetW, sheetH, pontType, pontMarginMm, pontSizeMm) {
  if (pontType === 'none') return [];
  const m = Math.max(4, Number(pontMarginMm) || 10);
  const s = Math.max(3, Number(pontSizeMm) || 5);
  return [
    { corner: 'TL', type: pontType, cx: m, cy: m, size: s },
    { corner: 'TR', type: pontType, cx: sheetW - m, cy: m, size: s },
    { corner: 'BL', type: pontType, cx: m, cy: sheetH - m, size: s },
    { corner: 'BR', type: pontType, cx: sheetW - m, cy: sheetH - m, size: s },
  ];
}

function stripVietnamese(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Concise, practical Job Checks (Preflight & Geometry diagnostics)
 */
export function runJobChecks(pagesMeta, sheets, sheetDim, config, summary) {
  const checks = [];
  if (!pagesMeta || pagesMeta.length === 0 || sheets.length === 0) return checks;

  const bleedMm = Math.max(0, Number(config.bleedMm) || 0);
  const safeMm = Math.max(0, Number(config.safeInsetMm) ?? 3);

  // 1. Sheet boundary & mark overflow check
  let outOfBounds = false;
  for (const s of sheets) {
    for (const p of s.placements) {
      if (
        p.x - p.clipBleed.left < -0.1 ||
        p.y - p.clipBleed.top < -0.1 ||
        p.x + p.trimW + p.clipBleed.right > sheetDim.width + 0.1 ||
        p.y + p.trimH + p.clipBleed.bottom > sheetDim.height + 0.1
      ) {
        outOfBounds = true;
        break;
      }
    }
    if (outOfBounds) break;
  }

  if (outOfBounds) {
    checks.push({
      id: 'bounds',
      level: 'error',
      title: 'Tràn ra ngoài khổ giấy',
      detail: 'Một số ô hoặc phần Bleed vượt quá mép tờ in. Hãy giảm số cột/hàng hoặc tăng lề.',
    });
  } else {
    checks.push({
      id: 'bounds',
      level: 'ok',
      title: 'Khổ giấy & lề hợp lệ',
      detail: `Toàn bộ ${summary.itemsPerSheet} con/tờ nằm gọn trong khổ ${sheetDim.width}×${sheetDim.height} mm.`,
    });
  }

  // 2. Source Bleed check
  const first = pagesMeta[0];
  const rawW = first.mediaWmm ?? first.width / MM_TO_PT;
  const rawH = first.mediaHmm ?? first.height / MM_TO_PT;
  const hasForcedTrim = Number(config.targetTrimW) > 0 && Number(config.targetTrimH) > 0;
  if (bleedMm > 0 && !first.hasExplicitTrimBox && !hasForcedTrim) {
    checks.push({
      id: 'bleed',
      level: 'warn',
      title: `Khai báo Bleed ${bleedMm} mm (chưa có TrimBox)`,
      detail: `File gốc (${rawW.toFixed(1)}×${rawH.toFixed(1)} mm) không có TrimBox; hệ thống tự lùi ${bleedMm} mm mỗi cạnh để làm thành phẩm ${summary.trimW}×${summary.trimH} mm.`,
    });
  } else if (bleedMm > 0) {
    checks.push({
      id: 'bleed',
      level: 'ok',
      title: `Bleed ${bleedMm} mm đã sẵn sàng`,
      detail: 'Smart Bleed Clipping tự cắt gọn phần tràn lề tại giữa khe hở.',
    });
  }

  // 3. Mixed page dimensions check
  if (pagesMeta.length > 1) {
    let mismatch = false;
    for (let i = 1; i < pagesMeta.length; i++) {
      const pw = pagesMeta[i].mediaWmm ?? pagesMeta[i].width / MM_TO_PT;
      const ph = pagesMeta[i].mediaHmm ?? pagesMeta[i].height / MM_TO_PT;
      if (Math.abs(pw - rawW) > 1.0 || Math.abs(ph - rawH) > 1.0) {
        mismatch = true;
        break;
      }
    }
    if (mismatch) {
      checks.push({
        id: 'size-mismatch',
        level: 'warn',
        title: 'Kích thước các trang/file không đồng nhất',
        detail: 'Các trang nguồn lệch nhau > 1 mm; có thể bật "Ép Trim Size" (VD: 90×54 mm) để đồng bộ.',
      });
    }
  }

  // 4. Duplex mixed 1-sided / 2-sided check
  if (config.mode !== 'booklet' && config.duplexMode && config.duplexMode !== 'simplex') {
    const gang = config.gangItems || [];
    const oneSidedCount = gang.filter((it) => it.backIndex === null).length;
    if (oneSidedCount > 0) {
      checks.push({
        id: 'duplex-mixed',
        level: 'warn',
        title: `Trộn ${oneSidedCount} mẫu 1 mặt trên tờ 2 mặt`,
        detail: 'Các ô mặt sau tương ứng với mẫu 1 mặt sẽ tự động để trắng.',
      });
    }
  }

  // 5. Safe Area check summary
  if (safeMm > 0) {
    const innerW = Math.max(0, Math.round((summary.trimW - 2 * safeMm) * 10) / 10);
    const innerH = Math.max(0, Math.round((summary.trimH - 2 * safeMm) * 10) / 10);
    checks.push({
      id: 'safe-area',
      level: innerW <= 0 || innerH <= 0 ? 'warn' : 'ok',
      title: `Vùng an toàn ${safeMm} mm (${innerW}×${innerH} mm)`,
      detail: 'Đảm bảo chữ/logo/QR nằm trong khung nét đứt xanh lá trên bản xem trước.',
    });
  }

  return checks;
}

/**
 * Binary-search Ratio Stack allocator:
 * Given M slots on a sheet and items with quantities Q_i, find minimum sheet count S
 * such that sum(ceil(Q_i / S)) <= M.
 */
function allocateRatioStack(items, M) {
  const active = items.filter((it) => (Number(it.quantity) || 0) > 0);
  if (active.length === 0 || M <= 0) return { slots: [], sheetsNeeded: 0 };

  // If more distinct items than slots on 1 sheet, fall back to 1 slot per item sequentially
  if (active.length > M) {
    return { slots: active, sheetsNeeded: 1, overflow: true };
  }

  const maxQ = Math.max(...active.map((it) => Math.max(1, Number(it.quantity) || 1)));
  let lo = 1;
  let hi = maxQ;
  let bestS = maxQ;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let needed = 0;
    for (const it of active) {
      needed += Math.ceil((Number(it.quantity) || 1) / mid);
    }
    if (needed <= M) {
      bestS = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Assign minimum required slots per item
  const counts = active.map((it) => Math.ceil((Number(it.quantity) || 1) / bestS));
  let totalAssigned = counts.reduce((a, b) => a + b, 0);

  // Distribute any remaining spare slots to items with highest over-demand ratio
  while (totalAssigned < M) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < active.length; i++) {
      const score = (Number(active[i].quantity) || 1) / counts[i];
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    counts[bestIdx]++;
    totalAssigned++;
  }

  const slots = [];
  for (let i = 0; i < active.length; i++) {
    for (let c = 0; c < counts[i]; c++) {
      slots.push(active[i]);
    }
  }

  return { slots, sheetsNeeded: bestS, overflow: false };
}

/**
 * Main Entry Point: Compute full deterministic SheetPlan[] for Grid or Booklet
 */
export function computeImpositionPlan(pagesMeta, config) {
  const sheetDim = getSheetDimensionsMm(
    config.paperSizeKey,
    config.customPaperWidth,
    config.customPaperHeight,
    config.orientation
  );

  if (!pagesMeta || pagesMeta.length === 0) {
    return {
      sheetDim,
      sheets: [],
      summary: {
        totalSheets: 0,
        itemsPerSheet: 0,
        utilizationPct: 0,
        trimW: 0,
        trimH: 0,
        primaryCount: 0,
        secondaryCount: 0,
      },
    };
  }

  const margins = {
    top: Math.max(0, Number(config.marginTop) || 0),
    bottom: Math.max(0, Number(config.marginBottom) || 0),
    left: Math.max(0, Number(config.marginLeft) || 0),
    right: Math.max(0, Number(config.marginRight) || 0),
  };

  // If marginIncludesMarks is true, shrink usable area by markOffset + markLength
  const markReserve =
    config.marginIncludesMarks && config.markStyle !== 'none'
      ? (Number(config.markOffset) || 3) + (Number(config.markLength) || 5)
      : 0;

  const effMargins = {
    top: margins.top + markReserve,
    bottom: margins.bottom + markReserve,
    left: margins.left + markReserve,
    right: margins.right + markReserve,
  };

  const availW = Math.max(10, sheetDim.width - effMargins.left - effMargins.right);
  const availH = Math.max(10, sheetDim.height - effMargins.top - effMargins.bottom);
  const bleedMm = Math.max(0, Number(config.bleedMm) || 0);

  const first = pagesMeta[0];
  // Use explicit targetTrimW/H if forced by user (e.g. Namecard 90x54), else TrimBox or MediaBox - 2*Bleed
  const rawW = first.mediaWmm ?? first.width / MM_TO_PT;
  const rawH = first.mediaHmm ?? first.height / MM_TO_PT;
  const hasForcedTrim = Number(config.targetTrimW) > 0 && Number(config.targetTrimH) > 0;
  const trimW = hasForcedTrim
    ? Number(config.targetTrimW)
    : first.hasExplicitTrimBox
    ? first.trimWmm
    : Math.max(1, rawW - 2 * bleedMm);
  const trimH = hasForcedTrim
    ? Number(config.targetTrimH)
    : first.hasExplicitTrimBox
    ? first.trimHmm
    : Math.max(1, rawH - 2 * bleedMm);

  const sheets = [];

  // ==================== STICKER DIE-CUT MODE ('sticker') ====================
  if (config.mode === 'sticker') {
    const gX = Math.max(0, Number(config.gutterX) || 0);
    const gY = Math.max(0, Number(config.gutterY) || 0);
    const pontType = config.pontType || 'circle5mm'; // 'circle5mm' | 'circleHollow' | 'graphtec' | 'none'
    const pontMargin = Math.max(5, Number(config.pontMarginMm) || 10);
    const pontSize = Math.max(3, Number(config.pontSizeMm) || 5);
    const avoidCornerMarks = config.avoidCornerMarks !== false && pontType !== 'none';
    const stickerShape = config.stickerShape || 'rect'; // 'rect' | 'circle' | 'oval'
    const cornerRadius = Math.max(0, Number(config.cornerRadiusMm) || 0);
    const stickerLayout = config.stickerLayout || 'optimal'; // 'honeycomb' | 'optimal' | 'simple'
    const singleCut1Dao = Boolean(config.singleCut1Dao);

    const pontMarks = generatePontMarks(sheetDim.width, sheetDim.height, pontType, pontMargin, pontSize);
    const keepOut = avoidCornerMarks ? pontMargin + pontSize / 2 + 2 : 0;
    const cornerBoxes = avoidCornerMarks
      ? [
          { x1: 0, y1: 0, x2: keepOut, y2: keepOut },
          { x1: sheetDim.width - keepOut, y1: 0, x2: sheetDim.width, y2: keepOut },
          { x1: 0, y1: sheetDim.height - keepOut, x2: keepOut, y2: sheetDim.height },
          { x1: sheetDim.width - keepOut, y1: sheetDim.height - keepOut, x2: sheetDim.width, y2: sheetDim.height },
        ]
      : [];

    const hitsCorner = (x, y, w, h) => {
      for (const kb of cornerBoxes) {
        if (x < kb.x2 && x + w > kb.x1 && y < kb.y2 && y + h > kb.y1) return true;
      }
      return false;
    };

    let rawSlots = [];
    if (stickerLayout === 'honeycomb') {
      // Staggered Honeycomb packing for round/oval stickers
      const stepX = trimW + gX;
      // Vertical pitch for hexagonal/circle packing: sqrt(3)/2 * (h + gY) when circular, or 0.88 * (h + gY)
      const ratio = Math.abs(trimW - trimH) < 2 ? 0.866 : 0.88;
      const stepY = Math.max(trimH * 0.72, (trimH + gY) * ratio);
      const maxRows = Math.max(1, Math.floor((availH - trimH) / stepY) + 1);

      for (let r = 0; r < maxRows; r++) {
        const y = effMargins.top + r * stepY;
        if (y + trimH > sheetDim.height - effMargins.bottom + 0.1) break;
        const rowOffset = r % 2 === 1 ? stepX / 2 : 0;
        const maxCols = Math.max(1, Math.floor((availW - rowOffset - trimW) / stepX) + 1);
        for (let c = 0; c < maxCols; c++) {
          const x = effMargins.left + rowOffset + c * stepX;
          if (x + trimW > sheetDim.width - effMargins.right + 0.1) break;
          if (!hitsCorner(x, y, trimW, trimH)) {
            rawSlots.push({ x, y, trimW, trimH, rotate: 0, scale: 1, block: 'primary' });
          }
        }
      }
    } else {
      const { slots } = buildRawSlots(
        { ...config, layoutType: stickerLayout === 'simple' ? 'simple' : 'optimal', keepOriginalSize: true },
        availW,
        availH,
        trimW,
        trimH
      );
      const aligned = alignSlots(slots, sheetDim.width, sheetDim.height, effMargins, 'center');
      rawSlots = aligned.filter((s) => !hitsCorner(s.x, s.y, s.trimW, s.trimH));
    }

    const slotsWithClip = applySmartBleedClipping(rawSlots, bleedMm);
    const M = slotsWithClip.length;

    // Build logical items (1-sided stickers)
    const gang = Array.isArray(config.gangItems) && config.gangItems.length > 0
      ? config.gangItems.map((it) => ({ front: it.frontIndex }))
      : pagesMeta.map((_, i) => ({ front: i }));

    const collation = config.collation || 'stepAndRepeat';
    const sheetLists = [];
    if (collation === 'sequential' && gang.length > 1) {
      const S = Math.ceil(gang.length / Math.max(1, M));
      for (let s = 0; s < S; s++) {
        sheetLists.push(
          slotsWithClip.map((slot, idx) => {
            const gIdx = s * M + idx;
            return gIdx < gang.length ? { ...slot, pageIndex: gang[gIdx].front } : null;
          }).filter(Boolean)
        );
      }
    } else {
      for (let i = 0; i < gang.length; i++) {
        sheetLists.push(slotsWithClip.map((slot) => ({ ...slot, pageIndex: gang[i].front })));
      }
    }

    sheetLists.forEach((placements, idx) => {
      let stickerCutPaths = [];
      if (singleCut1Dao && stickerShape === 'rect' && cornerRadius === 0 && gX <= 0.05 && gY <= 0.05) {
        stickerCutPaths = deduplicateRectCutLines(placements);
      } else {
        stickerCutPaths = placements.map((p) => {
          if (stickerShape === 'circle' || stickerShape === 'oval') {
            return { kind: 'ellipse', cx: p.x + p.trimW / 2, cy: p.y + p.trimH / 2, rx: p.trimW / 2, ry: p.trimH / 2 };
          }
          return { kind: 'rect', x: p.x, y: p.y, w: p.trimW, h: p.trimH, r: cornerRadius };
        });
      }

      const rawSlug = `Toolbinhfile | Binh Tem Be (${stickerShape}) | To ${idx + 1}/${sheetLists.length} | ${placements.length} tem/to | Boong ${pontType} | Kho ${sheetDim.width}x${sheetDim.height}mm`;
      sheets.push({
        index: idx,
        physicalSheet: idx + 1,
        side: 'Simplex',
        placements,
        marks: { lines: [], registrations: [] },
        pontMarks,
        stickerCutPaths,
        slugText: config.showSlugLine ? stripVietnamese(rawSlug) : '',
      });
    });

    const usedArea = slotsWithClip.reduce((acc, s) => acc + s.trimW * s.trimH, 0);
    const stickerSummary = {
      totalSheets: sheets.length,
      physicalSheets: sheets.length,
      itemsPerSheet: M,
      utilizationPct: Math.min(100, Math.round((usedArea / (sheetDim.width * sheetDim.height)) * 1000) / 10),
      trimW: Math.round(trimW * 100) / 100,
      trimH: Math.round(trimH * 100) / 100,
      primaryCount: M,
      secondaryCount: 0,
      cutPathCount: sheets[0]?.stickerCutPaths?.length || 0,
    };

    return {
      sheetDim,
      sheets,
      summary: stickerSummary,
      jobChecks: runJobChecks(pagesMeta, sheets, sheetDim, config, stickerSummary),
    };
  }

  if (config.mode === 'booklet') {
    const numPages = pagesMeta.length;
    const bookletStyle = config.bookletStyle || 'saddleStitch'; // 'saddleStitch' | 'perfectBound' | 'wireO' | 'zine8'
    const binding = config.bookletBinding || 'left';
    const creepMm = Math.max(0, Number(config.bookletCreep) || 0);
    const pagesPerSig = [4, 8, 16].includes(Number(config.pagesPerSignature)) ? Number(config.pagesPerSignature) : 4;
    const coverAtEnd = Math.max(0, Math.min(4, parseInt(config.coverPagesAtEnd, 10) || 0));

    // Helper: map 1-based imposed page slot (1..padded) to 0-based source pageIndex (or -1 if blank)
    const resolveBookletPageIdx = (slotNum1Based, totalPadded) => {
      if (coverAtEnd > 0 && numPages > coverAtEnd && totalPadded > numPages) {
        const blanks = totalPadded - numPages;
        const bodyCount = numPages - coverAtEnd;
        if (slotNum1Based <= bodyCount) return slotNum1Based - 1;
        if (slotNum1Based <= bodyCount + blanks) return -1; // blank inserted BEFORE back cover
        return numPages - (totalPadded - slotNum1Based) - 1;
      }
      return slotNum1Based <= numPages ? slotNum1Based - 1 : -1;
    };

    // --- ZINE 8-PAGE (1-SIDED 4x2) ---
    if (bookletStyle === 'zine8') {
      const zineChunks = Math.max(1, Math.ceil(numPages / 8));
      const cellW = availW / 4;
      const cellH = availH / 2;
      const scale = config.keepOriginalSize
        ? Math.min(1, cellW / trimW, cellH / trimH)
        : Math.min(cellW / trimW, cellH / trimH);
      const drawW = trimW * scale;
      const drawH = trimH * scale;
      const startX = effMargins.left + (availW - 4 * drawW) / 2;
      const startY = effMargins.top + (availH - 2 * drawH) / 2;

      // Top row (180°): [5, 4, 3, 2], Bottom row (0°): [6, 7, 8, 1]
      const zineOrder = [
        { num: 5, row: 0, col: 0, rot: 180 },
        { num: 4, row: 0, col: 1, rot: 180 },
        { num: 3, row: 0, col: 2, rot: 180 },
        { num: 2, row: 0, col: 3, rot: 180 },
        { num: 6, row: 1, col: 0, rot: 0 },
        { num: 7, row: 1, col: 1, rot: 0 },
        { num: 8, row: 1, col: 2, rot: 0 },
        { num: 1, row: 1, col: 3, rot: 0 },
      ];

      for (let z = 0; z < zineChunks; z++) {
        const placements = [];
        for (const slot of zineOrder) {
          const pIdx = z * 8 + slot.num - 1;
          if (pIdx < numPages) {
            placements.push({
              pageIndex: pIdx,
              x: startX + slot.col * drawW,
              y: startY + slot.row * drawH,
              trimW: drawW,
              trimH: drawH,
              rotate: slot.rot,
              scale,
              block: 'primary',
              clipBleed: { top: 0, right: 0, bottom: 0, left: 0 },
            });
          }
        }
        const marks = generateSheetMarks(placements, sheetDim.width, sheetDim.height, {
          markStyle: config.markStyle,
          markLength: config.markLength,
          markOffset: config.markOffset,
          bleedMm: 0,
          registrationMarks: config.registrationMarks,
        });
        const rawSlug = `Toolbinhfile | Zine 8 trang (1 to 4x2) | To ${z + 1}/${zineChunks} | Kho ${sheetDim.width}x${sheetDim.height}mm`;
        sheets.push({
          index: sheets.length,
          physicalSheet: z + 1,
          side: 'Simplex',
          placements,
          marks,
          slugText: config.showSlugLine ? stripVietnamese(rawSlug) : '',
        });
      }

      const zineSummary = {
        totalSheets: sheets.length,
        physicalSheets: zineChunks,
        itemsPerSheet: 8,
        utilizationPct: Math.min(100, Math.round(((8 * drawW * drawH) / (sheetDim.width * sheetDim.height)) * 1000) / 10),
        trimW: Math.round(trimW * 100) / 100,
        trimH: Math.round(trimH * 100) / 100,
        primaryCount: 8,
        secondaryCount: 0,
      };
      return {
        sheetDim,
        sheets,
        summary: zineSummary,
        jobChecks: runJobChecks(pagesMeta, sheets, sheetDim, config, zineSummary),
      };
    }

    // --- SADDLE STITCH / PERFECT BOUND (4/8/16p) / WIRE-O (Cut & Stack) ---
    const unitPages = bookletStyle === 'perfectBound' ? pagesPerSig : 4;
    const padded =
      bookletStyle === 'perfectBound'
        ? Math.ceil(numPages / pagesPerSig) * pagesPerSig
        : Math.ceil(numPages / 4) * 4;
    const physicalSheets = Math.max(1, padded / 4);

    const halfAvailW = availW / 2;
    const scaleX = halfAvailW / trimW;
    const scaleY = availH / trimH;
    const scale = config.keepOriginalSize ? Math.min(1, scaleX, scaleY) : Math.min(scaleX, scaleY);
    const drawW = trimW * scale;
    const drawH = trimH * scale;
    const spineX = effMargins.left + availW / 2;
    const topY = effMargins.top + (availH - drawH) / 2;

    for (let k = 0; k < physicalSheets; k++) {
      let fLeft, fRight, bLeft, bRight;
      let creepShift = 0;

      if (bookletStyle === 'wireO') {
        // Cut & Stack 2-Up: left pile = pages 1..2K, right pile = pages 2K+1..4K
        const K = physicalSheets;
        fLeft = 2 * k + 1;
        fRight = 2 * K + 2 * k + 1;
        bLeft = 2 * K + 2 * k + 2; // Mirror X for work & turn
        bRight = 2 * k + 2;
      } else if (bookletStyle === 'perfectBound') {
        const sheetsPerSig = pagesPerSig / 4;
        const sigIdx = Math.floor(k / sheetsPerSig);
        const kInSig = k % sheetsPerSig;
        const sigBase = sigIdx * pagesPerSig;
        fLeft = sigBase + (pagesPerSig - 2 * kInSig);
        fRight = sigBase + (2 * kInSig + 1);
        bLeft = sigBase + (2 * kInSig + 2);
        bRight = sigBase + (pagesPerSig - 2 * kInSig - 1);
        creepShift = kInSig * creepMm;
      } else {
        // Saddle-Stitch nested
        fLeft = padded - 2 * k;
        fRight = 2 * k + 1;
        bLeft = 2 * k + 2;
        bRight = padded - 2 * k - 1;
        creepShift = k * creepMm;
      }

      if (binding === 'right' && bookletStyle !== 'wireO') {
        [fLeft, fRight] = [fRight, fLeft];
        [bLeft, bRight] = [bRight, bLeft];
      }

      const buildBookletSide = (leftNum, rightNum, sideLabel) => {
        const placements = [];
        const leftIdx = resolveBookletPageIdx(leftNum, padded);
        const rightIdx = resolveBookletPageIdx(rightNum, padded);

        if (leftIdx >= 0) {
          placements.push({
            pageIndex: leftIdx,
            x: spineX - drawW + creepShift,
            y: topY,
            trimW: drawW,
            trimH: drawH,
            rotate: 0,
            scale,
            block: 'primary',
            clipBleed: { top: bleedMm * scale, right: 0, bottom: bleedMm * scale, left: bleedMm * scale },
          });
        }
        if (rightIdx >= 0) {
          placements.push({
            pageIndex: rightIdx,
            x: spineX - creepShift,
            y: topY,
            trimW: drawW,
            trimH: drawH,
            rotate: 0,
            scale,
            block: 'primary',
            clipBleed: { top: bleedMm * scale, right: bleedMm * scale, bottom: bleedMm * scale, left: 0 },
          });
        }

        const marks = generateSheetMarks(placements, sheetDim.width, sheetDim.height, {
          markStyle: config.markStyle,
          markLength: config.markLength,
          markOffset: config.markOffset,
          bleedMm: bleedMm * scale,
          registrationMarks: config.registrationMarks,
        });

        const modeLabel =
          bookletStyle === 'wireO'
            ? 'Wire-O Gay xoan'
            : bookletStyle === 'perfectBound'
            ? `Dong keo Tay ${unitPages}p`
            : 'Bam kim';
        const rawSlug = `Toolbinhfile | ${modeLabel} | To ${k + 1}/${physicalSheets} (${sideLabel}) | Kho ${sheetDim.width}x${sheetDim.height}mm | Creep ${creepMm}mm`;
        sheets.push({
          index: sheets.length,
          physicalSheet: k + 1,
          side: sideLabel,
          placements,
          marks,
          slugText: config.showSlugLine ? stripVietnamese(rawSlug) : '',
        });
      };

      buildBookletSide(fLeft, fRight, 'Front');
      buildBookletSide(bLeft, bRight, 'Back');
    }

    const usedArea = 2 * drawW * drawH;
    const sheetArea = sheetDim.width * sheetDim.height;
    const bookletSummary = {
      totalSheets: sheets.length,
      physicalSheets,
      itemsPerSheet: 2,
      utilizationPct: Math.min(100, Math.round((usedArea / sheetArea) * 1000) / 10),
      trimW: Math.round(trimW * 100) / 100,
      trimH: Math.round(trimH * 100) / 100,
      primaryCount: 2,
      secondaryCount: 0,
    };
    return {
      sheetDim,
      sheets,
      summary: bookletSummary,
      jobChecks: runJobChecks(pagesMeta, sheets, sheetDim, config, bookletSummary),
    };
  }

  // ==================== GRID / GUILLOTINE MODE ====================
  const { slots: rawSlots, layoutMeta } = buildRawSlots(config, availW, availH, trimW, trimH);
  const alignedSlots = alignSlots(rawSlots, sheetDim.width, sheetDim.height, effMargins, config.alignment || 'center');
  const slotsWithClip = applySmartBleedClipping(alignedSlots, bleedMm);
  const M = slotsWithClip.length;

  // Compute slot ordering according to flowPattern ('Z' | 'S' | 'N')
  const flowPattern = config.flowPattern || 'Z';
  const orderedSlotIndices = slotsWithClip.map((_, i) => i);
  if (flowPattern === 'S') {
    // Snake rows: group by row (y), alternate left-to-right / right-to-left
    const rowsMap = new Map();
    slotsWithClip.forEach((s, idx) => {
      const yKey = Math.round(s.y * 2);
      if (!rowsMap.has(yKey)) rowsMap.set(yKey, []);
      rowsMap.get(yKey).push({ idx, x: s.x });
    });
    const sortedKeys = Array.from(rowsMap.keys()).sort((a, b) => a - b);
    orderedSlotIndices.length = 0;
    sortedKeys.forEach((k, rIdx) => {
      const arr = rowsMap.get(k).sort((a, b) => (rIdx % 2 === 0 ? a.x - b.x : b.x - a.x));
      arr.forEach((item) => orderedSlotIndices.push(item.idx));
    });
  } else if (flowPattern === 'N') {
    // Column-first: sort by x then y
    orderedSlotIndices.sort((a, b) => {
      const dx = slotsWithClip[a].x - slotsWithClip[b].x;
      return Math.abs(dx) > 1 ? dx : slotsWithClip[a].y - slotsWithClip[b].y;
    });
  }

  const collation = config.collation || 'stepAndRepeat'; // 'stepAndRepeat' | 'sequential' | 'cutAndStack' | 'ratioStack' | 'repeatPerRow' | 'repeatPerCol'
  const duplexMode = config.duplexMode || 'simplex'; // 'simplex' | 'workAndTurn' | 'workAndTumble'
  const isDuplex = duplexMode !== 'simplex';
  const numSrcPages = pagesMeta.length;

  // Build list of logical items (each item is { front: idx, back: idx | null, quantity?: number })
  let logicalItems = [];
  if (Array.isArray(config.gangItems) && config.gangItems.length > 0) {
    logicalItems = config.gangItems.map((it) => ({
      front: it.frontIndex,
      back: it.backIndex !== undefined && it.backIndex !== null ? it.backIndex : null,
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
      name: it.name || '',
    }));
  } else if (isDuplex) {
    for (let i = 0; i < numSrcPages; i += 2) {
      logicalItems.push({ front: i, back: i + 1 < numSrcPages ? i + 1 : null, quantity: 1 });
    }
  } else {
    for (let i = 0; i < numSrcPages; i++) {
      logicalItems.push({ front: i, back: null, quantity: 1 });
    }
  }

  const N = logicalItems.length;
  const physicalSheetSlots = []; // Array of arrays of logicalItems (length M per physical sheet)
  let ratioSheetsNeeded = 0;

  if (collation === 'repeatPerRow' || collation === 'repeatPerCol') {
    // Group slots by distinct Y (row) or X (col)
    const groupMap = new Map();
    slotsWithClip.forEach((s, idx) => {
      const key = collation === 'repeatPerRow' ? Math.round(s.y * 2) : Math.round(s.x * 2);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(idx);
    });
    const keys = Array.from(groupMap.keys()).sort((a, b) => a - b);
    const numGroups = keys.length || 1;
    const S = Math.ceil(N / numGroups);
    for (let s = 0; s < S; s++) {
      const row = Array(M).fill(null);
      keys.forEach((k, gIdx) => {
        const itemIdx = s * numGroups + gIdx;
        if (itemIdx < N) {
          for (const slotIdx of groupMap.get(k)) {
            row[slotIdx] = logicalItems[itemIdx];
          }
        }
      });
      physicalSheetSlots.push(row);
    }
  } else if (collation === 'ratioStack') {
    const { slots: ratioSlots, sheetsNeeded, overflow } = allocateRatioStack(logicalItems, M);
    ratioSheetsNeeded = sheetsNeeded;
    if (!overflow && ratioSlots.length > 0) {
      physicalSheetSlots.push(ratioSlots);
    } else {
      const S = Math.ceil(N / M);
      for (let s = 0; s < S; s++) {
        const row = Array(M).fill(null);
        for (let p = 0; p < M; p++) {
          const itemIdx = s * M + p;
          if (itemIdx < N) row[orderedSlotIndices[p]] = logicalItems[itemIdx];
        }
        physicalSheetSlots.push(row);
      }
    }
  } else if (collation === 'stepAndRepeat') {
    for (let i = 0; i < N; i++) {
      physicalSheetSlots.push(Array(M).fill(logicalItems[i]));
    }
  } else if (collation === 'cutAndStack') {
    const stackSplit = Math.max(0, parseInt(config.stackSplit, 10) || 0);
    const batchItemsSize = stackSplit > 0 ? M * stackSplit : N;
    for (let batchStart = 0; batchStart < N; batchStart += batchItemsSize) {
      const batch = logicalItems.slice(batchStart, batchStart + batchItemsSize);
      const S = Math.ceil(batch.length / M);
      for (let s = 0; s < S; s++) {
        const row = Array(M).fill(null);
        for (let p = 0; p < M; p++) {
          const itemIdx = p * S + s;
          if (itemIdx < batch.length) row[orderedSlotIndices[p]] = batch[itemIdx];
        }
        physicalSheetSlots.push(row);
      }
    }
  } else {
    // sequential N-Up
    const S = Math.ceil(N / M);
    for (let s = 0; s < S; s++) {
      const row = Array(M).fill(null);
      for (let p = 0; p < M; p++) {
        const itemIdx = s * M + p;
        if (itemIdx < N) row[orderedSlotIndices[p]] = logicalItems[itemIdx];
      }
      physicalSheetSlots.push(row);
    }
  }

  const totalPhysical = physicalSheetSlots.length;
  for (let ps = 0; ps < totalPhysical; ps++) {
    const assigned = physicalSheetSlots[ps];
    const frontPlacements = [];
    const backPageIndices = [];

    for (let slotIdx = 0; slotIdx < M; slotIdx++) {
      const item = assigned[slotIdx];
      if (!item) continue;
      frontPlacements.push({
        ...slotsWithClip[slotIdx],
        pageIndex: item.front,
      });
      backPageIndices.push(item.back);
    }

    const frontMarks = generateSheetMarks(frontPlacements, sheetDim.width, sheetDim.height, {
      markStyle: config.markStyle,
      markLength: config.markLength,
      markOffset: config.markOffset,
      bleedMm,
      registrationMarks: config.registrationMarks,
    });

    const ratioNote = ratioSheetsNeeded > 0 ? ` | In ${ratioSheetsNeeded} to` : '';
    const slugBase = `To ${ps + 1}/${totalPhysical}${ratioNote} | ${M} con/to (${layoutMeta.primaryCount} ngang + ${layoutMeta.secondaryCount} doc) | TP ${trimW.toFixed(1)}x${trimH.toFixed(1)}mm | Kho ${sheetDim.width}x${sheetDim.height}mm | Bleed ${bleedMm}mm`;

    sheets.push({
      index: sheets.length,
      physicalSheet: ps + 1,
      side: isDuplex ? 'Front' : 'Simplex',
      placements: frontPlacements,
      marks: frontMarks,
      slugText: config.showSlugLine ? stripVietnamese(`${slugBase} | ${isDuplex ? 'Mat Truoc' : '1 Mat'}`) : '',
    });

    if (isDuplex) {
      const backPlacements = mirrorPlacementsForBack(
        frontPlacements,
        sheetDim.width,
        sheetDim.height,
        duplexMode,
        backPageIndices
      );
      const backMarks = generateSheetMarks(backPlacements, sheetDim.width, sheetDim.height, {
        markStyle: config.markStyle,
        markLength: config.markLength,
        markOffset: config.markOffset,
        bleedMm,
        registrationMarks: config.registrationMarks,
      });
      sheets.push({
        index: sheets.length,
        physicalSheet: ps + 1,
        side: 'Back',
        placements: backPlacements,
        marks: backMarks,
        slugText: config.showSlugLine
          ? stripVietnamese(`${slugBase} | Mat Sau (${duplexMode === 'workAndTurn' ? 'Tro Nhip' : 'Tro Dit'})`)
          : '',
      });
    }
  }

  const usedArea = slotsWithClip.reduce((acc, s) => acc + s.trimW * s.trimH, 0);
  const sheetArea = sheetDim.width * sheetDim.height;
  const gridSummary = {
    totalSheets: sheets.length,
    physicalSheets: totalPhysical,
    ratioSheetsNeeded,
    itemsPerSheet: M,
    utilizationPct: Math.min(100, Math.round((usedArea / sheetArea) * 1000) / 10),
    trimW: Math.round(trimW * 100) / 100,
    trimH: Math.round(trimH * 100) / 100,
    primaryCount: layoutMeta.primaryCount,
    secondaryCount: layoutMeta.secondaryCount,
    cols: layoutMeta.cols,
    rows: layoutMeta.rows,
  };

  return {
    sheetDim,
    sheets,
    summary: gridSummary,
    jobChecks: runJobChecks(pagesMeta, sheets, sheetDim, config, gridSummary),
  };
}
