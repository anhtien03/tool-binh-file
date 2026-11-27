/**
 * PrintKit V1 — Phase 4: Smart Sticker Imposition Planner
 *
 * Pure, deterministic, additive planning engine (ZERO edits to 17 LOCKED engine files).
 * Emits H.2-compatible `sheetTemplateBlueprints` that feed directly into the ONE shared
 * PrintKit V1/H.2 BatchPlan (`buildV1StickerTabPlan` -> `createCheckpointKBatch`).
 *
 * Capabilities:
 *  - Optimal packing from actual sticker contour dimensions (widthMm × heightMm).
 *  - Step & Repeat (S&R), N-Up Multi-SKU, and Hybrid Mixed (S&R + N-Up) multi-model imposition.
 *  - Automatic 0° / 90° / 180° rotation when permitted (`allowRotationMode`).
 *  - Multi-option generation & ranking so operators can compare & pick the best plan.
 *  - Exact production metrics: stickers/sheet, sheets needed, waste area (mm²/cm²/%), utilization %.
 *  - Production clustering by model (`by_model`), quantity (`by_quantity`), or order (`by_order`).
 */

export const ROTATION_MODES = Object.freeze({
  NONE: 'none',
  ROT_90: 'rot90',
  ROT_180: 'rot180',
  ROT_90_180: 'rot90_180',
});

export const CLUSTER_MODES = Object.freeze({
  NONE: 'none',
  BY_MODEL: 'by_model',
  BY_QUANTITY: 'by_quantity',
  BY_ORDER: 'by_order',
});

export const IMPOSITION_STRATEGIES = Object.freeze({
  AUTO_OPTIMAL: 'auto_optimal',
  KEEP_0: 'keep_0',
  FORCE_90: 'force_90',
  FORCE_180: 'force_180',
  MIXED_SR_NUP: 'mixed_sr_nup',
  NUP_GANG: 'nup_gang',
  SR_PER_MODEL: 'sr_per_model',
});

function r2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

/**
 * Resolve allowed rotation angles from `allowRotationMode`.
 */
export function resolveAllowedRotations(allowRotationMode = ROTATION_MODES.ROT_90_180) {
  switch (allowRotationMode) {
    case ROTATION_MODES.NONE:
      return [0];
    case ROTATION_MODES.ROT_90:
      return [0, 90];
    case ROTATION_MODES.ROT_180:
      return [0, 180];
    case ROTATION_MODES.ROT_90_180:
    default:
      return [0, 90, 180];
  }
}

/**
 * Evaluate exact grid capacity for a given sticker cell size and rotation angle (0, 90, 180, 270).
 */
