import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { MM_TO_PT } from '../engine/impositionEngine';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const RESIZE_PRESETS = [
  { key: 'A4', label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { key: 'A5', label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  { key: 'A6', label: 'A6 (105 × 148 mm)', w: 105, h: 148 },
  { key: 'A3', label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  { key: 'SRA3', label: 'SRA3 (320 × 450 mm)', w: 320, h: 450 },
  { key: 'Namecard', label: 'Namecard (90 × 54 mm)', w: 90, h: 54 },
  { key: 'DL', label: 'Voucher DL (210 × 99 mm)', w: 210, h: 99 },
  { key: 'Square150', label: 'Vuông (150 × 150 mm)', w: 150, h: 150 },
  { key: 'Custom', label: 'Tùy chỉnh (W × H mm)...', w: 210, h: 297 },
];

export default function FilePrepStudio({
  activeTool = 'organizer',
  initialFile,
  onSharedFileChange,
  onApplyToWorkspace,
  onSendToImpose,
}) {
  const [sourceFile, setSourceFile] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [rawPages, setRawPages] = useState([]); // [{ origIndex, widthMm, heightMm, dataUrl, inkCropMm }]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activePageIdx, setActivePageIdx] = useState(0);
  const [zoom, setZoom] = useState(1.0);

  // 1. Page Organizer state: ordered array of items { id, origIndex, isBlank, rotate: 0|90|180|270, wMm, hMm }
  const [organizedPages, setOrganizedPages] = useState([]);
  const [dragIdx, setDragIdx] = useState(null);

  // 2. Resize state
  const [resizePreset, setResizePreset] = useState('A4');
  const [targetWmm, setTargetWmm] = useState(210);
  const [targetHmm, setTargetHmm] = useState(297);
  const [resizeOrientation, setResizeOrientation] = useState('portrait'); // 'portrait' | 'landscape' | 'auto'
  const [resizeFitMode, setResizeFitMode] = useState('fit'); // 'fit' (vừa trang giữ tỷ lệ) | 'fill' (tràn trang) | 'stretch' (kéo giãn) | 'center100' (giữ 100% đặt giữa)
  const [addBleedMm, setAddBleedMm] = useState(0);
  const [resizeScope, setResizeScope] = useState('all'); // 'all' | 'current'

  // 3. Crop state (mm inset from 4 sides)
  const [cropTopMm, setCropTopMm] = useState(0);
  const [cropBottomMm, setCropBottomMm] = useState(0);
  const [cropLeftMm, setCropLeftMm] = useState(0);
  const [cropRightMm, setCropRightMm] = useState(0);
  const [cropBoxTarget, setCropBoxTarget] = useState('both'); // 'both' (MediaBox + TrimBox) | 'trimOnly' (chỉ gán TrimBox, giữ Bleed ngoài)
  const [cropScope, setCropScope] = useState('all'); // 'all' | 'current' | 'odd' | 'even'

  // 4. Trim & Shift state
  const [oddShiftX, setOddShiftX] = useState(0);
  const [oddShiftY, setOddShiftY] = useState(0);
  const [evenShiftX, setEvenShiftX] = useState(0);
  const [evenShiftY, setEvenShiftY] = useState(0);
  const [mirrorEvenShiftX, setMirrorEvenShiftX] = useState(true); // Tự động đối xứng gáy cho trang chẵn (-oddShiftX)
  const [shiftScalePct, setShiftScalePct] = useState(100);
  const [trimFinalWmm, setTrimFinalWmm] = useState(0); // 0 = keep current page size
  const [trimFinalHmm, setTrimFinalHmm] = useState(0);

  const viewportRef = useRef(null);

  useEffect(() => {
    if (mirrorEvenShiftX) {
      setEvenShiftX(-oddShiftX);
    }
  }, [oddShiftX, mirrorEvenShiftX]);

  // Mouse wheel zoom
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setZoom((prev) => {
        const step = prev >= 2 ? 0.25 : 0.15;
        return Math.round(Math.min(6, Math.max(0.4, prev + (e.deltaY < 0 ? step : -step))) * 100) / 100;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const detectInkCropMm = (canvas, wMm, hMm) => {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
    for (let y = 2; y < height - 2; y += 2) {
      for (let x = 2; x < width - 2; x += 2) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 25 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    if (!found || maxX <= minX || maxY <= minY) {
      return { top: 0, bottom: 0, left: 0, right: 0 };
    }
    return {
      left: Math.max(0, Math.round(((minX / width) * wMm) * 10) / 10),
      top: Math.max(0, Math.round(((minY / height) * hMm) * 10) / 10),
      right: Math.max(0, Math.round((((width - maxX) / width) * wMm) * 10) / 10),
      bottom: Math.max(0, Math.round((((height - maxY) / height) * hMm) * 10) / 10),
    };
  };

  const handleUpload = async (file, notifyParent = true) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setSourceFile(file);
    if (notifyParent && onSharedFileChange) {
      onSharedFileChange(file);
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPdfBytes(bytes);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const loaded = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const vp1 = page.getViewport({ scale: 1.0 });
        const wMm = Math.round((vp1.width / MM_TO_PT) * 10) / 10;
        const hMm = Math.round((vp1.height / MM_TO_PT) * 10) / 10;
        const scale = Math.min(1.8, 900 / Math.max(1, vp1.width, vp1.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const inkCropMm = detectInkCropMm(c, wMm, hMm);
        loaded.push({
          origIndex: p - 1,
          widthMm: wMm,
          heightMm: hMm,
          dataUrl: c.toDataURL('image/jpeg', 0.88),
          inkCropMm,
        });
      }
      setRawPages(loaded);
      setOrganizedPages(
        loaded.map((pg, idx) => ({
          id: `pg-${idx}-${Date.now()}`,
          origIndex: pg.origIndex,
          isBlank: false,
          rotate: 0,
          wMm: pg.widthMm,
          hMm: pg.heightMm,
        }))
      );
      setActivePageIdx(0);
      if (loaded[0]) {
        setTrimFinalWmm(loaded[0].widthMm);
        setTrimFinalHmm(loaded[0].heightMm);
      }
    } catch (e) {
      console.error(e);
      setError('Không thể đọc file PDF này. Vui lòng kiểm tra lại file.');
    } finally {
      setLoading(false);
    }
  };

  // Auto-load workspace shared file when switching between tools
  useEffect(() => {
    if (initialFile && initialFile !== sourceFile) {
      handleUpload(initialFile, false);
    }
  }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build output PDF according to activeTool ('organizer' | 'resize' | 'crop' | 'trimShift')
  const buildProcessedPdfBytes = async () => {
    if (!pdfBytes || rawPages.length === 0) return null;
    const srcDoc = await PDFDocument.load(pdfBytes);
    const outDoc = await PDFDocument.create();

    if (activeTool === 'organizer') {
      for (const item of organizedPages) {
        if (item.isBlank) {
          outDoc.addPage([item.wMm * MM_TO_PT, item.hMm * MM_TO_PT]);
        } else {
          const [copied] = await outDoc.copyPages(srcDoc, [item.origIndex]);
          const curRot = copied.getRotation().angle || 0;
          copied.setRotation(degrees((curRot + item.rotate) % 360));
          outDoc.addPage(copied);
        }
      }
    } else if (activeTool === 'resize') {
      const srcPages = srcDoc.getPages();
      for (let i = 0; i < srcPages.length; i++) {
        const shouldResize = resizeScope === 'all' || i === activePageIdx;
        if (!shouldResize) {
          const [copied] = await outDoc.copyPages(srcDoc, [i]);
          outDoc.addPage(copied);
          continue;
        }
        const sp = srcPages[i];
        const { width: sw, height: sh } = sp.getSize();
        let twMm = Math.max(10, Number(targetWmm) || 210);
        let thMm = Math.max(10, Number(targetHmm) || 297);
        if (resizeOrientation === 'landscape' && twMm < thMm) [twMm, thMm] = [thMm, twMm];
        else if (resizeOrientation === 'portrait' && twMm > thMm) [twMm, thMm] = [thMm, twMm];
        else if (resizeOrientation === 'auto') {
          const srcIsLand = sw > sh;
          if ((srcIsLand && twMm < thMm) || (!srcIsLand && twMm > thMm)) [twMm, thMm] = [thMm, twMm];
        }

        const bleedPt = Math.max(0, Number(addBleedMm) || 0) * MM_TO_PT;
        const trimWpt = twMm * MM_TO_PT;
        const trimHpt = thMm * MM_TO_PT;
        const mediaWpt = trimWpt + bleedPt * 2;
        const mediaHpt = trimHpt + bleedPt * 2;

        const newPage = outDoc.addPage([mediaWpt, mediaHpt]);
        if (bleedPt > 0) {
          newPage.setTrimBox(bleedPt, bleedPt, trimWpt, trimHpt);
          newPage.setBleedBox(0, 0, mediaWpt, mediaHpt);
        }

        const embedded = await outDoc.embedPage(sp);
        let drawW = trimWpt;
        let drawH = trimHpt;
        let dx = bleedPt;
        let dy = bleedPt;

        if (resizeFitMode === 'fit') {
          const s = Math.min(trimWpt / sw, trimHpt / sh);
          drawW = sw * s;
          drawH = sh * s;
          dx = bleedPt + (trimWpt - drawW) / 2;
          dy = bleedPt + (trimHpt - drawH) / 2;
        } else if (resizeFitMode === 'fill') {
          const s = Math.max(mediaWpt / sw, mediaHpt / sh);
          drawW = sw * s;
          drawH = sh * s;
          dx = (mediaWpt - drawW) / 2;
          dy = (mediaHpt - drawH) / 2;
        } else if (resizeFitMode === 'center100') {
          drawW = sw;
          drawH = sh;
          dx = bleedPt + (trimWpt - sw) / 2;
          dy = bleedPt + (trimHpt - sh) / 2;
        } else {
          // stretch to full media
          drawW = mediaWpt;
          drawH = mediaHpt;
          dx = 0;
          dy = 0;
        }
        newPage.drawPage(embedded, { x: dx, y: dy, width: drawW, height: drawH });
      }
    } else if (activeTool === 'crop') {
      const srcPages = srcDoc.getPages();
      for (let i = 0; i < srcPages.length; i++) {
        const [copied] = await outDoc.copyPages(srcDoc, [i]);
        const applyHere =
          cropScope === 'all' ||
          (cropScope === 'current' && i === activePageIdx) ||
          (cropScope === 'odd' && (i + 1) % 2 === 1) ||
          (cropScope === 'even' && (i + 1) % 2 === 0);

        if (applyHere) {
          const { x, y, width, height } = copied.getMediaBox();
          const cL = Math.max(0, Number(cropLeftMm) || 0) * MM_TO_PT;
          const cR = Math.max(0, Number(cropRightMm) || 0) * MM_TO_PT;
          const cT = Math.max(0, Number(cropTopMm) || 0) * MM_TO_PT;
          const cB = Math.max(0, Number(cropBottomMm) || 0) * MM_TO_PT;
          const newW = Math.max(10 * MM_TO_PT, width - cL - cR);
          const newH = Math.max(10 * MM_TO_PT, height - cT - cB);
          const newX = x + cL;
          const newY = y + cB;

          if (cropBoxTarget === 'trimOnly') {
            copied.setTrimBox(newX, newY, newW, newH);
          } else {
            copied.setMediaBox(newX, newY, newW, newH);
            copied.setCropBox(newX, newY, newW, newH);
            copied.setTrimBox(newX, newY, newW, newH);
          }
        }
        outDoc.addPage(copied);
      }
    } else if (activeTool === 'trimShift') {
      const srcPages = srcDoc.getPages();
      const scaleFactor = Math.max(0.1, (Number(shiftScalePct) || 100) / 100);
      for (let i = 0; i < srcPages.length; i++) {
        const sp = srcPages[i];
        const { width: sw, height: sh } = sp.getSize();
        const isOdd = (i + 1) % 2 === 1;
        const sxPt = (isOdd ? Number(oddShiftX) || 0 : Number(evenShiftX) || 0) * MM_TO_PT;
        const syPt = (isOdd ? Number(oddShiftY) || 0 : Number(evenShiftY) || 0) * MM_TO_PT;

        const outWpt = Number(trimFinalWmm) > 5 ? Number(trimFinalWmm) * MM_TO_PT : sw;
        const outHpt = Number(trimFinalHmm) > 5 ? Number(trimFinalHmm) * MM_TO_PT : sh;
        const newPage = outDoc.addPage([outWpt, outHpt]);
        const embedded = await outDoc.embedPage(sp);
        const drawW = sw * scaleFactor;
        const drawH = sh * scaleFactor;
        const dx = (outWpt - drawW) / 2 + sxPt;
        const dy = (outHpt - drawH) / 2 + syPt;
        newPage.drawPage(embedded, { x: dx, y: dy, width: drawW, height: drawH });
      }
    }

    return await outDoc.save();
  };

  const handleExportOrImpose = async (action = 'download') => {
    if (!pdfBytes) return;
    setLoading(true);
    try {
      const outBytes = await buildProcessedPdfBytes();
      if (!outBytes) return;
      const base = (sourceFile?.name || 'file').replace(/\.pdf$/i, '');
      const prefix =
        activeTool === 'organizer'
          ? 'XaoTrang'
          : activeTool === 'resize'
          ? `Resize_${targetWmm}x${targetHmm}mm`
          : activeTool === 'crop'
          ? 'Crop'
          : 'TrimShift';
      const outName = `${prefix}_${base}.pdf`;
      const f = new File([outBytes], outName, { type: 'application/pdf' });

      if (action === 'apply' && onApplyToWorkspace) {
        await handleUpload(f, false);
        onApplyToWorkspace(f);
      } else if ((action === 'impose' || action === true) && onSendToImpose) {
        onSendToImpose(f);
      } else {
        const blob = new Blob([outBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(e);
      setError('Lỗi khi xuất file PDF đã xử lý.');
    } finally {
      setLoading(false);
    }
  };

  const curPage = rawPages[Math.min(activePageIdx, Math.max(0, rawPages.length - 1))] || null;

  // Organizer helper actions
  const rotateItem = (idx, deltaDeg = 90) => {
    setOrganizedPages((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, rotate: (it.rotate + deltaDeg + 360) % 360 } : it))
    );
  };
  const duplicateItem = (idx) => {
    setOrganizedPages((prev) => {
      const target = prev[idx];
      if (!target) return prev;
      const copy = { ...target, id: `dup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };
  const insertBlankAfter = (idx) => {
    const ref = curPage || { widthMm: 210, heightMm: 297 };
    setOrganizedPages((prev) => {
      const blank = {
        id: `blank-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        origIndex: -1,
        isBlank: true,
        rotate: 0,
        wMm: ref.widthMm,
        hMm: ref.heightMm,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, blank);
      return next;
    });
  };
  const deleteItem = (idx) => {
    setOrganizedPages((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  return (
    <>
      {/* 1. LEFT: VISUAL WORKSPACE / INTERACTIVE PREVIEW */}
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded-lg bg-[#E6F4EF] text-[#146C53] font-bold">
              {activeTool === 'organizer'
                ? '🔀 XÁO TRỘN & SẮP XẾP TRANG'
                : activeTool === 'resize'
                ? '📏 CO GIÃN TRANG (RESIZE PDF)'
                : activeTool === 'crop'
                ? '✂️ CẮT KHỔ TRANG (CROP PDF)'
                : '↘️ TRIM & SHIFT (DỊCH LỀ CHẴN / LẺ)'}
            </span>
            {curPage && (
              <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 font-mono font-semibold">
                Gốc: {curPage.widthMm} × {curPage.heightMm} mm · {rawPages.length} trang
              </span>
            )}
          </div>

          {activeTool !== 'organizer' && rawPages.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs font-mono">
              <button
                onClick={() => setActivePageIdx((p) => Math.max(0, p - 1))}
                disabled={activePageIdx <= 0}
                className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 cursor-pointer"
              >
                ‹
              </button>
              <span className="font-bold text-slate-700">
                Trang {activePageIdx + 1}/{rawPages.length} ({(activePageIdx + 1) % 2 === 1 ? 'Lẻ' : 'Chẵn'})
              </span>
              <button
                onClick={() => setActivePageIdx((p) => Math.min(rawPages.length - 1, p + 1))}
                disabled={activePageIdx >= rawPages.length - 1}
                className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 cursor-pointer"
              >
                ›
              </button>
              <button
                onClick={() => setZoom(1.0)}
                className="ml-2 px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 font-sans font-semibold cursor-pointer"
              >
                Fit ({Math.round(zoom * 100)}%)
              </button>
            </div>
          )}
        </div>

        {error && <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs">⚠️ {error}</div>}

        <div
          ref={viewportRef}
          className="flex-1 min-h-[540px] rounded-xl bg-[#e5e7eb] border border-slate-300 overflow-auto p-6 flex items-center justify-center"
        >
          {rawPages.length === 0 ? (
            <label className="cursor-pointer bg-white hover:bg-emerald-50/60 border-2 border-dashed border-[#146C53]/50 rounded-2xl p-10 flex flex-col items-center gap-2 text-center shadow-xs transition-all">
              <span className="text-3xl">📄</span>
              <span className="text-sm font-bold text-slate-800">
                {loading ? '⏳ Đang đọc file PDF...' : 'Bấm để chọn file PDF cần xử lý'}
              </span>
              <span className="text-xs text-slate-500">
                Hỗ trợ Xáo trộn trang, Co giãn đổi khổ (Resize), Cắt lề (Crop) &amp; Dịch trang Chẵn/Lẻ (Trim &amp; Shift)
              </span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => handleUpload(e.target.files?.[0])}
              />
            </label>
          ) : activeTool === 'organizer' ? (
            /* GRID OF DRAGGABLE PAGE CARDS */
            <div className="w-full self-start grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3.5">
              {organizedPages.map((item, idx) => {
                const srcPg = !item.isBlank ? rawPages[item.origIndex] : null;
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={() => setDragIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIdx === null || dragIdx === idx) return;
                      setOrganizedPages((prev) => {
                        const next = [...prev];
                        const [moved] = next.splice(dragIdx, 1);
                        next.splice(idx, 0, moved);
                        return next;
                      });
                      setDragIdx(null);
                    }}
                    className={`bg-white rounded-xl border-2 p-2.5 flex flex-col items-center gap-2 shadow-xs transition-all cursor-grab ${
                      dragIdx === idx ? 'border-violet-500 opacity-60' : 'border-slate-200 hover:border-[#146C53]'
                    }`}
                  >
                    <div className="w-full flex items-center justify-between text-[11px] font-bold text-slate-700">
                      <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-[#146C53]">#{idx + 1}</span>
                      <span className="text-[10px] font-mono text-slate-400">
                        {item.isBlank ? 'Trang trắng' : `Gốc T${item.origIndex + 1}`}
                        {item.rotate > 0 ? ` · ${item.rotate}°` : ''}
                      </span>
                    </div>

                    <div className="w-full h-36 bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-center overflow-hidden p-1.5">
                      {item.isBlank ? (
                        <span className="text-xs italic text-slate-400">(Trang trắng {item.wMm}×{item.hMm}mm)</span>
                      ) : (
                        <img
                          src={srcPg?.dataUrl}
                          alt={`Trang ${idx + 1}`}
                          style={{ transform: `rotate(${item.rotate}deg)` }}
                          className="max-w-full max-h-full object-contain bg-white shadow-2xs transition-transform"
                        />
                      )}
                    </div>

                    <div className="w-full grid grid-cols-4 gap-1 pt-1 border-t border-slate-100">
                      <button
                        onClick={() => rotateItem(idx, 90)}
                        title="Xoay 90°"
                        className="py-1 rounded bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 cursor-pointer"
                      >
                        ↻
                      </button>
                      <button
                        onClick={() => duplicateItem(idx)}
                        title="Nhân bản trang này"
                        className="py-1 rounded bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 cursor-pointer"
                      >
                        ⧉
                      </button>
                      <button
                        onClick={() => insertBlankAfter(idx)}
                        title="Chèn trang trắng vào sau"
                        className="py-1 rounded bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700 cursor-pointer"
                      >
                        ＋⬜
                      </button>
                      <button
                        onClick={() => deleteItem(idx)}
                        title="Xóa trang này"
                        className="py-1 rounded bg-rose-50 hover:bg-rose-100 text-xs font-bold text-rose-600 cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* LIVE SINGLE-PAGE VISUAL SIMULATION FOR RESIZE / CROP / TRIM & SHIFT */
            curPage && (() => {
              const basePxPerMm = (440 / Math.max(curPage.widthMm, curPage.heightMm)) * zoom;

              if (activeTool === 'resize') {
                let tw = Math.max(10, Number(targetWmm) || 210);
                let th = Math.max(10, Number(targetHmm) || 297);
                if (resizeOrientation === 'landscape' && tw < th) [tw, th] = [th, tw];
                else if (resizeOrientation === 'portrait' && tw > th) [tw, th] = [th, tw];
                else if (resizeOrientation === 'auto') {
                  const isLand = curPage.widthMm > curPage.heightMm;
                  if ((isLand && tw < th) || (!isLand && tw > th)) [tw, th] = [th, tw];
                }
                const bleed = Math.max(0, Number(addBleedMm) || 0);
                const totalW = tw + bleed * 2;
                const totalH = th + bleed * 2;
                const scale = (440 / Math.max(totalW, totalH)) * zoom;

                let drawW = tw * scale;
                let drawH = th * scale;
                let leftPx = bleed * scale;
                let topPx = bleed * scale;
                if (resizeFitMode === 'fit') {
                  const s = Math.min(tw / curPage.widthMm, th / curPage.heightMm);
                  drawW = curPage.widthMm * s * scale;
                  drawH = curPage.heightMm * s * scale;
                  leftPx = bleed * scale + (tw * scale - drawW) / 2;
                  topPx = bleed * scale + (th * scale - drawH) / 2;
                } else if (resizeFitMode === 'fill') {
                  const s = Math.max(totalW / curPage.widthMm, totalH / curPage.heightMm);
                  drawW = curPage.widthMm * s * scale;
                  drawH = curPage.heightMm * s * scale;
                  leftPx = (totalW * scale - drawW) / 2;
                  topPx = (totalH * scale - drawH) / 2;
                } else if (resizeFitMode === 'center100') {
                  drawW = curPage.widthMm * scale;
                  drawH = curPage.heightMm * scale;
                  leftPx = bleed * scale + (tw * scale - drawW) / 2;
                  topPx = bleed * scale + (th * scale - drawH) / 2;
                } else {
                  drawW = totalW * scale;
                  drawH = totalH * scale;
                  leftPx = 0;
                  topPx = 0;
                }

                return (
                  <div
                    className="relative bg-white shadow-xl overflow-hidden border border-slate-400"
                    style={{ width: Math.round(totalW * scale), height: Math.round(totalH * scale) }}
                  >
                    <img
                      src={curPage.dataUrl}
                      alt="Resize preview"
                      style={{ position: 'absolute', left: leftPx, top: topPx, width: drawW, height: drawH }}
                    />
                    {/* TrimBox Blue Line */}
                    <div
                      className="absolute border-2 border-blue-600 pointer-events-none"
                      style={{
                        left: bleed * scale,
                        top: bleed * scale,
                        width: tw * scale,
                        height: th * scale,
                      }}
                    />
                    {bleed > 0 && (
                      <div className="absolute inset-0 border-2 border-dashed border-rose-500 pointer-events-none" />
                    )}
                    <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-900/80 text-white text-[11px] font-mono">
                      Khổ mới: {tw} × {th} mm {bleed > 0 ? `(+${bleed}mm Bleed)` : ''}
                    </div>
                  </div>
                );
              }

              if (activeTool === 'crop') {
                const wPx = Math.round(curPage.widthMm * basePxPerMm);
                const hPx = Math.round(curPage.heightMm * basePxPerMm);
                const cL = Math.min(curPage.widthMm * 0.45, Math.max(0, Number(cropLeftMm) || 0)) * basePxPerMm;
                const cR = Math.min(curPage.widthMm * 0.45, Math.max(0, Number(cropRightMm) || 0)) * basePxPerMm;
                const cT = Math.min(curPage.heightMm * 0.45, Math.max(0, Number(cropTopMm) || 0)) * basePxPerMm;
                const cB = Math.min(curPage.heightMm * 0.45, Math.max(0, Number(cropBottomMm) || 0)) * basePxPerMm;
                const croppedW = Math.max(1, curPage.widthMm - (Number(cropLeftMm) || 0) - (Number(cropRightMm) || 0));
                const croppedH = Math.max(1, curPage.heightMm - (Number(cropTopMm) || 0) - (Number(cropBottomMm) || 0));

                return (
                  <div className="relative bg-white shadow-xl border border-slate-400" style={{ width: wPx, height: hPx }}>
                    <img src={curPage.dataUrl} alt="Crop preview" className="w-full h-full block" />
                    {/* Dark shaded mask outside crop region */}
                    <div className="absolute top-0 left-0 right-0 bg-slate-900/45 pointer-events-none" style={{ height: cT }} />
                    <div className="absolute bottom-0 left-0 right-0 bg-slate-900/45 pointer-events-none" style={{ height: cB }} />
                    <div
                      className="absolute left-0 bg-slate-900/45 pointer-events-none"
                      style={{ top: cT, bottom: cB, width: cL }}
                    />
                    <div
                      className="absolute right-0 bg-slate-900/45 pointer-events-none"
                      style={{ top: cT, bottom: cB, width: cR }}
                    />
                    {/* Active Crop rectangle */}
                    <div
                      className="absolute border-2 border-dashed border-rose-600 pointer-events-none"
                      style={{ left: cL, top: cT, right: cR, bottom: cB }}
                    />
                    <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-rose-600 text-white text-[11px] font-mono font-bold">
                      Sau cắt: {croppedW.toFixed(1)} × {croppedH.toFixed(1)} mm
                    </div>
                  </div>
                );
              }

              // Trim & Shift preview
              const isOdd = (activePageIdx + 1) % 2 === 1;
              const sxMm = isOdd ? Number(oddShiftX) || 0 : Number(evenShiftX) || 0;
              const syMm = isOdd ? Number(oddShiftY) || 0 : Number(evenShiftY) || 0;
              const outW = Number(trimFinalWmm) > 5 ? Number(trimFinalWmm) : curPage.widthMm;
              const outH = Number(trimFinalHmm) > 5 ? Number(trimFinalHmm) : curPage.heightMm;
              const scale = (440 / Math.max(outW, outH)) * zoom;
              const sFactor = Math.max(0.1, (Number(shiftScalePct) || 100) / 100);
              const drawW = curPage.widthMm * sFactor * scale;
              const drawH = curPage.heightMm * sFactor * scale;
              const leftPx = (outW * scale - drawW) / 2 + sxMm * scale;
              const topPx = (outH * scale - drawH) / 2 - syMm * scale;

              return (
                <div
                  className="relative bg-white shadow-xl overflow-hidden border-2 border-blue-600"
                  style={{ width: Math.round(outW * scale), height: Math.round(outH * scale) }}
                >
                  <img
                    src={curPage.dataUrl}
                    alt="Trim & Shift preview"
                    style={{ position: 'absolute', left: leftPx, top: topPx, width: drawW, height: drawH }}
                  />
                  {/* Center Crosshair Guide */}
                  <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-emerald-500/60 pointer-events-none" />
                  <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-emerald-500/60 pointer-events-none" />
                  <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-900/80 text-white text-[11px] font-mono">
                    Trang {isOdd ? 'LẺ' : 'CHẴN'} · Dịch X: {sxMm > 0 ? `+${sxMm}` : sxMm}mm, Y: {syMm > 0 ? `+${syMm}` : syMm}mm
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </main>

      {/* 2. MIDDLE-RIGHT: SETTINGS PANEL FOR CURRENT FILE PREP TOOL */}
      <aside className="w-full lg:w-[345px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-80px)] shrink-0 shadow-xs">
        <div className="border-b border-slate-100 pb-2">
          <div className="text-xs font-bold text-slate-800 uppercase">
            {activeTool === 'organizer'
              ? '🔀 XÁO TRỘN & SẮP XẾP TRANG'
              : activeTool === 'resize'
              ? '📏 CO GIÃN TRANG (RESIZE)'
              : activeTool === 'crop'
              ? '✂️ CẮT KHỔ TRANG (CROP)'
              : '↘️ TRIM & SHIFT (DỊCH LỀ)'}
          </div>
          <div className="text-[10px] text-slate-400">
            {activeTool === 'organizer'
              ? 'Kéo thả đổi thứ tự, xoay, nhân bản, chèn trang trắng'
              : activeTool === 'resize'
              ? 'Đổi khổ trang PDF hàng loạt & tự động thêm Bleed'
              : activeTool === 'crop'
              ? 'Cắt bỏ lề thừa / bon cắt cũ theo 4 cạnh hoặc vùng mực'
              : 'Dịch chuyển nội dung trang Chẵn / Lẻ để chừa gáy đóng sách'}
          </div>
        </div>

        {/* File Upload box */}
        <label className="w-full cursor-pointer rounded-xl border-2 border-dashed border-[#146C53]/40 bg-[#E6F4EF]/40 hover:bg-[#E6F4EF]/70 px-3 py-2.5 text-center transition-colors">
          <div className="text-xs font-bold text-[#146C53] truncate">
            {sourceFile ? `📄 ${sourceFile.name} (${rawPages.length} trang)` : '+ Chọn file PDF nguồn'}
          </div>
          <input
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => handleUpload(e.target.files?.[0])}
          />
        </label>

        {/* TOOL-SPECIFIC CONTROLS */}
        {activeTool === 'organizer' && (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-bold text-slate-800">Thao tác hàng loạt ({organizedPages.length} trang)</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setOrganizedPages((prev) => [...prev].reverse())}
                disabled={organizedPages.length < 2}
                className="px-2.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-40"
              >
                ⇅ Đảo ngược thứ tự
              </button>
              <button
                onClick={() =>
                  setOrganizedPages((prev) => prev.map((it) => ({ ...it, rotate: (it.rotate + 90) % 360 })))
                }
                disabled={organizedPages.length === 0}
                className="px-2.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-40"
              >
                ↻ Xoay tất cả 90°
              </button>
              <button
                onClick={() => setOrganizedPages((prev) => prev.filter((_, i) => (i + 1) % 2 === 1))}
                disabled={organizedPages.length < 2}
                className="px-2.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-40"
              >
                1,3,5 Giữ trang Lẻ
              </button>
              <button
                onClick={() => setOrganizedPages((prev) => prev.filter((_, i) => (i + 1) % 2 === 0))}
                disabled={organizedPages.length < 2}
                className="px-2.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-40"
              >
                2,4,6 Giữ trang Chẵn
              </button>
              <button
                onClick={() => {
                  // Pad to multiple of 4 with blank pages for saddle-stitch booklet
                  const rem = organizedPages.length % 4;
                  if (rem === 0) return;
                  const need = 4 - rem;
                  const ref = curPage || { widthMm: 210, heightMm: 297 };
                  const blanks = Array.from({ length: need }, (_, k) => ({
                    id: `pad4-${Date.now()}-${k}`,
                    origIndex: -1,
                    isBlank: true,
                    rotate: 0,
                    wMm: ref.widthMm,
                    hMm: ref.heightMm,
                  }));
                  setOrganizedPages((prev) => [...prev, ...blanks]);
                }}
                disabled={organizedPages.length === 0}
                className="col-span-2 px-2.5 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-xs font-bold text-[#146C53] cursor-pointer disabled:opacity-40"
              >
                📖 Tự bù trang trắng cho chẵn bội số 4 (Đóng sách)
              </button>
              <button
                onClick={() =>
                  setOrganizedPages(
                    rawPages.map((pg, idx) => ({
                      id: `pg-reset-${idx}-${Date.now()}`,
                      origIndex: pg.origIndex,
                      isBlank: false,
                      rotate: 0,
                      wMm: pg.widthMm,
                      hMm: pg.heightMm,
                    }))
                  )
                }
                disabled={rawPages.length === 0}
                className="col-span-2 px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-[11px] font-semibold text-slate-500 cursor-pointer disabled:opacity-40"
              >
                ↺ Khôi phục thứ tự gốc ban đầu
              </button>
            </div>
          </div>
        )}

        {activeTool === 'resize' && (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-bold text-slate-800">1. Chọn khổ thành phẩm mới</span>
            <select
              value={resizePreset}
              onChange={(e) => {
                const k = e.target.value;
                setResizePreset(k);
                const found = RESIZE_PRESETS.find((p) => p.key === k);
                if (found && k !== 'Custom') {
                  setTargetWmm(found.w);
                  setTargetHmm(found.h);
                }
              }}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-800"
            >
              {RESIZE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Rộng W (mm)</label>
                <input
                  type="number"
                  value={targetWmm}
                  onChange={(e) => {
                    setResizePreset('Custom');
                    setTargetWmm(Math.max(10, parseFloat(e.target.value) || 10));
                  }}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Cao H (mm)</label>
                <input
                  type="number"
                  value={targetHmm}
                  onChange={(e) => {
                    setResizePreset('Custom');
                    setTargetHmm(Math.max(10, parseFloat(e.target.value) || 10));
                  }}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Hướng xoay trang</label>
                <select
                  value={resizeOrientation}
                  onChange={(e) => setResizeOrientation(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="auto">Tự theo trang gốc</option>
                  <option value="portrait">Ép Dọc (Portrait)</option>
                  <option value="landscape">Ép Ngang (Landscape)</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Thêm lề Bleed (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={addBleedMm}
                  onChange={(e) => setAddBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
            </div>

            <span className="text-xs font-bold text-slate-800 pt-1">2. Chế độ co giãn nội dung</span>
            <select
              value={resizeFitMode}
              onChange={(e) => setResizeFitMode(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-800"
            >
              <option value="fit">Vừa khổ mới (Giữ tỷ lệ, không mất nội dung)</option>
              <option value="fill">Lấp đầy khổ mới (Giữ tỷ lệ, tràn kín lề)</option>
              <option value="stretch">Kéo giãn 2 chiều (Ép khít W × H)</option>
              <option value="center100">Giữ nguyên tỷ lệ 100% (Đặt giữa khổ mới)</option>
            </select>

            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-slate-600">Áp dụng cho:</span>
              <select
                value={resizeScope}
                onChange={(e) => setResizeScope(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold"
              >
                <option value="all">Toàn bộ các trang</option>
                <option value="current">Chỉ trang đang xem (#{activePageIdx + 1})</option>
              </select>
            </div>
          </div>
        )}

        {activeTool === 'crop' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800">1. Lề cắt bỏ 4 cạnh (mm)</span>
              <button
                onClick={() => {
                  if (!curPage?.inkCropMm) return;
                  setCropTopMm(curPage.inkCropMm.top);
                  setCropBottomMm(curPage.inkCropMm.bottom);
                  setCropLeftMm(curPage.inkCropMm.left);
                  setCropRightMm(curPage.inkCropMm.right);
                }}
                disabled={!curPage}
                className="px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-[#146C53] text-[11px] font-bold cursor-pointer disabled:opacity-40"
              >
                ✨ Tự bắt sát vùng mực
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Cắt Trên (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={cropTopMm}
                  onChange={(e) => setCropTopMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Cắt Dưới (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={cropBottomMm}
                  onChange={(e) => setCropBottomMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Cắt Trái (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={cropLeftMm}
                  onChange={(e) => setCropLeftMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Cắt Phải (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={cropRightMm}
                  onChange={(e) => setCropRightMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[0, 2, 3, 5, 10].map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    setCropTopMm(v);
                    setCropBottomMm(v);
                    setCropLeftMm(v);
                    setCropRightMm(v);
                  }}
                  className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-[11px] font-mono font-semibold text-slate-700 cursor-pointer"
                >
                  4 cạnh = {v}mm
                </button>
              ))}
            </div>

            <span className="text-xs font-bold text-slate-800 pt-1">2. Kiểu áp dụng hộp PDF</span>
            <select
              value={cropBoxTarget}
              onChange={(e) => setCropBoxTarget(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-800"
            >
              <option value="both">Cắt thật (Thu nhỏ cả MediaBox &amp; TrimBox)</option>
              <option value="trimOnly">Chỉ gán TrimBox (Giữ phần ngoài làm Bleed)</option>
            </select>

            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-slate-600">Phạm vi trang:</span>
              <select
                value={cropScope}
                onChange={(e) => setCropScope(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold"
              >
                <option value="all">Tất cả các trang</option>
                <option value="odd">Chỉ trang Lẻ (1, 3, 5...)</option>
                <option value="even">Chỉ trang Chẵn (2, 4, 6...)</option>
                <option value="current">Chỉ trang đang xem (#{activePageIdx + 1})</option>
              </select>
            </div>
          </div>
        )}

        {activeTool === 'trimShift' && (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-bold text-slate-800">1. Dịch chuyển trang LẺ (1, 3, 5...)</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Dịch Ngang X (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={oddShiftX}
                  onChange={(e) => setOddShiftX(parseFloat(e.target.value) || 0)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-[#146C53]"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Dịch Dọc Y (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={oddShiftY}
                  onChange={(e) => setOddShiftY(parseFloat(e.target.value) || 0)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
            </div>

            <label className="flex items-center justify-between gap-2 text-[11px] text-slate-700 bg-emerald-50/70 px-2.5 py-1.5 rounded-lg border border-emerald-200 cursor-pointer">
              <span>Tự động đảo ngược X cho trang Chẵn (Chừa gáy sách)</span>
              <input
                type="checkbox"
                checked={mirrorEvenShiftX}
                onChange={(e) => setMirrorEvenShiftX(e.target.checked)}
                className="accent-[#146C53]"
              />
            </label>

            <span className="text-xs font-bold text-slate-800">2. Dịch chuyển trang CHẴN (2, 4, 6...)</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Dịch Ngang X (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  disabled={mirrorEvenShiftX}
                  value={evenShiftX}
                  onChange={(e) => setEvenShiftX(parseFloat(e.target.value) || 0)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Dịch Dọc Y (mm)</label>
                <input
                  type="number"
                  step="0.5"
                  value={evenShiftY}
                  onChange={(e) => setEvenShiftY(parseFloat(e.target.value) || 0)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
            </div>

            <span className="text-xs font-bold text-slate-800 pt-1">3. Co giãn &amp; Khổ Trim đích</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-slate-500">Tỷ lệ (%)</label>
                <input
                  type="number"
                  min="20"
                  max="300"
                  value={shiftScalePct}
                  onChange={(e) => setShiftScalePct(parseFloat(e.target.value) || 100)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Trim W (mm)</label>
                <input
                  type="number"
                  value={trimFinalWmm}
                  onChange={(e) => setTrimFinalWmm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500">Trim H (mm)</label>
                <input
                  type="number"
                  value={trimFinalHmm}
                  onChange={(e) => setTrimFinalHmm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono"
                />
              </div>
            </div>
          </div>
        )}

        {/* ACTION BUTTONS */}
        <div className="mt-auto pt-3 border-t border-slate-100 flex flex-col gap-2">
          <button
            onClick={() => handleExportOrImpose('apply')}
            disabled={loading || !pdfBytes}
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-40 shadow-xs"
          >
            ✅ Áp dụng lên File đang mở (Làm tiếp công cụ khác)
          </button>
          <button
            onClick={() => handleExportOrImpose('impose')}
            disabled={loading || !pdfBytes}
            className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold cursor-pointer disabled:opacity-40 shadow-xs"
          >
            🚀 Áp dụng &amp; Đưa sang Bình Bài In
          </button>
          <button
            onClick={() => handleExportOrImpose('download')}
            disabled={loading || !pdfBytes}
            className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold cursor-pointer disabled:opacity-40 shadow-xs"
          >
            {loading ? '⏳ Đang xử lý PDF...' : '💾 Tải File PDF Đã Xử Lý'}
          </button>
        </div>
      </aside>
    </>
  );
}
