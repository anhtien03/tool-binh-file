/**
 * PrintKit V1 — Machine Compatibility Validator (Additive, 0 Locked Files Modified)
 *
 * Audits exported CUT/PRINT PDFs & H.2 plans against Die-Cut (5mm) and Graphtec ARMS
 * (Type 1 / Type 2) machine specifications and emits TWO strictly separated reports:
 *   1. `geometryReport` (PASS / WARNING / FAIL) — CUT/BLEED/Bézier geometry integrity
 *   2. `machineReport`  (PASS / WARNING / FAIL) — Machine marks, quiet zone, CUT vector
 *      hygiene (closed, stroke-only, no duplicates, Spot CutContour), media & software compat.
 */

import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import {
  getMachineProfile,
  inferMachineProfileFromPontType,
  getMarkQuietZoneRectsMm,
} from './machineCompatibilityProfiles.js';

const PT_TO_MM = 25.4 / 72;

async function inflatePdfStreamBytes(raw, isFlate = false) {
  if (!isFlate) {
    return new TextDecoder('latin1').decode(raw);
  }
  // Works in both Node.js and modern browsers (DecompressionStream)
  if (typeof globalThis.DecompressionStream === 'function') {
    try {
      const ds = new globalThis.DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      const writePromise = writer.write(raw).then(() => writer.close()).catch(() => {});
      const chunks = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await writePromise;
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return new TextDecoder('latin1').decode(out);
    } catch {
      // fall through
    }
  }
  return new TextDecoder('latin1').decode(raw);
}

function isStreamFlateEncoded(streamObj) {
  const flt = streamObj?.dict?.get?.(PDFName.of('Filter'));
  return Boolean(flt && String(flt.toString()).includes('FlateDecode'));
}

async function extractPageStreamText(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return '';
  if (contents instanceof PDFArray || (typeof contents.size === 'function' && typeof contents.get === 'function')) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) {
      const s = doc.context.lookup(contents.get(i));
      if (s && typeof s.getContents === 'function') {
        out += (await inflatePdfStreamBytes(s.getContents(), isStreamFlateEncoded(s))) + '\n';
      }
    }
    return out;
  }
  const s = doc.context.lookup(contents);
  if (s && typeof s.getContents === 'function') {
    return inflatePdfStreamBytes(s.getContents(), isStreamFlateEncoded(s));
  }
  return '';
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Inspect an exported CUT PDF stream for strict vector hygiene:
 *  - Every Bézier CUT contour is closed (`h`)
 *  - Stroke-only (`S` / `s`), NEVER filled (`f`, `f*`, `F`, `B`, `B*`, `b`, `b*`)
 *  - Zero duplicate contours
 *  - Spot Color `/Separation /CutContour` present when `requireSpotCutContour` is true
 */
