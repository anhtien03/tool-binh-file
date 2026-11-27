/**
 * PrintKit Architecture V1 — Asset Analyzer (Checkpoint C)
 *
 * Pure classification & routing ONLY:
 *  - Classifies into: CLEAN_SINGLE | CLEAN_MULTI_SHEET | MOCKUP | LOW_QUALITY | INVALID
 *  - Routes into:     DIRECT_CUTLINE | NEED_EXTRACTION | NEED_REVIEW | BLOCK
 *  - Enforces confidence < 0.80 -> NEVER routed directly to production (DIRECT_CUTLINE)
 *  - hasWhiteBorder is strictly advisory (NEVER mutates BleedConfigV1)
 *  - Does NOT create CUT, BLEED, Imposition, or PDF; does NOT crop mockups.
 */

import { ANALYSIS_VERSION } from './v1Schema.js';

export const ANALYZER_THRESHOLDS = Object.freeze({
  minProductionConfidence: 0.8,
  lowQualityDpi: 150,
  minValidSizeMm: 0.5,
  maxValidSizeMm: 5000,
});

function r2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function estimateDpi(pixelSize, naturalSizeMm) {
  const dpiX = pixelSize.w / (naturalSizeMm.w / 25.4);
  const dpiY = pixelSize.h / (naturalSizeMm.h / 25.4);
  return r2(Math.min(dpiX, dpiY));
}

/**
 * Lightweight border & content inspection on RGBA ImageData (no canvas allocation).
 * Distinguishes transparent/clean uniform background vs noisy/shadow/mockup background,
 * and checks advisory white-border presence WITHOUT assuming white background === safe bleed.
 */
function inspectRasterHeuristics(imageData) {
  const { width: w, height: h, data } = imageData;
  if (!w || !h || !data || data.length < w * h * 4) return null;

  // Sample border ring (4 edges) to measure alpha transparency & background color variance
  const stepX = Math.max(1, Math.floor(w / 64));
  const stepY = Math.max(1, Math.floor(h / 64));
  let borderSamples = 0;
  let transparentBorder = 0;
  let whiteBorder = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  const borderColors = [];

  const samplePx = (x, y) => {
    const idx = (y * w + x) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
    borderSamples++;
    if (a < 20) {
      transparentBorder++;
      return;
    }
    if (r >= 245 && g >= 245 && b >= 245) whiteBorder++;
    sumR += r;
    sumG += g;
    sumB += b;
    borderColors.push([r, g, b]);
  };

  for (let x = 0; x < w; x += stepX) {
    samplePx(x, 0);
    samplePx(x, h - 1);
  }
  for (let y = 0; y < h; y += stepY) {
    samplePx(0, y);
    samplePx(w - 1, y);
  }

  const transparentRatio = borderSamples > 0 ? transparentBorder / borderSamples : 0;
  const opaqueCount = borderColors.length;
  let borderStdDev = 0;
  let meanR = 255, meanG = 255, meanB = 255;
  if (opaqueCount > 0) {
    meanR = sumR / opaqueCount;
    meanG = sumG / opaqueCount;
    meanB = sumB / opaqueCount;
    let varSum = 0;
    for (const [r, g, b] of borderColors) {
      varSum += (r - meanR) ** 2 + (g - meanG) ** 2 + (b - meanB) ** 2;
    }
    borderStdDev = Math.sqrt(varSum / (opaqueCount * 3));
  }

  // Advisory white border check: only true when outer border is transparent (alpha) AND an inner ring is pure white,
  // OR explicitly hinted; never conflated with a solid white page background!
  let innerWhitePixels = 0;
  let innerOpaquePixels = 0;
  if (transparentRatio > 0.7) {
    const stepIx = Math.max(1, Math.floor(w / 48));
    const stepIy = Math.max(1, Math.floor(h / 48));
    for (let y = 1; y < h - 1; y += stepIy) {
      for (let x = 1; x < w - 1; x += stepIx) {
        const idx = (y * w + x) * 4;
        if (data[idx + 3] > 200) {
          // Check if adjacent to transparent pixel (outer edge of sticker)
          const leftA = data[(y * w + (x - 1)) * 4 + 3];
          const rightA = data[(y * w + (x + 1)) * 4 + 3];
          const topA = data[((y - 1) * w + x) * 4 + 3];
          const botA = data[((y + 1) * w + x) * 4 + 3];
          if (leftA < 20 || rightA < 20 || topA < 20 || botA < 20) {
            innerOpaquePixels++;
            if (data[idx] >= 242 && data[idx + 1] >= 242 && data[idx + 2] >= 242) {
              innerWhitePixels++;
            }
          }
        }
      }
    }
  }
  const hasWhiteBorder = innerOpaquePixels >= 6 && innerWhitePixels / innerOpaquePixels >= 0.65;

  // Detect gray/colored studio mockup background (opaque non-white backdrop OR noisy border)
  const isNonWhiteBackdrop =
    transparentRatio < 0.1 && (meanR < 240 || meanG < 240 || meanB < 240) && whiteBorder / Math.max(1, borderSamples) < 0.3;
  const isNoisyBorder = transparentRatio < 0.2 && borderStdDev > 14;

  return {
    transparentRatio,
    borderStdDev: r2(borderStdDev),
    isNonWhiteBackdrop,
    isNoisyBorder,
    hasWhiteBorder,
  };
}