export function evaluateOrientationFit({ cellW, cellH, safeW, safeH, cutGapXMm = 0, cutGapYMm = 0, rotationDeg = 0 }) {
  const rot = ((Number(rotationDeg) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const effW = swap ? Number(cellH) || 0 : Number(cellW) || 0;
  const effH = swap ? Number(cellW) || 0 : Number(cellH) || 0;

  if (effW <= 0 || effH <= 0 || safeW <= 0 || safeH <= 0) {
    return { rotationDeg: rot, fits: false, columns: 0, rows: 0, capacity: 0, effW: r4(effW), effH: r4(effH) };
  }

  const fits = effW <= safeW + 1e-6 && effH <= safeH + 1e-6;
  const columns = fits ? Math.max(1, Math.floor((safeW + cutGapXMm + 1e-6) / Math.max(0.1, effW + cutGapXMm))) : 0;
  const rows = fits ? Math.max(1, Math.floor((safeH + cutGapYMm + 1e-6) / Math.max(0.1, effH + cutGapYMm))) : 0;
  return {
    rotationDeg: rot,
    fits,
    columns,
    rows,
    capacity: columns * rows,
    effW: r4(effW),
    effH: r4(effH),
  };
}

/**
 * Choose best orientation from allowed rotation angles (deterministic tie-break: 0° -> 90° -> 180°).
 */
export function selectBestOrientation({
  cellW,
  cellH,
  safeW,
  safeH,
  cutGapXMm = 0,
  cutGapYMm = 0,
  allowedRotations = [0, 90, 180],
  preferredRotation = null,
}) {
  if (preferredRotation !== null && preferredRotation !== undefined) {
    const pref = evaluateOrientationFit({
      cellW,
      cellH,
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      rotationDeg: preferredRotation,
    });
    if (pref.fits) return pref;
  }

  let best = null;
  for (const rot of allowedRotations) {
    const candidate = evaluateOrientationFit({
      cellW,
      cellH,
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      rotationDeg: rot,
    });
    if (!candidate.fits) continue;
    if (!best || candidate.capacity > best.capacity) {
      best = candidate;
    }
  }

  return (
    best ||
    evaluateOrientationFit({
      cellW,
      cellH,
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      rotationDeg: allowedRotations[0] ?? 0,
    })
  );
}

/**
 * Cluster sticker items deterministically by model, quantity tier, or order ID.
 */
export function clusterStickerItems(items = [], { clusterMode = CLUSTER_MODES.NONE } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  if (clusterMode === CLUSTER_MODES.BY_MODEL) {
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const key = String(it.modelKey || it.label || it.id || `MODEL-${i + 1}`);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    let idx = 1;
    return Array.from(groups.entries()).map(([key, list]) => ({
      clusterId: `CL-MODEL-${idx++}`,
      clusterMode: CLUSTER_MODES.BY_MODEL,
      clusterLabel: `Mẫu: ${key}`,
      groupKey: key,
      items: list,
    }));
  }

  if (clusterMode === CLUSTER_MODES.BY_ORDER) {
    const groups = new Map();
    for (const it of items) {
      const orderKey = String(it.orderId || 'DON-01').trim() || 'DON-01';
      if (!groups.has(orderKey)) groups.set(orderKey, []);
      groups.get(orderKey).push(it);
    }
    let idx = 1;
    return Array.from(groups.entries()).map(([orderKey, list]) => ({
      clusterId: `CL-ORDER-${idx++}`,
      clusterMode: CLUSTER_MODES.BY_ORDER,
      clusterLabel: `Đơn hàng: ${orderKey}`,
      groupKey: orderKey,
      items: list,
    }));
  }

  if (clusterMode === CLUSTER_MODES.BY_QUANTITY) {
    // Sort by requested quantity descending, then partition into balanced quantity tiers (max/min <= 2.0)
    const sorted = [...items].sort((a, b) => (Number(b.quantity) || 1) - (Number(a.quantity) || 1));
    const tiers = [];
    for (const it of sorted) {
      const q = Math.max(1, Number(it.quantity) || 1);
      const lastTier = tiers[tiers.length - 1];
      if (!lastTier) {
        tiers.push({ minQ: q, maxQ: q, items: [it] });
      } else {
        const nextMin = Math.min(lastTier.minQ, q);
        const nextMax = Math.max(lastTier.maxQ, q);
        if (nextMax / Math.max(1, nextMin) <= 2.0) {
          lastTier.minQ = nextMin;
          lastTier.maxQ = nextMax;
          lastTier.items.push(it);
        } else {
          tiers.push({ minQ: q, maxQ: q, items: [it] });
        }
      }
    }
    return tiers.map((t, idx) => ({
      clusterId: `CL-QTY-${idx + 1}`,
      clusterMode: CLUSTER_MODES.BY_QUANTITY,
      clusterLabel:
        t.minQ === t.maxQ
          ? `Cụm SL ${t.minQ} tem`
          : `Cụm SL ${t.minQ}–${t.maxQ} tem`,
      groupKey: `${t.minQ}-${t.maxQ}`,
      items: t.items,
    }));
  }

  return [
    {
      clusterId: 'CL-ALL',
      clusterMode: CLUSTER_MODES.NONE,
      clusterLabel: 'Tất cả mẫu',
      groupKey: 'ALL',
      items: [...items],
    },
  ];
}

/**
 * Compute comprehensive production & waste metrics for a set of sheet template blueprints.
 */
export function computeImpositionMetrics({
  sheetWidthMm,
  sheetHeightMm,
  blueprints = [],
  totalRequestedStickers = 0,
}) {
  const sheetAreaMm2 = Math.max(0, (Number(sheetWidthMm) || 0) * (Number(sheetHeightMm) || 0));
  let physicalSheetsNeeded = 0;
  let totalProducedStickers = 0;
  let totalUsedAreaMm2 = 0;
  let minPerSheet = Infinity;
  let maxPerSheet = 0;

  for (const bp of blueprints) {
    const runCount = Math.max(1, Number(bp.runCount) || 1);
    const perSheet = bp.items.reduce((sum, it) => sum + (Number(it.copiesPerRun) || 0), 0);
    const sheetUsedMm2 = bp.items.reduce(
      (sum, it) => sum + (Number(it.copiesPerRun) || 0) * (Number(it.widthMm) || 0) * (Number(it.heightMm) || 0),
      0
    );
    physicalSheetsNeeded += runCount;
    totalProducedStickers += perSheet * runCount;
    totalUsedAreaMm2 += sheetUsedMm2 * runCount;
    if (perSheet < minPerSheet) minPerSheet = perSheet;
    if (perSheet > maxPerSheet) maxPerSheet = perSheet;
  }

  const totalSheetAreaMm2 = sheetAreaMm2 * physicalSheetsNeeded;
  const utilizationPct =
    totalSheetAreaMm2 > 0 ? Math.min(100, r2((totalUsedAreaMm2 / totalSheetAreaMm2) * 100)) : 0;
  const wasteAreaMm2 = Math.max(0, r2(totalSheetAreaMm2 - totalUsedAreaMm2));
  const wasteAreaCm2 = r2(wasteAreaMm2 / 100);
  const wastePct = totalSheetAreaMm2 > 0 ? Math.max(0, r2(100 - utilizationPct)) : 0;
  const avgStickersPerSheet =
    physicalSheetsNeeded > 0 ? r2(totalProducedStickers / physicalSheetsNeeded) : 0;
  const req = Math.max(0, Number(totalRequestedStickers) || 0);
  const overrunStickers = Math.max(0, totalProducedStickers - req);

  return {
    stickersPerSheet: maxPerSheet,
    avgStickersPerSheet,
    minStickersPerSheet: Number.isFinite(minPerSheet) ? minPerSheet : 0,
    maxStickersPerSheet: maxPerSheet,
    physicalSheetsNeeded,
    uniqueTemplatesCount: blueprints.length,
    totalProducedStickers,
    totalRequestedStickers: req,
    overrunStickers,
    sheetAreaMm2: r2(sheetAreaMm2),
    totalSheetAreaMm2: r2(totalSheetAreaMm2),
    usedAreaMm2: r2(totalUsedAreaMm2),
    wasteAreaMm2,
    wasteAreaCm2,
    utilizationPct,
    wastePct,
  };
}

/**
 * Pack a single cluster of sticker items according to a packing style (`sr`, `nup`, `mixed`).
 * Returns `{ feasible, blueprints, reason }`.
 */
function packCluster({
  cluster,
  packStyle, // 'sr' | 'nup' | 'mixed'
  safeW,
  safeH,
  cutGapXMm,
  cutGapYMm,
  allowedRotations,
  forcedRotation = null,
  autoFillSheet = true,
  defaultRunCount = 1,
}) {
  const blueprints = [];
  const items = cluster.items || [];
  if (items.length === 0) return { feasible: false, blueprints: [], reason: 'EMPTY_CLUSTER' };

  const resolveItemRotations = (it) => {
    if (it.allowRotate === false) return [0];
    if (forcedRotation !== null && forcedRotation !== undefined) {
      return allowedRotations.includes(forcedRotation) ? [forcedRotation] : [0];
    }
    return allowedRotations;
  };

  // Strategy A: S&R per model (each item gets dedicated sheet template(s))
  if (packStyle === 'sr') {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rots = resolveItemRotations(it);
      const orient = selectBestOrientation({
        cellW: it.widthMm,
        cellH: it.heightMm,
        safeW,
        safeH,
        cutGapXMm,
        cutGapYMm,
        allowedRotations: rots,
        preferredRotation: forcedRotation,
      });
      if (!orient.fits || orient.capacity < 1) {
        return { feasible: false, blueprints: [], reason: `ITEM_TOO_LARGE:${it.id}` };
      }

      const cap = orient.capacity;
      let copiesPerRun = cap;
      let runCount = Math.max(1, Number(defaultRunCount) || 1);

      if (it.isMultiDistinct) {
        if (cap < it.contourCount) {
          return { feasible: false, blueprints: [], reason: `MULTI_DISTINCT_CAPACITY:${it.id}` };
        }
        copiesPerRun = it.contourCount;
        runCount = Math.max(1, Number(it.runCount) || Number(defaultRunCount) || 1);
      } else if (Number.isFinite(Number(it.quantity)) && Number(it.quantity) >= 1) {
        const reqQty = Math.round(Number(it.quantity));
        if (!autoFillSheet && reqQty < cap) {
          copiesPerRun = reqQty;
          runCount = 1;
        } else {
          copiesPerRun = cap;
          runCount = Math.max(1, Math.ceil(reqQty / cap));
        }
      } else if (Number.isFinite(Number(it.runCount)) && Number(it.runCount) >= 1) {
        copiesPerRun = cap;
        runCount = Math.round(Number(it.runCount));
      }

      blueprints.push({
        templateId: `TPL-${cluster.clusterId}-SR-${i + 1}`,
        packType: 'SR',
        clusterId: cluster.clusterId,
        clusterLabel: cluster.clusterLabel,
        columns: orient.columns,
        rows: orient.rows,
        effW: orient.effW,
        effH: orient.effH,
        rotationDeg: orient.rotationDeg,
        runCount,
        items: [
          {
            id: it.id,
            pageNum: it.pageNum,
            jobId: it.jobId,
            widthMm: it.widthMm,
            heightMm: it.heightMm,
            copiesPerRun,
          },
        ],
      });
    }
    return { feasible: true, blueprints, reason: null };
  }

  // Multi-distinct pages (e.g. 99 stickers already arranged on a single source page) must use S&R
  const hasMultiDistinct = items.some((it) => it.isMultiDistinct);
  if (hasMultiDistinct) {
    return packCluster({
      cluster,
      packStyle: 'sr',
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      allowedRotations,
      forcedRotation,
      autoFillSheet,
      defaultRunCount,
    });
  }

  // Helper: pack a list of { item, qty } onto shared N-Up sheets
  const packSharedNup = (remainders, prefix) => {
    if (remainders.length === 0) return { feasible: true, sheets: [] };
    let maxW = 0;
    let maxH = 0;
    let canAllRotate = true;
    for (const { item } of remainders) {
      if (item.widthMm > maxW) maxW = item.widthMm;
      if (item.heightMm > maxH) maxH = item.heightMm;
      if (item.allowRotate === false) canAllRotate = false;
    }
    const rots = !canAllRotate
      ? [0]
      : forcedRotation !== null && forcedRotation !== undefined && allowedRotations.includes(forcedRotation)
      ? [forcedRotation]
      : allowedRotations;

    const orient = selectBestOrientation({
      cellW: maxW,
      cellH: maxH,
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      allowedRotations: rots,
      preferredRotation: canAllRotate ? forcedRotation : 0,
    });
    if (!orient.fits || orient.capacity < 1) {
      return { feasible: false, sheets: [] };
    }

    const cap = orient.capacity;
    const chunks = [];
    let currentItems = [];
    let currentUsed = 0;

    for (const { item, qty } of remainders) {
      const resolvedItemQty =
        Number.isFinite(Number(qty)) && Number(qty) >= 1
          ? Math.round(Number(qty))
          : autoFillSheet
          ? Math.max(1, Math.floor(cap / Math.max(1, remainders.length))) *
            Math.max(1, Number(item.runCount) || Number(defaultRunCount) || 1)
          : Math.max(1, Number(item.runCount) || Number(defaultRunCount) || 1);
      let rem = Math.max(1, resolvedItemQty);
      while (rem > 0) {
        const space = cap - currentUsed;
        if (space <= 0) {
          chunks.push(currentItems);
          currentItems = [];
          currentUsed = 0;
          continue;
        }
        const take = Math.min(rem, space);
        currentItems.push({
          id: item.id,
          pageNum: item.pageNum,
          jobId: item.jobId,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          copiesPerRun: take,
        });
        currentUsed += take;
        rem -= take;
      }
    }
    if (currentItems.length > 0) chunks.push(currentItems);

    // Merge identical chunks into a single template with incremented runCount (keeps unique templates compact!)
    const merged = [];
    for (const ch of chunks) {
      const sig = ch.map((c) => `${c.id}:${c.copiesPerRun}`).join('|');
      const existing = merged.find((m) => m.sig === sig);
      if (existing) {
        existing.runCount += 1;
      } else {
        merged.push({ sig, items: ch, runCount: 1 });
      }
    }

    const sheets = merged.map((m, idx) => ({
      templateId: `TPL-${cluster.clusterId}-${prefix}-${idx + 1}`,
      packType: 'NUP',
      clusterId: cluster.clusterId,
      clusterLabel: cluster.clusterLabel,
      columns: orient.columns,
      rows: orient.rows,
      effW: orient.effW,
      effH: orient.effH,
      rotationDeg: orient.rotationDeg,
      runCount: m.runCount,
      items: m.items,
    }));

    return { feasible: true, sheets };
  };

  // Strategy B: Pure N-Up Gang (all items packed sequentially onto shared N-Up sheets)
  if (packStyle === 'nup') {
    const reqs = items.map((it) => ({
      item: it,
      qty: Number.isFinite(Number(it.quantity)) && Number(it.quantity) >= 1 ? Math.round(Number(it.quantity)) : null,
    }));
    const nupRes = packSharedNup(reqs, 'NUP');
    if (!nupRes.feasible) return { feasible: false, blueprints: [], reason: 'NUP_TOO_LARGE' };
    return { feasible: true, blueprints: nupRes.sheets, reason: null };
  }

  // Strategy C: Mixed S&R + N-Up (full sheets as S&R with runCount, remainders gang-packed as N-Up)
  const remainders = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const rots = resolveItemRotations(it);
    const orient = selectBestOrientation({
      cellW: it.widthMm,
      cellH: it.heightMm,
      safeW,
      safeH,
      cutGapXMm,
      cutGapYMm,
      allowedRotations: rots,
      preferredRotation: forcedRotation,
    });
    if (!orient.fits || orient.capacity < 1) {
      return { feasible: false, blueprints: [], reason: `ITEM_TOO_LARGE:${it.id}` };
    }

    const cap = orient.capacity;
    const itemRunCount = Math.max(1, Number(it.runCount) || Number(defaultRunCount) || 1);
    const reqQty =
      Number.isFinite(Number(it.quantity)) && Number(it.quantity) >= 1
        ? Math.round(Number(it.quantity))
        : cap * itemRunCount;
    const fullSheets = Math.floor(reqQty / cap);
    const remQty = reqQty % cap;

    if (fullSheets >= 1) {
      blueprints.push({
        templateId: `TPL-${cluster.clusterId}-MIXSR-${i + 1}`,
        packType: 'SR',
        clusterId: cluster.clusterId,
        clusterLabel: cluster.clusterLabel,
        columns: orient.columns,
        rows: orient.rows,
        effW: orient.effW,
        effH: orient.effH,
        rotationDeg: orient.rotationDeg,
        runCount: fullSheets,
        items: [
          {
            id: it.id,
            pageNum: it.pageNum,
            jobId: it.jobId,
            widthMm: it.widthMm,
            heightMm: it.heightMm,
            copiesPerRun: cap,
          },
        ],
      });
    }
    if (remQty > 0) {
      remainders.push({ item: it, qty: remQty });
    }
  }

  if (remainders.length > 0) {
    const nupRes = packSharedNup(remainders, 'MIXNUP');
    if (!nupRes.feasible) return { feasible: false, blueprints: [], reason: 'MIXED_NUP_TOO_LARGE' };
    blueprints.push(...nupRes.sheets);
  }

  return { feasible: blueprints.length > 0, blueprints, reason: null };
}

