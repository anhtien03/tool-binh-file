/**
 * PrintKit V1 — Machine Compatibility Profiles (Additive, 0 Locked Files Modified)
 *
 * Defines vendor-neutral sheet die-cut & Graphtec ARMS registration mark profiles,
 * standard production layer roles (RegMark, CutLine, Crease, Bleed, Design),
 * and sensor quiet-zone geometry calculators.
 */

export const LAYER_ROLES = Object.freeze({
  REGMARK: 'RegMark',
  CUTLINE: 'CutLine',
  CREASE: 'Crease',
  BLEED: 'Bleed',
  DESIGN: 'Design',
});

export const MACHINE_PROFILES = Object.freeze({
  diecut_sheet_5mm: Object.freeze({
    id: 'diecut_sheet_5mm',
    label: 'Die-Cut Tờ (Boong tròn 5mm)',
    compatibleDevices: 'SAGA (SG-SC / ASC365 / SC450), Vulcan, iEcho, máy bế tờ phẳng',
    softwareCompat: ['SagaCut', 'DragonCut', 'CutStudio', 'Illustrator (.ai)'],
    pontType: 'circle5mm',
    allowedPontTypes: ['circle5mm', 'circleHollow'],
    markShape: 'dot_solid',
    markSizeMm: 5.0,
    minMarkSizeMm: 4.0,
    maxMarkSizeMm: 8.0,
    defaultMarkInsetMm: 10.0,
    minMarkInsetMm: 8.0,
    maxMarkInsetMm: 35.0,
    markColorSpace: 'DeviceCMYK',
    markColorCmyk: [0, 0, 0, 1],
    quietZoneMm: 5.0,
    minSheetWidthMm: 100,
    maxSheetWidthMm: 360,
    minSheetHeightMm: 100,
    maxSheetHeightMm: 520,
    defaultSpotCutContour: true,
    spotCutColorName: 'CutContour',
    supportedFormats: ['PDF', 'AI'],
  }),
  graphtec_arms_t1: Object.freeze({
    id: 'graphtec_arms_t1',
    label: 'Graphtec ARMS Type 1 (┌ ┐ └ ┘)',
    compatibleDevices: 'Graphtec CE7000 / FC9000 / F-Mark (Type 1 — ôm trong)',
    softwareCompat: ['Cutting Master 4/5', 'Graphtec Pro Studio', 'Illustrator (.ai)'],
    pontType: 'graphtec',
    allowedPontTypes: ['graphtec'],
    markShape: 'bracket_inward',
    markSizeMm: 5.0,
    minMarkSizeMm: 3.0,
    maxMarkSizeMm: 12.0,
    minArmMm: 5.0,
    maxArmMm: 20.0,
    strokeMm: 0.6,
    minStrokeMm: 0.3,
    maxStrokeMm: 1.0,
    defaultMarkInsetMm: 10.0,
    minMarkInsetMm: 8.0,
    maxMarkInsetMm: 40.0,
    markColorSpace: 'DeviceCMYK',
    markColorCmyk: [0, 0, 0, 1],
    quietZoneMm: 5.0,
    minSheetWidthMm: 100,
    maxSheetWidthMm: 610,
    minSheetHeightMm: 100,
    maxSheetHeightMm: 1200,
    defaultSpotCutContour: true,
    spotCutColorName: 'CutContour',
    supportedFormats: ['PDF', 'AI'],
  }),
  graphtec_arms_t2: Object.freeze({
    id: 'graphtec_arms_t2',
    label: 'Graphtec ARMS Type 2 (┘ └ ┐ ┌)',
    compatibleDevices: 'Graphtec CE7000 / FC9000 / F-Mark (Type 2 — lật ngược)',
    softwareCompat: ['Cutting Master 4/5', 'Graphtec Pro Studio', 'Illustrator (.ai)'],
    pontType: 'graphtecType2',
    allowedPontTypes: ['graphtecType2'],
    markShape: 'bracket_outward',
    markSizeMm: 5.0,
    minMarkSizeMm: 3.0,
    maxMarkSizeMm: 12.0,
    minArmMm: 5.0,
    maxArmMm: 20.0,
    strokeMm: 0.6,
    minStrokeMm: 0.3,
    maxStrokeMm: 1.0,
    defaultMarkInsetMm: 8.0,
    minMarkInsetMm: 6.0,
    maxMarkInsetMm: 40.0,
    markColorSpace: 'DeviceCMYK',
    markColorCmyk: [0, 0, 0, 1],
    quietZoneMm: 4.0,
    minSheetWidthMm: 100,
    maxSheetWidthMm: 610,
    minSheetHeightMm: 100,
    maxSheetHeightMm: 1200,
    defaultSpotCutContour: true,
    spotCutColorName: 'CutContour',
    supportedFormats: ['PDF', 'AI'],
  }),
});

export function getMachineProfile(profileId) {
  if (!profileId || profileId === 'custom') return null;
  return MACHINE_PROFILES[profileId] || null;
}

export function listMachineProfiles() {
  return Object.values(MACHINE_PROFILES);
}

/**
 * Infer default machine profile from pontType when user hasn't picked one explicitly.
 */
export function inferMachineProfileFromPontType(pontType) {
  if (pontType === 'circle5mm' || pontType === 'circleHollow') return MACHINE_PROFILES.diecut_sheet_5mm;
  if (pontType === 'graphtecType2') return MACHINE_PROFILES.graphtec_arms_t2;
  if (pontType === 'graphtec') return MACHINE_PROFILES.graphtec_arms_t1;
  return null;
}

/**
 * Compute the 4 optical sensor quiet-zone rectangles (in top-down mm) around corner marks.
 * No sticker artwork, BLEED, or slug text should intrude into these zones.
 */
export function getMarkQuietZoneRectsMm({
  sheetWidthMm,
  sheetHeightMm,
  markInsetMm = 10,
  markSizeMm = 5,
  quietZoneMm = 5,
}) {
  const half = markSizeMm / 2 + quietZoneMm;
  const corners = [
    { corner: 'TL', cx: markInsetMm, cy: markInsetMm },
    { corner: 'TR', cx: sheetWidthMm - markInsetMm, cy: markInsetMm },
    { corner: 'BL', cx: markInsetMm, cy: sheetHeightMm - markInsetMm },
    { corner: 'BR', cx: sheetWidthMm - markInsetMm, cy: sheetHeightMm - markInsetMm },
  ];
  return corners.map((c) => {
    const x0 = Math.max(0, c.cx - half);
    const y0 = Math.max(0, c.cy - half);
    const x1 = Math.min(sheetWidthMm, c.cx + half);
    const y1 = Math.min(sheetHeightMm, c.cy + half);
    return {
      corner: c.corner,
      markCx: c.cx,
      markCy: c.cy,
      x: x0,
      y: y0,
      w: Math.max(0, x1 - x0),
      h: Math.max(0, y1 - y0),
    };
  });
}
