/**
 * Parametric Dieline 2D & 3D Hierarchical Folding Engine (PrynX-style)
 * All coordinates are in mm (origin top-left, +X right, +Y down).
 */

export const DIELINE_TEMPLATES = {
  rte: {
    id: 'rte',
    name: 'Hộp Nắp Gài Ngược (Reverse Tuck End)',
    shortName: 'Nắp gài ngược (RTE)',
    description: 'Mẫu hộp mỹ phẩm, dược phẩm phổ biến nhất — nắp trên và nắp dưới gài ngược chiều nhau.',
    defaults: { L: 80, W: 50, H: 120, thickness: 0.4, glueTab: 15, tuckFlap: 18 },
    uprightRotateX: -Math.PI / 2, // Stand Front panel vertically
  },
  ste: {
    id: 'ste',
    name: 'Hộp Nắp Gài Cùng Chiều (Straight Tuck End)',
    shortName: 'Nắp gài cùng chiều (STE)',
    description: 'Nắp trên và nắp dưới cùng gài về mặt sau — mặt trước sạch đẹp, tối ưu trưng bày.',
    defaults: { L: 80, W: 50, H: 120, thickness: 0.4, glueTab: 15, tuckFlap: 18 },
    uprightRotateX: -Math.PI / 2,
  },
  tray: {
    id: 'tray',
    name: 'Khay Hộp Mở Nắp (Open Tray)',
    shortName: 'Khay hộp (Tray)',
    description: 'Khay đựng thực phẩm, quà tặng, mỹ phẩm gồm đáy + 4 vách + 4 tai dán góc.',
    defaults: { L: 140, W: 100, H: 35, thickness: 0.5, glueTab: 18, tuckFlap: 0 },
    uprightRotateX: 0, // Bottom already sits flat on floor
  },
};

function rectPoly(x, y, w, h) {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

// Tapered trapezoid flap (glue tab / dust flap / tuck flap)
function tuckPoly(x, y, w, h, dir = 'up', taper = 3) {
  const t = Math.min(taper, w * 0.15);
  if (dir === 'up') {
    return [
      [x, y + h],
      [x + t, y],
      [x + w - t, y],
      [x + w, y + h],
    ];
  }
  return [
    [x, y],
    [x + w, y],
    [x + w - t, y + h],
    [x + t, y + h],
  ];
}

function dustFlapPoly(x, y, w, h, dir = 'up') {
  const cut = Math.min(5, w * 0.15, h * 0.25);
  if (dir === 'up') {
    return [
      [x, y + h],
      [x + cut, y],
      [x + w - cut, y],
      [x + w, y + h],
    ];
  }
  return [
    [x, y],
    [x + w, y],
    [x + w - cut, y + h],
    [x + cut, y + h],
  ];
}

function glueTabPoly(x, y, w, h, side = 'left') {
  const taper = Math.min(8, h * 0.12);
  if (side === 'left') {
    return [
      [x + w, y],
      [x + w, y + h],
      [x, y + h - taper],
      [x, y + taper],
    ];
  }
  return [
    [x, y],
    [x + w, y + taper],
    [x + w, y + h - taper],
    [x, y + h],
  ];
}

/**
 * Traverse panel tree to collect bounds, 2D cut polylines, and 2D crease segments
 */
function finalizeDieline(rootPanel, meta) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const visitBounds = (node) => {
    for (const [px, py] of node.polygon) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (node.children) node.children.forEach(visitBounds);
  };
  visitBounds(rootPanel);

  // Shift everything so top-left starts at (0, 0)
  const shiftNode = (node) => ({
    ...node,
    polygon: node.polygon.map(([px, py]) => [px - minX, py - minY]),
    hinge: node.hinge
      ? {
          p1: [node.hinge.p1[0] - minX, node.hinge.p1[1] - minY],
          p2: [node.hinge.p2[0] - minX, node.hinge.p2[1] - minY],
        }
      : null,
    children: node.children ? node.children.map(shiftNode) : [],
  });

  const normalizedRoot = shiftNode(rootPanel);
  const width = Math.round((maxX - minX) * 100) / 100;
  const height = Math.round((maxY - minY) * 100) / 100;

  // Extract Cut edges vs Crease edges
  const creaseSegments = [];
  const creaseKeySet = new Set();

  const segKey = (a, b) => {
    const k1 = `${Math.round(a[0] * 10)},${Math.round(a[1] * 10)}`;
    const k2 = `${Math.round(b[0] * 10)},${Math.round(b[1] * 10)}`;
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  };

  const collectCreases = (node) => {
    if (node.hinge) {
      const k = segKey(node.hinge.p1, node.hinge.p2);
      if (!creaseKeySet.has(k)) {
        creaseKeySet.add(k);
        creaseSegments.push([node.hinge.p1, node.hinge.p2]);
      }
    }
    node.children.forEach(collectCreases);
  };
  collectCreases(normalizedRoot);

  // Any polygon edge that is NOT a crease segment is a CutContour segment
  const cutSegments = [];
  const cutKeySet = new Set();

  const collectCuts = (node) => {
    const poly = node.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const k = segKey(a, b);
      if (!creaseKeySet.has(k) && !cutKeySet.has(k)) {
        cutKeySet.add(k);
        cutSegments.push([a, b]);
      }
    }
    node.children.forEach(collectCuts);
  };
  collectCuts(normalizedRoot);

  return {
    ...meta,
    bounds: { width, height },
    rootPanel: normalizedRoot,
    cutSegments,
    creaseSegments,
  };
}