/**
 * Analyze a single rendered page / image asset and return the V1 routing contract.
 * Preserves assetId & pageIndex provenance.
 */
export function analyzePage(pageInput = {}) {
  const {
    assetId = null,
    pageIndex = 1,
    pixelSize = null,
    naturalSizeMm = null,
    imageData = null,
    isCorrupt = false,
    hints = {}, // optional signals: { detectedComponentCount, mockupSignals, confidenceOverride, hasWhiteBorderHint }
  } = pageInput;

  const reasons = [];

  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return Object.freeze({
      assetId,
      pageIndex,
      analysisVersion: ANALYSIS_VERSION,
      classification: 'INVALID',
      confidence: 1.0,
      hasWhiteBorder: false,
      estimatedDpi: 0,
      reasons: [`pageIndex không hợp lệ (${pageIndex})`],
      recommendedAction: 'BLOCK',
    });
  }

  if (
    isCorrupt ||
    !pixelSize ||
    !naturalSizeMm ||
    !Number.isFinite(pixelSize.w) ||
    !Number.isFinite(pixelSize.h) ||
    pixelSize.w <= 0 ||
    pixelSize.h <= 0 ||
    !Number.isFinite(naturalSizeMm.w) ||
    !Number.isFinite(naturalSizeMm.h) ||
    naturalSizeMm.w < ANALYZER_THRESHOLDS.minValidSizeMm ||
    naturalSizeMm.h < ANALYZER_THRESHOLDS.minValidSizeMm ||
    naturalSizeMm.w > ANALYZER_THRESHOLDS.maxValidSizeMm ||
    naturalSizeMm.h > ANALYZER_THRESHOLDS.maxValidSizeMm
  ) {
    reasons.push(isCorrupt ? 'File hỏng hoặc không thể giải mã' : 'Kích thước pixel hoặc mm không hợp lệ');
    return Object.freeze({
      assetId,
      pageIndex,
      analysisVersion: ANALYSIS_VERSION,
      classification: 'INVALID',
      confidence: 1.0,
      hasWhiteBorder: false,
      estimatedDpi: 0,
      reasons,
      recommendedAction: 'BLOCK',
    });
  }

  const dpi = estimateDpi(pixelSize, naturalSizeMm);
  const raster = imageData ? inspectRasterHeuristics(imageData) : null;
  const hasWhiteBorder = Boolean(hints.hasWhiteBorderHint ?? raster?.hasWhiteBorder ?? false);

  const mockupDetected = Boolean(
    hints.mockupSignals?.hasDropShadow ||
      hints.mockupSignals?.hasPerspective ||
      hints.mockupSignals?.hasProps ||
      hints.isMockup ||
      raster?.isNonWhiteBackdrop ||
      raster?.isNoisyBorder
  );

  let classification = 'CLEAN_SINGLE';
  let confidence = 0.92;

  if (mockupDetected) {
    classification = 'MOCKUP';
    confidence = Number.isFinite(hints.confidenceOverride) ? hints.confidenceOverride : 0.85;
    if (hints.mockupSignals?.hasDropShadow) reasons.push('Phát hiện bóng đổ (drop shadow) kiểu mockup');
    if (hints.mockupSignals?.hasPerspective) reasons.push('Phát hiện phối cảnh nghiêng cần làm phẳng');
    if (hints.mockupSignals?.hasProps) reasons.push('Phát hiện vật thể trang trí ngoài vùng nhãn');
    if (raster?.isNonWhiteBackdrop) reasons.push('Nền ảnh không trong suốt / màu nền mockup');
    if (raster?.isNoisyBorder) reasons.push(`Biên ảnh nhiễu (stdDev=${raster.borderStdDev})`);
    if (reasons.length === 0) reasons.push('Phát hiện ảnh mockup cần tách vùng artwork sạch');
  } else if (dpi < ANALYZER_THRESHOLDS.lowQualityDpi) {
    classification = 'LOW_QUALITY';
    confidence = Number.isFinite(hints.confidenceOverride) ? hints.confidenceOverride : 0.9;
    reasons.push(`Độ phân giải ước tính thấp (${dpi} DPI < ${ANALYZER_THRESHOLDS.lowQualityDpi} DPI)`);
  } else if (Number.isInteger(hints.detectedComponentCount) && hints.detectedComponentCount > 1) {
    classification = 'CLEAN_MULTI_SHEET';
    confidence = Number.isFinite(hints.confidenceOverride) ? hints.confidenceOverride : 0.93;
    reasons.push(`Tờ sạch chứa nhiều tem (${hints.detectedComponentCount} vùng độc lập)`);
  } else {
    classification = 'CLEAN_SINGLE';
    confidence = Number.isFinite(hints.confidenceOverride) ? hints.confidenceOverride : 0.92;
  }

  if (Number.isFinite(hints.confidenceOverride)) {
    confidence = Math.max(0, Math.min(1, hints.confidenceOverride));
  }

  if (hasWhiteBorder) {
    reasons.push('Phát hiện dấu hiệu viền trắng (advisory — không tự đổi bleedMode)');
  }

  // Strict V1 Confidence & Routing Policy: confidence < 0.80 NEVER routes to DIRECT_CUTLINE
  let recommendedAction;
  if (classification === 'MOCKUP') {
    recommendedAction = confidence >= ANALYZER_THRESHOLDS.minProductionConfidence ? 'NEED_EXTRACTION' : 'NEED_REVIEW';
  } else if (confidence < ANALYZER_THRESHOLDS.minProductionConfidence) {
    recommendedAction = 'NEED_REVIEW';
    reasons.push(`Độ tin cậy phân tích (${r2(confidence)}) dưới ngưỡng ${ANALYZER_THRESHOLDS.minProductionConfidence}`);
  } else if (classification === 'LOW_QUALITY') {
    recommendedAction = 'NEED_REVIEW';
  } else {
    recommendedAction = 'DIRECT_CUTLINE';
  }

  return Object.freeze({
    assetId,
    pageIndex,
    analysisVersion: ANALYSIS_VERSION,
    classification,
    confidence: r2(confidence),
    hasWhiteBorder,
    estimatedDpi: dpi,
    reasons: Object.freeze(reasons),
    recommendedAction,
  });
}