function blueprintDedupSignature(blueprints) {
  return blueprints
    .map(
      (bp) =>
        `${bp.packType}:${bp.clusterId}:${bp.columns}x${bp.rows}@${bp.rotationDeg}:rc=${bp.runCount}:[${bp.items
          .map((it) => `${it.id}=${it.copiesPerRun}`)
          .join(',')}]`
    )
    .join('||');
}

/**
 * Generate and rank multiple concrete Smart Imposition options for operator selection.
 *
 * Each option carries:
 *  - `optionId`, `label`, `badge`, `strategy`, `recommended`
 *  - `rotationDegSummary` (e.g. `0°`, `90°`, `180°`, `Hỗn hợp 0°/90°`)
 *  - `metrics` (`stickersPerSheet`, `physicalSheetsNeeded`, `wasteAreaCm2`, `wastePct`, `utilizationPct`, `overrunStickers`)
 *  - `clusters` (per-cluster summary)
 *  - `sheetTemplateBlueprints` (ready to compile directly into ONE shared H.2 BatchPlan!)
 */
export function generateSmartImpositionOptions({
  items = [],
  sheetWidthMm = 330,
  sheetHeightMm = 390,
  marginsMm = { top: 15, right: 15, bottom: 15, left: 15 },
  cutGapXMm = 2,
  cutGapYMm = 2,
  allowRotationMode = ROTATION_MODES.ROT_90_180,
  clusterMode = CLUSTER_MODES.NONE,
  autoFillSheet = true,
  defaultRunCount = 1,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { options: [], recommendedOptionId: null, clusters: [] };
  }

  const mL = Math.max(0, Number(marginsMm?.left) || 0);
  const mR = Math.max(0, Number(marginsMm?.right) || 0);
  const mT = Math.max(0, Number(marginsMm?.top) || 0);
  const mB = Math.max(0, Number(marginsMm?.bottom) || 0);
  const safeW = Math.max(0, (Number(sheetWidthMm) || 0) - mL - mR);
  const safeH = Math.max(0, (Number(sheetHeightMm) || 0) - mT - mB);
  const allowedRotations = resolveAllowedRotations(allowRotationMode);
  const clusters = clusterStickerItems(items, { clusterMode });
  const isMultiModel = items.length > 1 && items.every((it) => !it.isMultiDistinct);
  const hasExplicitQuantities = items.some((it) => !it.isMultiDistinct && Number.isFinite(Number(it.quantity)) && Number(it.quantity) >= 1);
  const totalRequestedStickers = items.reduce((sum, it) => {
    if (it.isMultiDistinct) {
      return sum + (Number(it.contourCount) || 1) * Math.max(1, Number(it.runCount) || Number(defaultRunCount) || 1);
    }
    if (Number.isFinite(Number(it.quantity)) && Number(it.quantity) >= 1) {
      return sum + Math.round(Number(it.quantity));
    }
    return sum;
  }, 0);

  // Define candidate strategies to evaluate
  const candidateDefs = [];

  if (isMultiModel) {
    candidateDefs.push({
      optionId: 'OPT-MIXED-AUTO',
      strategy: IMPOSITION_STRATEGIES.MIXED_SR_NUP,
      label: 'Hỗn hợp S&R + N-Up (Tối ưu)',
      badge: 'S&R + N-Up',
      packStyle: 'mixed',
      forcedRotation: null,
    });
    candidateDefs.push({
      optionId: 'OPT-NUP-AUTO',
      strategy: IMPOSITION_STRATEGIES.NUP_GANG,
      label: 'N-Up gộp nhiều mẫu',
      badge: 'N-Up',
      packStyle: 'nup',
      forcedRotation: null,
    });
    candidateDefs.push({
      optionId: 'OPT-SR-AUTO',
      strategy: IMPOSITION_STRATEGIES.SR_PER_MODEL,
      label: 'Tách riêng S&R từng mẫu',
      badge: 'S&R',
      packStyle: 'sr',
      forcedRotation: null,
    });
  } else {
    candidateDefs.push({
      optionId: 'OPT-AUTO-OPTIMAL',
      strategy: IMPOSITION_STRATEGIES.AUTO_OPTIMAL,
      label: 'Tối ưu mật độ (Tự xoay)',
      badge: 'Tối ưu',
      packStyle: 'sr',
      forcedRotation: null,
    });
  }

  // Always offer explicit 0° option for grain/direction comparison
  candidateDefs.push({
    optionId: 'OPT-KEEP-0',
    strategy: IMPOSITION_STRATEGIES.KEEP_0,
    label: 'Giữ nguyên hướng 0° (Không xoay)',
    badge: '0°',
    packStyle: isMultiModel ? 'mixed' : 'sr',
    forcedRotation: 0,
  });

  // Offer explicit 90° option when permitted
  if (allowedRotations.includes(90)) {
    candidateDefs.push({
      optionId: 'OPT-FORCE-90',
      strategy: IMPOSITION_STRATEGIES.FORCE_90,
      label: 'Xoay 90° (Đổi chiều ngang/dọc)',
      badge: '90°',
      packStyle: isMultiModel ? 'mixed' : 'sr',
      forcedRotation: 90,
    });
  }

  // Offer explicit 180° option when permitted (head-to-foot / gripper-edge flip)
  if (allowedRotations.includes(180)) {
    candidateDefs.push({
      optionId: 'OPT-FORCE-180',
      strategy: IMPOSITION_STRATEGIES.FORCE_180,
      label: 'Xoay 180° (Đảo đầu nhíp)',
      badge: '180°',
      packStyle: isMultiModel ? 'mixed' : 'sr',
      forcedRotation: 180,
    });
  }

  const rawOptions = [];
  const seenSigs = new Set();

  for (const def of candidateDefs) {
    const allBlueprints = [];
    let feasible = true;
    for (const cl of clusters) {
      const res = packCluster({
        cluster: cl,
        packStyle: def.packStyle,
        safeW,
        safeH,
        cutGapXMm,
        cutGapYMm,
        allowedRotations,
        forcedRotation: def.forcedRotation,
        autoFillSheet,
        defaultRunCount,
      });
      if (!res.feasible) {
        feasible = false;
        break;
      }
      allBlueprints.push(...res.blueprints);
    }
    if (!feasible || allBlueprints.length === 0) continue;

    // Deduplicate identical layout blueprints (keep explicit 180° distinct since rotationDeg differs)
    const sig = blueprintDedupSignature(allBlueprints);
    if (seenSigs.has(sig)) continue;
    seenSigs.add(sig);

    const metrics = computeImpositionMetrics({
      sheetWidthMm,
      sheetHeightMm,
      blueprints: allBlueprints,
      totalRequestedStickers,
    });

    const rotSet = Array.from(new Set(allBlueprints.map((bp) => bp.rotationDeg))).sort((a, b) => a - b);
    const rotationDegSummary = rotSet.length === 1 ? `${rotSet[0]}°` : rotSet.map((r) => `${r}°`).join('/');

    const clusterSummaries = clusters.map((cl) => {
      const clBps = allBlueprints.filter((bp) => bp.clusterId === cl.clusterId);
      const clMetrics = computeImpositionMetrics({
        sheetWidthMm,
        sheetHeightMm,
        blueprints: clBps,
        totalRequestedStickers: cl.items.reduce((s, it) => s + Math.max(1, Number(it.quantity) || 1), 0),
      });
      return {
        clusterId: cl.clusterId,
        clusterMode: cl.clusterMode,
        clusterLabel: cl.clusterLabel,
        itemCount: cl.items.length,
        templateIds: clBps.map((bp) => bp.templateId),
        physicalSheets: clMetrics.physicalSheetsNeeded,
        totalStickers: clMetrics.totalProducedStickers,
        utilizationPct: clMetrics.utilizationPct,
        wastePct: clMetrics.wastePct,
      };
    });

    rawOptions.push({
      optionId: def.optionId,
      strategy: def.strategy,
      label: def.label,
      badge: def.badge,
      packStyle: def.packStyle,
      rotationDegSummary,
      rotationsUsed: rotSet,
      metrics,
      clusters: clusterSummaries,
      sheetTemplateBlueprints: allBlueprints,
      recommended: false,
    });
  }

  // Deterministic ranking:
  // - When explicit sticker quantities are provided:
  //   1. Lowest physicalSheetsNeeded
  //   2. Highest utilizationPct (lowest wastePct)
  //   3. Lowest overrunStickers
  //   4. Fewest uniqueTemplatesCount (fewer die-cut setups)
  //   5. Prefer 0° / 90° over 180° on exact tie
  // - When no explicit sticker quantities are provided (sheet-fill comparison):
  //   1. Highest utilizationPct (prefer fuller sheets over sparse sheets)
  //   2. Lowest physicalSheetsNeeded
  //   3. Fewest uniqueTemplatesCount
  //   4. Prefer 0° / 90° over 180° on exact tie
  rawOptions.sort((a, b) => {
    if (hasExplicitQuantities) {
      if (a.metrics.physicalSheetsNeeded !== b.metrics.physicalSheetsNeeded) {
        return a.metrics.physicalSheetsNeeded - b.metrics.physicalSheetsNeeded;
      }
      if (Math.abs(b.metrics.utilizationPct - a.metrics.utilizationPct) > 0.05) {
        return b.metrics.utilizationPct - a.metrics.utilizationPct;
      }
      if (a.metrics.overrunStickers !== b.metrics.overrunStickers) {
        return a.metrics.overrunStickers - b.metrics.overrunStickers;
      }
    } else {
      if (Math.abs(b.metrics.utilizationPct - a.metrics.utilizationPct) > 0.05) {
        return b.metrics.utilizationPct - a.metrics.utilizationPct;
      }
      if (a.metrics.physicalSheetsNeeded !== b.metrics.physicalSheetsNeeded) {
        return a.metrics.physicalSheetsNeeded - b.metrics.physicalSheetsNeeded;
      }
    }
    if (a.metrics.uniqueTemplatesCount !== b.metrics.uniqueTemplatesCount) {
      return a.metrics.uniqueTemplatesCount - b.metrics.uniqueTemplatesCount;
    }
    const aIs180 = a.strategy === IMPOSITION_STRATEGIES.FORCE_180 ? 1 : 0;
    const bIs180 = b.strategy === IMPOSITION_STRATEGIES.FORCE_180 ? 1 : 0;
    return aIs180 - bIs180;
  });

  if (rawOptions.length > 0) {
    rawOptions[0].recommended = true;
  }

  return {
    options: rawOptions,
    recommendedOptionId: rawOptions[0]?.optionId || null,
    clusters: rawOptions[0]?.clusters || [],
  };
}