/**
 * Generate Reverse Tuck End (RTE) or Straight Tuck End (STE) box
 */
function buildTuckBox(templateId, params) {
  const L = Math.max(20, Number(params.L) || 80);
  const W = Math.max(15, Number(params.W) || 50);
  const H = Math.max(25, Number(params.H) || 120);
  const glueW = Math.max(8, Number(params.glueTab) || 15);
  const tuckH = Math.max(10, Number(params.tuckFlap) || 18);
  const dustH = Math.min(W * 0.72, Math.max(12, W * 0.6));
  const isStraight = templateId === 'ste';

  // Horizontal band layout:
  // [GlueTab (glueW)] | [LeftSide (W)] | [Front (L) - ROOT] | [RightSide (W)] | [Back (L)]
  // Place Front (root) at x = 0..L, y = 0..H
  const frontX = 0;
  const rightX = L;
  const backX = L + W;
  const leftX = -W;
  const glueX = -W - glueW;

  // Top lid attached to Back (x = backX..backX+L, y = -W..0)
  const topLid = {
    id: 'top-lid',
    name: 'Nắp trên',
    polygon: rectPoly(backX, -W, L, W),
    hinge: { p1: [backX, 0], p2: [backX + L, 0] },
    foldAngleDeg: 90,
    foldWindow: [0.52, 0.8],
    children: [
      {
        id: 'top-tuck',
        name: 'Tai gài trên',
        polygon: tuckPoly(backX + 0.5, -W - tuckH, L - 1, tuckH, 'up', 4),
        hinge: { p1: [backX + 0.5, -W], p2: [backX + L - 0.5, -W] },
        foldAngleDeg: 90,
        foldWindow: [0.75, 1.0],
        children: [],
      },
    ],
  };

  // Bottom lid: for STE attached to Back (same side); for RTE attached to Front (opposite side)
  const bottomLidParentX = isStraight ? backX : frontX;
  const bottomLid = {
    id: 'bottom-lid',
    name: 'Nắp đáy',
    polygon: rectPoly(bottomLidParentX, H, L, W),
    hinge: { p1: [bottomLidParentX, H], p2: [bottomLidParentX + L, H] },
    foldAngleDeg: 90,
    foldWindow: [0.52, 0.8],
    children: [
      {
        id: 'bottom-tuck',
        name: 'Tai gài đáy',
        polygon: tuckPoly(bottomLidParentX + 0.5, H + W, L - 1, tuckH, 'down', 4),
        hinge: { p1: [bottomLidParentX + 0.5, H + W], p2: [bottomLidParentX + L - 0.5, H + W] },
        foldAngleDeg: 90,
        foldWindow: [0.75, 1.0],
        children: [],
      },
    ],
  };

  const backPanel = {
    id: 'back',
    name: 'Mặt sau',
    polygon: rectPoly(backX, 0, L, H),
    hinge: { p1: [backX, 0], p2: [backX, H] },
    foldAngleDeg: 90,
    foldWindow: [0.0, 0.42],
    children: isStraight ? [topLid, bottomLid] : [topLid],
  };

  const rightPanel = {
    id: 'right',
    name: 'Hông phải',
    polygon: rectPoly(rightX, 0, W, H),
    hinge: { p1: [rightX, 0], p2: [rightX, H] },
    foldAngleDeg: 90,
    foldWindow: [0.0, 0.42],
    children: [
      backPanel,
      {
        id: 'dust-top-right',
        name: 'Tai bụi trên phải',
        polygon: dustFlapPoly(rightX + 0.5, -dustH, W - 1, dustH, 'up'),
        hinge: { p1: [rightX + 0.5, 0], p2: [rightX + W - 0.5, 0] },
        foldAngleDeg: 90,
        foldWindow: [0.32, 0.6],
        children: [],
      },
      {
        id: 'dust-bottom-right',
        name: 'Tai bụi dưới phải',
        polygon: dustFlapPoly(rightX + 0.5, H, W - 1, dustH, 'down'),
        hinge: { p1: [rightX + 0.5, H], p2: [rightX + W - 0.5, H] },
        foldAngleDeg: 90,
        foldWindow: [0.32, 0.6],
        children: [],
      },
    ],
  };

  const leftPanel = {
    id: 'left',
    name: 'Hông trái',
    polygon: rectPoly(leftX, 0, W, H),
    hinge: { p1: [0, 0], p2: [0, H] },
    foldAngleDeg: 90,
    foldWindow: [0.0, 0.42],
    children: [
      {
        id: 'glue-tab',
        name: 'Mép dán hông',
        polygon: glueTabPoly(glueX, 0, glueW, H, 'left'),
        hinge: { p1: [leftX, 0], p2: [leftX, H] },
        foldAngleDeg: 90,
        foldWindow: [0.15, 0.55],
        children: [],
      },
      {
        id: 'dust-top-left',
        name: 'Tai bụi trên trái',
        polygon: dustFlapPoly(leftX + 0.5, -dustH, W - 1, dustH, 'up'),
        hinge: { p1: [leftX + 0.5, 0], p2: [leftX + W - 0.5, 0] },
        foldAngleDeg: 90,
        foldWindow: [0.32, 0.6],
        children: [],
      },
      {
        id: 'dust-bottom-left',
        name: 'Tai bụi dưới trái',
        polygon: dustFlapPoly(leftX + 0.5, H, W - 1, dustH, 'down'),
        hinge: { p1: [leftX + 0.5, H], p2: [leftX + W - 0.5, H] },
        foldAngleDeg: 90,
        foldWindow: [0.32, 0.6],
        children: [],
      },
    ],
  };

  const frontRoot = {
    id: 'front',
    name: 'Mặt trước',
    polygon: rectPoly(frontX, 0, L, H),
    hinge: null,
    foldAngleDeg: 0,
    foldWindow: [0, 1],
    children: isStraight ? [leftPanel, rightPanel] : [leftPanel, rightPanel, bottomLid],
  };

  return finalizeDieline(frontRoot, {
    templateId,
    templateName: DIELINE_TEMPLATES[templateId].name,
    params: { L, W, H, thickness: Number(params.thickness) || 0.4, glueTab: glueW, tuckFlap: tuckH },
    uprightRotateX: DIELINE_TEMPLATES[templateId].uprightRotateX,
  });
}