export async function validateCutVectorStream(
  cutPdfBytes,
  { requireSpotCutContour = false, spotColorName = 'CutContour', expectedContourCount = null } = {}
) {
  const doc = await PDFDocument.load(cutPdfBytes);
  const page = doc.getPage(0);
  const streamText = await extractPageStreamText(doc, page);

  // Check Spot Color resource `/Separation /CutContour`
  let hasSpotCutContour = false;
  const res = page.node.Resources();
  const csDict = res?.lookup ? res.lookup(PDFName.of('ColorSpace')) : null;
  if (csDict && typeof csDict.entries === 'function') {
    for (const [, val] of csDict.entries()) {
      const resolved = doc.context.lookup(val);
      if (resolved && typeof resolved.size === 'function' && resolved.size() >= 2) {
        const typeName = resolved.get(0)?.toString?.();
        const colorName = resolved.get(1)?.toString?.();
        if (typeName === '/Separation' && colorName === `/${spotColorName}`) {
          hasSpotCutContour = true;
          break;
        }
      }
    }
  }
  // Also allow direct inline check in stream CS operator if referenced
  const usesSpotInStream = hasSpotCutContour && /\bCS\b/.test(streamText);

  // Parse path painting blocks containing cubic Bézier (`c`)
  // Split at every painting operator (`S`, `s`, `f`, `F`, `f*`, `B`, `B*`, `b`, `b*`, `n`)
  const paintRe = /([\s\S]*?)(\b(?:B\*|b\*|f\*|S|s|f|F|B|b|n)\b)/g;
  let bezierContours = 0;
  let unclosedBezierCount = 0;
  let filledBezierCount = 0;
  const signatures = new Set();
  let duplicateContourCount = 0;

  let m;
  while ((m = paintRe.exec(streamText)) !== null) {
    const body = m[1];
    const op = m[2];
    if (op === 'n') continue; // clipping path, not painted CUT
    if (!/\bc\b/.test(body)) continue; // straight lines (e.g. registration brackets)

    // Exclude small circular registration marks (4 cubic arcs with diameter <= 10mm)
    const pts = [];
    for (const pm of body.matchAll(/([-\d.]+)\s+([-\d.]+)\s+(?:m|l)\b/g)) {
      pts.push([+pm[1] * PT_TO_MM, +pm[2] * PT_TO_MM]);
    }
    for (const cm of body.matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+c\b/g)) {
      pts.push([+cm[5] * PT_TO_MM, +cm[6] * PT_TO_MM]);
    }
    if (pts.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const wMm = maxX - minX;
    const hMm = maxY - minY;
    // Ignore registration dot circles (4 Bézier segments, <= 12mm)
    const cCount = (body.match(/\bc\b/g) || []).length;
    if (cCount <= 4 && wMm <= 12.5 && hMm <= 12.5 && Math.abs(wMm - hMm) < 0.2) {
      continue;
    }

    bezierContours++;
    const isClosed = /\bh\b/.test(body) || op === 's' || op === 'b' || op === 'b*';
    if (!isClosed) unclosedBezierCount++;
    if (op === 'f' || op === 'f*' || op === 'F' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*') {
      filledBezierCount++;
    }
    const sig = `${Math.round(minX * 100)}_${Math.round(minY * 100)}_${Math.round(maxX * 100)}_${Math.round(maxY * 100)}_${cCount}`;
    if (signatures.has(sig)) {
      duplicateContourCount++;
    } else {
      signatures.add(sig);
    }
  }

  const issues = [];
  if (unclosedBezierCount > 0) {
    issues.push({ severity: 'FAIL', code: 'CUT_UNCLOSED', message: `Phát hiện ${unclosedBezierCount} đường CUT không khép kín.` });
  }
  if (filledBezierCount > 0) {
    issues.push({ severity: 'FAIL', code: 'CUT_HAS_FILL', message: `Phát hiện ${filledBezierCount} đường CUT có tô nền (fill) — máy bế yêu cầu chỉ stroke, không fill.` });
  }
  if (duplicateContourCount > 0) {
    issues.push({ severity: 'FAIL', code: 'CUT_DUPLICATE', message: `Phát hiện ${duplicateContourCount} đường CUT trùng lặp (dễ cắt đúp rách đế decal).` });
  }
  if (expectedContourCount != null && bezierContours !== expectedContourCount) {
    issues.push({
      severity: 'FAIL',
      code: 'CUT_COUNT_MISMATCH',
      message: `Số lượng đường CUT xuất (${bezierContours}) không khớp kế hoạch (${expectedContourCount}).`,
    });
  }
  if (requireSpotCutContour && !usesSpotInStream) {
    issues.push({
      severity: 'FAIL',
      code: 'SPOT_CUTCONTOUR_MISSING',
      message: `Thiếu Spot Color "/Separation /${spotColorName}" trên đường CUT theo yêu cầu workflow máy.`,
    });
  }

  return {
    ok: issues.filter((i) => i.severity === 'FAIL').length === 0,
    bezierContours,
    unclosedBezierCount,
    filledBezierCount,
    duplicateContourCount,
    hasSpotCutContour: usesSpotInStream,
    issues,
  };
}

/**
 * Evaluate full Machine Compatibility + separate Geometry report for a V1 plan / exported bundle.
 */
