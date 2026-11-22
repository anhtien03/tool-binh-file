import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { MM_TO_PT } from '../engine/impositionEngine.js';
import {
  extractStickerContoursFromImage,
  extractPdfImagePlacementsMm,
  exportBleedExtendedPdf,
  exportContourTracedPdf,
  exportSplitStickersPdf,
  TARGET_PRINT_DPI,
} from '../engine/bleedContourEngine.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export default function BleedAndContourStudio({
  initialFile,
  onSharedFileChange,
  onOpenStickerImpose,
  onSendSplitStickersToImpose,
}) {
  const [subMode, setSubMode] = useState('contour'); // 'contour' | 'bleed'
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceType, setSourceType] = useState('image');
  const [renderedCanvas, setRenderedCanvas] = useState(null);
  const [sizeMm, setSizeMm] = useState({ w: 150, h: 150 });
  const [actualDpi, setActualDpi] = useState(TARGET_PRINT_DPI);
  const [loading, setLoading] = useState(false);
  const [loadPct, setLoadPct] = useState(0);
  const [loadStage, setLoadStage] = useState('');
  const [isTracing, setIsTracing] = useState(false);
  const [error, setError] = useState(null);

  // Contour Tracer Options (5-Step Pipeline: Alpha Cut + Corner-Preserving Bézier + Bleed Offset + Geometry Validation)
  const [shapeMode, setShapeMode] = useState('auto'); // 'auto' | 'circle' | 'oval' | 'rect'
  const [offsetMm, setOffsetMm] = useState(0.5); // CutContour offset from artwork edge (mm)
  const [bleedOffsetMm, setBleedOffsetMm] = useState(1.5); // Outward Bleed offset from CutContour (mm)
  const [showBleedContour, setShowBleedContour] = useState(true);
  const [cornerAngleDeg, setCornerAngleDeg] = useState(130); // Preserve sharp corners <= 130°
  const [smoothLevel, setSmoothLevel] = useState(1);
  const [simplifyMm, setSimplifyMm] = useState(0.18); // ~0.45px equivalent
  const [minAreaMm2, setMinAreaMm2] = useState(8.0);
  const [mergeGapMm, setMergeGapMm] = useState(0.35); // Intra-sticker detail merge gap (mm)
  const [ignoreCornerMarks, setIgnoreCornerMarks] = useState(true);
  const [contoursMm, setContoursMm] = useState([]);
  const [imagePlacementsMm, setImagePlacementsMm] = useState([]);
  const [inputMode, setInputMode] = useState('multi'); // 'single' (PDF/PNG đã có biên) | 'multi' (Tách nhiều tem)
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [bleedCompleted, setBleedCompleted] = useState(false);
  const [selectedStickerIdx, setSelectedStickerIdx] = useState(null); // null = All stickers, or 0..K-1 = specific sticker
  const [perStickerOverrides, setPerStickerOverrides] = useState({}); // { [compIdx]: { shapeMode, offsetMm, hidden } }

  // 4-Edge Bleed Extension Options
  const [bleedAllMm, setBleedAllMm] = useState(2.0);
  const [bleedEdges, setBleedEdges] = useState({ top: true, bottom: true, left: true, right: true });
  const [fillMode, setFillMode] = useState('mirror'); // 'mirror' | 'stretch' | 'solid'
  const [solidColorHex, setSolidColorHex] = useState('#ffffff');

  // Zoom, Pan & Multi-Page PDF navigation
  const [zoom, setZoom] = useState(1.0);
  const [isPanning, setIsPanning] = useState(false);
  const [activePdfPage, setActivePdfPage] = useState(1);
  const [totalPdfPages, setTotalPdfPages] = useState(1);
  const pdfBytesRef = useRef(null);
  const viewportRef = useRef(null);
  const panStateRef = useRef({ active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });
  const previewCanvasRef = useRef(null);

  const renderPdfPageAt = async (bytes, pageNum) => {
    setLoadPct(18);
    setLoadStage('Đang giải mã cấu trúc trang PDF...');
    await new Promise((r) => setTimeout(r, 0));
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
    }).promise;
    setTotalPdfPages(pdf.numPages);
    const safePage = Math.max(1, Math.min(pdf.numPages, pageNum));
    setActivePdfPage(safePage);
    const page = await pdf.getPage(safePage);
    const vp1 = page.getViewport({ scale: 1.0 });
    const wMm = Math.round((vp1.width / MM_TO_PT) * 10) / 10;
    const hMm = Math.round((vp1.height / MM_TO_PT) * 10) / 10;
    setSizeMm({ w: wMm, h: hMm });

    // Render at true 300 DPI (300 / 72 = 4.1667x scale), safely capped at 4800px max dimension
    const scale300 = TARGET_PRINT_DPI / 72;
    const maxSafeScale = 4800 / Math.max(1, vp1.width, vp1.height);
    const renderScale = Math.min(scale300, maxSafeScale);
    setActualDpi(Math.round(renderScale * 72));

    setLoadPct(52);
    setLoadStage(`Đang kết xuất trang ${safePage}/${pdf.numPages} ở độ phân giải ${Math.round(renderScale * 72)} DPI...`);
    await new Promise((r) => setTimeout(r, 0));

    const vp = page.getViewport({ scale: renderScale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    // Pass transparent background so PDFs without a full-page white rect preserve their native vector/SMask Alpha channel!
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    setLoadPct(85);
    setLoadStage('Đang trích xuất tọa độ đối tượng & dò đường bế...');
    await new Promise((r) => setTimeout(r, 0));
    const placements = await extractPdfImagePlacementsMm(bytes, safePage);
    setImagePlacementsMm(placements);
    setLoadPct(100);
    setRenderedCanvas(c);
  };

  const handleUpload = async (file, notifyParent = true) => {
    if (!file) return;
    setSourceFile(file);
    if (notifyParent && onSharedFileChange) {
      onSharedFileChange(file);
    }
    setError(null);
    setLoading(true);
    try {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        setSourceType('pdf');
        const bytes = new Uint8Array(await file.arrayBuffer());
        pdfBytesRef.current = bytes;
        await renderPdfPageAt(bytes, 1);
      } else {
        setSourceType('image');
        pdfBytesRef.current = null;
        setImagePlacementsMm([]);
        setTotalPdfPages(1);
        setActivePdfPage(1);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.src = url;
        await new Promise((res) => {
          img.onload = res;
          img.onerror = res;
        });
        // Default 300 DPI assumption for PNG/JPG -> mm (editable by user)
        const wMm = Math.round(((img.width / 300) * 25.4) * 10) / 10;
        const hMm = Math.round(((img.height / 300) * 25.4) * 10) / 10;
        setSizeMm({ w: Math.max(10, wMm), h: Math.max(10, hMm) });
        setActualDpi(TARGET_PRINT_DPI);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        setRenderedCanvas(c);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error(err);
      setError(err?.message || 'Không thể đọc file này. Vui lòng thử file PDF/PNG khác.');
    } finally {
      setLoading(false);
    }
  };

  // Auto-load workspace shared file if user switches to Bleed studio without having to re-upload
  useEffect(() => {
    if (initialFile && initialFile !== sourceFile) {
      handleUpload(initialFile, false);
    }
  }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-trace contours asynchronously so UI never freezes on complex PDFs
  useEffect(() => {
    if (!renderedCanvas || subMode !== 'contour') {
      setContoursMm([]);
      setIsTracing(false);
      return;
    }
    // Debounce: while user drags a slider, only re-trace after they pause (~250ms) instead of on every tick
    setIsTracing(true);
    const timer = setTimeout(() => {
      try {
        const traced = extractStickerContoursFromImage(renderedCanvas, sizeMm.w, sizeMm.h, {
          offsetMm,
          bleedOffsetMm: showBleedContour ? bleedOffsetMm : 0,
          smoothLevel,
          simplifyMm,
          cornerAngleDeg,
          minAreaMm2,
          mergeGapMm,
          shapeMode,
          ignoreCornerMarks,
          imagePlacementsMm,
          perStickerOverrides,
        });
        setContoursMm(traced);
      } catch (err) {
        console.error(err);
        setError('Lỗi khi dò đường bế từ hình ảnh.');
      } finally {
        setIsTracing(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [
    renderedCanvas,
    subMode,
    sizeMm.w,
    sizeMm.h,
    offsetMm,
    bleedOffsetMm,
    showBleedContour,
    cornerAngleDeg,
    smoothLevel,
    simplifyMm,
    minAreaMm2,
    mergeGapMm,
    shapeMode,
    ignoreCornerMarks,
    imagePlacementsMm,
    perStickerOverrides,
  ]);

  // Draw live preview canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const maxBox = Math.round(720 * zoom);
    let ratio = window.devicePixelRatio || 2;
    const padMm = subMode === 'contour' ? Math.max(4, offsetMm + 3) : bleedAllMm + 2;
    const totalW = sizeMm.w + padMm * 2;
    const totalH = sizeMm.h + padMm * 2;
    const scale = Math.min(maxBox / totalW, maxBox / totalH);

    const viewW = Math.round(totalW * scale);
    const viewH = Math.round(totalH * scale);
    // Cap backing-store size: at 1000% zoom x DPR 2 the canvas would be ~14000px (500MB+ RAM) and freeze the browser
    const MAX_SIDE = 8192;
    const MAX_AREA = 16_000_000;
    ratio = Math.min(ratio, MAX_SIDE / Math.max(1, viewW), MAX_SIDE / Math.max(1, viewH), Math.sqrt(MAX_AREA / Math.max(1, viewW * viewH)));
    canvas.width = Math.max(1, Math.floor(viewW * ratio));
    canvas.height = Math.max(1, Math.floor(viewH * ratio));
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);

    if (!renderedCanvas) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px Inter, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Tải ảnh PNG sticker hoặc PDF để dò đường bế / bù xén', viewW / 2, viewH / 2);
      return;
    }

    const x0 = padMm * scale;
    const y0 = padMm * scale;
    const w0 = sizeMm.w * scale;
    const h0 = sizeMm.h * scale;

    if (subMode === 'bleed') {
      // Draw Bleed preview around center
      const bL = bleedEdges.left ? bleedAllMm * scale : 0;
      const bR = bleedEdges.right ? bleedAllMm * scale : 0;
      const bT = bleedEdges.top ? bleedAllMm * scale : 0;
      const bB = bleedEdges.bottom ? bleedAllMm * scale : 0;

      if (fillMode === 'solid') {
        ctx.fillStyle = solidColorHex;
        ctx.fillRect(x0 - bL, y0 - bT, w0 + bL + bR, h0 + bT + bB);
      } else {
        const sw = renderedCanvas.width;
        const sh = renderedCanvas.height;
        if (fillMode === 'mirror') {
          if (bL > 0) {
            ctx.save();
            ctx.translate(x0, y0);
            ctx.scale(-1, 1);
            ctx.drawImage(renderedCanvas, 0, 0, Math.min(sw, 40), sh, 0, 0, bL, h0);
            ctx.restore();
          }
          if (bR > 0) {
            ctx.save();
            ctx.translate(x0 + w0 + bR, y0);
            ctx.scale(-1, 1);
            ctx.drawImage(renderedCanvas, Math.max(0, sw - 40), 0, Math.min(sw, 40), sh, 0, 0, bR, h0);
            ctx.restore();
          }
          if (bT > 0) {
            ctx.save();
            ctx.translate(x0, y0);
            ctx.scale(1, -1);
            ctx.drawImage(renderedCanvas, 0, 0, sw, Math.min(sh, 40), 0, 0, w0, bT);
            ctx.restore();
          }
          if (bB > 0) {
            ctx.save();
            ctx.translate(x0, y0 + h0 + bB);
            ctx.scale(1, -1);
            ctx.drawImage(renderedCanvas, 0, Math.max(0, sh - 40), sw, Math.min(sh, 40), 0, 0, w0, bB);
            ctx.restore();
          }
        } else {
          if (bL > 0) ctx.drawImage(renderedCanvas, 0, 0, 2, sh, x0 - bL, y0, bL, h0);
          if (bR > 0) ctx.drawImage(renderedCanvas, sw - 2, 0, 2, sh, x0 + w0, y0, bR, h0);
          if (bT > 0) ctx.drawImage(renderedCanvas, 0, 0, sw, 2, x0, y0 - bT, w0, bT);
          if (bB > 0) ctx.drawImage(renderedCanvas, 0, sh - 2, sw, 2, x0, y0 + h0, w0, bB);
        }
      }

      ctx.drawImage(renderedCanvas, x0, y0, w0, h0);

      // TrimBox blue & BleedBox red dashed
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 1.1;
      ctx.strokeRect(x0, y0, w0, h0);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 - bL, y0 - bT, w0 + bL + bR, h0 + bT + bB);
      ctx.setLineDash([]);
    } else {
      // Contour mode: draw image + traced Cyan BleedContour + Magenta CutContour closed Cubic Bézier paths
      ctx.drawImage(renderedCanvas, x0, y0, w0, h0);

      const drawContourLoop = (poly, strokeColor, lineW, dashed = false) => {
        if (!poly || poly.length < 2) return;
        ctx.save();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineW;
        if (dashed) ctx.setLineDash([4, 2.5]);
        ctx.beginPath();
        if (poly.beziersMm && poly.beziersMm.length >= 2) {
          for (const cmd of poly.beziersMm) {
            if (cmd.type === 'M') {
              ctx.moveTo((padMm + cmd.to[0]) * scale, (padMm + cmd.to[1]) * scale);
            } else if (cmd.type === 'L') {
              ctx.lineTo((padMm + cmd.to[0]) * scale, (padMm + cmd.to[1]) * scale);
            } else if (cmd.type === 'C') {
              ctx.bezierCurveTo(
                (padMm + cmd.c1[0]) * scale,
                (padMm + cmd.c1[1]) * scale,
                (padMm + cmd.c2[0]) * scale,
                (padMm + cmd.c2[1]) * scale,
                (padMm + cmd.to[0]) * scale,
                (padMm + cmd.to[1]) * scale
              );
            }
          }
        } else {
          poly.forEach(([px, py], i) => {
            const vx = (padMm + px) * scale;
            const vy = (padMm + py) * scale;
            if (i === 0) ctx.moveTo(vx, vy);
            else ctx.lineTo(vx, vy);
          });
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      };

      const bleedList = contoursMm?.bleedContoursMm || [];
      if (showBleedContour && bleedList.length > 0) {
        for (const bPoly of bleedList) {
          drawContourLoop(bPoly, '#0284c7', 1.35, true);
        }
      }

      for (let idx = 0; idx < contoursMm.length; idx++) {
        const poly = contoursMm[idx];
        const isSelected = selectedStickerIdx !== null && (poly.compIdx === selectedStickerIdx || idx === selectedStickerIdx);
        drawContourLoop(poly, isSelected ? '#7c3aed' : '#db2777', isSelected ? 2.6 : 1.65, false);

        // Draw sticker number badge (#1, #2, ...) at centroid of each sticker so user can click/identify each sticker
        if (poly && poly.length >= 3) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [x, y] of poly) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          const cxPx = (padMm + (minX + maxX) / 2) * scale;
          const cyPx = (padMm + (minY + maxY) / 2) * scale;
          ctx.save();
          ctx.fillStyle = isSelected ? 'rgba(124, 58, 237, 0.92)' : 'rgba(15, 23, 42, 0.72)';
          ctx.beginPath();
          ctx.arc(cxPx, cyPx, isSelected ? 11 : 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 10px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`#${idx + 1}`, cxPx, cyPx);
          ctx.restore();
        }
      }
    }
  }, [renderedCanvas, subMode, sizeMm, offsetMm, bleedOffsetMm, showBleedContour, contoursMm, bleedAllMm, bleedEdges, fillMode, solidColorHex, zoom, selectedStickerIdx]);

  // Direct Mouse Wheel Zoom (up to 1000%)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Coalesce wheel ticks into 1 zoom update per animation frame (touchpads fire 60-120 wheel events/sec)
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
        setZoom((prev) => {
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
  }, []);

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
    viewportRef.current.scrollLeft = panStateRef.current.scrollLeft - (e.clientX - panStateRef.current.startX);
    viewportRef.current.scrollTop = panStateRef.current.scrollTop - (e.clientY - panStateRef.current.startY);
  };

  const stopPanning = () => {
    if (panStateRef.current.active) {
      panStateRef.current.active = false;
      setIsPanning(false);
    }
  };

  const handleExportPdf = async () => {
    if (!renderedCanvas) return;
    setLoading(true);
    try {
      let bytes;
      if (subMode === 'contour') {
        const padExport = Math.max(5, Math.max(0, offsetMm) + (showBleedContour ? Math.max(0, bleedOffsetMm) : 0) + 3);
        bytes = await exportContourTracedPdf(renderedCanvas, sizeMm.w, sizeMm.h, contoursMm, padExport, {
          sourceType,
          sourceFile,
          activePdfPage,
          includeBleedContour: showBleedContour && bleedOffsetMm > 0,
        });
      } else {
        bytes = await exportBleedExtendedPdf({
          sourceType,
          sourceFile,
          renderedCanvas,
          trimWmm: sizeMm.w,
          trimHmm: sizeMm.h,
          bleedEdges: {
            top: bleedEdges.top ? bleedAllMm : 0,
            bottom: bleedEdges.bottom ? bleedAllMm : 0,
            left: bleedEdges.left ? bleedAllMm : 0,
            right: bleedEdges.right ? bleedAllMm : 0,
          },
          fillMode,
          solidColorHex,
        });
      }
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const base = (sourceFile?.name || 'file').replace(/\.(pdf|png|jpg|jpeg)$/i, '');
      a.download = subMode === 'contour' ? `CutContour_${base}.pdf` : `Bleed_${base}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  };

  const handleSplitExport = async (sendToImpose = false, preferredLayout = 'nesting') => {
    if (!renderedCanvas || contoursMm.length === 0) return;
    setLoading(true);
    try {
      const padMm = showBleedContour ? Math.max(0.5, bleedOffsetMm) : 1.5;
      let bytes;
      let outName;
      const base = (sourceFile?.name || 'stickers').replace(/\.(pdf|png|jpg|jpeg)$/i, '');

      if (inputMode === 'single' || contoursMm.length === 1) {
        bytes = await exportContourTracedPdf(renderedCanvas, sizeMm.w, sizeMm.h, contoursMm, padMm + Math.max(1, offsetMm), {
          sourceType,
          sourceFile,
          activePdfPage,
          includeBleedContour: showBleedContour && bleedOffsetMm > 0,
        });
        outName = `CutContour_${base}.pdf`;
      } else {
        bytes = await exportSplitStickersPdf(renderedCanvas, sizeMm.w, sizeMm.h, contoursMm, padMm);
        outName = `Tach_${contoursMm.length}Tem_${base}.pdf`;
      }

      if (sendToImpose && onSendSplitStickersToImpose) {
        const fileObj = new File([bytes], outName, { type: 'application/pdf' });
        onSendSplitStickersToImpose(fileObj, preferredLayout);
        return;
      }

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-3 flex-1 min-w-0">
      {/* LEFT: CENTER CANVAS */}
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center justify-between shadow-xs gap-2.5">
        <div className="w-full flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="px-2.5 py-1 rounded-lg bg-[#E6F4EF] text-[#146C53] font-bold">
              {subMode === 'contour' ? `${contoursMm.length} tem nhận diện` : `Bleed +${bleedAllMm}mm`}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 font-semibold">
              {sizeMm.w}×{sizeMm.h}mm
            </span>
            {sourceType === 'pdf' && totalPdfPages > 1 && (
              <div className="flex items-center gap-1 bg-slate-100 rounded-lg px-2 py-0.5">
                <button
                  disabled={activePdfPage <= 1 || loading}
                  onClick={() => pdfBytesRef.current && renderPdfPageAt(pdfBytesRef.current, activePdfPage - 1)}
                  className="px-1 hover:text-[#146C53] disabled:opacity-30 cursor-pointer font-bold"
                >
                  ◀
                </button>
                <span className="text-[11px] font-bold text-slate-700">
                  Trang {activePdfPage}/{totalPdfPages}
                </span>
                <button
                  disabled={activePdfPage >= totalPdfPages || loading}
                  onClick={() => pdfBytesRef.current && renderPdfPageAt(pdfBytesRef.current, activePdfPage + 1)}
                  className="px-1 hover:text-[#146C53] disabled:opacity-30 cursor-pointer font-bold"
                >
                  ▶
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 bg-slate-100 rounded-lg px-2 py-1 text-xs font-mono text-slate-600">
            <button onClick={() => setZoom(1.0)} className="px-1.5 hover:text-[#146C53] font-sans font-semibold cursor-pointer">
              Fit
            </button>
            <button onClick={() => setZoom(2.0)} className="px-1.5 hover:text-[#146C53] text-[11px] cursor-pointer">
              200%
            </button>
            <button onClick={() => setZoom(4.0)} className="px-1.5 hover:text-[#146C53] text-[11px] cursor-pointer">
              400%
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.35, Math.round((z - (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))}
              className="px-1.5 hover:text-slate-900 cursor-pointer"
            >
              −
            </button>
            <span className="min-w-[46px] text-center font-bold text-[#146C53]">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(10.0, Math.round((z + (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))}
              className="px-1.5 hover:text-slate-900 cursor-pointer"
            >
              +
            </button>
          </div>
        </div>

        <div
          ref={viewportRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopPanning}
          onMouseLeave={stopPanning}
          title="Cuộn chuột để Phóng to / Thu nhỏ (tối đa 1000%) · Kéo chuột trái để di chuyển"
          className={`relative w-full h-[calc(100vh-190px)] min-h-[600px] rounded-2xl border border-slate-200 flex overflow-auto p-3 select-none ${
            isPanning ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{
            backgroundColor: '#fafbf9',
            backgroundImage:
              'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          {(loading || isTracing) && (
            <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-2xs flex items-center justify-center p-4 pointer-events-none">
              <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-2xl p-5 flex flex-col items-center gap-3 text-center">
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-4 border-emerald-100" />
                  <div className="absolute inset-0 rounded-full border-4 border-[#146C53] border-t-transparent animate-spin" />
                  <span className="text-[11px] font-extrabold font-mono text-[#146C53]">
                    {loading ? `${Math.max(10, loadPct)}%` : '300'}
                  </span>
                </div>
                <div className="text-xs font-extrabold text-slate-800">
                  {loading ? loadStage || 'Đang tải & kết xuất file ở 300 DPI...' : 'Đang dò đường bế Bézier & bù xén...'}
                </div>
                <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#146C53] to-emerald-400 transition-all duration-150 rounded-full"
                    style={{ width: `${loading ? Math.max(12, loadPct) : 92}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          <div className="m-auto shrink-0">
            <canvas ref={previewCanvasRef} className="bg-white shadow-md rounded border border-slate-200 block" />
          </div>
        </div>
        <div className="flex gap-4 mt-2.5 text-[11px] text-slate-500">
          {subMode === 'contour' ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t-2 border-pink-600 inline-block" /> Đường cắt Bézier (CUT — Magenta)
              </span>
              {showBleedContour && bleedOffsetMm > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-4 border-t-2 border-dashed border-sky-600 inline-block" /> Đường bù xén Bézier (BLEED — Cyan)
                </span>
              )}
              <span className="text-slate-400">· Ảnh nguồn: {actualDpi} DPI</span>
              {isTracing && <span className="text-violet-600 font-semibold animate-pulse">⏳ Đang dò lại đường bế...</span>}
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t border-blue-700 inline-block" /> Thành phẩm (TrimBox)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-4 border-t border-dashed border-red-500 inline-block" /> Vùng bù xén (BleedBox)
              </span>
            </>
          )}
        </div>
      </main>

      {/* MIDDLE-RIGHT: SETTINGS & EXPORT PANEL (PrynX 2-Phase Wizard Layout) */}
      <aside className="w-full lg:w-[345px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between gap-3 overflow-y-auto max-h-[calc(100vh-80px)] shrink-0 shadow-xs">
        <div className="flex flex-col gap-3">
          {/* Top Utility Header Bar: File Size MB Badge + Save / Undo / Close */}
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-mono font-bold">
              {sourceFile ? `${(sourceFile.size / (1024 * 1024)).toFixed(2)} MB` : `${sizeMm.w}×${sizeMm.h} mm`}
            </span>
            <div className="flex items-center gap-1.5 text-slate-400">
              <button
                onClick={handleExportPdf}
                disabled={!renderedCanvas || loading}
                title="Lưu / Xuất nhanh PDF"
                className="p-1 rounded hover:bg-slate-100 hover:text-[#146C53] disabled:opacity-30 cursor-pointer text-xs"
              >
                💾
              </button>
              <button
                onClick={() => {
                  setOffsetMm(0.5);
                  setBleedOffsetMm(1.5);
                  setCornerAngleDeg(130);
                  setSmoothLevel(1);
                  setSimplifyMm(0.18);
                  setMergeGapMm(0.35);
                  setBleedCompleted(false);
                  setSettingsOpen(true);
                }}
                title="Hoàn tác / Khôi phục mặc định"
                className="p-1 rounded hover:bg-slate-100 hover:text-amber-600 cursor-pointer text-xs"
              >
                ↩️
              </button>
              <button
                onClick={onOpenStickerImpose}
                title="Chuyển sang Bình Tem Bế"
                className="p-1 rounded hover:bg-slate-100 hover:text-slate-700 cursor-pointer text-xs"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="text-center pb-1">
            <div className="text-xs font-extrabold text-slate-800 tracking-wide">🔪 BÙ XÉN - TẠO ĐƯỜNG CẮT</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Quét hình ảnh, tự động offset viền và tràn lề cho tem nhãn.
            </div>
          </div>

          {/* Row 1: Input Mode Cards (PDF/PNG đã có biên vs Tách nhiều tem) */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                setInputMode('single');
                setMergeGapMm(2.5);
                setBleedCompleted(false);
              }}
              className={`py-2 px-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                inputMode === 'single'
                  ? 'bg-[#E6F4EF] border-[#146C53] text-[#146C53] shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span>📄</span>
              <span>PDF/PNG đã có biên</span>
            </button>
            <button
              onClick={() => {
                setInputMode('multi');
                setMergeGapMm(0.35);
                setBleedCompleted(false);
              }}
              className={`py-2 px-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                inputMode === 'multi'
                  ? 'bg-[#E6F4EF] border-[#146C53] text-[#146C53] shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span>🥞</span>
              <span>Tách nhiều tem</span>
            </button>
          </div>

          {/* Row 2: Output Cut Type Cards (Bế tem nhãn vs Xén vuông góc) */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                setSubMode('contour');
                setShapeMode('auto');
                setBleedCompleted(false);
              }}
              className={`py-2 px-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                subMode === 'contour' && shapeMode !== 'rect'
                  ? 'bg-indigo-50 border-indigo-500 text-indigo-700 shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span>🎯</span>
              <span>Bế tem nhãn</span>
            </button>
            <button
              onClick={() => {
                if (subMode === 'contour' && shapeMode === 'rect') {
                  setSubMode('bleed');
                } else {
                  setSubMode('contour');
                  setShapeMode('rect');
                }
                setBleedCompleted(false);
              }}
              className={`py-2 px-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                subMode === 'bleed' || shapeMode === 'rect'
                  ? 'bg-indigo-50 border-indigo-500 text-indigo-700 shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span>{subMode === 'bleed' || shapeMode === 'rect' ? '☑️' : '☐'}</span>
              <span>Xén vuông góc</span>
            </button>
          </div>

          {/* File Upload */}
          <div className="relative border border-dashed border-slate-300 hover:border-[#146C53] rounded-xl p-2.5 text-center cursor-pointer bg-[#FAFBF9]">
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.pdf"
              onChange={(e) => {
                handleUpload(e.target.files[0]);
                setBleedCompleted(false);
                setSettingsOpen(true);
                e.target.value = '';
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="text-xs font-semibold text-slate-700 truncate">
              {loading ? '⏳ Đang xử lý file...' : sourceFile ? `📄 ${sourceFile.name}` : '⬆️ Chọn ảnh PNG sticker hoặc file PDF'}
            </div>
            {renderedCanvas && (
              <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                Kích thước: {sizeMm.w} × {sizeMm.h} mm · Đã nhận diện {contoursMm.length} tem
              </div>
            )}
          </div>
          {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px]">⚠️ {error}</div>}

          {/* Accordion Header: THIẾT LẬP BÙ XÉN (Xem lại / chỉnh sửa ⌄) */}
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-bold text-slate-800 cursor-pointer"
          >
            <span>THIẾT LẬP BÙ XÉN</span>
            <span className="text-[11px] font-semibold text-slate-500">
              {settingsOpen ? 'Thu gọn ⌃' : 'Xem lại / chỉnh sửa ⌄'}
            </span>
          </button>

          {settingsOpen && (
            <div className="flex flex-col gap-3 px-0.5">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Rộng thực tế (mm)</label>
                  <input
                    type="number"
                    min="10"
                    value={sizeMm.w}
                    onChange={(e) => setSizeMm((s) => ({ ...s, w: Math.max(10, parseFloat(e.target.value) || 10) }))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Cao thực tế (mm)</label>
                  <input
                    type="number"
                    min="10"
                    value={sizeMm.h}
                    onChange={(e) => setSizeMm((s) => ({ ...s, h: Math.max(10, parseFloat(e.target.value) || 10) }))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
              </div>

          {subMode === 'contour' ? (
            <div className="flex flex-col gap-3 pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">Chỉnh đường bế (CutContour)</span>
                {renderedCanvas && (
                  <span className="px-2 py-0.5 rounded-full bg-[#E6F4EF] text-[#146C53] text-[10px] font-bold">
                    Đã nhận diện {contoursMm.length} tem
                  </span>
                )}
              </div>

              {/* Per-Sticker Selector Chips: Chỉnh chung Tất cả vs Chỉnh riêng từng tem (#1..#N) */}
              {contoursMm.length > 1 && (
                <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-200 rounded-xl p-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-bold text-slate-600">CHỌN TEM ĐỂ CHỈNH RIÊNG:</span>
                    {Object.keys(perStickerOverrides).length > 0 && (
                      <button
                        onClick={() => {
                          setPerStickerOverrides({});
                          setSelectedStickerIdx(null);
                        }}
                        className="text-rose-600 hover:underline font-semibold cursor-pointer"
                      >
                        Reset riêng
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                    <button
                      onClick={() => setSelectedStickerIdx(null)}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-bold cursor-pointer ${
                        selectedStickerIdx === null
                          ? 'bg-[#146C53] text-white'
                          : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      Tất cả ({contoursMm.length})
                    </button>
                    {contoursMm.map((poly, idx) => {
                      const cIdx = poly.compIdx !== undefined ? poly.compIdx : idx;
                      const hasOvr = Boolean(perStickerOverrides[cIdx]);
                      const isSel = selectedStickerIdx === cIdx;
                      return (
                        <button
                          key={cIdx}
                          onClick={() => setSelectedStickerIdx(isSel ? null : cIdx)}
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold cursor-pointer ${
                            isSel
                              ? 'bg-purple-600 text-white shadow-2xs'
                              : hasOvr
                              ? 'bg-purple-50 border border-purple-300 text-purple-700'
                              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          #{idx + 1}
                        </button>
                      );
                    })}
                  </div>

                  {selectedStickerIdx !== null && (
                    <div className="mt-1 pt-1.5 border-t border-purple-200/80 bg-purple-50/60 rounded-lg p-2 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-extrabold text-purple-800">
                          🎯 Đang chỉnh riêng Tem #{contoursMm.findIndex((p, i) => (p.compIdx ?? i) === selectedStickerIdx) + 1}
                        </span>
                        <button
                          onClick={() => {
                            setPerStickerOverrides((prev) => ({
                              ...prev,
                              [selectedStickerIdx]: { ...(prev[selectedStickerIdx] || {}), hidden: true },
                            }));
                            setSelectedStickerIdx(null);
                          }}
                          className="px-2 py-0.5 rounded bg-rose-100 hover:bg-rose-200 text-rose-700 text-[10px] font-bold cursor-pointer"
                        >
                          🗑️ Ẩn tem này
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[10px] text-purple-700 font-semibold">Khung riêng tem này</label>
                          <select
                            value={perStickerOverrides[selectedStickerIdx]?.shapeMode || 'default'}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPerStickerOverrides((prev) => ({
                                ...prev,
                                [selectedStickerIdx]: { ...(prev[selectedStickerIdx] || {}), shapeMode: val },
                              }));
                            }}
                            className="bg-white border border-purple-300 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-800"
                          >
                            <option value="default">Theo mặc định chung</option>
                            <option value="auto">Tự do (Freeform)</option>
                            <option value="rect">Chữ nhật vuông</option>
                            <option value="circle">Hình tròn</option>
                            <option value="oval">Hình Oval</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[10px] text-purple-700 font-semibold">Offset riêng (mm)</label>
                          <input
                            type="number"
                            min="-1.5"
                            max="6"
                            step="0.25"
                            placeholder={`${offsetMm}`}
                            value={
                              perStickerOverrides[selectedStickerIdx]?.offsetMm !== undefined
                                ? perStickerOverrides[selectedStickerIdx].offsetMm
                                : ''
                            }
                            onChange={(e) => {
                              const val = e.target.value;
                              setPerStickerOverrides((prev) => ({
                                ...prev,
                                [selectedStickerIdx]: {
                                  ...(prev[selectedStickerIdx] || {}),
                                  offsetMm: val === '' ? undefined : parseFloat(val),
                                },
                              }));
                            }}
                            className="bg-white border border-purple-300 rounded-lg px-2 py-1 text-[11px] font-mono text-slate-800"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-500">Hình dáng đường bế</label>
                <select
                  value={shapeMode}
                  onChange={(e) => setShapeMode(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-800"
                >
                  <option value="auto">Tự do theo hình (Freeform)</option>
                  <option value="circle">Ép Tròn chuẩn (Circle đều 100%)</option>
                  <option value="oval">Ép Oval / Elip chuẩn</option>
                  <option value="rect">Ép Chữ nhật vuông</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-600">Offset đường CẮT (CutContour)</span>
                  <span className="font-mono font-bold text-pink-600">{offsetMm > 0 ? `+${offsetMm}` : offsetMm} mm</span>
                </div>
                <input
                  type="range"
                  min="-1.5"
                  max="5"
                  step="0.25"
                  value={offsetMm}
                  onChange={(e) => setOffsetMm(parseFloat(e.target.value))}
                  className="w-full accent-pink-600"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[11px]">
                  <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showBleedContour}
                      onChange={(e) => setShowBleedContour(e.target.checked)}
                      className="accent-sky-600"
                    />
                    <span>Offset đường BÙ XÉN (Bleed)</span>
                  </label>
                  <span className="font-mono font-bold text-sky-600">
                    {showBleedContour ? `+${bleedOffsetMm} mm` : 'Tắt (0 mm)'}
                  </span>
                </div>
                {showBleedContour && (
                  <input
                    type="range"
                    min="0"
                    max="5"
                    step="0.25"
                    value={bleedOffsetMm}
                    onChange={(e) => setBleedOffsetMm(parseFloat(e.target.value))}
                    className="w-full accent-sky-600"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Bảo toàn góc nhọn (&le; °)</label>
                  <input
                    type="number"
                    min="60"
                    max="165"
                    step="5"
                    value={cornerAngleDeg}
                    onChange={(e) => setCornerAngleDeg(Math.max(60, Math.min(165, parseInt(e.target.value, 10) || 130)))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Khử răng cưa (0-3)</label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    step="1"
                    value={smoothLevel}
                    onChange={(e) => setSmoothLevel(Math.max(0, Math.min(3, parseInt(e.target.value, 10) || 0)))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Độ bám (~0.18)</label>
                  <input
                    type="number"
                    min="0.05"
                    max="2"
                    step="0.05"
                    value={simplifyMm}
                    onChange={(e) => setSimplifyMm(Math.max(0.05, parseFloat(e.target.value) || 0.18))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500" title="Gộp các chữ/chi tiết rời nằm gần nhau vào cùng 1 tem (mm)">
                    Gộp chữ (mm)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="8"
                    step="0.25"
                    value={mergeGapMm}
                    onChange={(e) => setMergeGapMm(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">Lọc nhiễu (mm²)</label>
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={minAreaMm2}
                    onChange={(e) => setMinAreaMm2(Math.max(0.5, parseFloat(e.target.value) || 4))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
              </div>

              {contoursMm.validation && contoursMm.length > 0 && (
                <div
                  className={`rounded-xl p-2.5 border text-[11px] flex flex-col gap-1 ${
                    contoursMm.validation.valid
                      ? 'bg-[#E6F4EF]/70 border-emerald-300 text-[#112A24]'
                      : 'bg-amber-50 border-amber-300 text-amber-900'
                  }`}
                >
                  <div className="font-bold flex items-center justify-between">
                    <span>
                      {contoursMm.validation.valid ? '✓ Kiểm tra hình học đạt chuẩn' : '⚠️ Cảnh báo hình học'}
                    </span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/80 font-bold">
                      {actualDpi} DPI
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-slate-600 leading-relaxed">
                    • {contoursMm.validation.closedCount}/{contoursMm.validation.stickerCount} Path Bézier CUT khép kín
                    {showBleedContour && contoursMm.validation.bleedPathCount > 0
                      ? ` + ${contoursMm.validation.bleedPathCount} Path BLEED`
                      : ''}
                    <br />• {contoursMm.validation.totalBezierSegments} đoạn Cubic Bézier · {contoursMm.validation.totalSharpCorners} góc nhọn (&le;{cornerAngleDeg}°)
                    <br />• Tự giao: {contoursMm.validation.selfIntersections} · Va chạm giữa các tem:{' '}
                    {contoursMm.validation.collisions.length === 0
                      ? '0'
                      : `${contoursMm.validation.collisions.length} cặp`}
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-[#146C53]"
                  checked={ignoreCornerMarks}
                  onChange={(e) => setIgnoreCornerMarks(e.target.checked)}
                />
                Bỏ qua 4 boong góc khi dò tem
              </label>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-2 border-t border-slate-100">
              <span className="text-xs font-bold text-slate-800">Thiết lập bù tràn lề 4 cạnh</span>
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-600">Độ rộng bù xén (Bleed)</span>
                  <span className="font-mono font-bold text-[#146C53]">{bleedAllMm} mm</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="6"
                  step="0.5"
                  value={bleedAllMm}
                  onChange={(e) => setBleedAllMm(parseFloat(e.target.value))}
                  className="w-full accent-[#146C53]"
                />
              </div>

              <div className="grid grid-cols-4 gap-1.5 text-[11px]">
                {[
                  ['top', '↑ Trên'],
                  ['bottom', '↓ Dưới'],
                  ['left', '← Trái'],
                  ['right', '→ Phải'],
                ].map(([k, lbl]) => (
                  <button
                    key={k}
                    onClick={() => setBleedEdges((prev) => ({ ...prev, [k]: !prev[k] }))}
                    className={`py-1.5 rounded-lg border font-semibold cursor-pointer ${
                      bleedEdges[k]
                        ? 'bg-[#E6F4EF] border-[#146C53] text-[#146C53]'
                        : 'bg-slate-50 border-slate-200 text-slate-400'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-500">Thuật toán bù mép</label>
                <select
                  value={fillMode}
                  onChange={(e) => setFillMode(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold"
                >
                  <option value="mirror">Phản chiếu mép (Mirror — Đẹp nhất cho ảnh)</option>
                  <option value="stretch">Kéo giãn mép (Edge Stretch)</option>
                  <option value="solid">Đổ màu trơn</option>
                </select>
              </div>

              {fillMode === 'solid' && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-600">Màu nền bù:</span>
                  <input
                    type="color"
                    value={solidColorHex}
                    onChange={(e) => setSolidColorHex(e.target.value)}
                    className="w-10 h-7 rounded border border-slate-200 cursor-pointer"
                  />
                </div>
              )}
            </div>
          )}
            </div>
          )}

          {/* Phase 2 Green Handoff Card (Exact Image 1 UX: Đã tạo bù xén thành công -> Chọn kiểu dàn trang) */}
          {renderedCanvas && (
            <div className="rounded-2xl border border-emerald-200 bg-[#E6F4EF]/55 p-3 flex flex-col gap-2.5 mt-1">
              <div className="flex items-start gap-2">
                <span className="w-6 h-6 rounded-full bg-emerald-100 text-[#146C53] flex items-center justify-center text-xs font-bold shrink-0">
                  ✓
                </span>
                <div>
                  <div className="text-xs font-bold text-[#146C53]">
                    Đã tạo bù xén thành công ({contoursMm.length} tem)!
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Bước tiếp theo: Chọn kiểu dàn trang (Imposition)
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleSplitExport(true, 'optimal')}
                disabled={loading || contoursMm.length === 0}
                className="w-full p-2.5 rounded-xl bg-white hover:bg-emerald-50/60 border border-slate-200 hover:border-[#146C53] flex items-center justify-between gap-2 text-left transition-all cursor-pointer shadow-2xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-lg shrink-0">✂️</span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800">Bình bài Bế Tem</div>
                    <div className="text-[11px] text-slate-500 truncate">Xếp tem bế so le / lưới tiêu chuẩn</div>
                  </div>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-extrabold shrink-0">
                  PRO
                </span>
              </button>

              <button
                onClick={() => handleSplitExport(true, 'nesting')}
                disabled={loading || contoursMm.length === 0}
                className="w-full p-2.5 rounded-xl bg-white hover:bg-emerald-50/60 border border-slate-200 hover:border-[#146C53] flex items-center justify-between gap-2 text-left transition-all cursor-pointer shadow-2xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-lg shrink-0">🔗</span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800">Bình lồng ghép tự do</div>
                    <div className="text-[11px] text-slate-500 truncate">Xếp nhiều loại khuôn, xoay tự do mọi góc</div>
                  </div>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-extrabold shrink-0">
                  PRO
                </span>
              </button>

              {!settingsOpen && (
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="text-[11px] font-semibold text-slate-500 hover:text-[#146C53] text-center pt-0.5 cursor-pointer"
                >
                  Quay lại chỉnh sửa bù xén
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-2.5 border-t border-slate-100">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={handleExportPdf}
              disabled={loading || !renderedCanvas}
              className={`py-2 px-2 rounded-xl text-[11px] font-bold transition-colors cursor-pointer ${
                loading || !renderedCanvas
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-[#146C53] hover:bg-[#0f5440] text-white shadow-xs'
              }`}
            >
              {loading ? 'Đang xử lý...' : '✂️ Tải PDF nguyên tờ'}
            </button>
            <button
              onClick={() => handleSplitExport(false)}
              disabled={loading || contoursMm.length === 0}
              className="py-2 px-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-40"
            >
              📑 Tách {contoursMm.length} trang PDF
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