/**
 * Generate Open Tray (Khay hộp mở nắp)
 */
function buildTrayBox(params) {
  const L = Math.max(30, Number(params.L) || 140);
  const W = Math.max(30, Number(params.W) || 100);
  const H = Math.max(12, Number(params.H) || 35);
  const tabW = Math.min(H, Math.max(10, Number(params.glueTab) || 18));

  const topWall = {
    id: 'wall-top',
    name: 'Vách sau',
    polygon: rectPoly(0, -H, L, H),
    hinge: { p1: [0, 0], p2: [L, 0] },
    foldAngleDeg: 90,
    foldWindow: [0.0, 0.65],
    children: [
      {
        id: 'tab-tl',
        name: 'Tai góc trái-sau',
        polygon: glueTabPoly(-tabW, -H + 0.5, tabW, H - 1, 'left'),
        hinge: { p1: [0, -H + 0.5], p2: [0, -0.5] },
        foldAngleDeg: 90,
        foldWindow: [0.25, 0.85],
        children: [],
      },
      {
        id: 'tab-tr',
        name: 'Tai góc phải-sau',
        polygon: glueTabPoly(L, -H + 0.5, tabW, H - 1, 'right'),
        hinge: { p1: [L, -H + 0.5], p2: [L, -0.5] },
        foldAngleDeg: 90,
        foldWindow: [0.25, 0.85],
        children: [],
      },
    ],
  };

  const bottomWall = {
    id: 'wall-bottom',
    name: 'Vách trước',
    polygon: rectPoly(0, W, L, H),
    hinge: { p1: [0, W], p2: [L, W] },
    foldAngleDeg: 90,
    foldWindow: [0.0, 0.65],
    children: [
      {
        id: 'tab-bl',
        name: 'Tai góc trái-trước',
        polygon: glueTabPoly(-tabW, W + 0.5, tabW, H - 1, 'left'),
        hinge: { p1: [0, W + 0.5], p2: [0, W + H - 0.5] },
        foldAngleDeg: 90,
        foldWindow: [0.25, 0.85],
        children: [],
      },
      {
        id: 'tab-br',
        name: 'Tai góc phải-trước',
        polygon: glueTabPoly(L, W + 0.5, tabW, H - 1, 'right'),
        hinge: { p1: [L, W + 0.5], p2: [L, W + H - 0.5] },
        foldAngleDeg: 90,
        foldWindow: [0.25, 0.85],
        children: [],
      },
    ],
  };

  const leftWall = {
    id: 'wall-left',
    name: 'Vách trái',
    polygon: rectPoly(-H, 0, H, W),
    hinge: { p1: [0, 0], p2: [0, W] },
    foldAngleDeg: 90,
    foldWindow: [0.3, 1.0],
    children: [],
  };

  const rightWall = {
    id: 'wall-right',
    name: 'Vách phải',
    polygon: rectPoly(L, 0, H, W),
    hinge: { p1: [L, 0], p2: [L, W] },
    foldAngleDeg: 90,
    foldWindow: [0.3, 1.0],
    children: [],
  };

  const bottomRoot = {
    id: 'bottom',
    name: 'Đáy khay',
    polygon: rectPoly(0, 0, L, W),
    hinge: null,
    foldAngleDeg: 0,
    foldWindow: [0, 1],
    children: [topWall, bottomWall, leftWall, rightWall],
  };

  return finalizeDieline(bottomRoot, {
    templateId: 'tray',
    templateName: DIELINE_TEMPLATES.tray.name,
    params: { L, W, H, thickness: Number(params.thickness) || 0.5, glueTab: tabW, tuckFlap: 0 },
    uprightRotateX: DIELINE_TEMPLATES.tray.uprightRotateX,
  });
}

export function generateDieline(templateId, params) {
  if (templateId === 'tray') return buildTrayBox(params);
  if (templateId === 'ste') return buildTuckBox('ste', params);
  return buildTuckBox('rte', params);
}
