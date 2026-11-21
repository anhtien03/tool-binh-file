/**
 * Parametric Dieline 2D & 3D Hierarchical Folding Engine (ECMA / Editorial-CAD)
 * All coordinates are in mm (origin top-left, +X right, +Y down).
 */

export const DIELINE_CATEGORIES = [
  { id: 'all', name: 'Tất cả' },
  { id: 'folding', name: 'Hộp giấy gấp' },
  { id: 'tray', name: 'Khay giấy' },
  { id: 'bag', name: 'Túi giấy & Bao bì' },
];

export const DIELINE_TEMPLATES = {
  ste: {
    id: 'ste',
    code: 'ECMA A20.20.01.01',
    category: 'folding',
    name: 'Hộp nắp cài hai đầu — hai nắp cùng mặt',
    shortName: 'Nắp cài · cùng mặt',
    description: 'Nắp trên và nắp dưới cùng gài về mặt sau — mặt trước sạch đẹp, tối ưu trưng bày.',
    defaults: { L: 100, W: 60, H: 150, thickness: 0.43, glueTab: 15, tuckFlap: 18 },
    uprightRotateX: -Math.PI / 2,
  },
  rte: {
    id: 'rte',
    code: 'ECMA A20.20.03.01',
    category: 'folding',
    name: 'Hộp nắp cài hai đầu — hai nắp đối xứng',
    shortName: 'Nắp cài · đối xứng',
    description: 'Mẫu hộp mỹ phẩm, dược phẩm phổ biến nhất — nắp trên và nắp dưới gài ngược chiều nhau.',
    defaults: { L: 80, W: 50, H: 120, thickness: 0.4, glueTab: 15, tuckFlap: 18 },
    uprightRotateX: -Math.PI / 2,
  },
  tray: {
    id: 'tray',
    code: 'ECMA A60.20.01.01',
    category: 'tray',
    name: 'Khay hộp mở nắp 4 vách có tai dán góc',
    shortName: 'Khay hộp mở nắp',
    description: 'Khay đựng thực phẩm, quà tặng, mỹ phẩm gồm đáy + 4 vách + 4 tai dán góc.',
    defaults: { L: 140, W: 100, H: 35, thickness: 0.5, glueTab: 18, tuckFlap: 0 },
    uprightRotateX: 0,
  },
  sleeve: {
    id: 'sleeve',
    code: 'ECMA A01.10.01.01',
    category: 'folding',
    name: 'Vỏ bao hộp trượt (Sleeve / Belly Band)',
    shortName: 'Vỏ bao trượt',
    description: 'Đai giấy hoặc vỏ bọc trượt ngoài khay hộp — tiết kiệm phôi, dễ in ấn.',
    defaults: { L: 142, W: 102, H: 37, thickness: 0.35, glueTab: 15, tuckFlap: 0 },
    uprightRotateX: -Math.PI / 2,
  },
  bag: {
    id: 'bag',
    code: 'ECMA B10.10.01.01',
    category: 'bag',
    name: 'Túi giấy đứng đáy gập (Shopping Bag)',
    shortName: 'Túi giấy đáy gập',
    description: 'Túi giấy quai xách tiêu chuẩn gồm 4 mặt hông, mép dán và phần đáy gập.',
    defaults: { L: 180, W: 80, H: 240, thickness: 0.35, glueTab: 18, tuckFlap: 0 },
    uprightRotateX: -Math.PI / 2,
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
 * Adjust L/W/H by dimensionMode ('production' | 'inner' | 'outer')
 */
export function resolveManufacturingDims(params, dimensionMode = 'production') {
  const rawL = Math.max(20, Number(params.L) || 80);
  const rawW = Math.max(15, Number(params.W) || 50);
  const rawH = Math.max(12, Number(params.H) || 120);
  const t = Math.max(0.1, Number(params.thickness) || 0.4);

  let L = rawL, W = rawW, H = rawH;
  if (dimensionMode === 'inner') {
    L = rawL + t * 2;
    W = rawW + t * 2;
    H = rawH + t * 2;
  } else if (dimensionMode === 'outer') {
    L = Math.max(15, rawL - t * 2);
    W = Math.max(12, rawW - t * 2);
    H = Math.max(10, rawH - t * 2);
  }

  return {
    L: Math.round(L * 100) / 100,
    W: Math.round(W * 100) / 100,
    H: Math.round(H * 100) / 100,
    inner: {
      L: Math.round((L - t * 2) * 100) / 100,
      W: Math.round((W - t * 2) * 100) / 100,
      H: Math.round((H - t * 2) * 100) / 100,
    },
    outer: {
      L: Math.round((L + t * 2) * 100) / 100,
      W: Math.round((W + t * 2) * 100) / 100,
      H: Math.round((H + t * 2) * 100) / 100,
    },
    thickness: t,
  };
}

function buildTuckBox(templateId, params, dimensionMode) {
  const dims = resolveManufacturingDims(params, dimensionMode);
  const { L, W, H, thickness } = dims;
  const glueW = Math.max(8, Number(params.glueTab) || 15);
  const tuckH = Math.max(10, Number(params.tuckFlap) || 18);
  const dustH = Math.min(W * 0.72, Math.max(12, W * 0.6));
  const isStraight = templateId === 'ste';

  const frontX = 0, rightX = L, backX = L + W, leftX = -W, glueX = -W - glueW;

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
    code: DIELINE_TEMPLATES[templateId].code,
    templateName: DIELINE_TEMPLATES[templateId].name,
    params: { ...dims, glueTab: glueW, tuckFlap: tuckH },
    uprightRotateX: DIELINE_TEMPLATES[templateId].uprightRotateX,
  });
}