/**
 * Analyze a multi-page (or single-page) asset without flattening page provenance.
 */
export function analyzeAsset(assetInput = {}) {
  const { assetId = null, pages = [] } = assetInput;
  if (!Array.isArray(pages) || pages.length === 0) {
    const invalid = analyzePage({ assetId, pageIndex: 1, isCorrupt: true });
    return Object.freeze({
      assetId,
      analysisVersion: ANALYSIS_VERSION,
      pageCount: 0,
      pages: Object.freeze([invalid]),
      summary: invalid,
    });
  }

  const pageResults = pages.map((p, idx) =>
    analyzePage({
      ...p,
      assetId,
      pageIndex: p.pageIndex ?? idx + 1,
    })
  );

  // Aggregate summary conservatively (worst action wins: BLOCK > NEED_EXTRACTION > NEED_REVIEW > DIRECT_CUTLINE)
  const priority = { BLOCK: 4, NEED_EXTRACTION: 3, NEED_REVIEW: 2, DIRECT_CUTLINE: 1 };
  let worst = pageResults[0];
  for (const pr of pageResults) {
    if ((priority[pr.recommendedAction] || 0) > (priority[worst.recommendedAction] || 0)) {
      worst = pr;
    }
  }

  return Object.freeze({
    assetId,
    analysisVersion: ANALYSIS_VERSION,
    pageCount: pageResults.length,
    pages: Object.freeze(pageResults),
    summary: worst,
  });
}