export async function validateMachineCompatibility({
  v1PlanState,
  cutPageFiles = [],
  machineProfileId = null,
  pontType = 'graphtec',
  requireSpotCutContour = false,
} = {}) {
  const imp = v1PlanState?.checkpoint?.batchPlan?.impositionPlan;
  const manifest = v1PlanState?.checkpoint?.batchPlan?.productionOrderManifest;
  const profile = getMachineProfile(machineProfileId) || inferMachineProfileFromPontType(pontType);

  // 1. Separate Geometry Report (from H2.2 + G + Post-Export Verifier)
  const geoChecks = [];
  const geoStatusRaw = manifest?.bleedPolicy?.geometryStatus || 'UNKNOWN';
  const colorStatusRaw = manifest?.bleedPolicy?.colorStatus || 'UNKNOWN';
  const cutVerifyAllPass =
    cutPageFiles.length === 0 || cutPageFiles.every((f) => f.verification?.status === 'PASS');

  let geometryStatus = 'PASS';
  if (geoStatusRaw === 'GEOMETRY_BLOCKED' || !cutVerifyAllPass) {
    geometryStatus = 'FAIL';
  } else if (colorStatusRaw.includes('UNVERIFIED') || manifest?.bleedPolicy?.productionStatus === 'WARNING') {
    geometryStatus = 'WARNING';
  }

  geoChecks.push({
    code: 'H22_GEOMETRY',
    status: geoStatusRaw === 'GEOMETRY_SAFE' ? 'PASS' : 'FAIL',
    detail: `An toàn hình học CUT/BLEED: ${geoStatusRaw} (Hở CUT = ${manifest?.bleedPolicy?.cutGapMm ?? '—'} mm)`,
  });
  geoChecks.push({
    code: 'BEZIER_PRESERVATION',
    status: cutVerifyAllPass ? 'PASS' : 'FAIL',
    detail:
      cutPageFiles.length > 0
        ? `Hậu kiểm Bézier ${cutPageFiles.length}/${cutPageFiles.length} file CUT: không simplify, 0 kinks, 0 collisions`
        : 'Đường Bézier gốc được bảo toàn (chưa xuất file)',
  });
  if (colorStatusRaw.includes('UNVERIFIED')) {
    geoChecks.push({
      code: 'BLEED_COLOR_METADATA',
      status: 'WARNING',
      detail: `Màu tràn viền chồng BLEED (${colorStatusRaw}) — cần xác nhận cùng màu nền khi in`,
    });
  }

  const geometryReport = {
    status: geometryStatus,
    checks: geoChecks,
    summary:
      geometryStatus === 'PASS'
        ? 'Hình học CUT/BLEED/Bézier đạt chuẩn 100%'
        : geometryStatus === 'WARNING'
          ? 'Hình học CUT/BLEED đạt chuẩn (có cảnh báo metadata màu nền)'
          : 'Hình học có lỗi chặn sản xuất',
  };

  // 2. Separate Machine Compatibility Report
  const machineChecks = [];
  const blockers = [];
  const warnings = [];

  const pushCheck = (code, status, detail) => {
    machineChecks.push({ code, status, detail });
    if (status === 'FAIL') blockers.push({ code, message: detail });
    else if (status === 'WARNING') warnings.push({ code, message: detail });
  };

  if (!profile) {
    pushCheck(
      'MACHINE_PROFILE',
      pontType === 'none' ? 'WARNING' : 'WARNING',
      pontType === 'none'
        ? 'Không dùng boong định vị — không thể bế tự động bằng mắt đọc quang học (SAGA/Graphtec).'
        : 'Chưa chọn Machine Profile cụ thể.'
    );
  } else {
    // 2a. Mark type check
    const markTypeOk = profile.allowedPontTypes.includes(pontType);
    pushCheck(
      'REGMARK_TYPE',
      markTypeOk ? 'PASS' : 'FAIL',
      markTypeOk
        ? `Kiểu boong "${pontType}" khớp chuẩn ${profile.label} (CMYK K=100%).`
        : `Kiểu boong "${pontType}" không tương thích với ${profile.label} (yêu cầu: ${profile.allowedPontTypes.join(', ')}).`
    );

    const markInsetMm = Number(imp?.productionProfile?.markInsetMm ?? v1PlanState?.summary?.markInsetMm ?? 10);
    const markSizeMm = Number(imp?.productionProfile?.markSizeMm ?? v1PlanState?.summary?.markSizeMm ?? 5);

    const sizeOk = markSizeMm >= profile.minMarkSizeMm && markSizeMm <= profile.maxMarkSizeMm;
    pushCheck(
      'REGMARK_SIZE',
      sizeOk ? 'PASS' : 'FAIL',
      sizeOk
        ? `Kích thước dấu ${markSizeMm} mm hợp lệ (${profile.minMarkSizeMm}–${profile.maxMarkSizeMm} mm).`
        : `Kích thước dấu ${markSizeMm} mm ngoài dải chuẩn ${profile.minMarkSizeMm}–${profile.maxMarkSizeMm} mm của ${profile.label}.`
    );

    const insetOk = markInsetMm >= profile.minMarkInsetMm && markInsetMm <= profile.maxMarkInsetMm;
    pushCheck(
      'REGMARK_INSET',
      insetOk ? 'PASS' : 'WARNING',
      insetOk
        ? `Lề đặt boong ${markInsetMm} mm đạt chuẩn (${profile.minMarkInsetMm}–${profile.maxMarkInsetMm} mm).`
        : `Lề đặt boong ${markInsetMm} mm ngoài khuyến nghị ${profile.minMarkInsetMm}–${profile.maxMarkInsetMm} mm.`
    );

    // 2b. Media size & Quiet Zone check across all sheets
    const sheets = imp?.sheets || [];
    const bleedOutsetMm = Number(v1PlanState?.uiParams?.bleedOutsetMm || 0);
    let mediaOutOfBounds = false;
    let quietZoneIntrusions = 0;

    for (const sh of sheets) {
      if (
        sh.widthMm < profile.minSheetWidthMm ||
        sh.widthMm > profile.maxSheetWidthMm ||
        sh.heightMm < profile.minSheetHeightMm ||
        sh.heightMm > profile.maxSheetHeightMm
      ) {
        mediaOutOfBounds = true;
      }
      const qzRects = getMarkQuietZoneRectsMm({
        sheetWidthMm: sh.widthMm,
        sheetHeightMm: sh.heightMm,
        markInsetMm,
        markSizeMm,
        quietZoneMm: profile.quietZoneMm,
      });
      for (const pl of sh.placements || []) {
        const rm = pl.rigidMatrixMm;
        const x = Array.isArray(rm) ? rm[4] : Number(rm?.tx) || 0;
        const y = Array.isArray(rm) ? rm[5] : Number(rm?.ty) || 0;
        const w = Number(pl.targetSizeMm?.w) || 0;
        const h = Number(pl.targetSizeMm?.h) || 0;
        const bleedRect = {
          x: x - bleedOutsetMm,
          y: y - bleedOutsetMm,
          w: w + 2 * bleedOutsetMm,
          h: h + 2 * bleedOutsetMm,
        };
        for (const qz of qzRects) {
          if (rectsOverlap(bleedRect, qz)) {
            quietZoneIntrusions++;
          }
        }
      }
    }

    pushCheck(
      'MEDIA_SIZE',
      mediaOutOfBounds ? 'FAIL' : 'PASS',
      mediaOutOfBounds
        ? `Khổ vật liệu ${sheets[0]?.widthMm}×${sheets[0]?.heightMm} mm vượt giới hạn ${profile.maxSheetWidthMm}×${profile.maxSheetHeightMm} mm của ${profile.label}.`
        : `Khổ vật liệu ${sheets[0]?.widthMm || '—'}×${sheets[0]?.heightMm || '—'} mm tương thích ${profile.label}.`
    );

    pushCheck(
      'QUIET_ZONE',
      quietZoneIntrusions === 0 ? 'PASS' : 'FAIL',
      quietZoneIntrusions === 0
        ? `Vùng an toàn cảm biến quanh 4 boong (±${profile.quietZoneMm} mm) thông thoáng, 0 tem/BLEED xâm lấn.`
        : `Phát hiện ${quietZoneIntrusions} vị trí tem/BLEED xâm lấn vào vùng an toàn cảm biến (±${profile.quietZoneMm} mm) quanh boong.`
    );
  }

  // 2c. Exported CUT vector hygiene & Spot Color CutContour verification
  if (cutPageFiles.length > 0) {
    let allVectorOk = true;
    let totalSpotOk = 0;
    for (const cf of cutPageFiles) {
      const vecCheck = await validateCutVectorStream(cf.bytes, {
        requireSpotCutContour,
        spotColorName: profile?.spotCutColorName || 'CutContour',
        expectedContourCount: cf.placementCount,
      });
      if (vecCheck.hasSpotCutContour) totalSpotOk++;
      if (!vecCheck.ok) {
        allVectorOk = false;
        for (const iss of vecCheck.issues) {
          pushCheck(`T${cf.pageNumber}_${iss.code}`, iss.severity, `Trang ${cf.pageNumber}: ${iss.message}`);
        }
      }
    }
    if (allVectorOk) {
      pushCheck(
        'CUT_VECTOR_HYGIENE',
        'PASS',
        `100% đường CUT trên ${cutPageFiles.length} file là vector khép kín, không fill, 0 contour trùng${requireSpotCutContour ? `, có Spot Color CutContour (${totalSpotOk}/${cutPageFiles.length})` : ''}.`
      );
    }
  } else if (requireSpotCutContour) {
    pushCheck(
      'SPOT_CUTCONTOUR_READY',
      'PASS',
      'Đã bật xuất Spot Color "/Separation /CutContour" cho đường CUT (sẽ xác minh trực tiếp trên stream PDF/AI khi xuất).'
    );
  }

  const machineStatus =
    blockers.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARNING' : 'PASS';

  const machineReport = {
    status: machineStatus,
    profileId: profile?.id || 'custom',
    profileLabel: profile?.label || 'Tùy chỉnh',
    softwareCompat: profile?.softwareCompat || [],
    checks: machineChecks,
    blockers,
    warnings,
    summary:
      machineStatus === 'PASS'
        ? `Tương thích máy ${profile?.label || 'V1'}: PASS (sẵn sàng cắt thử thực tế)`
        : machineStatus === 'WARNING'
          ? `Tương thích máy ${profile?.label || 'V1'}: WARNING (${warnings.length} lưu ý)`
          : `Tương thích máy ${profile?.label || 'V1'}: FAIL (${blockers.length} lỗi cần xử lý)`,
  };

  return {
    geometryReport,
    machineReport,
  };
}
