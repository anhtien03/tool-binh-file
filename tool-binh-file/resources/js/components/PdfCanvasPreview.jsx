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
  splitStickerPreview = false,
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
  const cutCanvasRef = useRef(null);
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

        // Detect tight Ink Bounding Box (Auto-Crop whitespace around artwork)
        let inkBox = null;
        try {
          const ctx2d = offscreen.getContext('2d');
          const cw = offscreen.width;
          const ch = offscreen.height;
          const imgData = ctx2d.getImageData(0, 0, cw, ch).data;
          let minX = cw, minY = ch, maxX = -1, maxY = -1;
          for (let py = 0; py < ch; py += 2) {
            for (let px = 0; px < cw; px += 2) {
              const idx = (py * cw + px) * 4;
              const r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2], a = imgData[idx + 3];
              if (a > 25 && (r < 244 || g < 244 || b < 244)) {
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px > maxX) maxX = px;
                if (py > maxY) maxY = py;
              }
            }
          }
          if (maxX > minX && maxY > minY) {
            const pxToMmX = meta.mediaWmm / Math.max(1, cw);
            const pxToMmY = meta.mediaHmm / Math.max(1, ch);
            const padMm = 1.0;
            const leftMm = Math.max(0, minX * pxToMmX - padMm);
            const topMm = Math.max(0, minY * pxToMmY - padMm);
            const rightMm = Math.min(meta.mediaWmm, (maxX + 2) * pxToMmX + padMm);
            const bottomEdgeMm = Math.min(meta.mediaHmm, (maxY + 2) * pxToMmY + padMm);
            const trimWmm = Math.round(Math.max(2, rightMm - leftMm) * 100) / 100;
            const trimHmm = Math.round(Math.max(2, bottomEdgeMm - topMm) * 100) / 100;
            inkBox = {
              trimWmm,
              trimHmm,
              offsetLeftMm: Math.round(leftMm * 100) / 100,
              offsetTopMm: Math.round(topMm * 100) / 100,
              offsetBottomMm: Math.round(Math.max(0, meta.mediaHmm - bottomEdgeMm) * 100) / 100,
            };
          }
        } catch {
          // ignore ink detection error
        }

        renderedPages.push({
          img,
          dataUrl,
          width: rawVp.width,
          height: rawVp.height,
          fileId: entry.id,
          fileName: entry.file.name,
          localPageNumber: i,
          inkBox,
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

  const BASE_WIDTH = splitStickerPreview ? 460 : 780;
  const BASE_HEIGHT = splitStickerPreview ? 500 : 560;
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

  // 2. Render active SheetPlan onto Canvas (supports single combined or split Print + Cut)
  useEffect(() => {
    const drawSheetToCanvas = (canvas, layerFilter) => {
      if (!canvas) return;

      const ratio = window.devicePixelRatio || 2;
      canvas.width = canvasWidth * ratio;
      canvas.height = canvasHeight * ratio;

      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      const scale = canvasWidth / sheetDim.width;

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
        ctx.font = '14px Inter, system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Tải lên file PDF để xem sơ đồ bình bài thời gian thực', canvasWidth / 2, canvasHeight / 2);
        return;
      }

      // Draw artwork placements (unless cutOnly)
      if (layerFilter !== 'cutOnly') {
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

          const declaredB = Math.max(0, Number(bleedMm) || 0);
          const customBox = p.srcTrimBoxMm;
          const srcTrimW = customBox
            ? customBox.trimW
            : pageInfo.hasExplicitTrimBox
            ? pageInfo.trimWmm
            : Math.max(1, pageInfo.mediaWmm - 2 * declaredB);
          const srcTrimH = customBox
            ? customBox.trimH
            : pageInfo.hasExplicitTrimBox
            ? pageInfo.trimHmm
            : Math.max(1, pageInfo.mediaHmm - 2 * declaredB);
          const offLeft = customBox
            ? customBox.offsetLeft
            : pageInfo.hasExplicitTrimBox
            ? pageInfo.trimOffsetLeftMm
            : declaredB;
          const offTop = customBox
            ? customBox.offsetTop
            : pageInfo.hasExplicitTrimBox
            ? pageInfo.trimOffsetTopMm
            : declaredB;

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

          ctx.translate(xPx + wPx / 2, yPx + hPx / 2);
          ctx.rotate((-rot * Math.PI) / 180);
          ctx.drawImage(pageInfo.img, -trimCenterXInMedia, -trimCenterYInMedia, fullDrawW, fullDrawH);
          ctx.restore();

          if (layerFilter === 'all') {
            ctx.strokeStyle = p.block === 'secondary' ? 'rgba(245, 158, 11, 0.85)' : 'rgba(100, 116, 139, 0.6)';
            ctx.lineWidth = 0.85;
            ctx.strokeRect(xPx, yPx, wPx, hPx);

            if (showBleedOverlay && (p.clipBleed.left > 0 || p.clipBleed.right > 0 || p.clipBleed.top > 0 || p.clipBleed.bottom > 0)) {
              ctx.save();
              ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
              ctx.lineWidth = 0.8;
              ctx.setLineDash([3, 2]);
              ctx.strokeRect(clipX, clipY, clipW, clipH);
              ctx.restore();
            }

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
        }
      }

      // Draw Crop Marks & Registration Targets
      for (const line of activeSheet.marks.lines) {
        ctx.strokeStyle = line.kind === 'bleed' ? '#0ea5e9' : '#0f172a';
        ctx.lineWidth = line.kind === 'bleed' ? 0.75 : 1.0;
        ctx.beginPath();
        ctx.moveTo(line.x1 * scale, line.y1 * scale);
        ctx.lineTo(line.x2 * scale, line.y2 * scale);
        ctx.stroke();
      }

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

      // Always draw 4 Pont Marks on both Print and Cut sheets
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

      // Draw Sticker CutContour Paths (unless printOnly)
      if (layerFilter !== 'printOnly' && activeSheet.stickerCutPaths && activeSheet.stickerCutPaths.length > 0) {
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

      if (activeSheet.slugText) {
        ctx.fillStyle = '#334155';
        ctx.font = `${Math.max(8, Math.round(2.4 * scale))}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(activeSheet.slugText, 6 * scale, canvasHeight - 2 * scale);
      }

      // Draw mm ruler ticks along top and left borders (0, 20, 40, 60, 80, 100... mm)
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.lineWidth = 0.75;
      ctx.font = '9px monospace';
      for (let mm = 0; mm <= sheetDim.width; mm += 10) {
        const px = mm * scale;
        const isMajor = mm % 20 === 0;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, isMajor ? 6 : 3.5);
        ctx.stroke();
        if (isMajor && mm > 0 && px < canvasWidth - 18) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(`${mm}`, px, 6.5);
        }
      }
      for (let mm = 0; mm <= sheetDim.height; mm += 10) {
        const py = mm * scale;
        const isMajor = mm % 20 === 0;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(isMajor ? 6 : 3.5, py);
        ctx.stroke();
        if (isMajor && mm > 0 && py < canvasHeight - 12) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${mm}`, 7.5, py);
        }
      }
      ctx.restore();
    };

    if (splitStickerPreview) {
      drawSheetToCanvas(canvasRef.current, 'printOnly');
      drawSheetToCanvas(cutCanvasRef.current, 'cutOnly');
    } else {
      drawSheetToCanvas(canvasRef.current, 'all');
    }
  }, [activeSheet, pages, sheetDim, margins, bleedMm, showBleedOverlay, showSafeArea, safeInsetMm, splitStickerPreview, canvasWidth, canvasHeight]);

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
        {splitStickerPreview ? (
          <div className="flex flex-wrap xl:flex-nowrap items-start justify-center gap-5 m-auto w-fit">
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <span className="px-2.5 py-0.5 rounded-full bg-[#146C53] text-white text-[11px] font-bold">
                🖨️ BÀI IN (PRINT)
              </span>
              <canvas
                ref={canvasRef}
                className="shadow-lg bg-white rounded border border-slate-300 block"
                style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
              />
            </div>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <span className="px-2.5 py-0.5 rounded-full bg-rose-600 text-white text-[11px] font-bold">
                ✂️ KHUÔN BẾ (CUT)
              </span>
              <canvas
                ref={cutCanvasRef}
                className="shadow-lg bg-white rounded border border-slate-300 block"
                style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
              />
            </div>
          </div>
        ) : (
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
        )}
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
