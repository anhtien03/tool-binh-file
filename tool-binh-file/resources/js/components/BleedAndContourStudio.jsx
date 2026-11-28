import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PkIcon } from './PrintKitUI';
import {
  buildPaperTransparentCanvas,
  drawContourBleedFillPreview,
  buildBleedFilledExportCanvas,
} from '../engine/contourBleedFill.js';
import { MM_TO_PT } from '../engine/impositionEngine.js';
import {
  extractStickerContoursFromImage,
  extractPdfImagePlacementsMm,
  exportBleedExtendedPdf,
  exportContourTracedPdf,
  exportSplitStickersPdf,
  TARGET_PRINT_DPI,
} from '../engine/bleedContourEngine.js';
import {
  runVectorFirstPdfImport,
  resolveVectorFirstContours,
  CONTOUR_PROVENANCE,
} from '../engine/vectorFirstPipeline.js';
import {
  PAGE_STAGE,
  PAGE_STAGE_META,
  computeFileSignature,
  computeBleedSettingsSignature,
  createInitialPageStates,
  validatePageOwnership,
  getEffectivePageStage,
  partitionPagesForHandoff,
} from '../engine/studioMultiPageState.js';
import {
  DIELINE_MODES,
  DIELINE_MODE_OPTIONS,
  MANUAL_EDIT_TOOLS,
  mapSliderControlsToTracerParams,
  preprocessCanvasForTracing,
  applyCornerRoundingMm,
  mergeSelectedContours,
  resolveDielineModeContours,
  extractPdfTrimBleedBoxesMm,
  buildContourFromTrimBoxMm,
} from '../engine/contourEditHelpers.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export default function BleedAndContourStudio({
  initialFile,
  onSharedFileChange,
  onOpenStickerImpose,
  onSendSplitStickersToImpose,
  onSendV1StickersToImpose,
  settingsCollapsed = false,
  onToggleSettings,
  isFocusMode = false,
  onToggleFocusMode,
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
  const [detailMode, setDetailMode] = useState('standard'); // 'standard' | 'high'
  const [offsetMm, setOffsetMm] = useState(0.5); // CutContour offset from artwork edge (mm)
  const [bleedOffsetMm, setBleedOffsetMm] = useState(1.5); // Outward Bleed offset from CutContour (mm)
  const [showBleedContour, setShowBleedContour] = useState(true);
  const [contourBleedFillMode, setContourBleedFillMode] = useState('auto'); // 'auto' | 'solid' | 'off'
  const [contourBleedColorHex, setContourBleedColorHex] = useState('#f2ead3');

  const transparentArtworkCanvas = useMemo(() => {
    if (!renderedCanvas) return null;
    try {
      return buildPaperTransparentCanvas(renderedCanvas);
    } catch {
      return renderedCanvas;
    }
  }, [renderedCanvas]);
  const [showAdvancedTrace, setShowAdvancedTrace] = useState(false);
  const [dielineMode, setDielineMode] = useState(DIELINE_MODES.ORIGINAL);
  const [shadowRemovalMode, setShadowRemovalMode] = useState('keep');
  const [antiAliasPct, setAntiAliasPct] = useState(50);
  const [fidelityPct, setFidelityPct] = useState(50);
  const [cornerRadiusMm, setCornerRadiusMm] = useState(0);
  const [manualEditTool, setManualEditTool] = useState(MANUAL_EDIT_TOOLS.NONE);
  const [brushRadiusMm, setBrushRadiusMm] = useState(2.5);
  const [manualMaskRevision, setManualMaskRevision] = useState(0);
  const [mergedGroups, setMergedGroups] = useState([]);
  const [selectedStickerIndices, setSelectedStickerIndices] = useState([]);
  const manualMaskCanvasRef = useRef(null);
  const isBrushToolActive =
    manualEditTool === MANUAL_EDIT_TOOLS.ERASE_SHADOW || manualEditTool === MANUAL_EDIT_TOOLS.KEEP_REGION;
  const [cornerAngleDeg, setCornerAngleDeg] = useState(130); // Preserve sharp corners <= 130°
  const [smoothLevel, setSmoothLevel] = useState(1);
  const [simplifyMm, setSimplifyMm] = useState(0.18); // ~0.45px equivalent
  const [minAreaMm2, setMinAreaMm2] = useState(8.0);
  const [mergeGapMm, setMergeGapMm] = useState(0.35); // Intra-sticker detail merge gap (mm)
  const [ignoreCornerMarks, setIgnoreCornerMarks] = useState(true);
  const [contoursMm, setContoursMm] = useState([]);
  const [imagePlacementsMm, setImagePlacementsMm] = useState([]);
  const [vectorImportResult, setVectorImportResult] = useState(null);
  const [pdfTrimBleedInfo, setPdfTrimBleedInfo] = useState(null);
  const [forceRasterFallback, setForceRasterFallback] = useState(false);
  const [contourProvenance, setContourProvenance] = useState({
    provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
    badgeLabel: 'RASTER — STANDARD',
    badgeTone: 'slate',
    selectionMode: null,
    fallbackReason: null,
    warnings: [],
    requiresUserConfirmation: false,
  });
  const [inputMode, setInputMode] = useState('multi'); // 'single' (PDF/PNG đã có biên) | 'multi' (Tách nhiều tem)
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [bleedCompleted, setBleedCompleted] = useState(false);
  const [handoffPageExpr, setHandoffPageExpr] = useState(''); // '' = trang hiện tại | 'all' | '1-7' | '1,3,5'
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
  const pdfFileSigRef = useRef('');
  const pdfPageCacheRef = useRef(new Map());
  const batchCancelRef = useRef(false);
  const [pageStates, setPageStates] = useState({});
  const [batchProgress, setBatchProgress] = useState(null); // { current, total, pageNum, stageText }
  const [handoffWarning, setHandoffWarning] = useState('');
  const viewportRef = useRef(null);
  const panStateRef = useRef({ active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });
  const previewCanvasRef = useRef(null);

  const currentBleedSig = useMemo(
    () =>
      computeBleedSettingsSignature({
        offsetMm,
        bleedOffsetMm,
        showBleedContour,
        contourBleedFillMode,
        contourBleedColorHex,
        shapeMode,
      }),
    [offsetMm, bleedOffsetMm, showBleedContour, contourBleedFillMode, contourBleedColorHex, shapeMode]
  );

  const updatePageStateRecord = (pNum, patch) => {
    setPageStates((prev) => {
      const existing = prev[pNum] || {
        pageNum: pNum,
        fileSignature: pdfFileSigRef.current,
        stage: PAGE_STAGE.PDF_LOADED,
        hasPreview: false,
        hasCut: false,
        hasBleed: false,
        contourCount: 0,
        bleedSignature: null,
        errorMessage: null,
      };
      return {
        ...prev,
        [pNum]: { ...existing, ...patch },
      };
    });
  };

  const renderPdfPageAt = async (bytes, pageNum, fileSigOverride = null) => {
    const activeSig = fileSigOverride || pdfFileSigRef.current;
    const cached = pdfPageCacheRef.current.get(pageNum);
    if (cached && cached.bytesRef === bytes && cached.fileSignature === activeSig) {
      setTotalPdfPages(cached.totalPages);
      setActivePdfPage(pageNum);
      setSizeMm({ w: cached.wMm, h: cached.hMm });
      setActualDpi(cached.actualDpi);
      setImagePlacementsMm(cached.placements);
      setVectorImportResult(cached.vecRes);
      setPdfTrimBleedInfo(cached.trimBleedInfo || null);
      setForceRasterFallback(false);
      if (cached.vecRes?.status === 'OK') {
        setOffsetMm(0);
        setShapeMode('auto');
        setPerStickerOverrides({});
      }
      setLoadPct(100);
      setRenderedCanvas(cached.canvas);
      return;
    }

    setLoadPct(18);
    setLoadStage('Đang giải mã cấu trúc trang PDF...');
    await new Promise((r) => setTimeout(r, 0));
    const isLocalDesktop = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: isLocalDesktop ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: isLocalDesktop
        ? '/standard_fonts/'
        : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
    }).promise;
    setTotalPdfPages(pdf.numPages);
    setPageStates((prev) => {
      if (Object.keys(prev).length === pdf.numPages && prev[1]?.fileSignature === activeSig) return prev;
      return createInitialPageStates(pdf.numPages, activeSig);
    });
    const safePage = Math.max(1, Math.min(pdf.numPages, pageNum));
    setActivePdfPage(safePage);
    const page = await pdf.getPage(safePage);
    const vp1 = page.getViewport({ scale: 1.0 });
    const wMm = vp1.width / MM_TO_PT;
    const hMm = vp1.height / MM_TO_PT;
    setSizeMm({ w: wMm, h: hMm });

    // Render at true 300 DPI (300 / 72 = 4.1667x scale), safely capped at 4800px max dimension
    const scale300 = TARGET_PRINT_DPI / 72;
    const maxSafeScale = 4800 / Math.max(1, vp1.width, vp1.height);
    const renderScale = Math.min(scale300, maxSafeScale);
    const pageDpi = Math.round(renderScale * 72);
    setActualDpi(pageDpi);

    setLoadPct(52);
    setLoadStage(`Đang kết xuất trang ${safePage}/${pdf.numPages} ở độ phân giải ${pageDpi} DPI...`);
    await new Promise((r) => setTimeout(r, 0));

    const vp = page.getViewport({ scale: renderScale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    // Pass transparent background so PDFs without a full-page white rect preserve their native vector/SMask Alpha channel!
    await page.render({ canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    updatePageStateRecord(safePage, {
      fileSignature: activeSig,
      stage: PAGE_STAGE.PREVIEW_READY,
      hasPreview: true,
      errorMessage: null,
    });

    setLoadPct(85);
    setLoadStage('Đang kiểm tra vector gốc & trích xuất tọa độ đối tượng...');
    await new Promise((r) => setTimeout(r, 0));
    const placements = await extractPdfImagePlacementsMm(bytes, safePage);
    setImagePlacementsMm(placements);
    const trimBleedInfo = await extractPdfTrimBleedBoxesMm(bytes, safePage);
    setPdfTrimBleedInfo(trimBleedInfo);

    let vecRes = null;
    try {
      vecRes = await runVectorFirstPdfImport(bytes, { pageNumber: safePage, minAreaMm2 });
      const own = validatePageOwnership({
        expectedPageNum: safePage,
        expectedFileSignature: activeSig,
        actualFileSignature: activeSig,
        vecRes,
      });
      if (!own.ok) throw new Error(own.reason);
    } catch (vecErr) {
      vecRes = {
        status: 'FALLBACK_TO_RASTER',
        provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
        pageNumber: safePage,
        contours: [],
        warnings: [`Không thể phân tích luồng vector PDF (${vecErr?.message || 'lỗi định dạng'}) — chuyển sang Raster Fallback`],
        reasons: ['VECTOR_IMPORT_ERROR'],
      };
    }
    setVectorImportResult(vecRes);
    setForceRasterFallback(false);
    if (vecRes?.status === 'OK' && Array.isArray(vecRes.contours) && vecRes.contours.length > 0) {
      // Preserve 100% VECTOR_ORIGINAL by defaulting offset to 0mm on valid vector PDFs
      setOffsetMm(0);
      setShapeMode('auto');
      setPerStickerOverrides({});
      updatePageStateRecord(safePage, {
        fileSignature: activeSig,
        stage: PAGE_STAGE.CUT_READY,
        hasPreview: true,
        hasCut: true,
        contourCount: vecRes.contours.length,
        errorMessage: null,
      });
    } else {
      updatePageStateRecord(safePage, {
        fileSignature: activeSig,
        stage: PAGE_STAGE.NO_CUT,
        hasPreview: true,
        hasCut: false,
        hasBleed: false,
        contourCount: 0,
        errorMessage: vecRes?.warnings?.[0] || 'Trang không có đường bế vector hợp lệ',
      });
    }

    pdfPageCacheRef.current.set(safePage, {
      bytesRef: bytes,
      fileSignature: activeSig,
      totalPages: pdf.numPages,
      canvas: c,
      wMm,
      hMm,
      actualDpi: pageDpi,
      placements,
      vecRes,
      trimBleedInfo,
      bleedArtifact: null,
    });

    setLoadPct(100);
    setRenderedCanvas(c);
  };

  const runBatchProcessPages = async (pagesToRun = null) => {
    if (sourceType !== 'pdf' || !pdfBytesRef.current || totalPdfPages <= 1) return;
    const bytes = pdfBytesRef.current;
    const activeSig = pdfFileSigRef.current;
    const applyBleedFill = showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
    const effBleedMm = showBleedContour ? bleedOffsetMm : 0;
    const targetList =
      Array.isArray(pagesToRun) && pagesToRun.length > 0
        ? pagesToRun
        : Array.from({ length: totalPdfPages }, (_, i) => i + 1);

    batchCancelRef.current = false;
    setError('');
    setHandoffWarning('');
    setLoading(true);

    try {
      const isLocalDesktop = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
      let pdfDoc = null;
      const ensurePdfDoc = async () => {
        if (!pdfDoc) {
          pdfDoc = await pdfjsLib.getDocument({
            data: bytes.slice(),
            cMapUrl: isLocalDesktop ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: isLocalDesktop
              ? '/standard_fonts/'
              : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
          }).promise;
        }
        return pdfDoc;
      };

      for (let idx = 0; idx < targetList.length; idx++) {
        if (batchCancelRef.current) break;
        const pNum = targetList[idx];
        const existingRec = pageStates[pNum];
        const existingStage = getEffectivePageStage(existingRec, currentBleedSig);
        const existingCache = pdfPageCacheRef.current.get(pNum);

        // Already BLEED_READY for current settings & valid cache -> skip
        if (
          existingStage === PAGE_STAGE.BLEED_READY &&
          existingCache?.fileSignature === activeSig &&
          existingCache?.bleedArtifact?.bleedSignature === currentBleedSig
        ) {
          setBatchProgress({
            current: idx + 1,
            total: targetList.length,
            pageNum: pNum,
            stageText: `Trang ${pNum} đã BLEED Ready (dùng cache)`,
          });
          continue;
        }

        setBatchProgress({
          current: idx + 1,
          total: targetList.length,
          pageNum: pNum,
          stageText:
            existingStage === PAGE_STAGE.CUT_READY
              ? `Cập nhật BLEED trang ${pNum}/${targetList.length}...`
              : `Đang bóc tách trang ${pNum}/${targetList.length}...`,
        });
        await new Promise((r) => setTimeout(r, 0));

        let cachedPg = existingCache && existingCache.fileSignature === activeSig ? existingCache : null;
        if (!cachedPg || !cachedPg.canvas || !cachedPg.vecRes) {
          try {
            const doc = await ensurePdfDoc();
            const pdfPage = await doc.getPage(pNum);
            const vp1 = pdfPage.getViewport({ scale: 1.0 });
            const pgWmm = vp1.width / MM_TO_PT;
            const pgHmm = vp1.height / MM_TO_PT;
            const scale300 = TARGET_PRINT_DPI / 72;
            const maxSafeScale = 4800 / Math.max(1, vp1.width, vp1.height);
            const renderScale = Math.min(scale300, maxSafeScale);
            const vp = pdfPage.getViewport({ scale: renderScale });
            const pgCanvas = document.createElement('canvas');
            pgCanvas.width = Math.round(vp.width);
            pgCanvas.height = Math.round(vp.height);
            await pdfPage.render({
              canvasContext: pgCanvas.getContext('2d', { willReadFrequently: true }),
              viewport: vp,
              background: 'rgba(0,0,0,0)',
            }).promise;

            updatePageStateRecord(pNum, {
              fileSignature: activeSig,
              stage: PAGE_STAGE.PREVIEW_READY,
              hasPreview: true,
              errorMessage: null,
            });

            const vecRes = await runVectorFirstPdfImport(bytes, { pageNumber: pNum, minAreaMm2 });
            const own = validatePageOwnership({
              expectedPageNum: pNum,
              expectedFileSignature: activeSig,
              actualFileSignature: activeSig,
              vecRes,
            });
            if (!own.ok) throw new Error(own.reason);

            cachedPg = {
              bytesRef: bytes,
              fileSignature: activeSig,
              totalPages: doc.numPages,
              canvas: pgCanvas,
              wMm: pgWmm,
              hMm: pgHmm,
              actualDpi: Math.round(renderScale * 72),
              placements: [],
              vecRes,
              bleedArtifact: null,
            };
            pdfPageCacheRef.current.set(pNum, cachedPg);
          } catch (pgErr) {
            updatePageStateRecord(pNum, {
              fileSignature: activeSig,
              stage: PAGE_STAGE.ERROR,
              hasCut: false,
              hasBleed: false,
              contourCount: 0,
              errorMessage: pgErr?.message || `Lỗi bóc tách trang ${pNum}`,
            });
            continue;
          }
        }

        // Resolve CUT & BLEED strictly from this page's own vecRes
        const ownCheck = validatePageOwnership({
          expectedPageNum: pNum,
          expectedFileSignature: activeSig,
          actualFileSignature: cachedPg.fileSignature,
          vecRes: cachedPg.vecRes,
        });
        if (!ownCheck.ok) {
          updatePageStateRecord(pNum, {
            fileSignature: activeSig,
            stage: PAGE_STAGE.ERROR,
            hasCut: false,
            hasBleed: false,
            errorMessage: ownCheck.reason,
          });
          continue;
        }

        const resolved = resolveVectorFirstContours(cachedPg.vecRes, {
          offsetMm,
          bleedOffsetMm: applyBleedFill ? effBleedMm : 0,
          shapeMode,
          pageWidthMm: cachedPg.vecRes?.pageWidthMm || cachedPg.wMm,
          pageHeightMm: cachedPg.vecRes?.pageHeightMm || cachedPg.hMm,
        });

        if (!resolved.contoursMm || resolved.contoursMm.length === 0) {
          updatePageStateRecord(pNum, {
            fileSignature: activeSig,
            stage: PAGE_STAGE.NO_CUT,
            hasPreview: true,
            hasCut: false,
            hasBleed: false,
            contourCount: 0,
            bleedSignature: null,
            errorMessage: 'Không tìm thấy đường bế vector hợp lệ',
          });
          continue;
        }

        updatePageStateRecord(pNum, {
          fileSignature: activeSig,
          stage: PAGE_STAGE.CUT_READY,
          hasPreview: true,
          hasCut: true,
          contourCount: resolved.contoursMm.length,
          errorMessage: null,
        });

        const cleanPgCanvas = applyBleedFill
          ? buildBleedFilledExportCanvas(
            cachedPg.canvas,
            buildPaperTransparentCanvas(cachedPg.canvas),
            { w: cachedPg.wMm, h: cachedPg.hMm },
            resolved.contoursMm,
            { mode: contourBleedFillMode, solidColorHex: contourBleedColorHex }
          )
          : cachedPg.canvas;
        const pgBlob = await new Promise((resolve) => cleanPgCanvas.toBlob(resolve, 'image/png'));
        if (!pgBlob) {
          updatePageStateRecord(pNum, {
            fileSignature: activeSig,
            stage: PAGE_STAGE.ERROR,
            hasBleed: false,
            errorMessage: `Không thể tạo ảnh BLEED cho trang ${pNum}`,
          });
          continue;
        }
        const pgBytes = new Uint8Array(await pgBlob.arrayBuffer());
        cachedPg.bleedArtifact = {
          pageNum: pNum,
          bleedSignature: currentBleedSig,
          cleanArtworkCanvas: cleanPgCanvas,
          cleanArtworkBytes: pgBytes,
          sourceSizeMm: { w: cachedPg.wMm, h: cachedPg.hMm },
          contoursMm: resolved.contoursMm,
          bleedOffsetMm: effBleedMm,
          contourProvenance: resolved.provenance,
        };
        pdfPageCacheRef.current.set(pNum, cachedPg);

        updatePageStateRecord(pNum, {
          fileSignature: activeSig,
          stage: PAGE_STAGE.BLEED_READY,
          hasPreview: true,
          hasCut: true,
          hasBleed: true,
          contourCount: resolved.contoursMm.length,
          bleedSignature: currentBleedSig,
          errorMessage: null,
        });
      }
    } finally {
      setBatchProgress(null);
      setLoading(false);
    }
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
        const fileSig = computeFileSignature(bytes, file.name);
        pdfPageCacheRef.current.clear();
        pdfFileSigRef.current = fileSig;
        pdfBytesRef.current = bytes;
        setPageStates({});
        setHandoffWarning('');
        await renderPdfPageAt(bytes, 1, fileSig);
      } else {
        setSourceType('image');
        pdfPageCacheRef.current.clear();
        pdfFileSigRef.current = '';
        pdfBytesRef.current = null;
        setPageStates({});
        setHandoffWarning('');
        setVectorImportResult(null);
        setForceRasterFallback(false);
        setOffsetMm(0.5);
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

  // Re-trace contours asynchronously with stale-run cancellation so UI never shows outdated results
  const traceSeqRef = useRef(0);
  useEffect(() => {
    const runSeq = ++traceSeqRef.current;
    if (!renderedCanvas || subMode !== 'contour') {
      setContoursMm([]);
      setIsTracing(false);
      return;
    }
    // Debounce: while user drags a slider, only re-trace after they pause (~250ms) instead of on every tick
    setIsTracing(true);
    const timer = setTimeout(() => {
      if (runSeq !== traceSeqRef.current) return;
      try {
        // Prepress "PDF/PNG đã có biên" (explicit TrimBox + existing Bleed 2-3mm, no explicit CutContour layer)
        if (
          sourceType === 'pdf' &&
          inputMode === 'single' &&
          pdfTrimBleedInfo?.hasExplicitTrimBox &&
          vectorImportResult?.selectionMode !== 'EXPLICIT_CUT_LAYER' &&
          !forceRasterFallback
        ) {
          const trimContours = buildContourFromTrimBoxMm(pdfTrimBleedInfo, {
            offsetMm,
            extraBleedMm: showBleedContour ? bleedOffsetMm : 0,
          });
          const finalContours = applyPostContourEdits(trimContours);
          setContoursMm(finalContours);
          const hasBuiltInBleed = Boolean(pdfTrimBleedInfo.hasExistingBleed);
          const bMin = pdfTrimBleedInfo.existingBleedMm?.min || 0;
          setContourProvenance({
            provenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
            badgeLabel: hasBuiltInBleed
              ? `PDF TRIMBOX — CÓ SẴN BLEED (+${bMin.toFixed(1)}mm)`
              : 'PDF TRIMBOX — ĐÃ CÓ BIÊN',
            badgeTone: 'emerald',
            selectionMode: 'PDF_TRIMBOX',
            fallbackReason: null,
            warnings: [],
            requiresUserConfirmation: false,
          });
          setError('');

          const activeSig = pdfFileSigRef.current;
          const cachedActive = pdfPageCacheRef.current.get(activePdfPage);
          if (activeSig && cachedActive && cachedActive.fileSignature === activeSig) {
            // Preserve designer's existing bleed pixels untouched (no double-bleed fill!)
            const effBleedNow = hasBuiltInBleed ? bMin : showBleedContour ? bleedOffsetMm : 0;
            const needExtraFill = !hasBuiltInBleed && showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
            const cleanPgCanvas = needExtraFill
              ? buildBleedFilledExportCanvas(
                cachedActive.canvas,
                buildPaperTransparentCanvas(cachedActive.canvas),
                { w: cachedActive.wMm, h: cachedActive.hMm },
                finalContours,
                { mode: contourBleedFillMode, solidColorHex: contourBleedColorHex }
              )
              : cachedActive.canvas;
            cleanPgCanvas.toBlob(async (pgBlob) => {
              if (runSeq !== traceSeqRef.current || !pgBlob) return;
              const pgBytes = new Uint8Array(await pgBlob.arrayBuffer());
              if (runSeq !== traceSeqRef.current) return;
              cachedActive.bleedArtifact = {
                pageNum: activePdfPage,
                bleedSignature: currentBleedSig,
                cleanArtworkCanvas: cleanPgCanvas,
                cleanArtworkBytes: pgBytes,
                sourceSizeMm: { w: cachedActive.wMm, h: cachedActive.hMm },
                contoursMm: finalContours,
                bleedOffsetMm: effBleedNow,
                contourProvenance: CONTOUR_PROVENANCE.VECTOR_ORIGINAL,
              };
              pdfPageCacheRef.current.set(activePdfPage, cachedActive);
              updatePageStateRecord(activePdfPage, {
                fileSignature: activeSig,
                stage: PAGE_STAGE.BLEED_READY,
                hasPreview: true,
                hasCut: true,
                hasBleed: true,
                contourCount: finalContours.length,
                bleedSignature: currentBleedSig,
                errorMessage: null,
              });
            }, 'image/png');
          }
          return;
        }

        // Strict mode separation: "PDF/PNG đã có biên" MUST NOT silently split a multi-sticker PDF
        // that has neither an explicit CutContour layer nor an explicit TrimBox/BleedBox!
        if (
          sourceType === 'pdf' &&
          inputMode === 'single' &&
          !pdfTrimBleedInfo?.hasExplicitTrimBox &&
          vectorImportResult?.selectionMode !== 'EXPLICIT_CUT_LAYER' &&
          !forceRasterFallback
        ) {
          const detectedLooseCount = Array.isArray(vectorImportResult?.contours)
            ? vectorImportResult.contours.length
            : 0;
          setContoursMm([]);
          setContourProvenance({
            provenance: CONTOUR_PROVENANCE.VECTOR_IMPORT_REJECTED,
            badgeLabel: 'CHƯA CÓ BIÊN SẴN (TRIMBOX / CUTCONTOUR)',
            badgeTone: 'amber',
            selectionMode: 'SINGLE_MODE_NO_BOUNDARY',
            fallbackReason:
              detectedLooseCount > 1
                ? `PDF chưa có TrimBox/Bleed hay layer CutContour sẵn (phát hiện ${detectedLooseCount} tem rời).`
                : 'PDF chưa có TrimBox/Bleed hay layer CutContour sẵn.',
            warnings: [],
            requiresUserConfirmation: false,
          });
          setError('');
          return;
        }

        // Vector First Pipeline for PDFs (Points A, B, C, E)
        if (sourceType === 'pdf' && vectorImportResult && !forceRasterFallback) {
          const resolved = resolveVectorFirstContours(vectorImportResult, {
            offsetMm,
            bleedOffsetMm: showBleedContour ? bleedOffsetMm : 0,
            shapeMode,
            pageWidthMm: sizeMm.w,
            pageHeightMm: sizeMm.h,
            perStickerOverrides,
          });
          if (runSeq !== traceSeqRef.current) return;

          if (resolved.mode === 'VECTOR_ORIGINAL' || resolved.mode === 'VECTOR_TRANSFORMED') {
            setContoursMm(resolved.contoursMm);
            setContourProvenance({
              provenance: resolved.provenance,
              badgeLabel:
                resolved.mode === 'VECTOR_ORIGINAL'
                  ? 'PDF VECTOR — ORIGINAL'
                  : `PDF VECTOR — TRANSFORMED (${offsetMm > 0 ? '+' : ''}${offsetMm}mm)`,
              badgeTone: resolved.mode === 'VECTOR_ORIGINAL' ? 'emerald' : 'sky',
              selectionMode: resolved.selectionMode,
              fallbackReason: null,
              warnings: resolved.warnings || [],
              requiresUserConfirmation: false,
            });
            if (resolved.contoursMm?.validation?.errors?.length > 0) {
              setError(`Cảnh báo hình học: ${resolved.contoursMm.validation.errors[0]}`);
            } else {
              setError('');
            }
            // Mark active page BLEED_READY for current settings and cache its bleed artifact
            const activeSig = pdfFileSigRef.current;
            const cachedActive = pdfPageCacheRef.current.get(activePdfPage);
            if (
              activeSig &&
              cachedActive &&
              cachedActive.fileSignature === activeSig &&
              cachedActive.vecRes?.pageNumber === activePdfPage
            ) {
              const applyBleedFillNow = showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
              const effBleedNow = showBleedContour ? bleedOffsetMm : 0;
              const cleanPgCanvas = applyBleedFillNow
                ? buildBleedFilledExportCanvas(
                  cachedActive.canvas,
                  buildPaperTransparentCanvas(cachedActive.canvas),
                  { w: cachedActive.wMm, h: cachedActive.hMm },
                  resolved.contoursMm,
                  { mode: contourBleedFillMode, solidColorHex: contourBleedColorHex }
                )
                : cachedActive.canvas;
              cleanPgCanvas.toBlob(async (pgBlob) => {
                if (runSeq !== traceSeqRef.current || !pgBlob) return;
                const pgBytes = new Uint8Array(await pgBlob.arrayBuffer());
                if (runSeq !== traceSeqRef.current) return;
                cachedActive.bleedArtifact = {
                  pageNum: activePdfPage,
                  bleedSignature: currentBleedSig,
                  cleanArtworkCanvas: cleanPgCanvas,
                  cleanArtworkBytes: pgBytes,
                  sourceSizeMm: { w: cachedActive.wMm, h: cachedActive.hMm },
                  contoursMm: resolved.contoursMm,
                  bleedOffsetMm: effBleedNow,
                  contourProvenance: resolved.provenance,
                };
                pdfPageCacheRef.current.set(activePdfPage, cachedActive);
                updatePageStateRecord(activePdfPage, {
                  fileSignature: activeSig,
                  stage: PAGE_STAGE.BLEED_READY,
                  hasPreview: true,
                  hasCut: true,
                  hasBleed: true,
                  contourCount: resolved.contoursMm.length,
                  bleedSignature: currentBleedSig,
                  errorMessage: null,
                });
              }, 'image/png');
            }
            return;
          }

          if (resolved.mode === 'REJECTED' || resolved.mode === 'CONFIRM_RASTER_FOR_TRANSFORM') {
            // Points A & B: Do NOT silently drop vector, guess CUT, or leave stale exportable contours
            setContoursMm([]);
            setContourProvenance({
              provenance: resolved.provenance,
              badgeLabel:
                resolved.mode === 'REJECTED'
                  ? 'VECTOR IMPORT REJECTED'
                  : 'CẦN XÁC NHẬN RASTER',
              badgeTone: 'rose',
              selectionMode: resolved.selectionMode,
              fallbackReason: (resolved.reasons || []).join(', ') || null,
              warnings: resolved.warnings || [],
              requiresUserConfirmation: true,
              confirmationKind: resolved.mode,
            });
            setError(resolved.warnings?.[0] || 'Cần xác nhận nguồn đường bế.');
            return;
          }
          // Otherwise resolved.mode === 'FALLBACK_RASTER' (e.g. raster-only PDF) -> fall through to raster tracer
        }

        const traced = extractStickerContoursFromImage(renderedCanvas, sizeMm.w, sizeMm.h, {
          offsetMm,
          bleedOffsetMm: showBleedContour ? bleedOffsetMm : 0,
          smoothLevel,
          simplifyMm,
          cornerAngleDeg,
          minAreaMm2,
          mergeGapMm,
          shapeMode,
          detailMode,
          ignoreCornerMarks,
          imagePlacementsMm,
          perStickerOverrides,
        });
        if (runSeq !== traceSeqRef.current) return;
        traced.provenance = CONTOUR_PROVENANCE.RASTER_DERIVED;
        setContoursMm(traced);

        const isPdfFallback = sourceType === 'pdf';
        const fallbackReason = isPdfFallback
          ? forceRasterFallback
            ? (vectorImportResult?.reasons?.join(', ') || 'USER_CONFIRMED_RASTER_FALLBACK')
            : (vectorImportResult?.reasons?.join(', ') || 'NO_VECTOR_CONTOURS')
          : null;
        setContourProvenance({
          provenance: CONTOUR_PROVENANCE.RASTER_DERIVED,
          badgeLabel: isPdfFallback
            ? 'RASTER FALLBACK'
            : detailMode === 'high'
              ? 'RASTER — HIGH DETAIL'
              : 'RASTER — STANDARD',
          badgeTone: isPdfFallback ? 'amber' : 'indigo',
          selectionMode: null,
          fallbackReason,
          warnings: isPdfFallback ? (vectorImportResult?.warnings || []) : [],
          requiresUserConfirmation: false,
        });

        if (traced?.validation?.errors?.length > 0) {
          setError(`Cảnh báo hình học: ${traced.validation.errors[0]}`);
        } else {
          setError('');
        }
      } catch (err) {
        if (runSeq !== traceSeqRef.current) return;
        console.error(err);
        // Keep last valid contours displayed and explicitly warn user it's the previous valid result
        setError(`Lỗi khi dò đường bế (${err?.message || 'không xác định'}). Đang giữ kết quả hợp lệ trước đó.`);
      } finally {
        if (runSeq === traceSeqRef.current) setIsTracing(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [
    renderedCanvas,
    subMode,
    sourceType,
    vectorImportResult,
    forceRasterFallback,
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
    detailMode,
    ignoreCornerMarks,
    imagePlacementsMm,
    perStickerOverrides,
    contourBleedFillMode,
    contourBleedColorHex,
    currentBleedSig,
    activePdfPage,
    inputMode,
    pdfTrimBleedInfo,
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
      // Contour mode: draw Bleed Color Fill underneath artwork + Cyan BleedContour + Magenta CutContour
      const effectiveFillMode = showBleedContour && bleedOffsetMm > 0 ? contourBleedFillMode : 'off';
      drawContourBleedFillPreview(ctx, {
        rawCanvas: renderedCanvas,
        transparentCanvas: transparentArtworkCanvas,
        sizeMm,
        contoursMm,
        padMm,
        scale,
        mode: effectiveFillMode,
        solidColorHex: contourBleedColorHex,
      });

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
          if (!bPoly || bPoly.invalid) continue;
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
  }, [renderedCanvas, transparentArtworkCanvas, subMode, sizeMm, offsetMm, bleedOffsetMm, showBleedContour, contourBleedFillMode, contourBleedColorHex, contoursMm, bleedAllMm, bleedEdges, fillMode, solidColorHex, zoom, selectedStickerIdx]);

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
        const applyBleedFill = showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
        const exportCanvas = applyBleedFill
          ? buildBleedFilledExportCanvas(renderedCanvas, transparentArtworkCanvas, sizeMm, contoursMm, {
            mode: contourBleedFillMode,
            solidColorHex: contourBleedColorHex,
          })
          : renderedCanvas;
        bytes = await exportContourTracedPdf(exportCanvas, sizeMm.w, sizeMm.h, contoursMm, padExport, {
          sourceType: applyBleedFill ? 'image' : sourceType,
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
      const base = (sourceFile?.name || 'file').replace(/\.(pdf|png|jpg|jpeg|webp)$/i, '');
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
    if (!renderedCanvas || contoursMm.length === 0 || isTracing) return;
    setLoading(true);
    setError('');
    try {
      const padMm = showBleedContour ? Math.max(0.5, bleedOffsetMm) : 1.5;
      let bytes;
      let outName;
      const base = (sourceFile?.name || 'stickers').replace(/\.(pdf|png|jpg|jpeg|webp)$/i, '');

      const applyBleedFill = showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
      const exportCanvas = applyBleedFill
        ? buildBleedFilledExportCanvas(renderedCanvas, transparentArtworkCanvas, sizeMm, contoursMm, {
          mode: contourBleedFillMode,
          solidColorHex: contourBleedColorHex,
        })
        : renderedCanvas;

      if (inputMode === 'single' || contoursMm.length === 1) {
        bytes = await exportContourTracedPdf(exportCanvas, sizeMm.w, sizeMm.h, contoursMm, padMm + Math.max(1, offsetMm), {
          sourceType: applyBleedFill ? 'image' : sourceType,
          sourceFile,
          activePdfPage,
          includeBleedContour: showBleedContour && bleedOffsetMm > 0,
        });
        outName = `CutContour_${base}.pdf`;
      } else {
        bytes = await exportSplitStickersPdf(exportCanvas, sizeMm.w, sizeMm.h, contoursMm, padMm);
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
    } catch (err) {
      console.error(err);
      setError(err?.message || 'Không thể xuất file PDF sản xuất.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 min-w-0 h-full overflow-hidden">
      {/* LEFT: CENTER DARK PASTEBOARD CANVAS */}
      <main className="flex-1 min-w-0 bg-[#52565E] flex flex-col justify-between overflow-hidden">
        <div className="w-full min-h-[40px] px-3 py-1 bg-[#F8FAFC] border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
            <span className="px-2 py-0.5 rounded bg-[#DDF5EC] text-[#064E3B] font-bold">
              {subMode === 'contour' ? `${contoursMm.length} tem nhận diện` : `Bleed +${bleedAllMm}mm`}
            </span>
            {subMode === 'contour' && renderedCanvas && (
              <span
                title={
                  contourProvenance.fallbackReason
                    ? `Nguồn: ${contourProvenance.provenance} · Lý do: ${contourProvenance.fallbackReason} · ${actualDpi} DPI`
                    : `Nguồn: ${contourProvenance.provenance}${contourProvenance.selectionMode ? ` (${contourProvenance.selectionMode})` : ''} · ${actualDpi} DPI`
                }
                className={`px-2 py-0.5 rounded font-bold text-[10px] border ${contourProvenance.badgeTone === 'emerald'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                  : contourProvenance.badgeTone === 'sky'
                    ? 'bg-sky-50 border-sky-300 text-sky-800'
                    : contourProvenance.badgeTone === 'amber'
                      ? 'bg-amber-50 border-amber-300 text-amber-800'
                      : contourProvenance.badgeTone === 'rose'
                        ? 'bg-rose-50 border-rose-300 text-rose-800'
                        : 'bg-indigo-50 border-indigo-200 text-indigo-800'
                  }`}
              >
                {contourProvenance.badgeLabel}
                {contourProvenance.provenance === CONTOUR_PROVENANCE.RASTER_DERIVED ? ` · ${actualDpi} DPI` : ''}
              </span>
            )}
            <span className="px-2 py-0.5 rounded bg-white border border-[#E2E8F0] text-[#17212F] font-semibold">
              {sizeMm.w} × {sizeMm.h} mm
            </span>
            {sourceType === 'pdf' && totalPdfPages > 1 && (
              <div className="flex items-center gap-1.5 bg-white border border-[#E2E8F0] rounded px-1.5 py-0.5">
                <button
                  disabled={activePdfPage <= 1 || loading}
                  onClick={() => pdfBytesRef.current && renderPdfPageAt(pdfBytesRef.current, activePdfPage - 1)}
                  className="px-1 hover:text-[#087F5B] disabled:opacity-30 cursor-pointer font-bold"
                >
                  ‹
                </button>
                <span className="text-[11px] font-bold text-[#17212F]">
                  Trang {activePdfPage}/{totalPdfPages}
                </span>
                <button
                  disabled={activePdfPage >= totalPdfPages || loading}
                  onClick={() => pdfBytesRef.current && renderPdfPageAt(pdfBytesRef.current, activePdfPage + 1)}
                  className="px-1 hover:text-[#087F5B] disabled:opacity-30 cursor-pointer font-bold"
                >
                  ›
                </button>
                {(() => {
                  const st = getEffectivePageStage(pageStates[activePdfPage], currentBleedSig);
                  const meta = PAGE_STAGE_META[st] || PAGE_STAGE_META[PAGE_STAGE.PDF_LOADED];
                  const cls =
                    meta.tone === 'emerald'
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                      : meta.tone === 'amber'
                        ? 'bg-amber-100 text-amber-800 border-amber-300'
                        : meta.tone === 'sky'
                          ? 'bg-sky-100 text-sky-800 border-sky-300'
                          : meta.tone === 'rose'
                            ? 'bg-rose-100 text-rose-800 border-rose-300'
                            : 'bg-slate-100 text-slate-600 border-slate-300';
                  return (
                    <span className={`px-1.5 py-0.2 rounded border text-[10px] font-bold ${cls}`}>
                      {meta.label}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 bg-white border border-[#E2E8F0] rounded-md px-1.5 py-0.5 text-xs font-mono text-[#64748B]">
              <button onClick={() => setZoom(1.0)} className="px-1.5 hover:text-[#087F5B] font-sans font-semibold cursor-pointer">
                Fit
              </button>
              <button onClick={() => setZoom(2.0)} className="px-1.5 hover:text-[#087F5B] text-[11px] cursor-pointer">
                200%
              </button>
              <button onClick={() => setZoom(4.0)} className="px-1.5 hover:text-[#087F5B] text-[11px] cursor-pointer">
                400%
              </button>
              <button
                onClick={() => setZoom((z) => Math.max(0.35, Math.round((z - (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))}
                className="px-1.5 hover:text-[#17212F] cursor-pointer"
              >
                −
              </button>
              <span className="min-w-[44px] text-center font-bold text-[#087F5B]">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(10.0, Math.round((z + (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))}
                className="px-1.5 hover:text-[#17212F] cursor-pointer"
              >
                +
              </button>
            </div>
            {isFocusMode && typeof onToggleFocusMode === 'function' && (
              <button
                type="button"
                onClick={onToggleFocusMode}
                title="Thoát Focus Mode và khôi phục bảng điều khiển (Esc)"
                className="h-7 px-2.5 rounded-md bg-[#0F172A] hover:bg-[#1E293B] text-white text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors"
              >
                <PkIcon name="close" className="w-3 h-3" />
                <span>Thoát Focus (Esc)</span>
              </button>
            )}
            {!isFocusMode && settingsCollapsed && typeof onToggleSettings === 'function' && (
              <button
                type="button"
                onClick={onToggleSettings}
                title="Mở lại bảng thông số Bù Xén"
                className="h-7 px-2.5 rounded-md bg-white hover:bg-[#DDF5EC] border border-[#087F5B]/40 text-[#064E3B] text-[11px] font-semibold flex items-center gap-1 cursor-pointer shadow-2xs transition-colors"
              >
                <PkIcon name="chevronsLeft" className="w-3.5 h-3.5 text-[#087F5B]" />
                <span>Thông số</span>
              </button>
            )}
          </div>
        </div>

        <div
          ref={viewportRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopPanning}
          onMouseLeave={stopPanning}
          title="Cuộn chuột để Zoom (tối đa 1000%) · Kéo chuột trái để di chuyển"
          className={`relative flex-1 w-full flex overflow-auto p-6 select-none bg-[#52565E] ${isPanning ? 'cursor-grabbing' : 'cursor-grab'
            }`}
        >
          {(loading || isTracing) && (
            <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-2xs flex items-center justify-center p-4 pointer-events-none">
              <div className="w-full max-w-sm bg-white rounded-xl border border-[#E2E8F0] shadow-2xl p-5 flex flex-col items-center gap-3 text-center">
                <div className="relative w-12 h-12 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-4 border-[#DDF5EC]" />
                  <div className="absolute inset-0 rounded-full border-4 border-[#087F5B] border-t-transparent animate-spin" />
                  <span className="text-[11px] font-extrabold font-mono text-[#087F5B]">
                    {loading ? `${Math.max(10, loadPct)}%` : '300'}
                  </span>
                </div>
                <div className="text-xs font-bold text-[#17212F]">
                  {loading ? loadStage || 'Đang tải & kết xuất file ở 300 DPI...' : 'Đang dò đường bế Bézier & bù xén...'}
                </div>
                <div className="w-full h-2 bg-[#F3F5F7] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#087F5B] transition-all duration-150 rounded-full"
                    style={{ width: `${loading ? Math.max(12, loadPct) : 92}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          <div className="m-auto shrink-0">
            <canvas
              ref={previewCanvasRef}
              className="bg-white block"
              style={{ boxShadow: '0 14px 36px rgba(0,0,0,0.4)' }}
            />
          </div>
        </div>
        <div className="h-8 px-3 bg-white border-t border-[#E2E8F0] flex items-center justify-between gap-4 text-[11px] text-[#64748B] shrink-0">
          <div className="flex items-center gap-4">
            {subMode === 'contour' ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 border-t-2 border-pink-600 inline-block" /> CutContour (Magenta)
                </span>
                {showBleedContour && bleedOffsetMm > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 border-t-2 border-dashed border-sky-600 inline-block" /> BleedContour (Cyan)
                  </span>
                )}
                <span className="font-mono text-[#475569]">· {actualDpi} DPI</span>
                {isTracing && <span className="text-[#087F5B] font-semibold animate-pulse">Đang dò lại...</span>}
              </>
            ) : (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 border-t border-blue-700 inline-block" /> TrimBox
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 border-t border-dashed border-[#DC4545] inline-block" /> BleedBox
                </span>
              </>
            )}
          </div>
          <span className="font-mono text-[#64748B]">Cuộn chuột: Zoom · Kéo chuột: Di chuyển</span>
        </div>
      </main>

      {/* MIDDLE-RIGHT: PENPOT-REFINED SETTINGS & STICKY EXPORT PANEL (CSS-hidden on collapse to preserve scroll & state) */}
      <aside
        className={`${
          settingsCollapsed || isFocusMode
            ? 'hidden'
            : 'w-[288px] xl:w-[320px] flex'
        } pk-panel-transition bg-white border-l border-[#E2E8F0] flex-col h-full shrink-0 overflow-hidden`}
      >
        {/* Sticky Inspector Header */}
        <div className="px-3.5 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-6 h-6 rounded-md bg-[#DDF5EC] text-[#087F5B] flex items-center justify-center shrink-0">
              <PkIcon name="blade" className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-[11.5px] font-extrabold text-[#17212F] tracking-wide truncate">
                BÙ XÉN &amp; ĐƯỜNG BẾ
              </div>
              <div className="text-[10px] font-mono text-[#64748B] truncate">
                {sourceFile ? `${(sourceFile.size / (1024 * 1024)).toFixed(2)} MB` : `${sizeMm.w}×${sizeMm.h} mm`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={!renderedCanvas || loading}
              title="Lưu / Xuất nhanh PDF"
              className="w-7 h-7 rounded-md hover:bg-[#DDF5EC] text-[#64748B] hover:text-[#087F5B] disabled:opacity-30 flex items-center justify-center cursor-pointer transition-colors"
            >
              <PkIcon name="save" className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                const isValidVecPdf = sourceType === 'pdf' && vectorImportResult?.status === 'OK';
                setOffsetMm(isValidVecPdf ? 0 : 0.5);
                setShapeMode('auto');
                setPerStickerOverrides({});
                setForceRasterFallback(false);
                setBleedOffsetMm(1.5);
                setCornerAngleDeg(130);
                setSmoothLevel(1);
                setSimplifyMm(0.18);
                setMergeGapMm(0.35);
                setBleedCompleted(false);
                setSettingsOpen(true);
              }}
              title="Hoàn tác / Khôi phục mặc định"
              className="w-7 h-7 rounded-md hover:bg-amber-50 text-[#64748B] hover:text-amber-600 flex items-center justify-center cursor-pointer transition-colors"
            >
              <PkIcon name="undo" className="w-3.5 h-3.5" />
            </button>
            {typeof onToggleSettings === 'function' && (
              <button
                type="button"
                onClick={onToggleSettings}
                title="Thu gọn bảng thông số (»)"
                className="w-7 h-7 rounded-md bg-white hover:bg-[#DDF5EC] border border-[#E2E8F0] hover:border-[#087F5B]/40 text-[#64748B] hover:text-[#087F5B] flex items-center justify-center cursor-pointer transition-colors"
              >
                <PkIcon name="chevronsRight" className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Inspector Body */}
        <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3">
          {/* Row 1: Segmented Input Mode (PDF/PNG đã có biên vs Tách nhiều tem) */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0]">
            <button
              type="button"
              onClick={() => {
                setInputMode('single');
                setMergeGapMm(2.5);
                setBleedCompleted(false);
              }}
              title="Dùng cho file PDF đã chừa sẵn tràn lề (TrimBox + Bleed 2–3 mm) hoặc PNG 1 tem đã tách nền rõ. Giữ nguyên tràn lề gốc, không bù đúp."
              className={`py-1.5 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${inputMode === 'single'
                ? 'bg-white border border-[#087F5B]/40 text-[#064E3B] shadow-2xs'
                : 'border border-transparent text-[#64748B] hover:text-[#17212F]'
                }`}
            >
              <PkIcon name="file" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Có biên sẵn</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setInputMode('multi');
                setMergeGapMm(0.35);
                setBleedCompleted(false);
              }}
              title="Dùng khi 1 trang chứa nhiều tem cần tách riêng từng tem để tạo đường bế và bù xén."
              className={`py-1.5 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${inputMode === 'multi'
                ? 'bg-white border border-[#087F5B]/40 text-[#064E3B] shadow-2xs'
                : 'border border-transparent text-[#64748B] hover:text-[#17212F]'
                }`}
            >
              <PkIcon name="layers" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Tách nhiều tem</span>
            </button>
          </div>

          {sourceType === 'pdf' && inputMode === 'single' && contourProvenance.selectionMode === 'SINGLE_MODE_NO_BOUNDARY' && (
            <div className="rounded-xl bg-amber-50 border border-amber-300 px-2.5 py-2 text-[10px] text-amber-950 flex flex-col gap-1.5">
              <div className="leading-snug">
                <span className="font-bold">⚠️ File PDF này chưa có biên sẵn</span> (không có <span className="font-mono">TrimBox/Bleed</span> và không có layer <span className="font-mono">CutContour</span>).
                {contourProvenance.fallbackReason ? ` ${contourProvenance.fallbackReason}` : ''}
              </div>
              <button
                type="button"
                onClick={() => {
                  setInputMode('multi');
                  setMergeGapMm(0.35);
                  setBleedCompleted(false);
                }}
                className="w-full py-1.5 px-2 rounded-lg bg-[#146C53] hover:bg-[#0f5440] text-white text-[11px] font-bold cursor-pointer"
              >
                🥞 Chuyển sang "Tách nhiều tem" để tự bóc đường cắt
              </button>
            </div>
          )}

          {sourceType === 'pdf' && pdfTrimBleedInfo?.hasExplicitTrimBox && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-2.5 py-2 text-[10px] text-emerald-900 flex items-center justify-between gap-2">
              <div className="leading-snug">
                <span className="font-bold">📐 Phát hiện PDF có sẵn TrimBox</span>{' '}
                ({pdfTrimBleedInfo.trimRectMm.w.toFixed(1)}×{pdfTrimBleedInfo.trimRectMm.h.toFixed(1)}mm
                {pdfTrimBleedInfo.hasExistingBleed ? `, Bleed +${pdfTrimBleedInfo.existingBleedMm.min.toFixed(1)}mm` : ''})
                {inputMode === 'single' ? ' — đang giữ nguyên tràn lề gốc, không bù đúp.' : '.'}
              </div>
              {inputMode !== 'single' && (
                <button
                  type="button"
                  onClick={() => {
                    setInputMode('single');
                    setMergeGapMm(2.5);
                    setBleedCompleted(false);
                  }}
                  className="px-2 py-1 rounded-lg bg-[#146C53] text-white font-bold shrink-0 cursor-pointer"
                >
                  Dùng TrimBox
                </button>
              )}
            </div>
          )}

          {/* Row 2: Output Cut Type Cards (Bế tem nhãn vs Xén vuông góc) */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => {
                setSubMode('contour');
                setShapeMode('auto');
                setBleedCompleted(false);
              }}
              className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${subMode === 'contour' && shapeMode !== 'rect'
                ? 'bg-[#DDF5EC] border-[#087F5B] text-[#064E3B] shadow-2xs'
                : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                }`}
            >
              <PkIcon name="scissors" className="w-3.5 h-3.5 shrink-0" />
              <span>Bế tem nhãn</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (subMode === 'contour' && shapeMode === 'rect') {
                  setSubMode('bleed');
                } else {
                  setSubMode('contour');
                  setShapeMode('rect');
                }
                setBleedCompleted(false);
              }}
              className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${subMode === 'bleed' || shapeMode === 'rect'
                ? 'bg-[#DDF5EC] border-[#087F5B] text-[#064E3B] shadow-2xs'
                : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                }`}
            >
              <PkIcon name="crop" className="w-3.5 h-3.5 shrink-0" />
              <span>Xén vuông góc</span>
            </button>
          </div>

          {/* File Upload */}
          <div className="relative border border-dashed border-[#CBD5E1] hover:border-[#087F5B] rounded-lg p-2.5 text-center cursor-pointer bg-[#F8FAFC] hover:bg-[#DDF5EC]/20 transition-colors">
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.pdf"
              onChange={(e) => {
                handleUpload(e.target.files[0]);
                setBleedCompleted(false);
                setSettingsOpen(true);
                e.target.value = '';
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="text-xs font-semibold text-[#17212F] truncate flex items-center justify-center gap-1.5">
              <PkIcon name={sourceFile ? 'file' : 'upload'} className="w-3.5 h-3.5 text-[#087F5B] shrink-0" />
              <span className="truncate">
                {loading ? 'Đang xử lý file...' : sourceFile ? sourceFile.name : 'Chọn ảnh PNG sticker hoặc file PDF'}
              </span>
            </div>
            {renderedCanvas && (
              <div className="text-[10.5px] font-mono text-[#64748B] mt-0.5">
                {sizeMm.w} × {sizeMm.h} mm · {contoursMm.length} tem
              </div>
            )}
          </div>
          {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px]">⚠️ {error}</div>}

          {/* Provenance & Confirmation Banner (Points A, B, E) */}
          {subMode === 'contour' && renderedCanvas && (contourProvenance.requiresUserConfirmation || contourProvenance.fallbackReason || forceRasterFallback) && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-[11px] flex flex-col gap-1.5">
              <div className="font-bold flex items-center justify-between gap-1">
                <span>{contourProvenance.badgeLabel}</span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/80 text-amber-900">
                  {contourProvenance.provenance}
                </span>
              </div>
              {contourProvenance.fallbackReason && (
                <div className="font-mono text-[10px] text-amber-800">
                  Lý do: {contourProvenance.fallbackReason} · Render: {actualDpi} DPI
                </div>
              )}
              {contourProvenance.requiresUserConfirmation && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {contourProvenance.confirmationKind === 'CONFIRM_RASTER_FOR_TRANSFORM' && (
                    <button
                      type="button"
                      onClick={() => {
                        setOffsetMm(0);
                        setShapeMode('auto');
                        setPerStickerOverrides({});
                        setForceRasterFallback(false);
                      }}
                      className="px-2 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold cursor-pointer"
                    >
                      Giữ PDF Vector gốc (Offset 0)
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDetailMode('high');
                      setForceRasterFallback(true);
                    }}
                    className="px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold cursor-pointer"
                  >
                    Xác nhận chuyển sang Raster (High Detail)
                  </button>
                </div>
              )}
              {forceRasterFallback && vectorImportResult?.status === 'OK' && (
                <button
                  type="button"
                  onClick={() => {
                    setOffsetMm(0);
                    setShapeMode('auto');
                    setPerStickerOverrides({});
                    setForceRasterFallback(false);
                  }}
                  className="self-start px-2 py-1 rounded-lg bg-white border border-emerald-400 text-emerald-800 text-[10px] font-bold cursor-pointer"
                >
                  ↩ Quay lại PDF VECTOR — ORIGINAL
                </button>
              )}
            </div>
          )}

          {/* UNIFIED 1-STOP CARD: XEM VÀ CHỈNH ĐƯỜNG BẾ & BÙ XÉN (Penpot Inspector Style) */}
          {subMode === 'contour' && renderedCanvas && (
            <div className="pk-inspector-card flex flex-col gap-3">
              <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-[#F1F5F9]">
                <span className="pk-section-label">Đường bế &amp; Bù xén</span>
                <span className="px-2 py-0.5 rounded-full bg-[#DDF5EC] text-[#064E3B] text-[10px] font-mono font-bold shrink-0 whitespace-nowrap">
                  {contoursMm.length} tem
                </span>
              </div>

              {/* 4-Mode Dieline Selector */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[10.5px] font-semibold text-[#64748B]">Chế độ đường cắt (Dieline)</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {DIELINE_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDielineMode(opt.id)}
                      className={`px-2 py-1.5 rounded-md border text-[10.5px] font-semibold text-left transition-all cursor-pointer ${dielineMode === opt.id
                        ? 'bg-[#DDF5EC] border-[#087F5B] text-[#064E3B]'
                        : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                        }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Compact 1-row Shape + Detail Mode */}
              <div className={`grid gap-2 ${shapeMode === 'auto' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <div className="flex flex-col gap-1">
                  <label className="text-[10.5px] font-medium text-[#64748B]">Hình dáng bế</label>
                  <select
                    value={shapeMode}
                    onChange={(e) => setShapeMode(e.target.value)}
                    className="h-8 bg-white border border-[#CBD5E1] focus:border-[#087F5B] rounded-md px-2 text-[11px] font-semibold text-[#17212F]"
                  >
                    <option value="auto">Tự do (Freeform)</option>
                    <option value="circle">Ép Tròn chuẩn</option>
                    <option value="oval">Ép Oval / Elip</option>
                    <option value="rect">Ép Chữ nhật</option>
                  </select>
                </div>
                {shapeMode === 'auto' && (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10.5px] font-medium text-[#64748B]">Độ chi tiết</label>
                    <select
                      value={detailMode}
                      onChange={(e) => setDetailMode(e.target.value)}
                      className="h-8 bg-white border border-[#CBD5E1] focus:border-[#087F5B] rounded-md px-2 text-[11px] font-semibold text-[#17212F]"
                    >
                      <option value="standard">Tiêu chuẩn</option>
                      <option value="high">High Detail (Cánh hoa)</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Offset đường CẮT (Magenta CUT Semantic) */}
              <div className="flex flex-col gap-1 pt-2 border-t border-[#F1F5F9]">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#17212F] font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#DB2777] inline-block" />
                    Offset đường CẮT
                  </span>
                  <span className="pk-mm-badge-cut">{offsetMm > 0 ? `+${offsetMm}` : offsetMm} mm</span>
                </div>
                <input
                  type="range"
                  min="-1.5"
                  max="5"
                  step="0.25"
                  value={offsetMm}
                  onChange={(e) => setOffsetMm(parseFloat(e.target.value))}
                  className="w-full accent-[#DB2777]"
                />
              </div>

              {/* Offset đường BÙ XÉN (Cyan BLEED Semantic) */}
              <div className="flex flex-col gap-1.5 pt-1">
                <div className="flex items-center justify-between text-[11px]">
                  <label className="flex items-center gap-1.5 text-[#17212F] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showBleedContour}
                      onChange={(e) => setShowBleedContour(e.target.checked)}
                      className="accent-[#0284C7] rounded"
                    />
                    <span className="w-2 h-2 rounded-full bg-[#0284C7] inline-block" />
                    <span>Bù xén (Bleed)</span>
                  </label>
                  <span className="pk-mm-badge-bleed">
                    {showBleedContour ? `+${bleedOffsetMm} mm` : 'Tắt (0 mm)'}
                  </span>
                </div>
                {showBleedContour && (
                  <>
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="0.25"
                      value={bleedOffsetMm}
                      onChange={(e) => setBleedOffsetMm(parseFloat(e.target.value))}
                      className="w-full accent-[#0284C7]"
                    />
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[10.5px] text-[#64748B]">Tô màu tràn viền:</span>
                      <div className="flex items-center gap-1">
                        <select
                          value={contourBleedFillMode}
                          onChange={(e) => setContourBleedFillMode(e.target.value)}
                          className="h-7 bg-white border border-[#CBD5E1] rounded-md px-1.5 text-[10.5px] font-medium text-[#17212F]"
                        >
                          <option value="auto">Tự động (màu mép)</option>
                          <option value="solid">Màu tự chọn</option>
                          <option value="off">Chỉ nét đứt</option>
                        </select>
                        {contourBleedFillMode === 'solid' && (
                          <input
                            type="color"
                            value={contourBleedColorHex}
                            onChange={(e) => setContourBleedColorHex(e.target.value)}
                            className="w-6 h-6 rounded border border-[#CBD5E1] cursor-pointer"
                            title="Chọn màu tràn viền"
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Collapsible Advanced Edge Sliders (Khử bóng, Khử răng cưa, Bám sát, Bo cong, Lọc rác) */}
              <button
                type="button"
                onClick={() => setShowAdvancedTrace((v) => !v)}
                className="w-full flex items-center justify-between px-2.5 py-2 rounded-md bg-[#F8FAFC] hover:bg-[#F1F5F9] border border-[#E2E8F0] text-[11px] font-semibold text-[#475569] cursor-pointer transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <PkIcon name="sliders" className="w-3.5 h-3.5 text-[#087F5B]" />
                  <span>Tinh chỉnh nâng cao (Khử bóng · Bo · Lọc rác)</span>
                </span>
                <PkIcon name={showAdvancedTrace ? 'chevronUp' : 'chevronDown'} className="w-3.5 h-3.5 text-[#64748B] shrink-0" />
              </button>

              {showAdvancedTrace && (
                <div className="flex flex-col gap-2 pt-1 pl-0.5">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold text-slate-500">Khử bóng</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setShadowRemovalMode('keep')}
                        className={`py-1 rounded-lg border text-[10px] font-bold transition-all cursor-pointer ${shadowRemovalMode === 'keep'
                          ? 'bg-purple-50 border-purple-500 text-purple-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                      >
                        Giữ nguyên
                      </button>
                      <button
                        type="button"
                        onClick={() => setShadowRemovalMode('auto')}
                        className={`py-1 rounded-lg border text-[10px] font-bold transition-all cursor-pointer ${shadowRemovalMode === 'auto'
                          ? 'bg-purple-50 border-purple-500 text-purple-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                      >
                        Tự động
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-700 font-medium">Khử răng cưa</span>
                      <span className="font-mono font-bold text-purple-700">{antiAliasPct}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={antiAliasPct}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setAntiAliasPct(v);
                        setSmoothLevel(Math.round((v / 100) * 3));
                      }}
                      className="w-full accent-purple-600"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400">
                      <span>Giữ nguyên biên</span>
                      <span>Mượt hơn</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-700 font-medium">Bám sát hình gốc</span>
                      <span className="font-mono font-bold text-purple-700">{fidelityPct}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={fidelityPct}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setFidelityPct(v);
                        const mapped = mapSliderControlsToTracerParams({ antiAliasPct, fidelityPct: v, minAreaMm2 });
                        setSimplifyMm(mapped.simplifyMm);
                        setCornerAngleDeg(mapped.cornerAngleDeg);
                      }}
                      className="w-full accent-purple-600"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400">
                      <span>Mượt hơn</span>
                      <span>Bám sát</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-700 font-medium">Độ bo cong</span>
                      <span className="font-mono font-bold text-purple-700">{Number(cornerRadiusMm).toFixed(2)} mm</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="0.25"
                      value={cornerRadiusMm}
                      onChange={(e) => setCornerRadiusMm(parseFloat(e.target.value))}
                      className="w-full accent-purple-600"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400">
                      <span>Ít bo (giữ vector gốc)</span>
                      <span>Bo tròn</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-slate-700 font-medium">Lọc rác</span>
                        <span className="font-mono font-bold text-purple-700">{Number(minAreaMm2).toFixed(1)} mm²</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="10"
                        step="0.5"
                        value={Math.min(10, Math.max(0.5, minAreaMm2))}
                        onChange={(e) => setMinAreaMm2(parseFloat(e.target.value))}
                        className="w-full accent-purple-600"
                      />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] text-slate-600 font-medium" title="Gộp các chữ/chi tiết rời nằm gần nhau vào cùng 1 tem (mm)">
                        Gộp chữ rời (mm)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="8"
                        step="0.25"
                        value={mergeGapMm}
                        onChange={(e) => setMergeGapMm(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-[11px] font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="text-[10px] text-slate-400 pt-0.5 border-t border-slate-100">
                Đường màu tím là đường bế sẽ xuất.
              </div>
            </div>
          )}

          {/* SỬA NHANH VÙNG TEM Card (Matching reference screenshot #2) */}
          {subMode === 'contour' && renderedCanvas && (
            <div className="rounded-2xl border border-slate-200 bg-white p-3 flex flex-col gap-2 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-extrabold text-slate-800 tracking-wide">SỬA NHANH VÙNG TEM</span>
                {(manualMaskRevision > 0 || mergedGroups.length > 0 || manualEditTool !== MANUAL_EDIT_TOOLS.NONE) && (
                  <button
                    type="button"
                    onClick={() => {
                      setManualEditTool(MANUAL_EDIT_TOOLS.NONE);
                      manualMaskCanvasRef.current = null;
                      setManualMaskRevision(0);
                      setMergedGroups([]);
                    }}
                    className="text-[10px] font-bold text-rose-600 hover:underline cursor-pointer"
                  >
                    Xóa sửa thủ công
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: MANUAL_EDIT_TOOLS.ERASE_SHADOW, label: 'Xóa bóng' },
                  { id: MANUAL_EDIT_TOOLS.KEEP_REGION, label: 'Giữ lại' },
                  { id: MANUAL_EDIT_TOOLS.MERGE_STICKER, label: 'Gộp với tem' },
                ].map((tool) => {
                  const active = manualEditTool === tool.id;
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => setManualEditTool(active ? MANUAL_EDIT_TOOLS.NONE : tool.id)}
                      className={`py-1.5 px-1.5 rounded-lg border text-[11px] font-bold transition-all cursor-pointer ${active
                        ? 'bg-purple-50 border-purple-500 text-purple-700 shadow-2xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                    >
                      {tool.label}
                    </button>
                  );
                })}
              </div>

              {isBrushToolActive && (
                <div className="flex flex-col gap-1 bg-purple-50/60 border border-purple-200 rounded-lg p-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-purple-800">
                      {manualEditTool === MANUAL_EDIT_TOOLS.ERASE_SHADOW
                        ? '🖌️ Quét đỏ lên vùng bóng cần loại bỏ'
                        : '🖌️ Quét xanh lên vùng chi tiết cần giữ lại'}
                    </span>
                    <span className="font-mono font-bold text-purple-700">{brushRadiusMm} mm</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="10"
                    step="0.5"
                    value={brushRadiusMm}
                    onChange={(e) => setBrushRadiusMm(parseFloat(e.target.value))}
                    className="w-full accent-purple-600"
                  />
                </div>
              )}

              {manualEditTool === MANUAL_EDIT_TOOLS.MERGE_STICKER && (
                <div className="flex flex-col gap-1.5 bg-purple-50/60 border border-purple-200 rounded-lg p-2">
                  <div className="text-[10px] text-purple-800 font-medium">
                    Click chọn từ 2 tem trở lên trên ảnh rồi bấm Gộp ({selectedStickerIndices.length} tem đang chọn).
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={selectedStickerIndices.length < 2}
                      onClick={() => {
                        if (selectedStickerIndices.length < 2) return;
                        setMergedGroups((prev) => [...prev, [...selectedStickerIndices]]);
                        setSelectedStickerIndices([selectedStickerIndices[0]]);
                      }}
                      className="flex-1 py-1 px-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[10px] font-bold cursor-pointer"
                    >
                      Gộp {selectedStickerIndices.length} tem đã chọn
                    </button>
                    {mergedGroups.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setMergedGroups([])}
                        className="py-1 px-2 rounded-lg bg-white border border-slate-300 text-slate-600 text-[10px] font-bold cursor-pointer"
                      >
                        Hủy gộp
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

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
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-bold cursor-pointer ${selectedStickerIdx === null
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
                              className={`px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold cursor-pointer ${isSel
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

                  {/* Controls unified above in CHỈNH ĐƯỜNG BẾ & BÙ XÉN — keep only geometry verification below */}

                  {contoursMm.validation && contoursMm.length > 0 && (() => {
                    const v = contoursMm.validation;
                    const ps = v.precisionSummary;
                    const geomOk = v.geometryValid !== undefined ? v.geometryValid : v.valid;
                    const tolOk = v.offsetWithinTolerance !== undefined ? v.offsetWithinTolerance : true;
                    const prodReady = v.productionReady !== undefined ? v.productionReady : (geomOk && tolOk);
                    const bleedActive = Boolean(showBleedContour && ps?.enabled);
                    const failedList = ps?.failedStickers || v.offsetToleranceIssues || [];
                    const cardClass = prodReady
                      ? 'bg-[#E6F4EF]/70 border-emerald-300 text-[#112A24]'
                      : geomOk && !tolOk
                        ? 'bg-amber-50 border-amber-300 text-amber-950'
                        : 'bg-rose-50 border-rose-300 text-rose-950';
                    const headerTitle = prodReady
                      ? '✓ Kiểm tra hình học đạt chuẩn'
                      : geomOk && !tolOk
                        ? '⚠ BLEED cần kiểm tra'
                        : '⚠️ Cảnh báo hình học';

                    return (
                      <div className={`rounded-xl p-2.5 border text-[11px] flex flex-col gap-1.5 ${cardClass}`}>
                        <div className="font-bold flex items-center justify-between">
                          <span>{headerTitle}</span>
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/80 font-bold text-slate-700">
                            {actualDpi} DPI
                          </span>
                        </div>

                        {prodReady ? (
                          <>
                            <div className="font-mono text-[10px] text-slate-700 leading-relaxed">
                              • {v.closedCount}/{v.stickerCount} CUT khép kín
                              {bleedActive ? (
                                <>
                                  <br />• {v.bleedPathCount}/{v.stickerCount} BLEED khép kín
                                </>
                              ) : null}
                              <br />• Tự giao: {v.selfIntersections + (v.bleedSelfIntersections || 0)} · Va chạm:{' '}
                              {v.collisions.length === 0 ? '0' : `${v.collisions.length} cặp`}
                            </div>

                            {bleedActive && ps && (
                              <div className="pt-1.5 border-t border-emerald-200/80 font-mono text-[10px] text-slate-700 leading-relaxed">
                                <div className="font-sans font-bold text-[10px] text-[#146C53] mb-0.5">
                                  Precision BLEED ({ps.passedCount}/{ps.totalCount} đạt):
                                </div>
                                • Mục tiêu: +{Number(ps.targetMm).toFixed(2)} mm (dung sai {Number(ps.toleranceUnderMm).toFixed(2)} mm)
                                <br />• Nhỏ nhất: {ps.minDistMm != null ? Number(ps.minDistMm).toFixed(2) : '—'} mm · TB:{' '}
                                {ps.avgDistMm != null ? Number(ps.avgDistMm).toFixed(2) : '—'} mm
                                <br />• Sai lệch lớn nhất: {ps.maxDeficitMm > 0 ? `-${Number(ps.maxDeficitMm).toFixed(2)} mm` : '0.00 mm'}
                              </div>
                            )}

                            <div className="pt-1 border-t border-emerald-200/80 text-[11px] font-extrabold text-[#146C53]">
                              ✓ Sẵn sàng sản xuất
                            </div>
                          </>
                        ) : geomOk && !tolOk ? (
                          <>
                            <div className="font-mono text-[10px] text-amber-900 font-semibold">
                              {ps?.passedCount ?? 0}/{ps?.totalCount ?? v.stickerCount} đạt dung sai (≤ {Number(ps?.toleranceUnderMm ?? 0.15).toFixed(2)} mm)
                            </div>
                            {failedList.length > 0 && (
                              <div className="flex flex-col gap-1 bg-white/75 rounded-lg p-1.5 border border-amber-200 font-mono text-[10px] text-amber-950">
                                {failedList.slice(0, 4).map((item) => (
                                  <div key={item.sticker} className="leading-snug">
                                    <span className="font-bold">Tem #{item.sticker}</span>: Mục tiêu {Number(item.targetMm).toFixed(2)} mm · Thực tế nhỏ nhất{' '}
                                    <span className="font-bold text-rose-700">{Number(item.minDistMm).toFixed(2)} mm</span> · Thiếu{' '}
                                    <span className="font-bold text-rose-700">{Number(item.deficitMm).toFixed(2)} mm</span>
                                  </div>
                                ))}
                                {failedList.length > 4 && (
                                  <div className="text-[9px] text-amber-700">+{failedList.length - 4} tem khác chưa đạt dung sai</div>
                                )}
                              </div>
                            )}
                            <div className="pt-1 border-t border-amber-200/80 font-mono text-[10px] leading-relaxed">
                              • Hình học: <span className="font-bold text-emerald-700">hợp lệ</span>
                              <br />• Precision: <span className="font-bold text-rose-700">không đạt</span>
                              <br />• Sẵn sàng sản xuất: <span className="font-extrabold text-rose-700">KHÔNG</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="font-mono text-[10px] text-rose-900 leading-relaxed">
                              • {v.closedCount}/{v.stickerCount} CUT khép kín
                              {bleedActive ? ` · ${v.bleedPathCount}/${v.stickerCount} BLEED` : ''}
                              <br />• Tự giao: {v.selfIntersections + (v.bleedSelfIntersections || 0)} · Va chạm:{' '}
                              {v.collisions.length === 0 ? '0' : `${v.collisions.length} cặp`}
                            </div>
                            {v.errors?.length > 0 && (
                              <div className="bg-white/75 rounded-lg p-1.5 border border-rose-200 text-[10px] text-rose-900 leading-snug">
                                {v.errors.slice(0, 3).map((msg, i) => (
                                  <div key={i}>• {msg}</div>
                                ))}
                              </div>
                            )}
                            <div className="pt-1 border-t border-rose-200/80 font-mono text-[10px] leading-relaxed">
                              • Hình học: <span className="font-bold text-rose-700">không hợp lệ</span>
                              <br />• Sẵn sàng sản xuất: <span className="font-extrabold text-rose-700">KHÔNG</span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}

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
                        className={`py-1.5 rounded-lg border font-semibold cursor-pointer ${bleedEdges[k]
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
          {renderedCanvas && contoursMm.length > 0 && !contourProvenance.requiresUserConfirmation && (
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

              {sourceType === 'pdf' && totalPdfPages > 1 && (() => {
                const allPageNums = Array.from({ length: totalPdfPages }, (_, i) => i + 1);
                const counts = { ready: 0, cutOnly: 0, loaded: 0, invalid: 0 };
                for (const p of allPageNums) {
                  const st = getEffectivePageStage(pageStates[p], currentBleedSig);
                  if (st === PAGE_STAGE.BLEED_READY) counts.ready++;
                  else if (st === PAGE_STAGE.CUT_READY) counts.cutOnly++;
                  else if (st === PAGE_STAGE.NO_CUT || st === PAGE_STAGE.ERROR) counts.invalid++;
                  else counts.loaded++;
                }
                const needBatchCount = counts.loaded + counts.cutOnly;
                const batchBtnLabel =
                  counts.loaded === 0 && counts.cutOnly > 0
                    ? `Cập nhật BLEED (${counts.cutOnly} trang)`
                    : `Bóc tách tất cả (${totalPdfPages} trang)`;
                return (
                  <div className="flex flex-col gap-2 text-[11px] bg-white/90 border border-emerald-200 rounded-lg px-2.5 py-2">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="font-bold text-slate-700">
                        Trạng thái từng trang ({counts.ready}/{totalPdfPages} BLEED Ready)
                      </span>
                      {batchProgress ? (
                        <button
                          type="button"
                          onClick={() => { batchCancelRef.current = true; }}
                          className="px-2 py-0.5 rounded bg-rose-100 hover:bg-rose-200 text-rose-800 text-[10px] font-bold cursor-pointer"
                        >
                          Dừng
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={loading || needBatchCount === 0}
                          onClick={() => runBatchProcessPages(allPageNums)}
                          className="px-2 py-0.5 rounded bg-[#146C53] hover:bg-[#0f5440] disabled:bg-slate-200 disabled:text-slate-500 text-white text-[10px] font-bold cursor-pointer"
                        >
                          {needBatchCount === 0 ? 'Đã bóc đủ' : batchBtnLabel}
                        </button>
                      )}
                    </div>

                    {batchProgress && (
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-[10px] text-emerald-800 font-semibold">
                          <span>{batchProgress.stageText}</span>
                          <span>{batchProgress.current}/{batchProgress.total}</span>
                        </div>
                        <div className="w-full h-1.5 bg-emerald-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#146C53] transition-all"
                            style={{ width: `${Math.round((batchProgress.current / Math.max(1, batchProgress.total)) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-4 gap-1">
                      {allPageNums.map((p) => {
                        const rec = pageStates[p];
                        const st = getEffectivePageStage(rec, currentBleedSig);
                        const meta = PAGE_STAGE_META[st] || PAGE_STAGE_META[PAGE_STAGE.PDF_LOADED];
                        const isActive = p === activePdfPage;
                        const pillCls =
                          meta.tone === 'emerald'
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                            : meta.tone === 'amber'
                              ? 'bg-amber-50 border-amber-300 text-amber-800'
                              : meta.tone === 'sky'
                                ? 'bg-sky-50 border-sky-300 text-sky-800'
                                : meta.tone === 'rose'
                                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                                  : 'bg-slate-50 border-slate-200 text-slate-500';
                        return (
                          <button
                            key={p}
                            type="button"
                            disabled={loading}
                            title={`Trang ${p}: ${meta.label}${rec?.contourCount ? ` (${rec.contourCount} tem)` : ''}${rec?.errorMessage ? ` — ${rec.errorMessage}` : ''}`}
                            onClick={() => pdfBytesRef.current && renderPdfPageAt(pdfBytesRef.current, p)}
                            className={`px-1.5 py-1 rounded border text-[10px] text-left transition-all cursor-pointer ${pillCls} ${isActive ? 'ring-2 ring-[#146C53] font-bold' : ''}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold">T{p}</span>
                              {rec?.contourCount > 0 && <span className="text-[9px] opacity-80">{rec.contourCount}</span>}
                            </div>
                            <div className="text-[9px] truncate">{meta.shortLabel}</div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-slate-100">
                      <span className="font-semibold text-slate-700">Trang chuyển (1–{totalPdfPages}):</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setHandoffPageExpr(String(activePdfPage))}
                          className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-semibold cursor-pointer"
                        >
                          Trang {activePdfPage}
                        </button>
                        <button
                          type="button"
                          onClick={() => setHandoffPageExpr(`1-${totalPdfPages}`)}
                          className="px-1.5 py-0.5 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-800 text-[10px] font-bold cursor-pointer"
                        >
                          Tất cả
                        </button>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={handoffPageExpr}
                      onChange={(e) => setHandoffPageExpr(e.target.value)}
                      placeholder={`VD: 1-7, 1,3,5 (để trống = trang ${activePdfPage})`}
                      className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-[11px] font-mono text-slate-800 focus:outline-none focus:border-[#146C53]"
                    />

                    {handoffWarning && (
                      <div className="rounded bg-amber-50 border border-amber-300 px-2 py-1.5 text-[10px] text-amber-900 leading-snug">
                        <span className="font-bold">Cảnh báo trang chưa xử lý / bỏ qua:</span> {handoffWarning}
                      </div>
                    )}
                  </div>
                );
              })()}

              <button
                onClick={async () => {
                  if (!renderedCanvas || contoursMm.length === 0) return;
                  setLoading(true);
                  setError('');
                  setHandoffWarning('');
                  try {
                    const applyBleedFill = showBleedContour && bleedOffsetMm > 0 && contourBleedFillMode !== 'off';
                    const effBleedMm = showBleedContour ? bleedOffsetMm : 0;

                    // Parse flexible page expression: '', 'all', '1', '1-7', '1,3,5-7'
                    const parsePageExpr = (expr, maxP, curP) => {
                      const raw = String(expr || '').trim().toLowerCase();
                      if (!raw) return [curP];
                      if (raw === 'all' || raw === '*') return Array.from({ length: maxP }, (_, i) => i + 1);
                      const set = new Set();
                      for (const part of raw.split(/[,;\s]+/).filter(Boolean)) {
                        const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
                        if (range) {
                          const a = Math.max(1, Math.min(maxP, parseInt(range[1], 10)));
                          const b = Math.max(1, Math.min(maxP, parseInt(range[2], 10)));
                          const lo = Math.min(a, b), hi = Math.max(a, b);
                          for (let p = lo; p <= hi; p++) set.add(p);
                        } else if (/^\d+$/.test(part)) {
                          const p = parseInt(part, 10);
                          if (p >= 1 && p <= maxP) set.add(p);
                        }
                      }
                      const arr = Array.from(set).sort((a, b) => a - b);
                      if (arr.length === 0) throw new Error(`Dải trang "${expr}" không hợp lệ (chỉ nhận từ 1 đến ${maxP}).`);
                      return arr;
                    };

                    const targetPages =
                      sourceType === 'pdf' && totalPdfPages > 1
                        ? parsePageExpr(handoffPageExpr, totalPdfPages, activePdfPage)
                        : [activePdfPage];

                    if (
                      sourceType === 'pdf' &&
                      totalPdfPages > 1 &&
                      (targetPages.length > 1 || targetPages[0] !== activePdfPage) &&
                      pdfBytesRef.current &&
                      typeof onSendV1StickersToImpose === 'function'
                    ) {
                      const part = partitionPagesForHandoff({
                        targetPages,
                        pageStates,
                        pageCacheMap: pdfPageCacheRef.current,
                        currentBleedSignature: currentBleedSig,
                        fileSignature: pdfFileSigRef.current,
                      });

                      if (part.warningMessage) {
                        setHandoffWarning(part.warningMessage);
                      }

                      if (part.readyPages.length === 0) {
                        throw new Error(
                          `Chưa có trang nào trong dải [${targetPages.join(', ')}] đạt BLEED Ready. Hãy bấm "Bóc tách tất cả (${totalPdfPages} trang)" trước khi chuyển sang Bình Tem.`
                        );
                      }

                      onSendV1StickersToImpose({
                        pages: part.readyPages,
                        cleanArtworkCanvas: part.readyPages[0].cleanArtworkCanvas,
                        cleanArtworkBytes: part.readyPages[0].cleanArtworkBytes,
                        sourceSizeMm: part.readyPages[0].sourceSizeMm,
                        contoursMm: part.readyPages[0].contoursMm,
                        bleedOffsetMm: effBleedMm,
                        contourProvenance: part.readyPages[0].contourProvenance,
                        sourceFileName: sourceFile?.name || 'tem',
                        handoffWarning: part.warningMessage || null,
                      });
                      return;
                    }

                    const cleanCanvas = applyBleedFill
                      ? buildBleedFilledExportCanvas(renderedCanvas, transparentArtworkCanvas, sizeMm, contoursMm, {
                        mode: contourBleedFillMode,
                        solidColorHex: contourBleedColorHex,
                      })
                      : renderedCanvas;
                    const blob = await new Promise((resolve) => cleanCanvas.toBlob(resolve, 'image/png'));
                    if (!blob) throw new Error('Không thể xuất PNG artwork sạch để chuyển sang Bình Tem V1.');
                    const cleanArtworkBytes = new Uint8Array(await blob.arrayBuffer());
                    if (typeof onSendV1StickersToImpose === 'function') {
                      onSendV1StickersToImpose({
                        cleanArtworkCanvas: cleanCanvas,
                        cleanArtworkBytes,
                        sourceSizeMm: { w: sizeMm.w, h: sizeMm.h },
                        contoursMm,
                        bleedOffsetMm: effBleedMm,
                        contourProvenance,
                        sourceFileName: sourceFile?.name || 'tem',
                      });
                    } else {
                      throw new Error('Không tìm thấy luồng Bình Tem Bế V1 (Single Pipeline).');
                    }
                  } catch (err) {
                    console.error(err);
                    setError(err?.message || 'Không thể chuyển dữ liệu sang Bình Tem Bế V1.');
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading || contoursMm.length === 0}
                className="w-full p-2.5 rounded-xl bg-white hover:bg-emerald-50/60 border border-slate-200 hover:border-[#146C53] flex items-center justify-between gap-2 text-left transition-all cursor-pointer shadow-2xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-lg shrink-0">✂️</span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800">Bình bài Bế Tem</div>
                    <div className="text-[11px] text-slate-500 truncate">Chuyển sang tab Bình Tem V1 · Giữ nguyên Bézier gốc</div>
                  </div>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[9px] font-extrabold shrink-0">
                  V1
                </span>
              </button>

              <button
                onClick={() => { }}
                disabled
                title="Tạm khóa trong Single Pipeline V1 — dùng Bình bài Bế Tem (V1) để bảo toàn đường bế Bézier gốc"
                className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2 text-left opacity-55 cursor-not-allowed"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-lg shrink-0">🔗</span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-600">Bình lồng ghép tự do</div>
                    <div className="text-[11px] text-slate-400 truncate">Chưa hỗ trợ trong V1 · Không fallback Legacy</div>
                  </div>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[9px] font-extrabold shrink-0">
                  V1 KHÓA
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

        {/* Sticky Bottom Export Bar (always reachable regardless of panel scroll) */}
        <div className="shrink-0 bg-[#F8FAFC] border-t border-[#E2E8F0] p-3 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={loading || !renderedCanvas}
              className={`h-9 px-2.5 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${loading || !renderedCanvas
                ? 'bg-[#E2E8F0] text-[#94A3B8] cursor-not-allowed'
                : 'bg-[#087F5B] hover:bg-[#064E3B] text-white shadow-xs'
                }`}
            >
              <PkIcon name="download" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{loading ? 'Đang xử lý...' : 'Tải PDF nguyên tờ'}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSplitExport(false)}
              disabled={loading || contoursMm.length === 0}
              className="h-9 px-2.5 rounded-lg bg-white hover:bg-[#DDF5EC] border border-[#087F5B] text-[#064E3B] text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <PkIcon name="layers" className="w-3.5 h-3.5 shrink-0 text-[#087F5B]" />
              <span className="truncate">Tách {contoursMm.length} trang</span>
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