function buildTrayBox(params, dimensionMode) {
  const dims = resolveManufacturingDims(params, dimensionMode);
  const { L, W, H } = dims;
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
    code: DIELINE_TEMPLATES.tray.code,
    templateName: DIELINE_TEMPLATES.tray.name,
    params: { ...dims, glueTab: tabW, tuckFlap: 0 },
    uprightRotateX: DIELINE_TEMPLATES.tray.uprightRotateX,
  });
}

function buildSleeveBox(params, dimensionMode) {
  const dims = resolveManufacturingDims(params, dimensionMode);
  const { L, W, H } = dims;
  const glueW = Math.max(8, Number(params.glueTab) || 15);

  const frontRoot = {
    id: 'front',
    name: 'Mặt trên',
    polygon: rectPoly(0, 0, L, W),
    hinge: null,
    foldAngleDeg: 0,
    foldWindow: [0, 1],
    children: [
      {
        id: 'left',
        name: 'Thành trái',
        polygon: rectPoly(-H, 0, H, W),
        hinge: { p1: [0, 0], p2: [0, W] },
        foldAngleDeg: 90,
        foldWindow: [0, 0.5],
        children: [
          {
            id: 'glue-tab',
            name: 'Mép dán',
            polygon: glueTabPoly(-H - glueW, 0, glueW, W, 'left'),
            hinge: { p1: [-H, 0], p2: [-H, W] },
            foldAngleDeg: 90,
            foldWindow: [0.3, 0.8],
            children: [],
          },
        ],
      },
      {
        id: 'right',
        name: 'Thành phải',
        polygon: rectPoly(L, 0, H, W),
        hinge: { p1: [L, 0], p2: [L, W] },
        foldAngleDeg: 90,
        foldWindow: [0, 0.5],
        children: [
          {
            id: 'back',
            name: 'Mặt đáy',
            polygon: rectPoly(L + H, 0, L, W),
            hinge: { p1: [L + H, 0], p2: [L + H, W] },
            foldAngleDeg: 90,
            foldWindow: [0.35, 1.0],
            children: [],
          },
        ],
      },
    ],
  };

  return finalizeDieline(frontRoot, {
    templateId: 'sleeve',
    code: DIELINE_TEMPLATES.sleeve.code,
    templateName: DIELINE_TEMPLATES.sleeve.name,
    params: { ...dims, glueTab: glueW, tuckFlap: 0 },
    uprightRotateX: DIELINE_TEMPLATES.sleeve.uprightRotateX,
  });
}

