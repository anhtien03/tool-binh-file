import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createResourceStore } from '../engine/resourceStore.js';
import { PRODUCTION_PROFILES } from '../engine/batchImpositionAdapter.js';
import { contourBoundsMm } from '../engine/bleedContourEngine.js';
import {
  buildStudioStickerJobsV1,
  createCheckpointKBatch,
  exportCheckpointKBatch,
  releaseCheckpointKOutput,
  suggestGridForSheet,
} from '../engine/checkpointKUiBridge.js';

const SHEET_PRESETS = [
  { label: 'Decal 330 × 390 mm', w: 330, h: 390 },
  { label: 'Decal 320 × 330 mm (L0110)', w: 320, h: 330 },
  { label: 'A3+ 325 × 430 mm', w: 325, h: 430 },
  { label: 'A3 297 × 420 mm', w: 297, h: 420 },
];

async function canvasToPngUint8(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Không thể xuất PNG từ canvas artwork sạch.');
  return new Uint8Array(await blob.arrayBuffer());
}

export default function ProductionImposeV1Modal({
  open,
  onClose,
  onOpenLegacyImpose,
  cleanArtworkCanvas,
  sourceSizeMm,
  contoursMm,
  bleedOffsetMm = 1.5,
  sourceFileName = 'tem',
  provenanceInfo = null,
}) {
  const storeRef = useRef(null);
  const lastExportRef = useRef(null);
  const stickerCount = Array.isArray(contoursMm) ? contoursMm.length : 0;
  const [imposeMode, setImposeMode] = useState(stickerCount > 1 ? 'all' : 'repeat_first');

  useEffect(() => {
    if (open) {
      setImposeMode(stickerCount > 1 ? 'all' : 'repeat_first');
    }
  }, [open, stickerCount]);

  const firstBounds = useMemo(() => {
    if (!Array.isArray(contoursMm) || contoursMm.length === 0) return { w: 48, h: 48 };
    const b = contourBoundsMm(contoursMm[0]);
    return {
      w: b.w ?? b.width ?? Math.max(1, b.maxX - b.minX),
      h: b.h ?? b.height ?? Math.max(1, b.maxY - b.minY),
    };
  }, [contoursMm]);

  const [sheetWidthMm, setSheetWidthMm] = useState(330);
  const [sheetHeightMm, setSheetHeightMm] = useState(390);
  const [marginMm, setMarginMm] = useState(15);
  const [cutGapMm, setCutGapMm] = useState(3.5);
  const [runCount, setRunCount] = useState(1);

  const suggested = useMemo(
    () =>
      suggestGridForSheet({
        sheetWidthMm,
        sheetHeightMm,
        marginsMm: { top: marginMm, right: marginMm, bottom: marginMm, left: marginMm },
        trimWmm: firstBounds.w,
        trimHmm: firstBounds.h,
        cutGapMm,
      }),
    [sheetWidthMm, sheetHeightMm, marginMm, firstBounds.w, firstBounds.h, cutGapMm]
  );

  const [columns, setColumns] = useState(suggested.columns);
  const [rows, setRows] = useState(suggested.rows);
  const [bleedPolicy, setBleedPolicy] = useState('strict');
  const [bleedOverlapConfirmed, setBleedOverlapConfirmed] = useState(false);
  const [bleedOverlapJustification, setBleedOverlapJustification] = useState('');
  const [profileKey, setProfileKey] = useState('GENERIC');

  // Authoritative Checkpoint K B3.1.1 envelope: { batchPlan, uiSnapshot } + V1 jobs/assets
  const [checkpoint, setCheckpoint] = useState(null);
  const [preparedV1, setPreparedV1] = useState(null); // { jobs, assets }
  const [exportResult, setExportResult] = useState(null);
  const [warningAccepted, setWarningAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorBox, setErrorBox] = useState(null);

  // Sync suggested grid when modal opens or sheet preset changes
  useEffect(() => {
    if (open) {
      setColumns(suggested.columns);
      setRows(suggested.rows);
    }
  }, [open, suggested.columns, suggested.rows]);

  // Invalidate checkpoint & export result whenever ANY production UI parameter changes!
  useEffect(() => {
    setCheckpoint(null);
    setWarningAccepted(false);
    setErrorBox(null);
    if (lastExportRef.current && storeRef.current) {
      releaseCheckpointKOutput(storeRef.current, lastExportRef.current.output);
      lastExportRef.current = null;
    }
    setExportResult(null);
  }, [
    sheetWidthMm,
    sheetHeightMm,
    marginMm,
    columns,
    rows,
    runCount,
    cutGapMm,
    bleedPolicy,
    bleedOverlapConfirmed,
    bleedOverlapJustification,
    profileKey,
    bleedOffsetMm,
    imposeMode,
  ]);

  // Cleanup ResourceStore when modal closes or unmounts
  useEffect(() => {
    if (!open) {
      if (lastExportRef.current && storeRef.current) {
        releaseCheckpointKOutput(storeRef.current, lastExportRef.current.output);
        lastExportRef.current = null;
      }
      storeRef.current = null;
      setPreparedV1(null);
      setCheckpoint(null);
      setExportResult(null);
      setErrorBox(null);
    }
  }, [open]);

  if (!open) return null;

  const isAllStickersMode = imposeMode === 'all' && stickerCount > 1;
  const copiesPerSheet = isAllStickersMode ? stickerCount : Math.max(1, columns * rows);
  const totalStickers = copiesPerSheet * Math.max(1, runCount);
  const effectiveBleedOutset = Math.max(0, Number(bleedOffsetMm) || 0);
  const productionProfile = profileKey === 'NONE' ? PRODUCTION_PROFILES.NONE : PRODUCTION_PROFILES.GENERIC;

  const buildCurrentTemplates = (jobsList) => {
    const items = isAllStickersMode
      ? jobsList.map((j) => ({ jobId: j.jobId, copiesPerRun: 1 }))
      : [{ jobId: jobsList[0].jobId, copiesPerRun: Math.max(1, columns * rows) }];
    return [
      {
        templateId: 'TPL-V1-01',
        sheetWidthMm: Number(sheetWidthMm),
        sheetHeightMm: Number(sheetHeightMm),
        marginsMm: {
          top: Number(marginMm),
          right: Number(marginMm),
          bottom: Number(marginMm),
          left: Number(marginMm),
        },
        runCount: Number(runCount),
        gridSpec: {
          rows: Number(rows),
          columns: Number(columns),
          centerX: true,
          centerY: true,
        },
        items,
      },
    ];
  };

  const handleBuildPlan = async () => {
    setBusy(true);
    setErrorBox(null);
    setWarningAccepted(false);
    if (lastExportRef.current && storeRef.current) {
      releaseCheckpointKOutput(storeRef.current, lastExportRef.current.output);
      lastExportRef.current = null;
    }
    setExportResult(null);

    try {
      const store = createResourceStore();
      storeRef.current = store;
      const cleanPngBytes = await canvasToPngUint8(cleanArtworkCanvas);

      // Preserve 100% of exact Bézier contours (all N stickers or Sticker #1 repeated, zero refit/simplify)
      const baseName = (sourceFileName || 'tem').replace(/\.[^.]+$/, '');
      const selectedContours = isAllStickersMode ? contoursMm : [contoursMm[0]];
      const built = await buildStudioStickerJobsV1({
        cleanArtworkBytes: cleanPngBytes,
        mimeType: 'image/png',
        sourceSizeMm,
        contoursMm: selectedContours,
        bleedOffsetMm: effectiveBleedOutset,
        quantityPerSticker: isAllStickersMode ? Math.max(1, Number(runCount)) : totalStickers,
        resourceStore: store,
        labelPrefix: baseName,
        allowRotate: false,
      });

      const sheetTemplates = buildCurrentTemplates(built.jobs);
      const env = await createCheckpointKBatch({
        jobs: built.jobs,
        sheetTemplates,
        cutGapMm: Number(cutGapMm),
        bleedOutsetMm: effectiveBleedOutset,
        bleedClearanceMm: 0,
        bleedPolicy,
        bleedOverlapConfirmed,
        bleedOverlapJustification: bleedPolicy === 'allow_overlap' ? bleedOverlapJustification : null,
        productionProfile,
        allowWarnings: true,
      });

      setPreparedV1({ jobs: built.jobs, assets: built.assets, sheetTemplates });
      setCheckpoint(env);
    } catch (err) {
      setCheckpoint(null);
      setErrorBox({
        code: err?.code || 'BUILD_FAILED',
        message: err?.message || 'Không thể tạo kế hoạch bình tem H.2.',
        details: err?.details || null,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExportAndValidate = async () => {
    if (!checkpoint || !preparedV1 || !storeRef.current) return;
    setBusy(true);
    setErrorBox(null);
    setWarningAccepted(false);
    if (lastExportRef.current) {
      releaseCheckpointKOutput(storeRef.current, lastExportRef.current.output);
      lastExportRef.current = null;
    }
    setExportResult(null);

    try {
      const sheetTemplates = buildCurrentTemplates(preparedV1.jobs);
      const currentRunCounts = { 'TPL-V1-01': Number(runCount) };
      const expectedOrderManifest = checkpoint.batchPlan.productionOrderManifest;

      const res = await exportCheckpointKBatch({
        checkpoint,
        jobs: preparedV1.jobs,
        assets: preparedV1.assets,
        resourceStore: storeRef.current,
        sheetTemplates,
        currentRunCounts,
        expectedOrderManifest,
        cutGapMm: Number(cutGapMm),
        bleedOutsetMm: effectiveBleedOutset,
        bleedClearanceMm: 0,
        bleedPolicy,
        bleedOverlapConfirmed,
        bleedOverlapJustification: bleedPolicy === 'allow_overlap' ? bleedOverlapJustification : null,
        productionProfile,
        cutFormat: 'PDF',
        scope: 'CUT_ONLY',
      });

      lastExportRef.current = res;
      setExportResult(res);
    } catch (err) {
      // On FINAL_CHECK_BLOCK, release ResourceStore outputs immediately so memory never leaks
      if (err?.details?.output && storeRef.current) {
        releaseCheckpointKOutput(storeRef.current, err.details.output);
      }
      setErrorBox({
        code: err?.code || 'EXPORT_FAILED',
        message: err?.message || 'Xuất sản xuất bị chặn bởi Final Validator.',
        details: err?.details || null,
      });
    } finally {
      setBusy(false);
    }
  };

  const downloadResource = (kind) => {
    if (!exportResult || !storeRef.current) return;
    const canRelease = exportResult.releaseAllowed || (exportResult.warningApprovalRequired && warningAccepted);
    if (!canRelease) return;
    const rid = kind === 'print' ? exportResult.output?.print?.resourceId : exportResult.output?.cut?.resourceId;
    if (!rid) return;
    let url = null;
    let manualRevoke = false;
    if (typeof storeRef.current.getObjectUrl === 'function') {
      url = storeRef.current.getObjectUrl(rid);
    } else if (typeof storeRef.current.getBlob === 'function') {
      url = URL.createObjectURL(storeRef.current.getBlob(rid));
      manualRevoke = true;
    }
    if (!url) return;
    const base = (sourceFileName || 'tem').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download =
      kind === 'print'
        ? `PrintKitV1_IN_${base}_${sheetWidthMm}x${sheetHeightMm}_${copiesPerSheet}tem.pdf`
        : `PrintKitV1_BE_${base}_${sheetWidthMm}x${sheetHeightMm}_${copiesPerSheet}tem.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (manualRevoke) setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const canDownload =
    Boolean(exportResult) &&
    (exportResult.releaseAllowed || (exportResult.warningApprovalRequired && warningAccepted));

  const cutSegCount = Array.isArray(contoursMm?.[0]?.beziersMm)
    ? contoursMm[0].beziersMm.filter((c) => c.type === 'C' || c.type === 'L').length
    : 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-extrabold text-slate-900">✂️ Bình bài Bế Tem — PrintKit V1 (Checkpoint K)</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                Giữ nguyên {cutSegCount} đoạn Bézier gốc
              </span>
              {provenanceInfo?.badgeLabel && (
                <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 text-[10px] font-bold font-mono">
                  {provenanceInfo.badgeLabel}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Không tái nội suy lại đường bế · Xuất cặp FILE IN sạch (không nét hồng) + FILE BẾ vector chuẩn 3.1.3
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-slate-200 text-slate-500 font-bold text-sm cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex flex-col gap-4 text-xs">
          {/* Sticker summary */}
          <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-bold text-emerald-900">
                Tem nguồn: {firstBounds.w.toFixed(2)} × {firstBounds.h.toFixed(2)} mm · Bleed: +{effectiveBleedOutset} mm
                {stickerCount > 1 ? ` · ${stickerCount} tem trên trang` : ''}
              </div>
              <div className="text-[11px] text-emerald-700">
                Đường CUT giữ nguyên {cutSegCount} đoạn cubic Bézier (ma trận cứng 0.000 mm biến dạng).
              </div>
            </div>
            <div className="flex items-center gap-2">
              {stickerCount > 1 && (
                <select
                  value={imposeMode}
                  onChange={(e) => setImposeMode(e.target.value)}
                  className="border border-emerald-300 rounded-lg px-2 py-1 bg-white text-[11px] font-bold text-emerald-900"
                >
                  <option value="all">Giữ toàn bộ {stickerCount} tem riêng biệt</option>
                  <option value="repeat_first">Lặp lại Tem #1 theo lưới</option>
                </select>
              )}
              {onOpenLegacyImpose && (
                <button
                  onClick={onOpenLegacyImpose}
                  className="text-[11px] text-slate-500 hover:text-slate-800 underline cursor-pointer"
                >
                  Mở tab Bình cũ (PdfEditor)
                </button>
              )}
            </div>
          </div>

          {/* Sheet & Grid Config */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="col-span-2 sm:col-span-4 flex flex-wrap gap-1.5">
              {SHEET_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setSheetWidthMm(p.w);
                    setSheetHeightMm(p.h);
                  }}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer ${
                    sheetWidthMm === p.w && sheetHeightMm === p.h
                      ? 'bg-[#146C53] text-white border-[#146C53]'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Rộng tờ (mm)</span>
              <input
                type="number"
                min="50"
                value={sheetWidthMm}
                onChange={(e) => setSheetWidthMm(Math.max(50, Number(e.target.value) || 0))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Cao tờ (mm)</span>
              <input
                type="number"
                min="50"
                value={sheetHeightMm}
                onChange={(e) => setSheetHeightMm(Math.max(50, Number(e.target.value) || 0))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Lề boong 4 phía (mm)</span>
              <input
                type="number"
                min="0"
                value={marginMm}
                onChange={(e) => setMarginMm(Math.max(0, Number(e.target.value) || 0))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Khoảng cách CUT (mm)</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={cutGapMm}
                onChange={(e) => setCutGapMm(Math.max(0, Number(e.target.value) || 0))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Số cột (gợi ý: {suggested.columns})</span>
              <input
                type="number"
                min="1"
                value={columns}
                onChange={(e) => setColumns(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Số hàng (gợi ý: {suggested.rows})</span>
              <input
                type="number"
                min="1"
                value={rows}
                onChange={(e) => setRows(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Số tờ chạy (runCount)</span>
              <input
                type="number"
                min="1"
                value={runCount}
                onChange={(e) => setRunCount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="border border-slate-200 rounded-lg px-2 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-slate-500">Boong bế (Profile)</span>
              <select
                value={profileKey}
                onChange={(e) => setProfileKey(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1.5 bg-white font-semibold"
              >
                <option value="GENERIC">Boong 4 góc chuẩn (GENERIC)</option>
                <option value="NONE">Không boong (NONE)</option>
              </select>
            </label>
          </div>

          {/* BLEED overlap policy */}
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-700">Chính sách an toàn BLEED (H.2.2)</span>
              <select
                value={bleedPolicy}
                onChange={(e) => setBleedPolicy(e.target.value)}
                className="border border-slate-300 rounded-lg px-2 py-1 bg-white text-[11px] font-semibold"
              >
                <option value="strict">Nghiêm ngặt — Không chồng BLEED (strict)</option>
                <option value="allow_overlap">Cho phép chồng BLEED trong vùng rác (allow_overlap)</option>
              </select>
            </div>
            {bleedPolicy === 'allow_overlap' && (
              <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200">
                <label className="flex items-center gap-2 text-[11px] font-semibold text-amber-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bleedOverlapConfirmed}
                    onChange={(e) => setBleedOverlapConfirmed(e.target.checked)}
                  />
                  Tôi xác nhận các tem dùng cùng màu nền tràn viền và chỉ chồng BLEED trong vùng rác
                </label>
                <input
                  type="text"
                  placeholder="Nhập lý do xác nhận (bắt buộc, vd: Cùng nền xanh đậm, cắt bỏ vùng rác)"
                  value={bleedOverlapJustification}
                  onChange={(e) => setBleedOverlapJustification(e.target.value)}
                  className="border border-amber-300 rounded-lg px-2.5 py-1.5 text-[11px] bg-white"
                />
              </div>
            )}
          </div>

          {/* Error Banner */}
          {errorBox && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-900">
              <div className="font-extrabold text-xs">⛔ {errorBox.code}</div>
              <div className="text-[11px] mt-0.5">{errorBox.message}</div>
              {errorBox.details?.finalCheck?.errors?.length > 0 && (
                <ul className="list-disc pl-4 mt-1 text-[11px] space-y-0.5">
                  {errorBox.details.finalCheck.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>{typeof e === 'string' ? e : e.message || JSON.stringify(e)}</li>
                  ))}
                </ul>
              )}
              {errorBox.details?.postExportVerification?.errors?.length > 0 && (
                <ul className="list-disc pl-4 mt-1 text-[11px] space-y-0.5 font-mono">
                  {errorBox.details.postExportVerification.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Checkpoint K Plan Status */}
          {checkpoint && (
            <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 text-sky-950 flex flex-col gap-1">
              <div className="font-bold flex items-center justify-between">
                <span>✓ Kế hoạch H.2 hợp lệ ({copiesPerSheet} tem/tờ × {runCount} tờ = {totalStickers} tem)</span>
                <span className="font-mono text-[10px] text-sky-700">
                  {checkpoint.batchPlan.productionOrderManifest.bleedPolicy.geometryStatus}
                </span>
              </div>
              <div className="text-[11px] text-sky-800">
                Color status: <span className="font-mono">{checkpoint.batchPlan.productionOrderManifest.bleedPolicy.colorStatus}</span>
                {' · '}
                Freshness hash: <span className="font-mono">{checkpoint.batchPlan.productionOrderManifest.batchFreshnessHash.slice(0, 12)}…</span>
              </div>
            </div>
          )}

          {/* Export & Final Validator Result */}
          {exportResult && (
            <div
              className={`p-3 rounded-xl border flex flex-col gap-2 ${
                exportResult.releaseAllowed
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                  : 'bg-amber-50 border-amber-300 text-amber-950'
              }`}
            >
              <div className="font-extrabold flex items-center justify-between">
                <span>
                  {exportResult.releaseAllowed
                    ? '✅ FINAL VALIDATOR: PASS — Sẵn sàng phát hành'
                    : '⚠️ FINAL VALIDATOR: WARNING — Cần xác nhận trước khi tải'}
                </span>
                <span className="font-mono text-[10px]">
                  3.1.3 + Pair Delta ≤ 0.01 mm
                </span>
              </div>

              {exportResult.postExportVerification?.metrics && (
                <div className="p-2 rounded-lg bg-white/80 border border-emerald-200 font-mono text-[10px] text-slate-700 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <div>• CUT.pdf đọc lại: <strong>{exportResult.postExportVerification.metrics.exportedContours}/{exportResult.postExportVerification.metrics.expectedContours}</strong> khép kín</div>
                  <div>• Sai khác số đoạn Bézier: <strong>{exportResult.postExportVerification.metrics.segmentMismatches}</strong></div>
                  <div>• Hausdorff max: <strong>{exportResult.postExportVerification.metrics.maxHausdorffMm.toFixed(4)} mm</strong></div>
                  <div>• Mean delta: <strong>{exportResult.postExportVerification.metrics.meanDeviationMm.toFixed(4)} mm</strong></div>
                  <div>• Valley delta: <strong>{exportResult.postExportVerification.metrics.maxValleyDepthDeltaMm.toFixed(4)} mm</strong> · Kinks mới: <strong>{exportResult.postExportVerification.metrics.newKinksCount}</strong></div>
                  <div>• Min CUT-CUT gap: <strong>{exportResult.postExportVerification.metrics.minCutGapMm != null ? `${exportResult.postExportVerification.metrics.minCutGapMm.toFixed(3)} mm` : '—'}</strong></div>
                </div>
              )}

              {exportResult.finalCheck?.warnings?.length > 0 && (
                <ul className="list-disc pl-4 text-[11px] space-y-0.5">
                  {exportResult.finalCheck.warnings.slice(0, 5).map((w, i) => (
                    <li key={i}>{typeof w === 'string' ? w : w.message || w.code}</li>
                  ))}
                </ul>
              )}

              {exportResult.warningApprovalRequired && (
                <label className="flex items-center gap-2 text-[11px] font-bold text-amber-900 pt-1 border-t border-amber-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={warningAccepted}
                    onChange={(e) => setWarningAccepted(e.target.checked)}
                  />
                  Tôi đã kiểm tra các cảnh báo trên và đồng ý phát hành cặp file IN + BẾ
                </label>
              )}

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!canDownload}
                  onClick={() => downloadResource('print')}
                  className="py-2 px-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-xs cursor-pointer"
                >
                  📥 Tải FILE IN (PRINT.pdf)
                </button>
                <button
                  type="button"
                  disabled={!canDownload}
                  onClick={() => downloadResource('cut')}
                  className="py-2 px-3 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-xs cursor-pointer"
                >
                  ✂️ Tải FILE BẾ (CUT.pdf)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            Lưới: <strong className="text-slate-800">{columns} × {rows} = {copiesPerSheet} tem/tờ</strong>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleBuildPlan}
              className="px-4 py-2 rounded-xl bg-[#146C53] hover:bg-[#0f5440] disabled:opacity-40 text-white font-bold text-xs cursor-pointer"
            >
              {busy && !checkpoint ? 'Đang tạo kế hoạch…' : '1. Tạo kế hoạch H.2'}
            </button>
            <button
              type="button"
              disabled={busy || !checkpoint}
              onClick={handleExportAndValidate}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-xs cursor-pointer"
            >
              {busy && checkpoint ? 'Đang xuất & kiểm định…' : '2. Xuất & Kiểm định IN + BẾ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
