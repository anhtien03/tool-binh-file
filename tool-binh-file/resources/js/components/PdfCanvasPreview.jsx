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
  autoCropInk = false,
  inspectedPageIndex = null,
  onExitInspectPage,
  currentSheetIndex,
  setCurrentSheetIndex,
  onPagesSynced,
  zoom = 1.0,
  onZoomChange,
}) {
  const [pages, setPages] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ pct: 0, page: 0, total: 0, fileName: '', stage: '' });
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
    const parseSingleFile = async (entry, fileIdx, totalFiles) => {
      const fName = entry.file?.name || 'file.pdf';
      setLoadProgress({
        pct: 8,
        page: 0,
        total: 0,
        fileName: fName,
        stage: `Đang đọc cấu trúc MediaBox / TrimBox & đường bế (${fileIdx}/${totalFiles})...`,
      });
      await new Promise((r) => setTimeout(r, 0));
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
        const pct = Math.min(99, Math.max(12, Math.round((i / pdf.numPages) * 100)));
        setLoadProgress({
          pct,
          page: i,
          total: pdf.numPages,
          fileName: fName,
          stage: `Đang kết xuất trang ${i} / ${pdf.numPages} & nhận diện vùng mực...`,
        });
        await new Promise((r) => setTimeout(r, 0));
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
        for (let idx = 0; idx < missing.length; idx++) {
          if (cancelled) return;
          const entry = missing[idx];
          const parsed = await parseSingleFile(entry, idx + 1, missing.length);
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

  const inspectedPage =
    inspectedPageIndex !== null && inspectedPageIndex >= 0 && inspectedPageIndex < pages.length
      ? pages[inspectedPageIndex]
      : null;

  const sheetDim = inspectedPage
    ? {
        width: Math.max(10, Math.round(inspectedPage.mediaWmm * 10) / 10),
        height: Math.max(10, Math.round(inspectedPage.mediaHmm * 10) / 10),
      }
    : plan?.sheetDim || { width: 420, height: 297 };
  const sheets = plan?.sheets || [];
  const safeIndex = Math.min(currentSheetIndex, Math.max(0, sheets.length - 1));
  const activeSheet = sheets[safeIndex] || null;

  const BASE_WIDTH = !inspectedPage && splitStickerPreview ? 580 : 980;
  const BASE_HEIGHT = !inspectedPage && splitStickerPreview ? 640 : 680;
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

      // Cap backing-store size so 1000% zoom doesn't allocate a 500MB+ canvas and freeze the browser
      const ratio = Math.min(
        window.devicePixelRatio || 2,
        8192 / Math.max(1, canvasWidth),
        8192 / Math.max(1, canvasHeight),
        Math.sqrt(16_000_000 / Math.max(1, canvasWidth * canvasHeight))
      );
      canvas.width = Math.max(1, Math.floor(canvasWidth * ratio));
      canvas.height = Math.max(1, Math.floor(canvasHeight * ratio));

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

      // Single-Page Inspector Mode (when user clicks a page thumbnail in the Left Pages panel)
      if (inspectedPage) {
        if (inspectedPage.img) {
          ctx.drawImage(inspectedPage.img, 0, 0, canvasWidth, canvasHeight);
        }

        // Draw TrimBox / Auto-Crop InkBox overlay
        const useInk = autoCropInk && inspectedPage.inkBox;
        const tLeft = useInk
          ? inspectedPage.inkBox.offsetLeftMm
          : inspectedPage.hasExplicitTrimBox
          ? inspectedPage.trimOffsetLeftMm
          : bleedMm;
        const tTop = useInk
          ? inspectedPage.inkBox.offsetTopMm
          : inspectedPage.hasExplicitTrimBox
          ? inspectedPage.trimOffsetTopMm
          : bleedMm;
        const tW = useInk
          ? inspectedPage.inkBox.trimWmm
          : inspectedPage.hasExplicitTrimBox
          ? inspectedPage.trimWmm
          : Math.max(1, inspectedPage.mediaWmm - 2 * bleedMm);
        const tH = useInk
          ? inspectedPage.inkBox.trimHmm
          : inspectedPage.hasExplicitTrimBox
          ? inspectedPage.trimHmm
          : Math.max(1, inspectedPage.mediaHmm - 2 * bleedMm);

        ctx.save();
        ctx.strokeStyle = useInk ? '#16a34a' : '#2563eb';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(tLeft * scale, tTop * scale, tW * scale, tH * scale);
        ctx.restore();

        // Draw extracted CutContours on this page if present
        if (inspectedPage.extractedContours && inspectedPage.extractedContours.length > 0) {
          ctx.save();
          ctx.strokeStyle = '#e11d48';
          ctx.lineWidth = 1.6;
          for (const c of inspectedPage.extractedContours) {
            if (!c.ptsMm || c.ptsMm.length < 2) continue;
            ctx.beginPath();
            c.ptsMm.forEach(([mx, my], idx) => {
              if (idx === 0) ctx.moveTo(mx * scale, my * scale);
              else ctx.lineTo(mx * scale, my * scale);
            });
            if (c.closed) ctx.closePath();
            ctx.stroke();
          }
          ctx.restore();
        }

        // Draw mm ruler ticks along top and left borders
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.lineWidth = 0.8;
        ctx.font = '9px monospace';
        const stepMm = sheetDim.width <= 160 ? 10 : 20;
        for (let mm = 0; mm <= sheetDim.width; mm += stepMm / 2) {
          const px = mm * scale;
          const isMajor = mm % stepMm === 0;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, isMajor ? 7 : 4);
          ctx.stroke();
          if (isMajor && mm > 0 && px < canvasWidth - 16) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(`${mm}`, px, 7.5);
          }
        }
        for (let mm = 0; mm <= sheetDim.height; mm += stepMm / 2) {
          const py = mm * scale;
          const isMajor = mm % stepMm === 0;
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(isMajor ? 7 : 4, py);
          ctx.stroke();
          if (isMajor && mm > 0 && py < canvasHeight - 12) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${mm}`, 8, py);
          }
        }
        ctx.restore();
        return;
      }

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

    if (!inspectedPage && splitStickerPreview) {
      drawSheetToCanvas(canvasRef.current, 'printOnly');
      drawSheetToCanvas(cutCanvasRef.current, 'cutOnly');
    } else {
      drawSheetToCanvas(canvasRef.current, 'all');
    }
  }, [activeSheet, pages, sheetDim, margins, bleedMm, showBleedOverlay, showSafeArea, safeInsetMm, splitStickerPreview, autoCropInk, inspectedPage, canvasWidth, canvasHeight]);

  // 3. Direct Mouse Wheel Zoom (no Ctrl required — smooth zoom up to 1000% on wheel over canvas)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !onZoomChange) return;

    // Coalesce wheel ticks into 1 zoom update per animation frame
    let pendingTicks = 0;
    let rafId = 0;
    const handleWheel = (e) => {
      e.preventDefault();
      pendingTicks += e.deltaY < 0 ? 1 : -1;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        const ticks = Math.max(-3, Math.min(3, pendingTicks));
        pendingTicks = 0;
        rafId = 0;
        if (!ticks) return;
        onZoomChange((prev) => {
          let z = prev;
          for (let i = 0; i < Math.abs(ticks); i++) {
            const step = z >= 2.5 ? 0.35 : z >= 1.5 ? 0.22 : 0.15;
            z += ticks > 0 ? step : -step;
          }
          return Math.round(Math.min(10.0, Math.max(0.35, z)) * 100) / 100;
        });
      });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
      if (rafId) cancelAnimationFrame(rafId);
    };
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
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 flex flex-col items-center gap-3.5 text-center">
            <div className="relative w-14 h-14 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-4 border-emerald-100" />
              <div className="absolute inset-0 rounded-full border-4 border-[#146C53] border-t-transparent animate-spin" />
              <span className="text-xs font-extrabold font-mono text-[#146C53]">{loadProgress.pct}%</span>
            </div>
            <div className="flex flex-col gap-1 w-full">
              <div className="text-sm font-extrabold text-slate-900 truncate px-2">
                📂 Đang tải: {loadProgress.fileName || 'File PDF'}
              </div>
              <div className="text-xs font-medium text-slate-500">
                {loadProgress.stage || 'Đang phân tích TrimBox/Bleed & trích xuất trang PDF...'}
              </div>
            </div>
            <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
              <div
                className="h-full bg-gradient-to-r from-[#146C53] to-emerald-400 transition-all duration-150 rounded-full"
                style={{ width: `${Math.max(6, loadProgress.pct)}%` }}
              />
            </div>
            {loadProgress.total > 0 && (
              <div className="text-[11px] font-mono font-bold text-[#146C53]">
                Tiến độ: {loadProgress.page} / {loadProgress.total} trang ({loadProgress.pct}%)
              </div>
            )}
          </div>
        </div>
      )}

      {inspectedPage && (
        <div className="w-full mb-2.5 px-3.5 py-2 rounded-xl bg-[#112A24] text-white flex flex-wrap items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold">
              ĐANG XEM TRANG GỐC #{inspectedPageIndex + 1} / {pages.length}
            </span>
            <span className="font-semibold truncate max-w-[240px]">{inspectedPage.fileName}</span>
            <span className="font-mono text-emerald-200 text-[11px]">
              · Khổ trang: {inspectedPage.mediaWmm.toFixed(1)}×{inspectedPage.mediaHmm.toFixed(1)}mm
              {autoCropInk && inspectedPage.inkBox
                ? ` → Vùng mực: ${inspectedPage.inkBox.trimWmm.toFixed(1)}×${inspectedPage.inkBox.trimHmm.toFixed(1)}mm`
                : inspectedPage.hasExplicitTrimBox
                ? ` → Thành phẩm: ${inspectedPage.trimWmm.toFixed(1)}×${inspectedPage.trimHmm.toFixed(1)}mm`
                : ''}
            </span>
          </div>
          {onExitInspectPage && (
            <button
              onClick={onExitInspectPage}
              className="px-3 py-1 rounded-lg bg-[#146C53] hover:bg-emerald-600 text-white text-xs font-bold cursor-pointer"
            >
              ← Quay lại Xem Tờ Bình
            </button>
          )}
        </div>
      )}

      <div
        ref={viewportRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopPanning}
        onMouseLeave={stopPanning}
        title="Cuộn chuột để Phóng to / Thu nhỏ (tối đa 1000%) · Kéo chuột trái để di chuyển"
        className={`p-3 rounded-2xl border border-slate-200 w-full overflow-auto h-[calc(100vh-195px)] min-h-[600px] select-none flex ${
          isPanning ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundColor: '#fafbf9',
          backgroundImage:
            'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        {!inspectedPage && splitStickerPreview ? (
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