function buildPaperBag(params, dimensionMode) {
  const dims = resolveManufacturingDims(params, dimensionMode);
  const { L, W, H } = dims;
  const glueW = Math.max(10, Number(params.glueTab) || 18);
  const baseH = Math.max(20, Math.round(W * 0.65));

  const frontRoot = {
    id: 'front',
    name: 'Mặt trước túi',
    polygon: rectPoly(0, 0, L, H),
    hinge: null,
    foldAngleDeg: 0,
    foldWindow: [0, 1],
    children: [
      {
        id: 'left',
        name: 'Hông trái',
        polygon: rectPoly(-W, 0, W, H),
        hinge: { p1: [0, 0], p2: [0, H] },
        foldAngleDeg: 90,
        foldWindow: [0, 0.55],
        children: [
          {
            id: 'glue-tab',
            name: 'Mép dán hông',
            polygon: glueTabPoly(-W - glueW, 0, glueW, H, 'left'),
            hinge: { p1: [-W, 0], p2: [-W, H] },
            foldAngleDeg: 90,
            foldWindow: [0.25, 0.75],
            children: [],
          },
        ],
      },
      {
        id: 'right',
        name: 'Hông phải',
        polygon: rectPoly(L, 0, W, H),
        hinge: { p1: [L, 0], p2: [L, H] },
        foldAngleDeg: 90,
        foldWindow: [0, 0.55],
        children: [
          {
            id: 'back',
            name: 'Mặt sau túi',
            polygon: rectPoly(L + W, 0, L, H),
            hinge: { p1: [L + W, 0], p2: [L + W, H] },
            foldAngleDeg: 90,
            foldWindow: [0.3, 0.85],
            children: [
              {
                id: 'bottom-back',
                name: 'Đáy sau',
                polygon: rectPoly(L + W, H, L, baseH),
                hinge: { p1: [L + W, H], p2: [L + W + L, H] },
                foldAngleDeg: 90,
                foldWindow: [0.55, 1.0],
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: 'bottom-front',
        name: 'Đáy trước',
        polygon: rectPoly(0, H, L, baseH),
        hinge: { p1: [0, H], p2: [L, H] },
        foldAngleDeg: 90,
        foldWindow: [0.55, 1.0],
        children: [],
      },
    ],
  };

  return finalizeDieline(frontRoot, {
    templateId: 'bag',
    code: DIELINE_TEMPLATES.bag.code,
    templateName: DIELINE_TEMPLATES.bag.name,
    params: { ...dims, glueTab: glueW, tuckFlap: 0 },
    uprightRotateX: DIELINE_TEMPLATES.bag.uprightRotateX,
  });
}

export function generateDieline(templateId, params, dimensionMode = 'production') {
  if (templateId === 'tray') return buildTrayBox(params, dimensionMode);
  if (templateId === 'sleeve') return buildSleeveBox(params, dimensionMode);
  if (templateId === 'bag') return buildPaperBag(params, dimensionMode);
  if (templateId === 'ste') return buildTuckBox('ste', params, dimensionMode);
  return buildTuckBox('rte', params, dimensionMode);
}

/**
 * Generate pure SVG string for 1:1 Dieline export (mm units)
 */
export function exportDielineSvg(dieline) {
  const pad = 10;
  const vbW = dieline.bounds.width + pad * 2;
  const vbH = dieline.bounds.height + pad * 2;
  const creases = dieline.creaseSegments
    .map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#dc2626" stroke-width="0.35" stroke-dasharray="2.5 1.8" />`)
    .join('\n    ');
  const cuts = dieline.cutSegments
    .map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#1d4ed8" stroke-width="0.4" />`)
    .join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vbW}mm" height="${vbH}mm" viewBox="${-pad} ${-pad} ${vbW} ${vbH}">
  <g id="Crease">
    ${creases}
  </g>
  <g id="CutContour">
    ${cuts}
  </g>
</svg>`;
}
