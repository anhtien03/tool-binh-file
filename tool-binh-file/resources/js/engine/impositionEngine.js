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

function stripVietnamese(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
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
  // Use TrimBox if present; otherwise subtract declared bleed from raw size
  const rawW = first.mediaWmm ?? first.width / MM_TO_PT;
  const rawH = first.mediaHmm ?? first.height / MM_TO_PT;
  const trimW = first.hasExplicitTrimBox ? first.trimWmm : Math.max(1, rawW - 2 * bleedMm);
  const trimH = first.hasExplicitTrimBox ? first.trimHmm : Math.max(1, rawH - 2 * bleedMm);

  const sheets = [];

  if (config.mode === 'booklet') {
    const numPages = pagesMeta.length;
    const padded = Math.ceil(numPages / 4) * 4;
    const physicalSheets = padded / 4;
    const bookletStyle = config.bookletStyle || 'saddleStitch'; // 'saddleStitch' | 'perfectBound'
    const binding = config.bookletBinding || 'left';
    const creepMm = Math.max(0, Number(config.bookletCreep) || 0);

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
      if (bookletStyle === 'perfectBound') {
        // 4-page signatures stacked sequentially: (4|1) & (2|3), (8|5) & (6|7)...
        const base = k * 4;
        fLeft = base + 4;
        fRight = base + 1;
        bLeft = base + 2;
        bRight = base + 3;
      } else {
        // Saddle-Stitch nested
        fLeft = padded - 2 * k;
        fRight = 2 * k + 1;
        bLeft = 2 * k + 2;
        bRight = padded - 2 * k - 1;
      }

      if (binding === 'right') {
        [fLeft, fRight] = [fRight, fLeft];
        [bLeft, bRight] = [bRight, bLeft];
      }

      const creepShift = bookletStyle === 'saddleStitch' ? k * creepMm : 0;

      const buildBookletSide = (leftNum, rightNum, sideLabel) => {
        const placements = [];
        if (leftNum <= numPages) {
          placements.push({
            pageIndex: leftNum - 1,
            x: spineX - drawW + creepShift,
            y: topY,
            trimW: drawW,
            trimH: drawH,
            rotate: 0,
            scale,
            block: 'primary',
            // Clip inner spine bleed to 0; keep 3 outer edges
            clipBleed: { top: bleedMm * scale, right: 0, bottom: bleedMm * scale, left: bleedMm * scale },
          });
        }
        if (rightNum <= numPages) {
          placements.push({
            pageIndex: rightNum - 1,
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

        const rawSlug = `PrynX Engine | Booklet (${bookletStyle === 'saddleStitch' ? 'Bam kim' : 'Dong keo'}) | To ${k + 1}/${physicalSheets} (${sideLabel}) | Kho ${sheetDim.width}x${sheetDim.height}mm | Creep ${creepMm}mm`;
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
    return {
      sheetDim,
      sheets,
      summary: {
        totalSheets: sheets.length,
        physicalSheets,
        itemsPerSheet: 2,
        utilizationPct: Math.min(100, Math.round((usedArea / sheetArea) * 1000) / 10),
        trimW: Math.round(trimW * 100) / 100,
        trimH: Math.round(trimH * 100) / 100,
        primaryCount: 2,
        secondaryCount: 0,
      },
    };
  }

  // ==================== GRID / GUILLOTINE MODE ====================
  const { slots: rawSlots, layoutMeta } = buildRawSlots(config, availW, availH, trimW, trimH);
  const alignedSlots = alignSlots(rawSlots, sheetDim.width, sheetDim.height, effMargins, config.alignment || 'center');
  const slotsWithClip = applySmartBleedClipping(alignedSlots, bleedMm);
  const M = slotsWithClip.length;

  const collation = config.collation || 'stepAndRepeat'; // 'stepAndRepeat' | 'sequential' | 'cutAndStack' | 'ratioStack'
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

  if (collation === 'ratioStack') {
    const { slots: ratioSlots, sheetsNeeded, overflow } = allocateRatioStack(logicalItems, M);
    ratioSheetsNeeded = sheetsNeeded;
    if (!overflow && ratioSlots.length > 0) {
      physicalSheetSlots.push(ratioSlots);
    } else {
      const S = Math.ceil(N / M);
      for (let s = 0; s < S; s++) {
        const row = [];
        for (let p = 0; p < M; p++) {
          const itemIdx = s * M + p;
          row.push(itemIdx < N ? logicalItems[itemIdx] : null);
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
        const row = [];
        for (let p = 0; p < M; p++) {
          const itemIdx = p * S + s;
          row.push(itemIdx < batch.length ? batch[itemIdx] : null);
        }
        physicalSheetSlots.push(row);
      }
    }
  } else {
    // sequential N-Up
    const S = Math.ceil(N / M);
    for (let s = 0; s < S; s++) {
      const row = [];
      for (let p = 0; p < M; p++) {
        const itemIdx = s * M + p;
        row.push(itemIdx < N ? logicalItems[itemIdx] : null);
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

  return {
    sheetDim,
    sheets,
    summary: {
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
    },
  };
}
