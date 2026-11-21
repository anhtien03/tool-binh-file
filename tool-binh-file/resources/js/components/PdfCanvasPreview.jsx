import React, { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { MM_TO_PT, PAPER_SIZES } from '../engine/impositionEngine';
import { extractCutContoursFromPdfPage } from '../engine/pdfCutContourExtractor';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export { PAPER_SIZES };

export default function PdfCanvasPreview({
  sourceFiles = [],
  plan,
  margins,
  bleedMm = 0,
  showBleedOverlay = true,
  showSafeArea = true,
  safeInsetMm = 3,
  currentSheetIndex,
  setCurrentSheetIndex,
  onPagesSynced,
  zoom = 1.0,
  onZoomChange,
}) {
  const [pages, setPages] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const panStateRef = useRef({ active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });
  const fileCacheRef = useRef(new Map()); // id -> parsed pages array

  // 1. Parse any newly added PDFs (cached by file id) and flatten into global pagesMeta
  useEffect(() => {
    if (!sourceFiles || sourceFiles.length === 0) {
      setPages([]);
      if (onPagesSynced) onPagesSynced([], []);
      return;
    }

    let cancelled = false;
    const parseSingleFile = async (entry) => {
      const buffer = await entry.file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      const boxesMeta = [];
      try {
        const pdfDoc = await PDFDocument.load(bytes);
        pdfDoc.getPages().forEach((p) => {
          const mb = p.getMediaBox();
          let tb = mb;
          let hasExplicitTrimBox = false;
          try {
            const t = p.getTrimBox();
            if (
              t &&
              t.width > 0 &&
              t.height > 0 &&
              (Math.abs(t.width - mb.width) > 0.5 || Math.abs(t.height - mb.height) > 0.5)
            ) {
              tb = t;
              hasExplicitTrimBox = true;
            }
          } catch {
            // ignore
          }
          boxesMeta.push({
            mediaWmm: mb.width / MM_TO_PT,
            mediaHmm: mb.height / MM_TO_PT,
            trimWmm: tb.width / MM_TO_PT,
            trimHmm: tb.height / MM_TO_PT,
            trimOffsetLeftMm: (tb.x - mb.x) / MM_TO_PT,
            trimOffsetBottomMm: (tb.y - mb.y) / MM_TO_PT,
            trimOffsetTopMm: (mb.y + mb.height - (tb.y + tb.height)) / MM_TO_PT,
            hasExplicitTrimBox,
            extractedContours: extractCutContoursFromPdfPage(pdfDoc, p),
          });
        });
      } catch (err) {
        console.warn('Could not read PDF boxes via pdf-lib:', err);
      }

      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
      const pdf = await loadingTask.promise;
      const renderedPages = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return [];
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.25 });
        const offscreen = document.createElement('canvas');
        offscreen.width = viewport.width;
        offscreen.height = viewport.height;
        await page.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;

        const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve) => {
          if (img.complete) resolve();
          else {
            img.onload = resolve;
            img.onerror = resolve;
          }
        });

        const rawVp = page.getViewport({ scale: 1.0 });
        const meta = boxesMeta[i - 1] || {
          mediaWmm: rawVp.width / MM_TO_PT,
          mediaHmm: rawVp.height / MM_TO_PT,
          trimWmm: rawVp.width / MM_TO_PT,
          trimHmm: rawVp.height / MM_TO_PT,
          trimOffsetLeftMm: 0,
          trimOffsetBottomMm: 0,
          trimOffsetTopMm: 0,
          hasExplicitTrimBox: false,
        };

        renderedPages.push({
          img,
          dataUrl,
          width: rawVp.width,
          height: rawVp.height,
          fileId: entry.id,
          fileName: entry.file.name,
          localPageNumber: i,
          ...meta,
        });
      }
      return renderedPages;
    };

    const syncAll = async () => {
      const missing = sourceFiles.filter((f) => !fileCacheRef.current.has(f.id));
      if (missing.length > 0) setPdfLoading(true);
      try {
        for (const entry of missing) {
          if (cancelled) return;
          const parsed = await parseSingleFile(entry);
          if (!cancelled) fileCacheRef.current.set(entry.id, parsed);
        }

        if (cancelled) return;
        // Clean stale cache entries
        const activeIds = new Set(sourceFiles.map((f) => f.id));
        for (const k of fileCacheRef.current.keys()) {
          if (!activeIds.has(k)) fileCacheRef.current.delete(k);
        }

        const flatPages = [];
        const fileGroups = [];
        for (const entry of sourceFiles) {
          const fPages = fileCacheRef.current.get(entry.id) || [];
          const startGlobalIdx = flatPages.length;
          fPages.forEach((p, idx) => {
            flatPages.push({ ...p, globalPageIndex: startGlobalIdx + idx });
          });
          fileGroups.push({
            fileId: entry.id,
            fileName: entry.file.name,
            startGlobalIdx,
            pageCount: fPages.length,
          });
        }

        setPages(flatPages);
        if (onPagesSynced) onPagesSynced(flatPages, fileGroups);
      } catch (err) {
        console.error('Lỗi phân tích PDF:', err);
      } finally {
        if (!cancelled) setPdfLoading(false);
      }
    };

    syncAll();
    return () => {
      cancelled = true;
    };
  }, [sourceFiles]);

  const sheetDim = plan?.sheetDim || { width: 420, height: 297 };
  const sheets = plan?.sheets || [];
  const safeIndex = Math.min(currentSheetIndex, Math.max(0, sheets.length - 1));
  const activeSheet = sheets[safeIndex] || null;

  const BASE_WIDTH = 780;
  const BASE_HEIGHT = 560;
  const previewAspect = sheetDim.width / Math.max(1, sheetDim.height);
  const containerAspect = BASE_WIDTH / BASE_HEIGHT;

  let baseWidth = BASE_WIDTH;
  let baseHeight = BASE_HEIGHT;
  if (previewAspect > containerAspect) {
    baseWidth = BASE_WIDTH;
    baseHeight = Math.round(BASE_WIDTH / previewAspect);
  } else {
    baseHeight = BASE_HEIGHT;
    baseWidth = Math.round(BASE_HEIGHT * previewAspect);
  }

  const canvasWidth = Math.round(baseWidth * zoom);
  const canvasHeight = Math.round(baseHeight * zoom);

  // 2. Render active SheetPlan directly onto Canvas (100% synced with pdfExporter)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ratio = window.devicePixelRatio || 2;
    canvas.width = canvasWidth * ratio;
    canvas.height = canvasHeight * ratio;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const scale = canvasWidth / sheetDim.width; // px per mm

    // Sheet paper background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, canvasWidth, canvasHeight);

    // Margins dashed boundary
    const mL = Number(margins?.left) || 0;
    const mR = Number(margins?.right) || 0;
    const mT = Number(margins?.top) || 0;
    const mB = Number(margins?.bottom) || 0;
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(mL * scale, mT * scale, (sheetDim.width - mL - mR) * scale, (sheetDim.height - mT - mB) * scale);
    ctx.setLineDash([]);

    if (!activeSheet || pages.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '15px Inter, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Tải lên file PDF để xem sơ đồ bình bài thời gian thực', canvasWidth / 2, canvasHeight / 2);
      return;
    }

    // Draw each placement with Smart Bleed Clipping
    for (const p of activeSheet.placements) {
      const pageInfo = pages[p.pageIndex];
      if (!pageInfo || !pageInfo.img) continue;

      const xPx = p.x * scale;
      const yPx = p.y * scale;
      const wPx = p.trimW * scale;
      const hPx = p.trimH * scale;

      const clipX = (p.x - p.clipBleed.left) * scale;
      const clipY = (p.y - p.clipBleed.top) * scale;
      const clipW = (p.trimW + p.clipBleed.left + p.clipBleed.right) * scale;
      const clipH = (p.trimH + p.clipBleed.top + p.clipBleed.bottom) * scale;

      // Source image full MediaBox geometry relative to its TrimBox
      const declaredB = Math.max(0, Number(bleedMm) || 0);
      const srcTrimW = pageInfo.hasExplicitTrimBox ? pageInfo.trimWmm : Math.max(1, pageInfo.mediaWmm - 2 * declaredB);
      const srcTrimH = pageInfo.hasExplicitTrimBox ? pageInfo.trimHmm : Math.max(1, pageInfo.mediaHmm - 2 * declaredB);
      const offLeft = pageInfo.hasExplicitTrimBox ? pageInfo.trimOffsetLeftMm : declaredB;
      const offTop = pageInfo.hasExplicitTrimBox ? pageInfo.trimOffsetTopMm : declaredB;

      const rot = ((p.rotate % 360) + 360) % 360;
      const isRot90 = rot === 90 || rot === 270;
      const unrotTrimW = isRot90 ? p.trimH : p.trimW;
      const unrotTrimH = isRot90 ? p.trimW : p.trimH;
      const sx = unrotTrimW / Math.max(0.01, srcTrimW);
      const sy = unrotTrimH / Math.max(0.01, srcTrimH);

      const fullDrawW = pageInfo.mediaWmm * sx * scale;
      const fullDrawH = pageInfo.mediaHmm * sy * scale;
      const trimCenterXInMedia = (offLeft + srcTrimW / 2) * sx * scale;
      const trimCenterYInMedia = (offTop + srcTrimH / 2) * sy * scale;

      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();

      // Transform around TrimBox center; note Canvas clockwise = -PDF CCW
      ctx.translate(xPx + wPx / 2, yPx + hPx / 2);
      ctx.rotate((-rot * Math.PI) / 180);
      ctx.drawImage(pageInfo.img, -trimCenterXInMedia, -trimCenterYInMedia, fullDrawW, fullDrawH);
      ctx.restore();

      // TrimBox border
      ctx.strokeStyle = p.block === 'secondary' ? 'rgba(245, 158, 11, 0.85)' : 'rgba(100, 116, 139, 0.6)';
      ctx.lineWidth = 0.85;
      ctx.strokeRect(xPx, yPx, wPx, hPx);

      // Optional Red Dashed Bleed Overlay (like PrynX 👁 toggle)
      if (showBleedOverlay && (p.clipBleed.left > 0 || p.clipBleed.right > 0 || p.clipBleed.top > 0 || p.clipBleed.bottom > 0)) {
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(clipX, clipY, clipW, clipH);
        ctx.restore();
      }

      // Optional Green Dashed Safe Area Overlay (inset from TrimBox)
      const safeMm = Math.max(0, Number(safeInsetMm) || 0);
      if (showSafeArea && safeMm > 0 && p.trimW > 2 * safeMm && p.trimH > 2 * safeMm) {
        const sPx = safeMm * scale;
        ctx.save();
        ctx.strokeStyle = 'rgba(20, 108, 83, 0.85)';
        ctx.lineWidth = 0.85;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(xPx + sPx, yPx + sPx, wPx - 2 * sPx, hPx - 2 * sPx);
        ctx.restore();
      }

      // Page number & orientation badge
      const badgeRadius = Math.max(9, Math.min(13, Math.min(wPx, hPx) * 0.22));
      ctx.fillStyle = p.block === 'secondary' ? 'rgba(180, 83, 9, 0.82)' : 'rgba(15, 23, 42, 0.75)';
      ctx.beginPath();
      ctx.arc(xPx + wPx / 2, yPx + hPx / 2, badgeRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(badgeRadius * 0.9)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const arrow = rot === 0 ? '↑' : rot === 90 ? '←' : rot === 180 ? '↓' : '→';
      ctx.fillText(`${p.pageIndex + 1}${arrow}`, xPx + wPx / 2, yPx + hPx / 2);
    }

    // Draw Crop Marks (Western / Tonbo) — single scale multiplication!
    for (const line of activeSheet.marks.lines) {
      ctx.strokeStyle = line.kind === 'bleed' ? '#0ea5e9' : '#0f172a';
      ctx.lineWidth = line.kind === 'bleed' ? 0.75 : 1.0;
      ctx.beginPath();
      ctx.moveTo(line.x1 * scale, line.y1 * scale);
      ctx.lineTo(line.x2 * scale, line.y2 * scale);
      ctx.stroke();
    }

    // Draw Registration Targets (Ốc chồng màu)
    for (const reg of activeSheet.marks.registrations) {
      const cx = reg.cx * scale;
      const cy = reg.cy * scale;
      const r = reg.radius * scale;
      const half = (reg.crossLen / 2) * scale;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx - half, cy);
      ctx.lineTo(cx + half, cy);
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx, cy + half);
      ctx.stroke();
    }

    // Draw Optical Registration Marks (Boong máy bế decal)
    for (const pm of activeSheet.pontMarks || []) {
      const cx = pm.cx * scale;
      const cy = pm.cy * scale;
      const r = (pm.size / 2) * scale;
      ctx.save();
      if (pm.type === 'circle5mm') {
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (pm.type === 'circleHollow') {
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (pm.type === 'graphtec') {
        const arm = 10 * scale;
        const sx = pm.corner.includes('L') ? 1 : -1;
        const sy = pm.corner.includes('T') ? 1 : -1;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(cx + sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * arm);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draw Sticker CutContour Paths (Magenta)
    if (activeSheet.stickerCutPaths && activeSheet.stickerCutPaths.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 1.25;
      for (const cp of activeSheet.stickerCutPaths) {
        ctx.beginPath();
        if (cp.kind === 'line') {
          ctx.moveTo(cp.x1 * scale, cp.y1 * scale);
          ctx.lineTo(cp.x2 * scale, cp.y2 * scale);
        } else if (cp.kind === 'poly') {
          if (cp.pts && cp.pts.length >= 2) {
            cp.pts.forEach(([px, py], idx) => {
              if (idx === 0) ctx.moveTo(px * scale, py * scale);
              else ctx.lineTo(px * scale, py * scale);
            });
            if (cp.closed) ctx.closePath();
          }
        } else if (cp.kind === 'ellipse') {
          ctx.ellipse(cp.cx * scale, cp.cy * scale, cp.rx * scale, cp.ry * scale, 0, 0, Math.PI * 2);
        } else if (cp.kind === 'rect') {
          const rx = cp.x * scale, ry = cp.y * scale, rw = cp.w * scale, rh = cp.h * scale;
          const rad = Math.min((cp.r || 0) * scale, rw / 2, rh / 2);
          if (rad > 0 && ctx.roundRect) {
            ctx.roundRect(rx, ry, rw, rh, rad);
          } else {
            ctx.rect(rx, ry, rw, rh);
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draw Slug Line
    if (activeSheet.slugText) {
      ctx.fillStyle = '#334155';
      ctx.font = `${Math.max(8, Math.round(2.4 * scale))}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(activeSheet.slugText, 6 * scale, canvasHeight - 2 * scale);
    }
  }, [activeSheet, pages, sheetDim, margins, bleedMm, showBleedOverlay, showSafeArea, safeInsetMm, canvasWidth, canvasHeight]);

  // 3. Ctrl + Wheel Zoom (non-passive so browser page zoom is prevented)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !onZoomChange) return;

    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.15 : -0.15;
        onZoomChange((prev) => Math.round(Math.min(4.0, Math.max(0.4, prev + delta)) * 100) / 100);
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [onZoomChange]);

  // 4. Left-click Drag to Pan
  const handleMouseDown = (e) => {
    if (e.button !== 0 || !viewportRef.current) return;
    panStateRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: viewportRef.current.scrollLeft,
      scrollTop: viewportRef.current.scrollTop,
    };
    setIsPanning(true);
  };

  const handleMouseMove = (e) => {
    if (!panStateRef.current.active || !viewportRef.current) return;
    const dx = e.clientX - panStateRef.current.startX;
    const dy = e.clientY - panStateRef.current.startY;
    viewportRef.current.scrollLeft = panStateRef.current.scrollLeft - dx;
    viewportRef.current.scrollTop = panStateRef.current.scrollTop - dy;
  };

  const stopPanning = () => {
    if (panStateRef.current.active) {
      panStateRef.current.active = false;
      setIsPanning(false);
    }
  };

  return (
    <div className="flex flex-col items-center w-full relative">
      {pdfLoading && (
        <div className="flex items-center gap-2 text-[#146C53] mb-3 animate-pulse">
          <span className="text-xs font-semibold">Đang phân tích TrimBox/Bleed &amp; trích xuất trang PDF...</span>
        </div>
      )}

      <div
        ref={viewportRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopPanning}
        onMouseLeave={stopPanning}
        title="Giữ Ctrl + cuộn chuột để Zoom · Kéo chuột trái để di chuyển tờ in"
        className={`p-6 rounded-2xl border border-slate-200 w-full overflow-auto h-[540px] select-none ${
          isPanning ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundColor: '#fafbf9',
          backgroundImage:
            'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div
          className="m-auto shrink-0"
          style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
        >
          <canvas
            ref={canvasRef}
            className="shadow-lg bg-white rounded border border-slate-300 block"
            style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 mt-2.5 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-dashed border-red-500 inline-block" /> Bleed (Tràn lề)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-slate-500 inline-block" /> Đường cắt thành phẩm (Trim)
        </span>
        {showSafeArea && (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t border-dashed border-[#146C53] inline-block" /> Vùng an toàn ({safeInsetMm}mm)
          </span>
        )}
        <span className="text-slate-400">· Ctrl+Cuộn: Zoom · Kéo chuột trái: Di chuyển</span>
      </div>

      {sheets.length > 0 && (
        <div className="flex items-center gap-4 mt-4 bg-white px-5 py-2 rounded-full border border-slate-200 shadow-xs">
          <button
            onClick={() => setCurrentSheetIndex(Math.max(0, safeIndex - 1))}
            disabled={safeIndex === 0}
            className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded-full text-xs font-semibold text-slate-700 disabled:opacity-30 cursor-pointer"
          >
            ◀ Tờ trước
          </button>
          <div className="text-xs font-bold text-slate-800 text-center min-w-[160px]">
            Tờ {activeSheet.physicalSheet} / {plan.summary.physicalSheets || sheets.length}
            <span className="text-[11px] font-semibold text-[#146C53] block">
              {activeSheet.side === 'Front'
                ? 'Mặt trước (Front)'
                : activeSheet.side === 'Back'
                ? 'Mặt sau (Back — Đã lật gương)'
                : '1 Mặt (Simplex)'}{' '}
              · {activeSheet.placements.length} con
            </span>
          </div>
          <button
            onClick={() => setCurrentSheetIndex(Math.min(sheets.length - 1, safeIndex + 1))}
            disabled={safeIndex >= sheets.length - 1}
            className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded-full text-xs font-semibold text-slate-700 disabled:opacity-30 cursor-pointer"
          >
            Tờ sau ▶
          </button>
        </div>
      )}
    </div>
  );
}
