import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { MM_TO_PT, PAPER_SIZES } from '../engine/impositionEngine';
import { extractCutContoursFromPdfPage } from '../engine/pdfCutContourExtractor';
import {
  PAIR_VIEW_MODES,
  PARITY_STATUS,
  computeSyncedScrollPosition,
  computeSyncedZoom,
  analyzeArtworkCutOverlay,
} from '../engine/pairPreviewEngine';
import { useDragPan } from '../hooks/useDragPan';
import { PrepressRulerBar } from './PrintKitUI';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export { PAPER_SIZES };

export default function PdfCanvasPreview({
  sourceFiles = [],
  plan,
  margins,
  bleedMm = 0,
  showBleedOverlay = true,
  showSafeArea = true,
  showRulers = true,
  safeInsetMm = 3,
  splitStickerPreview = false,
  pairViewMode = null,
  overlayArtworkOpacity = 0.72,
  overlayCutColor = '#e11d48',
  overlayCutStrokePx = 1.8,
  overlayShowBleed = true,
  parityCheck = null,
  requireSpotCutContour = true,
  autoCropInk = false,
  inspectedPageIndex = null,
  onExitInspectPage,
  currentSheetIndex,
  setCurrentSheetIndex,
  onPagesSynced,
  zoom = 1.0,
  onZoomChange,
  v1ArtworkInfo = null,
  v1ArtworkPages = null,
}) {
  const effectiveViewMode =
    pairViewMode || (splitStickerPreview ? PAIR_VIEW_MODES.SIDE_BY_SIDE : PAIR_VIEW_MODES.SINGLE);
  const isSideBySide = !inspectedPageIndex && inspectedPageIndex !== 0 && effectiveViewMode === PAIR_VIEW_MODES.SIDE_BY_SIDE;
  const isOverlayMode = !inspectedPageIndex && inspectedPageIndex !== 0 && effectiveViewMode === PAIR_VIEW_MODES.OVERLAY;

  const [pages, setPages] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ pct: 0, page: 0, total: 0, fileName: '', stage: '' });
  const [cursorMm, setCursorMm] = useState(null);
  const [vpBox, setVpBox] = useState({ w: 680, h: 540 });
  const [rulerOrigin, setRulerOrigin] = useState({ x: 40, y: 40 });
  const canvasRef = useRef(null);
  const paperBoxRef = useRef(null);
  const cutCanvasRef = useRef(null);
  const viewportRef = useRef(null);
  const printPaneRef = useRef(null);
  const cutPaneRef = useRef(null);
  const syncingPaneRef = useRef(null);
  const { isPanning, onMouseDown: handleMouseDown } = useDragPan(viewportRef);
  const { isPanning: isPrintPanning, onMouseDown: handlePrintMouseDown } = useDragPan(printPaneRef);
  const { isPanning: isCutPanning, onMouseDown: handleCutMouseDown } = useDragPan(cutPaneRef);
  const cursorRafRef = useRef(0);
  const scrollRafRef = useRef(0);
  const fileCacheRef = useRef(new Map()); // id -> parsed pages array

  // Synchronized scroll handler between PRINT (left) and CUT (right) panes
  const syncPaneScroll = useCallback((sourceKey) => {
    if (syncingPaneRef.current && syncingPaneRef.current !== sourceKey) return;
    const src = sourceKey === 'print' ? printPaneRef.current : cutPaneRef.current;
    const dst = sourceKey === 'print' ? cutPaneRef.current : printPaneRef.current;
    if (!src || !dst) return;
    syncingPaneRef.current = sourceKey;
    const synced = computeSyncedScrollPosition({
      sourceScrollLeft: src.scrollLeft,
      sourceScrollTop: src.scrollTop,
      sourceMaxX: Math.max(0, src.scrollWidth - src.clientWidth),
      sourceMaxY: Math.max(0, src.scrollHeight - src.clientHeight),
      targetMaxX: Math.max(0, dst.scrollWidth - dst.clientWidth),
      targetMaxY: Math.max(0, dst.scrollHeight - dst.clientHeight),
    });
    if (Math.abs(dst.scrollLeft - synced.scrollLeft) > 1) dst.scrollLeft = synced.scrollLeft;
    if (Math.abs(dst.scrollTop - synced.scrollTop) > 1) dst.scrollTop = synced.scrollTop;
    requestAnimationFrame(() => {
      if (syncingPaneRef.current === sourceKey) syncingPaneRef.current = null;
    });
  }, []);

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
        const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        pdfDoc.getPages().forEach((p) => {
          const rawMb = p.getMediaBox();
          let mb = rawMb;
          try {
            const cb = p.getCropBox();
            if (cb && cb.width > 0 && cb.height > 0 && (cb.width < rawMb.width - 0.5 || cb.height < rawMb.height - 0.5)) {
              mb = cb;
            }
          } catch {
            // fallback to MediaBox
          }
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
          const pageRot = ((p.getRotation()?.angle || 0) % 360 + 360) % 360;
          const swapWH = pageRot === 90 || pageRot === 270;
          const mW = swapWH ? mb.height : mb.width;
          const mH = swapWH ? mb.width : mb.height;
          const tW = swapWH ? tb.height : tb.width;
          const tH = swapWH ? tb.width : tb.height;
          const offL = (tb.x - mb.x) / MM_TO_PT;
          const offB = (tb.y - mb.y) / MM_TO_PT;
          const offT = (mb.y + mb.height - (tb.y + tb.height)) / MM_TO_PT;
          const offR = (mb.x + mb.width - (tb.x + tb.width)) / MM_TO_PT;

          let rotOffL = offL;
          let rotOffT = offT;
          let rotOffB = offB;
          if (pageRot === 90) {
            rotOffL = offT;
            rotOffT = offR;
            rotOffB = offL;
          } else if (pageRot === 180) {
            rotOffL = offR;
            rotOffT = offB;
            rotOffB = offT;
          } else if (pageRot === 270) {
            rotOffL = offB;
            rotOffT = offL;
            rotOffB = offR;
          }

          boxesMeta.push({
            mediaWmm: mW / MM_TO_PT,
            mediaHmm: mH / MM_TO_PT,
            trimWmm: tW / MM_TO_PT,
            trimHmm: tH / MM_TO_PT,
            trimOffsetLeftMm: Math.max(0, rotOffL),
            trimOffsetBottomMm: Math.max(0, rotOffB),
            trimOffsetTopMm: Math.max(0, rotOffT),
            hasExplicitTrimBox,
            pageRotation: pageRot,
            extractedContours: extractCutContoursFromPdfPage(pdfDoc, p),
          });
        });
      } catch (err) {
        console.warn('Could not read PDF boxes via pdf-lib:', err);
      }

      const isLocalDesktop = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
      const loadingTask = pdfjsLib.getDocument({
        data: bytes.slice(),
        cMapUrl: isLocalDesktop ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: isLocalDesktop
          ? '/standard_fonts/'
          : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
      });
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
        const offCtx = offscreen.getContext('2d');
        await page.render({ canvasContext: offCtx, viewport, background: 'rgba(0,0,0,0)' }).promise;

        // Preserve alpha transparency (PNG) for cut-out stickers so tightly nested previews
        // never cover neighboring stickers with an opaque white JPEG rectangle; keep JPEG for opaque pages.
        let hasTransparency = false;
        try {
          const cw = offscreen.width;
          const ch = offscreen.height;
          if (cw > 2 && ch > 2) {
            const c1 = offCtx.getImageData(0, 0, 1, 1).data[3];
            const c2 = offCtx.getImageData(cw - 1, 0, 1, 1).data[3];
            const c3 = offCtx.getImageData(0, ch - 1, 1, 1).data[3];
            const c4 = offCtx.getImageData(cw - 1, ch - 1, 1, 1).data[3];
            hasTransparency = c1 < 250 || c2 < 250 || c3 < 250 || c4 < 250;
          }
        } catch {
          // ignore
        }

        const dataUrl = hasTransparency
          ? offscreen.toDataURL('image/png')
          : offscreen.toDataURL('image/jpeg', 0.85);
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

  // Measure actual pasteboard container so Fit (100%) always fits inside the visible viewport without clipping
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 100 && el.clientHeight > 100) {
        setVpBox({ w: el.clientWidth, h: el.clientHeight });
      }
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const availW = Math.max(260, vpBox.w - 52);
  const availH = Math.max(240, vpBox.h - 52);
  const BASE_WIDTH = !inspectedPage && isSideBySide ? Math.max(240, Math.floor((availW - 44) / 2)) : availW;
  const BASE_HEIGHT = !inspectedPage && isSideBySide ? Math.max(220, availH - 34) : availH;

  const overlayAnalysis = useMemo(() => {
    if (!activeSheet || inspectedPage) return null;
    return analyzeArtworkCutOverlay(activeSheet);
  }, [activeSheet, inspectedPage]);

  // Keep pinned rulers' 0mm origin locked to the paper sheet's top-left corner across zoom/resize
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const vp = viewportRef.current;
      const pb = paperBoxRef.current;
      if (vp && pb) {
        const vr = vp.getBoundingClientRect();
        const pr = pb.getBoundingClientRect();
        setRulerOrigin({ x: pr.left - vr.left, y: pr.top - vr.top });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [vpBox, zoom, sheetDim.width, sheetDim.height, pages.length, showRulers, inspectedPageIndex]);
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

      if (!activeSheet || (pages.length === 0 && !activeSheet.isV1Authoritative)) {
        ctx.fillStyle = '#64748b';
        ctx.font = '14px Inter, system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Tải lên file PDF để xem sơ đồ bình bài thời gian thực', canvasWidth / 2, canvasHeight / 2);
        return;
      }

      // Draw artwork placements (unless cutOnly)
      if (layerFilter !== 'cutOnly') {
        ctx.save();
        if (layerFilter === 'overlay') {
          ctx.globalAlpha = Math.max(0.1, Math.min(1, Number(overlayArtworkOpacity) || 0.72));
        }
        for (const p of activeSheet.placements) {
          const v1Pg =
            p.v1Placement && Array.isArray(v1ArtworkPages) && v1ArtworkPages[p.artworkPageIdx ?? 0]
              ? v1ArtworkPages[p.artworkPageIdx ?? 0]
              : v1ArtworkInfo;
          const pageInfo = p.v1Placement && v1Pg?.img ? v1Pg : pages[p.pageIndex];
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
          if (p.v1Placement && Array.isArray(p.bleedBeziersMm) && p.bleedBeziersMm.length >= 2) {
            for (const cmd of p.bleedBeziersMm) {
              if (cmd.type === 'M' && cmd.to) ctx.moveTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'L' && cmd.to) ctx.lineTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
                ctx.bezierCurveTo(
                  cmd.c1[0] * scale,
                  cmd.c1[1] * scale,
                  cmd.c2[0] * scale,
                  cmd.c2[1] * scale,
                  cmd.to[0] * scale,
                  cmd.to[1] * scale
                );
              }
            }
            ctx.closePath();
          } else {
            ctx.rect(clipX, clipY, clipW, clipH);
          }
          ctx.clip();

          ctx.translate(xPx + wPx / 2, yPx + hPx / 2);
          ctx.rotate(((p.v1Placement ? rot : -rot) * Math.PI) / 180);
          ctx.drawImage(pageInfo.img, -trimCenterXInMedia, -trimCenterYInMedia, fullDrawW, fullDrawH);
          ctx.restore();

          if (layerFilter === 'all' && !p.v1Placement) {
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
        ctx.restore();
      }

      // Draw Crop Marks & Registration Targets
      for (const line of activeSheet.marks?.lines || []) {
        ctx.strokeStyle = line.kind === 'bleed' ? '#0ea5e9' : '#0f172a';
        ctx.lineWidth = line.kind === 'bleed' ? 0.75 : 1.0;
        ctx.beginPath();
        ctx.moveTo(line.x1 * scale, line.y1 * scale);
        ctx.lineTo(line.x2 * scale, line.y2 * scale);
        ctx.stroke();
      }

      for (const reg of activeSheet.marks?.registrations || []) {
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

      // Draw Optical Sensor Quiet Zones around registration marks (when Machine Profile active)
      if (Array.isArray(activeSheet.quietZoneRectsMm) && activeSheet.quietZoneRectsMm.length > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.fillStyle = 'rgba(245, 158, 11, 0.06)';
        ctx.lineWidth = 0.9;
        ctx.setLineDash([3, 2]);
        for (const qz of activeSheet.quietZoneRectsMm) {
          ctx.fillRect(qz.x * scale, qz.y * scale, qz.w * scale, qz.h * scale);
          ctx.strokeRect(qz.x * scale, qz.y * scale, qz.w * scale, qz.h * scale);
        }
        ctx.restore();
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
        } else if (pm.type === 'graphtec' || pm.type === 'graphtecType2') {
          const isType2 = pm.type === 'graphtecType2';
          const rawArmMm = Math.max(5, (pm.size || 5) * 1.8);
          const insetMm = Math.min(pm.cx, pm.cy, (activeSheet.widthMm || 320) - pm.cx, (activeSheet.heightMm || 330) - pm.cy);
          const armMm = isType2 ? Math.min(rawArmMm, Math.max(3, insetMm - 1.2)) : rawArmMm;
          const arm = armMm * scale;
          const sx = (pm.corner.includes('L') ? 1 : -1) * (isType2 ? -1 : 1);
          const sy = (pm.corner.includes('T') ? 1 : -1) * (isType2 ? -1 : 1);
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = Math.max(1.5, 0.6 * scale);
          ctx.lineJoin = 'miter';
          ctx.lineCap = 'square';
          ctx.beginPath();
          ctx.moveTo(cx + sx * arm, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * arm);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Draw BLEED paths in Overlay mode (dashed cyan so operator can inspect CUT inside BLEED)
      if (layerFilter === 'overlay' && overlayShowBleed && Array.isArray(activeSheet.stickerBleedPaths) && activeSheet.stickerBleedPaths.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 1.0;
        ctx.setLineDash([4, 3]);
        for (const bp of activeSheet.stickerBleedPaths) {
          if (bp.kind === 'bezier' && Array.isArray(bp.beziersMm) && bp.beziersMm.length >= 2) {
            ctx.beginPath();
            for (const cmd of bp.beziersMm) {
              if (cmd.type === 'M' && cmd.to) ctx.moveTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'L' && cmd.to) ctx.lineTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
                ctx.bezierCurveTo(
                  cmd.c1[0] * scale,
                  cmd.c1[1] * scale,
                  cmd.c2[0] * scale,
                  cmd.c2[1] * scale,
                  cmd.to[0] * scale,
                  cmd.to[1] * scale
                );
              }
            }
            if (bp.closed) ctx.closePath();
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Draw Sticker CutContour Paths (unless printOnly)
      if (layerFilter !== 'printOnly' && activeSheet.stickerCutPaths && activeSheet.stickerCutPaths.length > 0) {
        ctx.save();
        ctx.strokeStyle = layerFilter === 'overlay' ? overlayCutColor || '#e11d48' : '#e11d48';
        ctx.lineWidth = layerFilter === 'overlay' ? Math.max(1, Number(overlayCutStrokePx) || 1.8) : 1.25;
        for (const cp of activeSheet.stickerCutPaths) {
          ctx.beginPath();
          if (cp.kind === 'line') {
            ctx.moveTo(cp.x1 * scale, cp.y1 * scale);
            ctx.lineTo(cp.x2 * scale, cp.y2 * scale);
          } else if (cp.kind === 'bezier' && Array.isArray(cp.beziersMm) && cp.beziersMm.length >= 2) {
            for (const cmd of cp.beziersMm) {
              if (cmd.type === 'M' && cmd.to) ctx.moveTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'L' && cmd.to) ctx.lineTo(cmd.to[0] * scale, cmd.to[1] * scale);
              else if (cmd.type === 'C' && cmd.c1 && cmd.c2 && cmd.to) {
                ctx.bezierCurveTo(
                  cmd.c1[0] * scale,
                  cmd.c1[1] * scale,
                  cmd.c2[0] * scale,
                  cmd.c2[1] * scale,
                  cmd.to[0] * scale,
                  cmd.to[1] * scale
                );
              }
            }
            if (cp.closed) ctx.closePath();
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

      // Draw V1 Guillotine Trim Marks (Dấu xén) matching PRINT PDF 1:1
      if (layerFilter !== 'cutOnly' && Array.isArray(activeSheet.v1TrimMarks) && activeSheet.v1TrimMarks.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#0f172a';
        for (const tm of activeSheet.v1TrimMarks) {
          ctx.lineWidth = Math.max(0.8, (tm.thicknessMm || 0.2) * scale);
          ctx.beginPath();
          ctx.moveTo(tm.x1 * scale, tm.y1 * scale);
          ctx.lineTo(tm.x2 * scale, tm.y2 * scale);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Draw Paper Guides (Thanh canh giấy) matching PRINT PDF 1:1
      if (layerFilter !== 'cutOnly' && Array.isArray(activeSheet.paperGuides) && activeSheet.paperGuides.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#0f172a';
        for (const g of activeSheet.paperGuides) {
          ctx.lineWidth = Math.max(1.0, (g.thicknessMm || 0.35) * scale);
          ctx.beginPath();
          ctx.moveTo(g.x1 * scale, g.y1 * scale);
          ctx.lineTo(g.x2 * scale, g.y2 * scale);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (layerFilter !== 'cutOnly' && activeSheet.slugText) {
        ctx.save();
        if (activeSheet.isV1Authoritative) {
          ctx.fillStyle = '#0f172a';
          ctx.font = `${Math.max(8, Math.round(2.6 * scale))}px Helvetica, Arial, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const slugY = (Number.isFinite(activeSheet.slugYmm) ? activeSheet.slugYmm : 8.5) * scale;
          ctx.fillText(activeSheet.slugText, canvasWidth / 2, slugY);
        } else {
          ctx.fillStyle = '#334155';
          ctx.font = `${Math.max(8, Math.round(2.4 * scale))}px monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(activeSheet.slugText, 6 * scale, canvasHeight - 2 * scale);
        }
        ctx.restore();
      }
    };

    // Coalesce rapid changes (zoom ticks, slider drags) into a single redraw per animation frame
    const drawRaf = requestAnimationFrame(() => {
      if (!inspectedPage && isSideBySide) {
        drawSheetToCanvas(canvasRef.current, 'printOnly');
        drawSheetToCanvas(cutCanvasRef.current, 'cutOnly');
      } else if (!inspectedPage && isOverlayMode) {
        drawSheetToCanvas(canvasRef.current, 'overlay');
      } else {
        drawSheetToCanvas(canvasRef.current, 'all');
      }
    });
    return () => cancelAnimationFrame(drawRaf);
    // Primitive deps only: parent passes a fresh `margins` object & `sheetDim` is rebuilt every render,
    // which previously forced a full sheet redraw on every unrelated re-render (mouse move, hover, typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSheet,
    pages,
    sheetDim.width,
    sheetDim.height,
    margins?.top,
    margins?.bottom,
    margins?.left,
    margins?.right,
    bleedMm,
    showBleedOverlay,
    showSafeArea,
    safeInsetMm,
    splitStickerPreview,
    isSideBySide,
    isOverlayMode,
    overlayArtworkOpacity,
    overlayCutColor,
    overlayCutStrokePx,
    overlayShowBleed,
    autoCropInk,
    inspectedPage,
    canvasWidth,
    canvasHeight,
    v1ArtworkInfo,
    v1ArtworkPages,
  ]);

  // 3. Direct Mouse Wheel Zoom — attached ONLY to active scroll panes (avoids parent+child double-fire in side-by-side mode)
  useEffect(() => {
    if (!onZoomChange) return;
    const targets = isSideBySide
      ? [printPaneRef.current, cutPaneRef.current].filter(Boolean)
      : [viewportRef.current].filter(Boolean);
    if (targets.length === 0) return;

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
        onZoomChange((prev) => computeSyncedZoom(prev, ticks));
      });
    };

    targets.forEach((el) => el.addEventListener('wheel', handleWheel, { passive: false }));
    return () => {
      targets.forEach((el) => el.removeEventListener('wheel', handleWheel));
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [onZoomChange, isSideBySide]);

  return (
    <div className="flex flex-col w-full h-full relative bg-[#52565E] overflow-hidden">
      {pdfLoading && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-2xl p-6 flex flex-col items-center gap-3.5 text-center">
            <div className="relative w-14 h-14 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-4 border-[#DDF5EC]" />
              <div className="absolute inset-0 rounded-full border-4 border-[#087F5B] border-t-transparent animate-spin" />
              <span className="text-xs font-extrabold font-mono text-[#087F5B]">{loadProgress.pct}%</span>
            </div>
            <div className="flex flex-col gap-1 w-full">
              <div className="text-sm font-bold text-[#17212F] truncate px-2">
                Đang mở: {loadProgress.fileName || 'File PDF'}
              </div>
              <div className="text-xs font-medium text-[#64748B]">
                {loadProgress.stage || 'Đang phân tích TrimBox/Bleed & trích xuất trang PDF...'}
              </div>
            </div>
            <div className="w-full h-2 bg-[#F3F5F7] rounded-full overflow-hidden border border-[#E2E8F0]">
              <div
                className="h-full bg-[#087F5B] transition-all duration-150 rounded-full"
                style={{ width: `${Math.max(6, loadProgress.pct)}%` }}
              />
            </div>
            {loadProgress.total > 0 && (
              <div className="text-[11px] font-mono font-semibold text-[#087F5B]">
                Tiến độ: {loadProgress.page} / {loadProgress.total} trang ({loadProgress.pct}%)
              </div>
            )}
          </div>
        </div>
      )}

      {inspectedPage && (
        <div className="w-full px-3 py-1.5 bg-[#064E3B] text-white flex flex-wrap items-center justify-between gap-2 border-b border-black/20 shrink-0">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded bg-white/15 text-[#DDF5EC] font-mono font-bold">
              TRANG GỐC #{inspectedPageIndex + 1} / {pages.length}
            </span>
            <span className="font-semibold truncate max-w-[260px]">{inspectedPage.fileName}</span>
            <span className="font-mono text-emerald-100/90">
              · {inspectedPage.mediaWmm.toFixed(1)} × {inspectedPage.mediaHmm.toFixed(1)} mm
              {autoCropInk && inspectedPage.inkBox
                ? ` → Vùng mực: ${inspectedPage.inkBox.trimWmm.toFixed(1)}×${inspectedPage.inkBox.trimHmm.toFixed(1)} mm`
                : inspectedPage.hasExplicitTrimBox
                ? ` → Thành phẩm: ${inspectedPage.trimWmm.toFixed(1)}×${inspectedPage.trimHmm.toFixed(1)} mm`
                : ''}
            </span>
          </div>
          {onExitInspectPage && (
            <button
              onClick={onExitInspectPage}
              className="px-2.5 py-0.5 rounded bg-[#087F5B] hover:bg-emerald-600 text-white text-[11px] font-semibold cursor-pointer border border-white/15"
            >
              ← Quay lại Tờ Bình
            </button>
          )}
        </div>
      )}

      {/* PREVIEW-VS-EXPORT PARITY WARNING BANNER (Phase 3) */}
      {!inspectedPage && parityCheck && (parityCheck.status === PARITY_STATUS.MISMATCH || parityCheck.status === PARITY_STATUS.WARNING) && (
        <div
          className={`w-full px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold border-b shrink-0 ${
            parityCheck.status === PARITY_STATUS.MISMATCH
              ? 'bg-rose-600 text-white border-rose-700'
              : 'bg-amber-500 text-slate-950 border-amber-600'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-1.5 py-0.5 rounded bg-black/15 font-mono text-[10px] font-extrabold shrink-0">
              {parityCheck.status === PARITY_STATUS.MISMATCH ? '⛔ SAI LỆCH PREVIEW ↔ PDF XUẤT' : '⚠ CẦN XUẤT LẠI PDF'}
            </span>
            <span className="truncate">{parityCheck.summaryMessage}</span>
          </div>
          {parityCheck.discrepancies?.length > 1 && (
            <span className="font-mono text-[10px] opacity-90 shrink-0">
              +{parityCheck.discrepancies.length - 1} cảnh báo khác
            </span>
          )}
        </div>
      )}

      {/* OVERLAY DEVIATION INSPECTION BAR (Phase 3) */}
      {!inspectedPage && isOverlayMode && overlayAnalysis && (
        <div className="w-full px-3 py-1.5 bg-[#1E293B] text-slate-100 border-b border-slate-700 flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`px-2 py-0.5 rounded font-mono font-extrabold text-[10px] ${
                overlayAnalysis.status === 'PASS'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : overlayAnalysis.status === 'WARNING'
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                  : 'bg-rose-500/25 text-rose-200 border border-rose-500/50'
              }`}
            >
              {overlayAnalysis.status === 'PASS'
                ? '✓ CHỒNG LỚP KHỚP'
                : overlayAnalysis.status === 'WARNING'
                ? '⚠ CẢNH BÁO CHỒNG LỚP'
                : '⛔ LỆCH ARTWORK ↔ CUT'}
            </span>
            <span className="font-mono text-slate-300">
              Lệch tâm: <strong className="text-white">{overlayAnalysis.maxCenterDeltaMm.toFixed(3)} mm</strong>
            </span>
            <span className="text-slate-600">|</span>
            <span className="font-mono text-slate-300">
              Lệch biên: <strong className="text-white">{overlayAnalysis.maxBoundsDeltaMm.toFixed(3)} mm</strong>
            </span>
            <span className="text-slate-600">|</span>
            <span className="font-mono text-slate-300">
              Lệch boong: <strong className="text-white">{overlayAnalysis.maxMarkDeltaMm.toFixed(3)} mm</strong>
            </span>
            {overlayAnalysis.minBleedMarginMm !== null && (
              <>
                <span className="text-slate-600">|</span>
                <span className="font-mono text-cyan-300">
                  Min Bleed: <strong>{overlayAnalysis.minBleedMarginMm.toFixed(2)} mm</strong>
                </span>
              </>
            )}
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            Đã đối chiếu {overlayAnalysis.matchedCutPaths}/{overlayAnalysis.checkedPlacements} tem
          </span>
        </div>
      )}

      {/* PINNED TOP & LEFT MM RULERS + DARK GRAY DESKTOP PASTEBOARD */}
      <div className="flex-1 min-h-0 w-full flex flex-col overflow-hidden">
        {showRulers && !isSideBySide && (
          <div className="flex h-5 shrink-0 bg-[#F8FAFC]">
            <div className="w-5 h-5 bg-[#E2E8F0] border-r border-b border-[#CBD5E1] text-[8px] font-mono font-bold text-[#475569] flex items-center justify-center shrink-0">
              mm
            </div>
            <PrepressRulerBar
              orientation="horizontal"
              viewportPx={vpBox.w}
              originPx={rulerOrigin.x}
              pxPerMm={canvasWidth / Math.max(1, sheetDim.width)}
              cursorMm={cursorMm?.x ?? null}
            />
          </div>
        )}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {showRulers && !isSideBySide && (
            <div className="w-5 shrink-0 flex flex-col bg-[#F8FAFC]">
              <PrepressRulerBar
                orientation="vertical"
                viewportPx={vpBox.h}
                originPx={rulerOrigin.y}
                pxPerMm={canvasHeight / Math.max(1, sheetDim.height)}
                cursorMm={cursorMm?.y ?? null}
              />
            </div>
          )}
          {!inspectedPage && isSideBySide ? (
            <div ref={viewportRef} className="flex-1 h-full grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-slate-700 overflow-hidden bg-[#52565E]">
              {/* LEFT PANE: PRINT (Synchronized Scroll + Zoom + Crosshair) */}
              <div className="flex flex-col min-w-0 min-h-0 overflow-hidden">
                <div className="h-7 px-3 bg-[#1E293B] border-b border-slate-700 flex items-center justify-between gap-2 text-[11px] shrink-0 select-none">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="px-2 py-0.5 rounded bg-[#087F5B] text-white text-[10px] font-extrabold tracking-wide shrink-0">
                      BÀI IN (PRINT)
                    </span>
                    <span className="font-mono text-slate-300 truncate">
                      Tờ {activeSheet?.physicalSheet || 1}/{sheets.length || 1} · {activeSheet?.placements?.length || 0} tem
                      {activeSheet?.runCount > 1 ? ` · ×${activeSheet.runCount} tờ` : ''}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-emerald-300 shrink-0">
                    {sheetDim.width.toFixed(0)}×{sheetDim.height.toFixed(0)} mm
                  </span>
                </div>
                <div
                  ref={printPaneRef}
                  onScroll={() => syncPaneScroll('print')}
                  onMouseDown={handlePrintMouseDown}
                  onMouseLeave={() => setCursorMm(null)}
                  title="Cuộn chuột để Zoom đồng bộ · Kéo chuột trái để cuộn đồng bộ PRINT & CUT"
                  className={`flex-1 overflow-auto p-5 select-none flex bg-[#4B5058] ${
                    isPrintPanning ? 'cursor-grabbing' : 'cursor-grab'
                  }`}
                >
                  <div
                    className="relative m-auto shrink-0"
                    style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
                    onMouseMove={(e) => {
                      if (isPrintPanning || cursorRafRef.current) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const cx = e.clientX;
                      const cy = e.clientY;
                      cursorRafRef.current = requestAnimationFrame(() => {
                        cursorRafRef.current = 0;
                        const xMm = ((cx - rect.left) / Math.max(1, rect.width)) * sheetDim.width;
                        const yMm = ((cy - rect.top) / Math.max(1, rect.height)) * sheetDim.height;
                        setCursorMm({
                          x: Math.round(Math.max(0, Math.min(sheetDim.width, xMm)) * 10) / 10,
                          y: Math.round(Math.max(0, Math.min(sheetDim.height, yMm)) * 10) / 10,
                        });
                      });
                    }}
                  >
                    <canvas
                      ref={canvasRef}
                      className="bg-white block"
                      style={{
                        width: `${canvasWidth}px`,
                        height: `${canvasHeight}px`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)',
                      }}
                    />
                    {cursorMm && (
                      <>
                        <div
                          className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-emerald-400/80"
                          style={{ left: `${(cursorMm.x / Math.max(1, sheetDim.width)) * 100}%` }}
                        />
                        <div
                          className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-emerald-400/80"
                          style={{ top: `${(cursorMm.y / Math.max(1, sheetDim.height)) * 100}%` }}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT PANE: CUT (Synchronized Scroll + Zoom + Crosshair) */}
              <div className="flex flex-col min-w-0 min-h-0 overflow-hidden">
                <div className="h-7 px-3 bg-[#1E293B] border-b border-slate-700 flex items-center justify-between gap-2 text-[11px] shrink-0 select-none">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="px-2 py-0.5 rounded bg-[#DC4545] text-white text-[10px] font-extrabold tracking-wide shrink-0">
                      KHUÔN BẾ (CUT)
                    </span>
                    <span className="font-mono text-slate-300 truncate">
                      {activeSheet?.stickerCutPaths?.length || 0} đường bế · {activeSheet?.pontMarks?.length || 0} boong
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-rose-300 shrink-0">
                    {requireSpotCutContour ? 'Spot: CutContour' : 'CMYK Magenta'}
                  </span>
                </div>
                <div
                  ref={cutPaneRef}
                  onScroll={() => syncPaneScroll('cut')}
                  onMouseDown={handleCutMouseDown}
                  onMouseLeave={() => setCursorMm(null)}
                  title="Cuộn chuột để Zoom đồng bộ · Kéo chuột trái để cuộn đồng bộ PRINT & CUT"
                  className={`flex-1 overflow-auto p-5 select-none flex bg-[#4B5058] ${
                    isCutPanning ? 'cursor-grabbing' : 'cursor-grab'
                  }`}
                >
                  <div
                    className="relative m-auto shrink-0"
                    style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
                    onMouseMove={(e) => {
                      if (isCutPanning || cursorRafRef.current) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const cx = e.clientX;
                      const cy = e.clientY;
                      cursorRafRef.current = requestAnimationFrame(() => {
                        cursorRafRef.current = 0;
                        const xMm = ((cx - rect.left) / Math.max(1, rect.width)) * sheetDim.width;
                        const yMm = ((cy - rect.top) / Math.max(1, rect.height)) * sheetDim.height;
                        setCursorMm({
                          x: Math.round(Math.max(0, Math.min(sheetDim.width, xMm)) * 10) / 10,
                          y: Math.round(Math.max(0, Math.min(sheetDim.height, yMm)) * 10) / 10,
                        });
                      });
                    }}
                  >
                    <canvas
                      ref={cutCanvasRef}
                      className="bg-white block"
                      style={{
                        width: `${canvasWidth}px`,
                        height: `${canvasHeight}px`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)',
                      }}
                    />
                    {cursorMm && (
                      <>
                        <div
                          className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-rose-400/80"
                          style={{ left: `${(cursorMm.x / Math.max(1, sheetDim.width)) * 100}%` }}
                        />
                        <div
                          className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-rose-400/80"
                          style={{ top: `${(cursorMm.y / Math.max(1, sheetDim.height)) * 100}%` }}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div
              ref={viewportRef}
              onScroll={() => {
                if (scrollRafRef.current) return;
                scrollRafRef.current = requestAnimationFrame(() => {
                  scrollRafRef.current = 0;
                  const vp = viewportRef.current;
                  const pb = paperBoxRef.current;
                  if (vp && pb) {
                    const vr = vp.getBoundingClientRect();
                    const pr = pb.getBoundingClientRect();
                    setRulerOrigin({ x: pr.left - vr.left, y: pr.top - vr.top });
                  }
                });
              }}
              onMouseDown={handleMouseDown}
              onMouseLeave={() => {
                setCursorMm(null);
              }}
              title="Cuộn chuột để Zoom (tối đa 1000%) · Kéo chuột trái để di chuyển bàn vẽ"
              className={`flex-1 h-full overflow-auto p-6 select-none flex bg-[#52565E] ${
                isPanning ? 'cursor-grabbing' : 'cursor-grab'
              }`}
            >
              <div
                ref={paperBoxRef}
                className="m-auto shrink-0"
                style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
                onMouseMove={(e) => {
                  // Skip cursor read-out while drag-panning, and throttle to 1 update per frame
                  if (isPanning || cursorRafRef.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const cx = e.clientX;
                  const cy = e.clientY;
                  cursorRafRef.current = requestAnimationFrame(() => {
                    cursorRafRef.current = 0;
                    const xMm = ((cx - rect.left) / Math.max(1, rect.width)) * sheetDim.width;
                    const yMm = ((cy - rect.top) / Math.max(1, rect.height)) * sheetDim.height;
                    setCursorMm({
                      x: Math.round(Math.max(0, Math.min(sheetDim.width, xMm)) * 10) / 10,
                      y: Math.round(Math.max(0, Math.min(sheetDim.height, yMm)) * 10) / 10,
                    });
                  });
                }}
                onMouseLeave={() => setCursorMm(null)}
              >
                <canvas
                  ref={canvasRef}
                  className="bg-white block"
                  style={{
                    width: `${canvasWidth}px`,
                    height: `${canvasHeight}px`,
                    boxShadow: '0 14px 36px rgba(0,0,0,0.4)',
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM NATIVE DESKTOP STATUS BAR & PRINT GUIDES LEGEND */}
      <div className="h-8 px-3 bg-[#FFFFFF] border-t border-[#E2E8F0] flex items-center justify-between gap-3 text-[11px] text-[#64748B] shrink-0 select-none">
        <div className="flex items-center gap-3 font-mono">
          {sheets.length > 0 && !inspectedPage ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentSheetIndex(Math.max(0, safeIndex - 1))}
                disabled={safeIndex === 0}
                title="Tờ trước"
                className="w-5 h-5 rounded hover:bg-[#F3F5F7] text-[#17212F] font-bold disabled:opacity-30 cursor-pointer flex items-center justify-center"
              >
                ‹
              </button>
              <span className="font-semibold text-[#17212F]">
                Tờ {activeSheet.physicalSheet}/{sheets.length}
                {activeSheet.runCount > 1 ? ` (×${activeSheet.runCount})` : ''}
                {plan.summary.physicalSheets > sheets.length ? ` · Tổng ${plan.summary.physicalSheets} tờ` : ''}
              </span>
              <button
                onClick={() => setCurrentSheetIndex(Math.min(sheets.length - 1, safeIndex + 1))}
                disabled={safeIndex >= sheets.length - 1}
                title="Tờ sau"
                className="w-5 h-5 rounded hover:bg-[#F3F5F7] text-[#17212F] font-bold disabled:opacity-30 cursor-pointer flex items-center justify-center"
              >
                ›
              </button>
              <span className="text-[#087F5B] font-sans font-semibold ml-1">
                {activeSheet.side === 'Front'
                  ? 'Mặt trước'
                  : activeSheet.side === 'Back'
                  ? 'Mặt sau (Lật gương)'
                  : '1 Mặt'}{' '}
                · {activeSheet.placements.length} con
              </span>
            </div>
          ) : (
            <span className="font-semibold text-[#17212F]">
              {pages.length > 0 ? `Trang ${(inspectedPageIndex ?? 0) + 1}/${pages.length}` : 'Chưa mở tài liệu'}
            </span>
          )}
          <span className="text-[#CBD5E1]">|</span>
          <span>
            {sheetDim.width.toFixed(1)} × {sheetDim.height.toFixed(1)} mm
          </span>
          <span className="text-[#CBD5E1]">|</span>
          <span>Zoom {Math.round(zoom * 100)}%</span>
          {cursorMm && (
            <>
              <span className="text-[#CBD5E1]">|</span>
              <span className="text-[#087F5B] font-semibold">
                X: {cursorMm.x.toFixed(1)} mm · Y: {cursorMm.y.toFixed(1)} mm
              </span>
            </>
          )}
        </div>

        <div className="hidden md:flex items-center gap-3.5">
          {parityCheck?.status === PARITY_STATUS.VERIFIED && (
            <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-[#064E3B] font-semibold text-[10px] whitespace-nowrap">
              ✓ Khớp PDF xuất
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 border-t-[1.5px] border-dashed border-[#DC4545] inline-block" /> Bleed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 border-t-[1.5px] border-[#475569] inline-block" /> Trim
          </span>
          {showSafeArea && (
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 border-t-[1.5px] border-dashed border-[#087F5B] inline-block" /> Safe ({safeInsetMm}mm)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
