import React, { useState, useMemo, useEffect } from 'react';
import PdfCanvasPreview from './PdfCanvasPreview';
import DielineStudio from './DielineStudio';
import Book3DViewer from './Book3DViewer';
import FilePrepStudio from './FilePrepStudio';
import TemplateLibrary from './TemplateLibrary';
import BleedAndContourStudio from './BleedAndContourStudio';
import { PkIcon } from './PrintKitUI';
import { PAPER_SIZES, computeImpositionPlan } from '../engine/impositionEngine';
import { exportImposedPdf, exportStickerPdf, exportStickerCutSvg } from '../engine/pdfExporter';

export default function PdfEditor() {
  // --- Top-Level Navigation ('viewer' | 'library' | 'dieline' | 'namecard' | 'sticker' | 'booklet' | 'bleed' | 'resize' | 'organizer' | 'crop' | 'trimShift') ---
  const [activeStudio, setActiveStudio] = useState('viewer');
  const [selectedTemplateId, setSelectedTemplateId] = useState('ste');
  const [toolSearch, setToolSearch] = useState('');
  const [showSettingsPanel, setShowSettingsPanel] = useState(true);
  const [showPagesSidebar, setShowPagesSidebar] = useState(true);
  const [inspectedPageIndex, setInspectedPageIndex] = useState(null);

  // --- Multi-File & Gang-Run State ---
  const [sourceFiles, setSourceFiles] = useState([]);
  const [pdfPages, setPdfPages] = useState([]);
  const [gangItems, setGangItems] = useState([]);

  // --- Core Imposition Mode (synced cleanly with activeStudio) ---
  const mode = activeStudio === 'booklet' ? 'booklet' : activeStudio === 'sticker' ? 'sticker' : 'grid';
  const [paperSizeKey, setPaperSizeKey] = useState('A3');
  const [customPaperWidth, setCustomPaperWidth] = useState('325');
  const [customPaperHeight, setCustomPaperHeight] = useState('430');
  const [orientation, setOrientation] = useState('landscape');

  // --- PrynX Grid / Guillotine Settings ---
  const [layoutType, setLayoutType] = useState('optimal');
  const [collation, setCollation] = useState('stepAndRepeat');
  const [flowPattern, setFlowPattern] = useState('Z'); // 'Z' | 'S' | 'N'
  const [finishedSizePreset, setFinishedSizePreset] = useState('auto'); // 'auto' | '90x54' | '88x53' | '85x55' | 'custom'
  const [targetTrimW, setTargetTrimW] = useState('');
  const [targetTrimH, setTargetTrimH] = useState('');
  const [stackSplit, setStackSplit] = useState(0);
  const [duplexMode, setDuplexMode] = useState('simplex');
  const [inkingAxis, setInkingAxis] = useState('none');
  const [alignment, setAlignment] = useState('center');
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(5);
  const [gutterX, setGutterX] = useState(2);
  const [gutterY, setGutterY] = useState(2);
  const [bleedMm, setBleedMm] = useState(1.5);
  const [keepOriginalSize, setKeepOriginalSize] = useState(true);

  // --- Booklet Settings ---
  const [bookletStyle, setBookletStyle] = useState('saddleStitch');
  const [bookletBinding, setBookletBinding] = useState('left');
  const [bookletCreep, setBookletCreep] = useState(0.2);
  const [pagesPerSignature, setPagesPerSignature] = useState(8);
  const [coverPagesAtEnd, setCoverPagesAtEnd] = useState(0);

  // --- Sticker Die-Cut Settings ('sticker' mode) ---
  const [stickerUnit, setStickerUnit] = useState('single'); // 'single' (Từng tem) | 'sheet' (Nguyên tấm decal)
  const [stickerShape, setStickerShape] = useState('rect'); // 'rect' | 'circle' | 'oval' | 'pdfContour'
  const [cornerRadiusMm, setCornerRadiusMm] = useState(3);
  const [stickerLayout, setStickerLayout] = useState('nesting'); // 'nesting' | 'optimal' | 'honeycomb' | 'simple'
  const [pontType, setPontType] = useState('circle5mm'); // 'circle5mm' | 'circleHollow' | 'graphtec' | 'none'
  const [pontMarginMm, setPontMarginMm] = useState(10);
  const [pontSizeMm, setPontSizeMm] = useState(5);
  const [avoidCornerMarks, setAvoidCornerMarks] = useState(true);
  const [singleCut1Dao, setSingleCut1Dao] = useState(true);
  const [splitStickerPreview, setSplitStickerPreview] = useState(false);
  const [autoCropInk, setAutoCropInk] = useState(false);
  const [pageRangeExpr, setPageRangeExpr] = useState('');
  const [stickerAutoFillSheet, setStickerAutoFillSheet] = useState(true);
  const [stickerQtyInput, setStickerQtyInput] = useState('');
  const [showStickerQtyTable, setShowStickerQtyTable] = useState(false);
  const [showExtendedStickerSettings, setShowExtendedStickerSettings] = useState(false);
  const [openStickerSubSection, setOpenStickerSubSection] = useState('pont');
  const [clusterSplit, setClusterSplit] = useState('none'); // 'none' | 'split2H' | 'split2V' | 'split3H'
  const [stickerTrimMarks, setStickerTrimMarks] = useState('none'); // 'none' | 'guillotine'
  const [showTrimMarkModal, setShowTrimMarkModal] = useState(false);
  const [markThicknessPt, setMarkThicknessPt] = useState(0.25);

  // --- Margins & Marks ---
  const [marginTop, setMarginTop] = useState(10);
  const [marginBottom, setMarginBottom] = useState(10);
  const [marginLeft, setMarginLeft] = useState(10);
  const [marginRight, setMarginRight] = useState(10);
  const [marginIncludesMarks, setMarginIncludesMarks] = useState(false);

  const [markStyle, setMarkStyle] = useState('western');
  const [markLength, setMarkLength] = useState(5);
  const [markOffset, setMarkOffset] = useState(3);
  const [registrationMarks, setRegistrationMarks] = useState(true);
  const [registrationColor, setRegistrationColor] = useState(false);
  const [showSlugLine, setShowSlugLine] = useState(true);
  const [showBleedOverlay, setShowBleedOverlay] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(true);
  const [safeInsetMm, setSafeInsetMm] = useState(3);

  // --- UI State ---
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const [showRulers, setShowRulers] = useState(true);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [showBook3D, setShowBook3D] = useState(false);

  useEffect(() => {
    const preventDefault = (e) => e.preventDefault();
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        setZoom(1.0);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setZoom((z) => Math.min(10.0, Math.round((z + 0.25) * 100) / 100));
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(0.35, Math.round((z - 0.25) * 100) / 100));
      }
    };
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleAddFiles = (fileList) => {
    const valid = Array.from(fileList || []).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (valid.length === 0) return;

    const newEntries = valid.map((file, i) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
      file,
    }));
    setSourceFiles((prev) => [...prev, ...newEntries]);
    setError(null);
    setSuccess(false);
  };

  const handlePagesSynced = (flatPages, fileGroups) => {
    setPdfPages(flatPages);
    setCurrentSheetIndex(0);

    if (flatPages.length === 0) {
      setGangItems([]);
      return;
    }

    const nextItems = [];
    let hasAnyTwoSided = false;

    for (const fg of fileGroups) {
      const baseName = fg.fileName.replace(/\.pdf$/i, '');
      if (fg.pageCount === 2) {
        hasAnyTwoSided = true;
        nextItems.push({
          id: `${fg.fileId}-pair`,
          name: baseName,
          frontIndex: fg.startGlobalIdx,
          backIndex: fg.startGlobalIdx + 1,
          quantity: 100,
        });
      } else {
        for (let p = 0; p < fg.pageCount; p++) {
          nextItems.push({
            id: `${fg.fileId}-p${p}`,
            name: fg.pageCount > 1 ? `${baseName} (T${p + 1})` : baseName,
            frontIndex: fg.startGlobalIdx + p,
            backIndex: null,
            quantity: 100,
          });
        }
      }
    }

    setGangItems(nextItems);

    if (hasAnyTwoSided && duplexMode === 'simplex') {
      setDuplexMode('workAndTurn');
    }
    if (nextItems.length > 1 && collation === 'stepAndRepeat') {
      setCollation('sequential');
    }
    if (flatPages.some((p) => p.extractedContours && p.extractedContours.length > 0)) {
      setStickerShape('pdfContour');
    }
  };

  const mergeWithNextItem = (idx) => {
    if (idx < 0 || idx >= gangItems.length - 1) return;
    const cur = gangItems[idx];
    const nxt = gangItems[idx + 1];
    if (cur.backIndex !== null || nxt.backIndex !== null) return;
    const merged = {
      id: `${cur.id}+${nxt.id}`,
      name: `${cur.name} (2 mặt)`,
      frontIndex: cur.frontIndex,
      backIndex: nxt.frontIndex,
      quantity: cur.quantity,
    };
    const nextList = [...gangItems];
    nextList.splice(idx, 2, merged);
    setGangItems(nextList);
    if (duplexMode === 'simplex') setDuplexMode('workAndTurn');
  };

  const splitItem = (idx) => {
    const cur = gangItems[idx];
    if (!cur || cur.backIndex === null) return;
    const a = { id: `${cur.id}-f`, name: `${cur.name} (M1)`, frontIndex: cur.frontIndex, backIndex: null, quantity: cur.quantity };
    const b = { id: `${cur.id}-b`, name: `${cur.name} (M2)`, frontIndex: cur.backIndex, backIndex: null, quantity: cur.quantity };
    const nextList = [...gangItems];
    nextList.splice(idx, 1, a, b);
    setGangItems(nextList);
  };

  const removeGangItem = (idx) => {
    setGangItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const duplicateGangItem = (idx) => {
    setGangItems((prev) => {
      const target = prev[idx];
      if (!target) return prev;
      const copy = { ...target, id: `${target.id}-dup-${Date.now()}` };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };

  // Imposio-style Page Range & Multiplier Filter (e.g. "3-15", "1-3, 7", "odd", "even", "3*", "3-15*2")
  const applyPageRangeFilter = (rawExpr = pageRangeExpr) => {
    const expr = (rawExpr || '').trim().toLowerCase();
    if (!expr || pdfPages.length === 0) return;

    const total = pdfPages.length;
    const selectedIndices = [];
    const tokens = expr.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);

    for (const tok of tokens) {
      let part = tok;
      let mult = 1;
      if (tok.includes('*')) {
        const [lhs, rhs] = tok.split('*').map((s) => s.trim());
        // Support both "3*" (page 3 x1 or all x3) and "3-15*2"
        if (lhs && rhs) {
          part = lhs;
          mult = Math.max(1, Math.min(200, parseInt(rhs, 10) || 1));
        } else if (lhs && !rhs) {
          const n = parseInt(lhs, 10);
          if (total === 1 && n > 1) {
            part = '1';
            mult = Math.min(200, n);
          } else {
            part = lhs;
            mult = 2;
          }
        }
      }

      let rangeIndices = [];
      if (part === 'odd' || part === 'le' || part === 'lẻ') {
        for (let p = 1; p <= total; p += 2) rangeIndices.push(p - 1);
      } else if (part === 'even' || part === 'chan' || part === 'chẵn') {
        for (let p = 2; p <= total; p += 2) rangeIndices.push(p - 1);
      } else if (part === 'all' || part === '*') {
        for (let p = 1; p <= total; p++) rangeIndices.push(p - 1);
      } else if (part.includes('-')) {
        const [aStr, bStr] = part.split('-').map((s) => s.trim());
        const a = Math.max(1, parseInt(aStr, 10) || 1);
        const b = Math.min(total, parseInt(bStr, 10) || total);
        const step = a <= b ? 1 : -1;
        for (let p = a; a <= b ? p <= b : p >= b; p += step) {
          if (p >= 1 && p <= total) rangeIndices.push(p - 1);
        }
      } else {
        const p = parseInt(part, 10);
        if (p >= 1 && p <= total) rangeIndices.push(p - 1);
      }

      for (let m = 0; m < mult; m++) {
        selectedIndices.push(...rangeIndices);
      }
    }

    if (selectedIndices.length > 0) {
      setGangItems(
        selectedIndices.map((pIdx, i) => {
          const pg = pdfPages[pIdx];
          const base = (pg?.fileName || 'Trang').replace(/\.pdf$/i, '');
          return {
            id: `filter-${Date.now()}-${i}-${pIdx}`,
            name: `${base} (T${pIdx + 1})`,
            frontIndex: pIdx,
            backIndex: null,
            quantity: 100,
          };
        })
      );
      setCurrentSheetIndex(0);
    }
  };

  const removeSmallMarkPages = () => {
    if (pdfPages.length === 0) return;
    setGangItems((prev) =>
      prev.filter((it) => {
        const pg = pdfPages[it.frontIndex];
        if (!pg) return false;
        const w = autoCropInk && pg.inkBox ? pg.inkBox.trimWmm : pg.trimWmm || pg.mediaWmm;
        const h = autoCropInk && pg.inkBox ? pg.inkBox.trimHmm : pg.trimHmm || pg.mediaHmm;
        return w >= 25 || h >= 25;
      })
    );
    setCurrentSheetIndex(0);
  };

  const resetAllGangPages = () => {
    if (pdfPages.length === 0) return;
    setGangItems(
      pdfPages.map((pg, idx) => ({
        id: `reset-${Date.now()}-${idx}`,
        name: `${(pg.fileName || 'Trang').replace(/\.pdf$/i, '')} (T${idx + 1})`,
        frontIndex: idx,
        backIndex: null,
        quantity: 100,
      }))
    );
    setPageRangeExpr('');
    setCurrentSheetIndex(0);
  };

  const updateItemQuantity = (idx, qty) => {
    setGangItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, quantity: Math.max(1, parseInt(qty, 10) || 1) } : it))
    );
  };

  const applyNamecardPreset = (presetKey) => {
    setActiveStudio('namecard');
    setKeepOriginalSize(true);
    setBleedMm(1.5);
    setGutterX(2);
    setGutterY(2);
    setMarginTop(10);
    setMarginBottom(10);
    setMarginLeft(10);
    setMarginRight(10);
    setMarkStyle('western');

    if (presetKey === 'a3_dutch_90x54') {
      setPaperSizeKey('A3');
      setOrientation('landscape');
      setLayoutType('optimal');
      setFinishedSizePreset('90x54');
      setTargetTrimW('90');
      setTargetTrimH('54');
    } else if (presetKey === 'sra3_90x54') {
      setPaperSizeKey('SRA3');
      setOrientation('landscape');
      setLayoutType('optimal');
      setFinishedSizePreset('90x54');
      setTargetTrimW('90');
      setTargetTrimH('54');
    } else if (presetKey === 'd325_90x54') {
      setPaperSizeKey('D325x430');
      setOrientation('landscape');
      setLayoutType('optimal');
      setFinishedSizePreset('90x54');
      setTargetTrimW('90');
      setTargetTrimH('54');
    } else if (presetKey === 'a3_grid_88x53') {
      setPaperSizeKey('A3');
      setOrientation('landscape');
      setLayoutType('simple');
      setFinishedSizePreset('88x53');
      setTargetTrimW('88');
      setTargetTrimH('53');
    }
  };

  const handleFinishedSizePresetChange = (val) => {
    setFinishedSizePreset(val);
    if (val === 'auto') {
      setTargetTrimW('');
      setTargetTrimH('');
    } else if (val === '90x54') {
      setTargetTrimW('90');
      setTargetTrimH('54');
    } else if (val === '88x53') {
      setTargetTrimW('88');
      setTargetTrimH('53');
    } else if (val === '85x55') {
      setTargetTrimW('85');
      setTargetTrimH('55');
    }
  };

  const clearAllFiles = () => {
    setSourceFiles([]);
    setPdfPages([]);
    setGangItems([]);
    setError(null);
    setSuccess(false);
  };

  const liveConfig = useMemo(
    () => ({
      mode,
      paperSizeKey,
      customPaperWidth,
      customPaperHeight,
      orientation,
      layoutType,
      collation,
      flowPattern,
      targetTrimW: finishedSizePreset === 'auto' ? 0 : Number(targetTrimW) || 0,
      targetTrimH: finishedSizePreset === 'auto' ? 0 : Number(targetTrimH) || 0,
      stackSplit,
      duplexMode,
      inkingAxis,
      alignment,
      cols,
      rows,
      gutterX,
      gutterY,
      bleedMm,
      keepOriginalSize,
      bookletStyle,
      bookletBinding,
      bookletCreep,
      pagesPerSignature,
      coverPagesAtEnd,
      stickerUnit,
      stickerShape,
      cornerRadiusMm,
      stickerLayout,
      pontType,
      pontMarginMm,
      pontSizeMm,
      avoidCornerMarks,
      singleCut1Dao,
      stickerAutoFillSheet,
      clusterSplit,
      stickerTrimMarks,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
      marginIncludesMarks,
      markStyle,
      markLength,
      markOffset,
      registrationMarks,
      registrationColor,
      showSlugLine,
      safeInsetMm,
      markThicknessPt,
      autoCropInk,
      gangItems,
    }),
    [
      mode,
      paperSizeKey,
      customPaperWidth,
      customPaperHeight,
      orientation,
      layoutType,
      collation,
      flowPattern,
      finishedSizePreset,
      targetTrimW,
      targetTrimH,
      stackSplit,
      duplexMode,
      inkingAxis,
      alignment,
      cols,
      rows,
      gutterX,
      gutterY,
      bleedMm,
      keepOriginalSize,
      bookletStyle,
      bookletBinding,
      bookletCreep,
      pagesPerSignature,
      coverPagesAtEnd,
      stickerUnit,
      stickerShape,
      cornerRadiusMm,
      stickerLayout,
      pontType,
      pontMarginMm,
      pontSizeMm,
      avoidCornerMarks,
      singleCut1Dao,
      stickerAutoFillSheet,
      clusterSplit,
      stickerTrimMarks,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
      marginIncludesMarks,
      markStyle,
      markLength,
      markOffset,
      registrationMarks,
      registrationColor,
      showSlugLine,
      safeInsetMm,
      markThicknessPt,
      autoCropInk,
      gangItems,
    ]
  );

  // Debounce: while the user is typing/changing numbers, wait ~300ms after the last change before re-imposing
  // (imposition nesting is heavy; recomputing on every keystroke froze the panel)
  const [config, setConfig] = useState(liveConfig);
  useEffect(() => {
    if (liveConfig === config) return;
    const t = setTimeout(() => setConfig(liveConfig), 300);
    return () => clearTimeout(t);
  }, [liveConfig]); // eslint-disable-line react-hooks/exhaustive-deps
  const isRecomputingPlan = liveConfig !== config;

  const plan = useMemo(() => computeImpositionPlan(pdfPages, config), [pdfPages, config]);

  useEffect(() => {
    if (plan.sheets.length > 0 && currentSheetIndex >= plan.sheets.length) {
      setCurrentSheetIndex(0);
    }
  }, [plan.sheets.length, currentSheetIndex]);

  const handleDownload = async (stickerRole = 'print') => {
    if (sourceFiles.length === 0 || plan.sheets.length === 0) {
      setError('Vui lòng chọn ít nhất 1 file PDF trước khi xuất!');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const baseName = sourceFiles.length > 1 ? `GangRun_${sourceFiles.length}files.pdf` : sourceFiles[0].file.name;
      if (mode === 'sticker') {
        if (stickerRole === 'svg') {
          const svg = exportStickerCutSvg(plan, currentSheetIndex);
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `FileBe_${baseName.replace(/\.pdf$/i, '')}.svg`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
        } else {
          const pdfBytesOutput = await exportStickerPdf(sourceFiles, plan, config, stickerRole);
          const blob = new Blob([pdfBytesOutput], { type: 'application/pdf' });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${stickerRole === 'cut' ? 'FileBe' : 'FileIn'}_${baseName}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
        }
      } else {
        const pdfBytesOutput = await exportImposedPdf(sourceFiles, plan, config);
        const blob = new Blob([pdfBytesOutput], { type: 'application/pdf' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Imposed_${baseName}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      }
      setSuccess(true);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Đã xảy ra lỗi khi xuất file.');
    } finally {
      setLoading(false);
    }
  };

  const firstPage = pdfPages[0];

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#F3F5F7] text-[#17212F] font-sans">
      {/* 1. TOP NAVIGATION BAR (Light Desktop Professional Shell — 52px) */}
      <header className="h-[52px] bg-white border-b border-[#E2E8F0] px-3.5 flex items-center justify-between gap-3 shrink-0 z-30 select-none">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setActiveStudio('viewer')}
            title="PrintKit Professional 2.0 — Về chế độ Xem tài liệu gốc"
            className="flex items-center gap-2 cursor-pointer group shrink-0"
          >
            <img
              src="/printkit_icon.png"
              alt="PrintKit"
              className="w-7 h-7 rounded-md border border-[#E2E8F0] bg-white p-0.5 object-contain"
            />
            <div className="flex items-center gap-1.5">
              <span className="font-bold tracking-tight text-[15px] text-[#17212F]">
                Print<span className="text-[#087F5B]">Kit</span>
              </span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase bg-[#DDF5EC] text-[#064E3B]">
                PRO 2.0
              </span>
            </div>
          </button>

          <span className="h-5 w-px bg-[#E2E8F0] hidden sm:block shrink-0" />

          {/* Active Document Tab Pill */}
          {sourceFiles.length > 0 ? (
            <div className="flex items-center bg-[#F3F5F7] rounded-md border border-[#E2E8F0] overflow-hidden max-w-[300px]">
              <button
                onClick={() => {
                  setActiveStudio('viewer');
                  setShowSettingsPanel(false);
                  setInspectedPageIndex(0);
                }}
                title={`Đang mở: ${sourceFiles[0].file.name} (${pdfPages.length} trang) — Bấm để xem trang gốc`}
                className="px-2.5 py-1 hover:bg-[#E2E8F0]/60 text-xs font-medium text-[#17212F] cursor-pointer flex items-center gap-1.5 min-w-0"
              >
                <PkIcon name="file" className="w-3.5 h-3.5 text-[#087F5B] shrink-0" />
                <span className="truncate font-semibold">
                  {sourceFiles[0].file.name}
                  {sourceFiles.length > 1 ? ` (+${sourceFiles.length - 1})` : ''}
                </span>
                {pdfPages.length > 0 && (
                  <span className="text-[10px] font-mono text-[#64748B] shrink-0">({pdfPages.length} tr)</span>
                )}
              </button>
              <button
                onClick={() => {
                  clearAllFiles();
                  setInspectedPageIndex(null);
                  setActiveStudio('viewer');
                }}
                title="Đóng file đang mở"
                className="px-2 py-1 hover:bg-[#DC4545] text-[#64748B] hover:text-white text-xs font-bold cursor-pointer border-l border-[#E2E8F0] transition-colors shrink-0"
              >
                ×
              </button>
            </div>
          ) : (
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-[#64748B]">
              <span className="w-2 h-2 rounded-full bg-[#CBD5E1]" />
              Chưa mở tài liệu PDF
            </span>
          )}
        </div>

        {/* Right Primary & Secondary Utility Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <label
            title="Mở file PDF mới từ máy tính"
            className="h-8 px-3 rounded-md bg-white hover:bg-[#F3F5F7] border border-[#CBD5E1] text-xs font-semibold text-[#17212F] cursor-pointer flex items-center gap-1.5 transition-colors"
          >
            <PkIcon name="folder" className="w-3.5 h-3.5 text-[#087F5B]" />
            <span>{sourceFiles.length > 0 ? 'Mở file khác' : 'Mở file PDF'}</span>
            <input
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  setSourceFiles([]);
                  handleAddFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
          </label>

          {(activeStudio === 'viewer' ||
            activeStudio === 'namecard' ||
            activeStudio === 'sticker' ||
            activeStudio === 'booklet') && (
            <button
              onClick={() => setShowPagesSidebar((v) => !v)}
              title={showPagesSidebar ? 'Thu gọn cột Quản lý Trang' : 'Mở cột Quản lý Trang'}
              className={`h-8 px-2.5 rounded-md border text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                showPagesSidebar
                  ? 'bg-[#DDF5EC]/60 border-[#087F5B]/30 text-[#064E3B]'
                  : 'bg-white border-[#E2E8F0] text-[#64748B] hover:bg-[#F3F5F7]'
              }`}
            >
              <PkIcon name="panelLeft" className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Trang</span>
            </button>
          )}

          {(activeStudio === 'namecard' || activeStudio === 'sticker' || activeStudio === 'booklet') && (
            <>
              <button
                onClick={() => setShowSettingsPanel((v) => !v)}
                title={showSettingsPanel ? 'Ẩn bảng thông số' : 'Hiện bảng thông số'}
                className={`h-8 px-2.5 rounded-md border text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                  showSettingsPanel
                    ? 'bg-[#DDF5EC]/60 border-[#087F5B]/30 text-[#064E3B]'
                    : 'bg-white border-[#E2E8F0] text-[#64748B] hover:bg-[#F3F5F7]'
                }`}
              >
                <PkIcon name="sliders" className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">Thông số</span>
              </button>
              <button
                onClick={() => handleDownload('print')}
                disabled={loading || sourceFiles.length === 0}
                title="Xuất file PDF chuẩn vector để đưa vào máy in"
                className={`h-8 px-3.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                  loading || sourceFiles.length === 0
                    ? 'bg-[#E2E8F0] text-[#94A3B8] cursor-not-allowed'
                    : 'bg-[#087F5B] hover:bg-[#064E3B] text-white shadow-xs'
                }`}
              >
                <PkIcon name="download" className="w-3.5 h-3.5" />
                <span>
                  {loading
                    ? 'Đang xuất...'
                    : activeStudio === 'booklet'
                    ? 'Xuất PDF Sách'
                    : activeStudio === 'sticker'
                    ? 'Xuất File IN'
                    : 'Xuất PDF In'}
                </span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* EDGE-TO-EDGE 4-ZONE DESKTOP SHELL: [LEFT PAGES] | [CENTER WORKSPACE] | [RIGHT SETTINGS] | [FAR-RIGHT TOOLS] */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden bg-[#F3F5F7]">
        {activeStudio === 'library' && (
          <div className="flex-1 min-w-0 h-full overflow-y-auto p-4">
            <TemplateLibrary
              onSelectTemplate={(id) => {
                setSelectedTemplateId(id);
                setActiveStudio('dieline');
              }}
              onOpenImpose={() => {
                setActiveStudio('namecard');
                setShowSettingsPanel(true);
                setCurrentSheetIndex(0);
              }}
              onOpenBooklet={() => {
                setActiveStudio('booklet');
                setShowSettingsPanel(true);
                setCurrentSheetIndex(0);
              }}
            />
          </div>
        )}

        {activeStudio === 'dieline' && (
          <div className="flex-1 min-w-0 h-full overflow-y-auto p-3 flex">
            <DielineStudio
              templateId={selectedTemplateId}
              onChangeTemplate={(id) => setSelectedTemplateId(id)}
              onOpenLibrary={() => setActiveStudio('library')}
              onOpenImpose={() => {
                setActiveStudio('namecard');
                setShowSettingsPanel(true);
                setCurrentSheetIndex(0);
              }}
            />
          </div>
        )}

        {activeStudio === 'bleed' && (
          <BleedAndContourStudio
            initialFile={sourceFiles[0]?.file || null}
            onSharedFileChange={(newFile) => {
              if (newFile && (newFile.type === 'application/pdf' || newFile.name?.toLowerCase().endsWith('.pdf'))) {
                setSourceFiles([{ id: `bleed-${Date.now()}`, file: newFile }]);
              }
            }}
            onOpenStickerImpose={() => {
              setActiveStudio('sticker');
              setShowSettingsPanel(true);
              setCurrentSheetIndex(0);
            }}
            onSendSplitStickersToImpose={(splitPdfFile, preferredLayout = 'nesting') => {
              setSourceFiles([{ id: `split-${Date.now()}`, file: splitPdfFile }]);
              setPaperSizeKey('D330x390');
              setOrientation('portrait');
              setMarginTop(5);
              setMarginBottom(5);
              setMarginLeft(5);
              setMarginRight(5);
              setGutterX(2);
              setGutterY(2);
              setStickerUnit('single');
              setStickerShape('pdfContour');
              setStickerLayout(preferredLayout);
              setCollation('sequential');
              setActiveStudio('sticker');
              setShowSettingsPanel(true);
              setInspectedPageIndex(null);
              setCurrentSheetIndex(0);
            }}
          />
        )}

        {(activeStudio === 'organizer' ||
          activeStudio === 'resize' ||
          activeStudio === 'crop' ||
          activeStudio === 'trimShift') && (
          <FilePrepStudio
            activeTool={activeStudio}
            initialFile={sourceFiles[0]?.file || null}
            onSharedFileChange={(newFile) => {
              if (newFile) {
                setSourceFiles([{ id: `prep-src-${Date.now()}`, file: newFile }]);
              }
            }}
            onApplyToWorkspace={(processedFile) => {
              setSourceFiles([{ id: `prep-apply-${Date.now()}`, file: processedFile }]);
              setInspectedPageIndex(0);
              setCurrentSheetIndex(0);
            }}
            onSendToImpose={(processedFile) => {
              setSourceFiles([{ id: `prep-${Date.now()}`, file: processedFile }]);
              setActiveStudio('namecard');
              setShowSettingsPanel(true);
              setInspectedPageIndex(null);
              setCurrentSheetIndex(0);
            }}
          />
        )}

        {(activeStudio === 'viewer' ||
          activeStudio === 'namecard' ||
          activeStudio === 'sticker' ||
          activeStudio === 'booklet') && (
          <>
            {/* 2. LEFT SIDEBAR: PAGES MANAGER (204px flush) */}
            {showPagesSidebar && (
              <aside className="w-[204px] bg-white border-r border-[#E2E8F0] p-2.5 flex flex-col gap-2 overflow-hidden h-full shrink-0">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                  <span className="text-[11px] font-bold text-[#17212F] tracking-wider uppercase">
                    Trang ({gangItems.length}/{pdfPages.length})
                  </span>
                  <button
                    onClick={() => setShowPagesSidebar(false)}
                    title="Thu gọn cột Trang"
                    className="w-5 h-5 rounded hover:bg-[#F3F5F7] text-[#64748B] hover:text-[#17212F] text-xs cursor-pointer flex items-center justify-center"
                  >
                    ×
                  </button>
                </div>

                {/* Page range filter box: e.g. 1-3, odd, 3* */}
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={pageRangeExpr}
                    onChange={(e) => setPageRangeExpr(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyPageRangeFilter();
                    }}
                    placeholder="e.g. 3-15, odd, 3*"
                    className="flex-1 min-w-0 bg-slate-50 border border-slate-300 rounded px-2 py-1 text-[11px] font-mono text-slate-800 focus:outline-none focus:border-[#146C53]"
                  />
                  <button
                    onClick={() => applyPageRangeFilter()}
                    title="Áp dụng lọc trang (Enter)"
                    className="px-2 py-1 rounded bg-[#146C53] hover:bg-[#115e48] text-white text-[10px] font-bold cursor-pointer shrink-0"
                  >
                    Lọc
                  </button>
                </div>

                {/* Quick Page Prep Icon Toolbar */}
                <div className="flex items-center justify-between gap-1 bg-slate-50 border border-slate-200/80 rounded-lg px-1.5 py-1">
                  <button
                    onClick={() => setAutoCropInk((v) => !v)}
                    title="Tự động cắt sát vùng mực (Auto-Crop lề trắng)"
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                      autoCropInk ? 'bg-[#146C53] text-white' : 'text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    ✂️ Crop
                  </button>
                  <button
                    onClick={removeSmallMarkPages}
                    title="Loại bỏ dấu bon góc / trang nhỏ hơn 25mm"
                    className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 cursor-pointer"
                  >
                    🧹 &lt;25mm
                  </button>
                  <button
                    onClick={() => {
                      resetAllGangPages();
                      setInspectedPageIndex(null);
                    }}
                    title="Khôi phục toàn bộ trang"
                    className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-600 hover:bg-slate-200 cursor-pointer"
                  >
                    ↺ All
                  </button>
                </div>

                {inspectedPageIndex !== null && (
                  <button
                    onClick={() => setInspectedPageIndex(null)}
                    className="w-full py-1 rounded-lg bg-[#146C53] text-white text-[11px] font-bold cursor-pointer shadow-xs"
                  >
                    ← Xem Tờ Bình
                  </button>
                )}

                {/* Vertical Page Thumbnails List */}
                <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-0.5">
                  {pdfPages.length === 0 ? (
                    <div className="text-[11px] text-slate-400 text-center py-8 px-2">
                      Tải file PDF để xem danh sách thumbnail từng trang
                    </div>
                  ) : (
                    gangItems.map((item, idx) => {
                      const pIdx = item.frontIndex;
                      const pg = pdfPages[pIdx];
                      if (!pg) return null;
                      const isInspected = inspectedPageIndex === pIdx;
                      const effW = autoCropInk && pg.inkBox ? pg.inkBox.trimWmm : pg.hasExplicitTrimBox ? pg.trimWmm : pg.mediaWmm;
                      const effH = autoCropInk && pg.inkBox ? pg.inkBox.trimHmm : pg.hasExplicitTrimBox ? pg.trimHmm : pg.mediaHmm;

                      return (
                        <div
                          key={item.id}
                          onClick={() => setInspectedPageIndex(isInspected ? null : pIdx)}
                          title="Bấm để phóng to kiểm tra riêng trang này (Bấm lần nữa để quay về tờ bình)"
                          className={`group relative rounded-xl p-1.5 border transition-all cursor-pointer flex flex-col items-center ${
                            isInspected
                              ? 'bg-blue-50/90 border-blue-600 ring-2 ring-blue-500/20'
                              : 'bg-slate-100/80 hover:bg-blue-50/40 border-slate-200 hover:border-blue-400'
                          }`}
                        >
                          {/* Top Quick Action Buttons on Thumbnail */}
                          <div className="w-full flex items-center justify-between mb-1 px-0.5">
                            <span className="text-[10px] font-mono font-bold text-slate-500">
                              Trang {pIdx + 1}
                            </span>
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => duplicateGangItem(idx)}
                                title="Nhân bản trang này (x2)"
                                className="px-1 rounded bg-white hover:bg-emerald-50 border border-slate-200 text-[10px] font-bold text-[#146C53] cursor-pointer"
                              >
                                +2×
                              </button>
                              <button
                                onClick={() => removeGangItem(idx)}
                                title="Bỏ trang này khỏi bài bình"
                                className="px-1 rounded bg-white hover:bg-rose-50 border border-slate-200 text-[10px] font-bold text-rose-600 cursor-pointer"
                              >
                                ✕
                              </button>
                            </div>
                          </div>

                          {/* Visual Thumbnail Image Box (Imposio style) */}
                          <div className="w-full h-28 bg-[#9ca3af] rounded-lg border-2 border-blue-500/80 flex items-center justify-center p-1.5 overflow-hidden">
                            <img
                              src={pg.dataUrl}
                              alt={`Trang ${pIdx + 1}`}
                              className="max-w-full max-h-full object-contain bg-white shadow-xs"
                            />
                          </div>

                          {/* Bottom Page Index & mm Dimensions */}
                          <div className="mt-1 flex items-center justify-between w-full px-0.5">
                            <span className="text-[11px] font-bold text-blue-700">#{idx + 1}</span>
                            <span className="text-[10px] font-mono font-semibold text-slate-600">
                              {effW.toFixed(1)}×{effH.toFixed(1)}mm
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </aside>
            )}

            {/* 3. CENTER WORKSPACE: RIBBON TOOLBAR + DARK GRAY PASTEBOARD CANVAS */}
            <main className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-[#52565E]">
              {/* WORKSPACE RIBBON TOOLBAR (40px) */}
              <div className="h-10 px-3 bg-[#F8FAFC] border-b border-[#E2E8F0] flex items-center justify-between gap-2 shrink-0 select-none">
                {/* Left: Zoom & View Guides Controls */}
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center bg-white border border-[#E2E8F0] rounded-md px-1 py-0.5 text-xs font-mono text-[#64748B]">
                    <button
                      onClick={() =>
                        setZoom((z) => Math.max(0.35, Math.round((z - (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))
                      }
                      title="Thu nhỏ"
                      className="w-6 h-6 rounded hover:bg-[#F3F5F7] text-[#17212F] flex items-center justify-center cursor-pointer"
                    >
                      −
                    </button>
                    <span className="min-w-[46px] text-center font-bold text-[#087F5B] text-[11px]">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      onClick={() =>
                        setZoom((z) => Math.min(10.0, Math.round((z + (z >= 2.0 ? 0.35 : 0.2)) * 100) / 100))
                      }
                      title="Phóng to"
                      className="w-6 h-6 rounded hover:bg-[#F3F5F7] text-[#17212F] flex items-center justify-center cursor-pointer"
                    >
                      +
                    </button>
                    <span className="h-4 w-px bg-[#E2E8F0] mx-0.5" />
                    <button
                      onClick={() => setZoom(1.0)}
                      title="Vừa khung nhìn (Fit)"
                      className={`px-1.5 py-0.5 rounded text-[11px] font-sans font-semibold cursor-pointer ${
                        Math.abs(zoom - 1.0) < 0.05 ? 'bg-[#DDF5EC] text-[#064E3B]' : 'hover:bg-[#F3F5F7] text-[#475569]'
                      }`}
                    >
                      Fit
                    </button>
                    <button
                      onClick={() => setZoom(2.0)}
                      className={`px-1.5 py-0.5 rounded text-[11px] cursor-pointer ${
                        Math.abs(zoom - 2.0) < 0.05 ? 'bg-[#DDF5EC] text-[#064E3B]' : 'hover:bg-[#F3F5F7] text-[#475569]'
                      }`}
                    >
                      200%
                    </button>
                    <button
                      onClick={() => setZoom(4.0)}
                      className={`px-1.5 py-0.5 rounded text-[11px] cursor-pointer ${
                        Math.abs(zoom - 4.0) < 0.05 ? 'bg-[#DDF5EC] text-[#064E3B]' : 'hover:bg-[#F3F5F7] text-[#475569]'
                      }`}
                    >
                      400%
                    </button>
                  </div>

                  <span className="h-5 w-px bg-[#E2E8F0] mx-0.5" />

                  <button
                    onClick={() => setShowRulers((v) => !v)}
                    title="Bật / Tắt thước đo mm trên bàn vẽ"
                    className={`h-7 px-2 rounded-md border text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors ${
                      showRulers
                        ? 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'
                        : 'bg-white border-[#E2E8F0] text-[#64748B] hover:bg-[#F3F5F7]'
                    }`}
                  >
                    <PkIcon name="ruler" className="w-3.5 h-3.5" />
                    <span className="hidden lg:inline">Thước mm</span>
                  </button>

                  <button
                    onClick={() => setShowBleedOverlay((v) => !v)}
                    title="Hiển thị đường Tràn lề (Bleed)"
                    className={`h-7 px-2 rounded-md border text-[11px] font-semibold cursor-pointer transition-colors ${
                      showBleedOverlay
                        ? 'bg-rose-50 border-rose-200 text-[#DC4545]'
                        : 'bg-white border-[#E2E8F0] text-[#64748B] hover:bg-[#F3F5F7]'
                    }`}
                  >
                    Bleed
                  </button>

                  <button
                    onClick={() => setShowSafeArea((v) => !v)}
                    title="Hiển thị Vùng an toàn (Safe Zone)"
                    className={`h-7 px-2 rounded-md border text-[11px] font-semibold cursor-pointer transition-colors ${
                      showSafeArea
                        ? 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'
                        : 'bg-white border-[#E2E8F0] text-[#64748B] hover:bg-[#F3F5F7]'
                    }`}
                  >
                    Safe
                  </button>

                  {mode === 'booklet' && (
                    <button
                      onClick={() => setShowBook3D(true)}
                      disabled={pdfPages.length === 0}
                      title="Xem cuốn sách thành phẩm dạng 3D, lật từng trang"
                      className="h-7 px-2.5 rounded-md bg-[#087F5B] hover:bg-[#064E3B] text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <PkIcon name="cube" className="w-3.5 h-3.5" />
                      <span>Xem Sách 3D</span>
                    </button>
                  )}
                </div>

                {/* Right: Live Imposition / Document Summary Metrics */}
                <div className="flex items-center gap-1.5 text-[11px] font-mono">
                  {activeStudio === 'viewer' ? (
                    <span className="px-2 py-0.5 rounded bg-white border border-[#E2E8F0] text-[#475569] font-sans font-medium">
                      Chế độ Xem tài liệu gốc
                    </span>
                  ) : (
                    <>
                      <span className="px-2 py-0.5 rounded bg-[#DDF5EC] text-[#064E3B] font-bold">
                        {plan.summary.itemsPerSheet} con/tờ
                        {plan.summary.secondaryCount > 0 && ` (${plan.summary.primaryCount}+${plan.summary.secondaryCount})`}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-white border border-[#E2E8F0] text-[#17212F] font-semibold">
                        {plan.sheetDim.width}×{plan.sheetDim.height}mm · {plan.summary.utilizationPct}%
                      </span>
                      {plan.summary.ratioSheetsNeeded > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 font-bold">
                          In {plan.summary.ratioSheetsNeeded} tờ
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {error && (
                <div className="px-3 py-1.5 bg-rose-50 border-b border-rose-200 text-[#DC4545] text-xs font-medium shrink-0">
                  {error}
                </div>
              )}
              {success && (
                <div className="px-3 py-1.5 bg-[#DDF5EC] border-b border-[#087F5B]/20 text-[#064E3B] text-xs font-semibold shrink-0">
                  Đã xuất file PDF vector chuẩn CMYK (giữ nguyên Bleed &amp; Smart Clipping).
                </div>
              )}

              <div
                className="flex-1 min-h-0 min-w-0 w-full relative overflow-hidden"
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(true);
                }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(false);
                  if (e.dataTransfer?.files?.length) {
                    handleAddFiles(e.dataTransfer.files);
                  }
                }}
              >
                {sourceFiles.length === 0 && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center p-6 bg-[#52565E]">
                    <label
                      className={`cursor-pointer bg-white rounded-xl border-2 border-dashed p-9 max-w-[420px] w-full flex flex-col items-center gap-3 text-center shadow-2xl transition-all ${
                        isDraggingOver
                          ? 'border-[#087F5B] bg-[#DDF5EC]/30 scale-[1.01]'
                          : 'border-[#CBD5E1] hover:border-[#087F5B]'
                      }`}
                    >
                      <div className="w-14 h-14 rounded-xl bg-[#DDF5EC] text-[#087F5B] flex items-center justify-center">
                        <PkIcon name="file" className="w-7 h-7" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <h2 className="text-[17px] font-bold text-[#17212F]">Bắt đầu dự án in ấn</h2>
                        <p className="text-xs text-[#64748B] leading-relaxed">
                          Kéo thả file PDF vào đây hoặc bấm chọn từ máy tính. File sẽ được đồng bộ sẵn cho tất cả công cụ
                          Bình bài, Bù xén đường cắt và Xử lý trang.
                        </p>
                      </div>
                      <span className="mt-1 px-5 py-2.5 rounded-lg bg-[#087F5B] hover:bg-[#064E3B] text-white text-xs font-semibold flex items-center gap-2 shadow-xs transition-colors">
                        <PkIcon name="folder" className="w-4 h-4" />
                        Mở file PDF
                      </span>
                      <span className="text-[11px] text-[#94A3B8]">Hỗ trợ PDF vector, CMYK, nhiều trang &amp; đường bế CutContour</span>
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            handleAddFiles(e.target.files);
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
                <PdfCanvasPreview
                  sourceFiles={sourceFiles}
                  plan={plan}
                  margins={{ top: marginTop, bottom: marginBottom, left: marginLeft, right: marginRight }}
                  bleedMm={bleedMm}
                  showBleedOverlay={showBleedOverlay}
                  showSafeArea={showSafeArea}
                  showRulers={showRulers}
                  safeInsetMm={safeInsetMm}
                  splitStickerPreview={mode === 'sticker' && splitStickerPreview}
                  autoCropInk={autoCropInk}
                  inspectedPageIndex={
                    activeStudio === 'viewer' ? (inspectedPageIndex !== null ? inspectedPageIndex : 0) : inspectedPageIndex
                  }
                  onExitInspectPage={() => {
                    if (activeStudio === 'viewer') {
                      setActiveStudio('namecard');
                      setShowSettingsPanel(true);
                    }
                    setInspectedPageIndex(null);
                  }}
                  currentSheetIndex={currentSheetIndex}
                  setCurrentSheetIndex={setCurrentSheetIndex}
                  onPagesSynced={handlePagesSynced}
                  zoom={zoom}
                  onZoomChange={setZoom}
                />
              </div>
              {showBook3D && mode === 'booklet' && (
                <Book3DViewer
                  pages={pdfPages}
                  bleedMm={bleedMm}
                  binding={bookletBinding}
                  bookletStyle={bookletStyle}
                  onClose={() => setShowBook3D(false)}
                />
              )}
            </main>

            {/* 4A. ACTIVE TOOL SETTINGS DRAWER (330px flush white panel) */}
            {showSettingsPanel && activeStudio !== 'viewer' && (
              <aside className="w-[330px] bg-white border-l border-[#E2E8F0] p-3.5 flex flex-col gap-3 overflow-y-auto h-full shrink-0">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div>
                    <div className="text-xs font-bold text-slate-800 uppercase">
                      {mode === 'sticker' ? 'BÌNH BÀI BẾ TEM' : mode === 'booklet' ? 'BÌNH SÁCH & TẠP CHÍ' : 'BÌNH CẮT XÉN'}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {mode === 'sticker'
                        ? 'Sắp xếp tem nhãn & đường bế CutContour'
                        : mode === 'booklet'
                        ? 'Đảo trang đóng ghim / đóng keo / gáy xoắn'
                        : 'Xếp tối ưu namecard, tờ rơi, voucher'}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setShowSettingsPanel(false);
                      setActiveStudio('viewer');
                    }}
                    title="Đóng công cụ này để quay về Xem trang PDF gốc"
                    className="w-6 h-6 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 text-sm cursor-pointer"
                  >
                    ×
                  </button>
                </div>
            {/* Multi-File Upload & Gang-Run Item List */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">1. File PDF nguồn</span>
                {pdfPages.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[#E6F4EF] text-[#146C53] text-[10px] font-mono font-bold">
                    {pdfPages.length} trang
                  </span>
                )}
              </div>

              <div className="relative border border-dashed border-slate-300 hover:border-[#146C53] rounded-xl p-3 flex flex-col items-center justify-center cursor-pointer bg-[#FAFBF9] transition-colors">
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  onChange={(e) => {
                    handleAddFiles(e.target.files);
                    e.target.value = '';
                  }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <span className="text-xs font-semibold text-slate-700 text-center">
                  {sourceFiles.length > 0
                    ? `➕ Thêm file PDF (${sourceFiles.length} file · ${pdfPages.length} trang)`
                    : '📄 Chọn 1 hoặc nhiều file PDF để bình'}
                </span>
                {firstPage && (
                  <span className="text-[11px] text-slate-500 font-mono mt-0.5">
                    Gốc: {firstPage.mediaWmm.toFixed(1)}×{firstPage.mediaHmm.toFixed(1)} → TP: {plan.summary.trimW}×{plan.summary.trimH}mm
                  </span>
                )}
              </div>

              {pdfPages.length > 0 && (
                <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-200 rounded-xl p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={pageRangeExpr}
                      onChange={(e) => setPageRangeExpr(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') applyPageRangeFilter();
                      }}
                      placeholder="Lọc trang: VD 3-15, odd, 3*"
                      className="flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-2 py-1 text-[11px] font-mono text-slate-800 focus:outline-none focus:border-[#146C53]"
                    />
                    <button
                      onClick={() => applyPageRangeFilter()}
                      className="px-2.5 py-1 rounded-lg bg-[#146C53] hover:bg-[#115e48] text-white text-[11px] font-bold cursor-pointer shrink-0"
                    >
                      Lọc
                    </button>
                    {gangItems.length !== pdfPages.length && (
                      <button
                        onClick={resetAllGangPages}
                        title="Lấy lại toàn bộ trang"
                        className="px-2 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-semibold cursor-pointer shrink-0"
                      >
                        Tất cả
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-slate-200/70">
                    <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[#146C53] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoCropInk}
                        onChange={(e) => setAutoCropInk(e.target.checked)}
                        className="accent-[#146C53]"
                      />
                      ✂️ Tự cắt sát vùng mực (Auto-Crop)
                    </label>
                    {pdfPages.length > 1 && (
                      <button
                        onClick={removeSmallMarkPages}
                        title="Loại bỏ các trang rác / dấu bon góc nhỏ hơn 25mm"
                        className="px-2 py-0.5 rounded bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-[10px] font-semibold cursor-pointer"
                      >
                        🧹 Bỏ bon góc (&lt;25mm)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {gangItems.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Danh sách mẫu ({gangItems.length}):</span>
                    <button onClick={clearAllFiles} className="text-rose-600 hover:underline font-semibold cursor-pointer">
                      Xóa hết
                    </button>
                  </div>
                  {gangItems.map((item, idx) => {
                    const pgMeta = pdfPages[item.frontIndex];
                    const itemW = pgMeta
                      ? autoCropInk && pgMeta.inkBox
                        ? pgMeta.inkBox.trimWmm
                        : pgMeta.hasExplicitTrimBox
                        ? pgMeta.trimWmm
                        : pgMeta.mediaWmm
                      : 0;
                    const itemH = pgMeta
                      ? autoCropInk && pgMeta.inkBox
                        ? pgMeta.inkBox.trimHmm
                        : pgMeta.hasExplicitTrimBox
                        ? pgMeta.trimHmm
                        : pgMeta.mediaHmm
                      : 0;
                    return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-1.5 bg-[#FAFBF9] border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-slate-800" title={item.name}>
                          {idx + 1}. {item.name}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`px-1.5 rounded text-[10px] font-bold ${
                              item.backIndex !== null
                                ? 'bg-[#E6F4EF] text-[#146C53]'
                                : 'bg-slate-200/70 text-slate-600'
                            }`}
                          >
                            {item.backIndex !== null ? '2 Mặt' : '1 Mặt'}
                          </span>
                          {itemW > 0 && (
                            <span className="text-[10px] font-mono text-slate-500">
                              {itemW.toFixed(1)}×{itemH.toFixed(1)}mm
                            </span>
                          )}
                          {item.backIndex === null && idx < gangItems.length - 1 && gangItems[idx + 1].backIndex === null && (
                            <button
                              onClick={() => mergeWithNextItem(idx)}
                              className="text-[10px] text-amber-600 font-semibold hover:underline cursor-pointer"
                            >
                              Ghép 2 mặt ↓
                            </button>
                          )}
                          {item.backIndex !== null && (
                            <button
                              onClick={() => splitItem(idx)}
                              className="text-[10px] text-sky-600 font-semibold hover:underline cursor-pointer"
                            >
                              Tách
                            </button>
                          )}
                        </div>
                      </div>
                      {collation === 'ratioStack' && (
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItemQuantity(idx, e.target.value)}
                          className="w-14 bg-white border border-slate-300 rounded px-1.5 py-0.5 text-[11px] font-mono text-right text-[#146C53] font-bold"
                        />
                      )}
                      <button
                        onClick={() => removeGangItem(idx)}
                        className="text-slate-400 hover:text-rose-600 px-1 cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>

            {/* Paper & Margins */}
            <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100">
              <span className="text-xs font-bold text-slate-800">2. Khổ giấy &amp; Lề (mm)</span>
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={paperSizeKey}
                  onChange={(e) => setPaperSizeKey(e.target.value)}
                  className="col-span-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
                >
                  {Object.keys(PAPER_SIZES).map((k) => (
                    <option key={k} value={k}>
                      {PAPER_SIZES[k].name}
                    </option>
                  ))}
                </select>
                <select
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
                >
                  <option value="landscape">Ngang</option>
                  <option value="portrait">Đứng</option>
                </select>
              </div>

              {paperSizeKey === 'Custom' && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    value={customPaperWidth}
                    onChange={(e) => setCustomPaperWidth(e.target.value)}
                    placeholder="Rộng (mm)"
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                  <input
                    type="number"
                    value={customPaperHeight}
                    onChange={(e) => setCustomPaperHeight(e.target.value)}
                    placeholder="Cao (mm)"
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
              )}

              <div className="grid grid-cols-4 gap-1.5">
                {[
                  ['Trên', marginTop, setMarginTop],
                  ['Dưới', marginBottom, setMarginBottom],
                  ['Trái', marginLeft, setMarginLeft],
                  ['Phải', marginRight, setMarginRight],
                ].map(([label, val, setter]) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">{label}</label>
                    <input
                      type="number"
                      min="0"
                      value={val}
                      onChange={(e) => setter(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                    />
                  </div>
                ))}
              </div>

              <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={marginIncludesMarks}
                  onChange={(e) => setMarginIncludesMarks(e.target.checked)}
                  className="accent-[#146C53]"
                />
                Lề bao gồm cả bon cắt
              </label>
            </div>

            {/* Mode Controls */}
            {mode === 'grid' ? (
              <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800">3. Preset Namecard &amp; Thuật toán</span>
                </div>

                {/* Quick Namecard Presets */}
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => applyNamecardPreset('a3_dutch_90x54')}
                    className="px-2 py-1.5 rounded-lg bg-[#FAFBF9] hover:bg-[#E6F4EF] border border-slate-200 hover:border-[#146C53] text-[10px] font-semibold text-slate-700 hover:text-[#146C53] text-left cursor-pointer"
                  >
                    90×54 · A3 (Dutch Cut)
                  </button>
                  <button
                    onClick={() => applyNamecardPreset('sra3_90x54')}
                    className="px-2 py-1.5 rounded-lg bg-[#FAFBF9] hover:bg-[#E6F4EF] border border-slate-200 hover:border-[#146C53] text-[10px] font-semibold text-slate-700 hover:text-[#146C53] text-left cursor-pointer"
                  >
                    90×54 · SRA3 (In nhanh)
                  </button>
                  <button
                    onClick={() => applyNamecardPreset('d325_90x54')}
                    className="px-2 py-1.5 rounded-lg bg-[#FAFBF9] hover:bg-[#E6F4EF] border border-slate-200 hover:border-[#146C53] text-[10px] font-semibold text-slate-700 hover:text-[#146C53] text-left cursor-pointer"
                  >
                    90×54 · 325×430mm
                  </button>
                  <button
                    onClick={() => applyNamecardPreset('a3_grid_88x53')}
                    className="px-2 py-1.5 rounded-lg bg-[#FAFBF9] hover:bg-[#E6F4EF] border border-slate-200 hover:border-[#146C53] text-[10px] font-semibold text-slate-700 hover:text-[#146C53] text-left cursor-pointer"
                  >
                    88×53 · A3 (Lưới thẳng)
                  </button>
                </div>

                {/* Finished Size Override */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500">Kích thước thành phẩm (Trim Size)</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    <select
                      value={finishedSizePreset}
                      onChange={(e) => handleFinishedSizePresetChange(e.target.value)}
                      className="col-span-3 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="auto">Tự động theo file PDF</option>
                      <option value="90x54">Chuẩn VN · 90 × 54 mm</option>
                      <option value="88x53">Ép gọn · 88 × 53 mm</option>
                      <option value="85x55">Chuẩn EU/ID · 85 × 55 mm</option>
                      <option value="custom">Tùy chỉnh mm...</option>
                    </select>
                    {finishedSizePreset === 'custom' && (
                      <>
                        <input
                          type="number"
                          value={targetTrimW}
                          onChange={(e) => setTargetTrimW(e.target.value)}
                          placeholder="Rộng mm"
                          className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                        />
                        <input
                          type="number"
                          value={targetTrimH}
                          onChange={(e) => setTargetTrimH(e.target.value)}
                          placeholder="Cao mm"
                          className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                        />
                      </>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500">Cách xếp lưới</label>
                    <select
                      value={layoutType}
                      onChange={(e) => setLayoutType(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="optimal">Dutch Cut (0°+90°)</option>
                      <option value="simple">Lưới đơn giản</option>
                      <option value="manual">Tùy chỉnh Cột×Hàng</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500">Cách thức ráp</label>
                    <select
                      value={collation}
                      onChange={(e) => setCollation(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="stepAndRepeat">Step &amp; Repeat</option>
                      <option value="sequential">N-Up ghép mẫu</option>
                      <option value="repeatPerRow">Mỗi hàng 1 mẫu</option>
                      <option value="repeatPerCol">Mỗi cột 1 mẫu</option>
                      <option value="ratioStack">Ratio Stack (Tỷ lệ)</option>
                      <option value="cutAndStack">Cut &amp; Stack</option>
                    </select>
                  </div>
                </div>

                {(collation === 'sequential' || collation === 'cutAndStack') && (
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] text-slate-500">Thứ tự điền ô (Flow):</label>
                    <select
                      value={flowPattern}
                      onChange={(e) => setFlowPattern(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs"
                    >
                      <option value="Z">Chữ Z (Trái → Phải)</option>
                      <option value="S">Chữ S (Ziczac hàng)</option>
                      <option value="N">Chữ N (Trên → Dưới cột)</option>
                    </select>
                  </div>
                )}

                {collation === 'cutAndStack' && (
                  <div className="flex items-center justify-between gap-2 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200">
                    <label className="text-[11px] text-slate-600">Chia cọc xén (tờ/cọc):</label>
                    <input
                      type="number"
                      min="0"
                      value={stackSplit}
                      onChange={(e) => setStackSplit(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-16 bg-white border border-slate-300 rounded px-2 py-0.5 text-xs font-mono text-right"
                    />
                  </div>
                )}

                {layoutType === 'manual' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] text-slate-500">Số cột</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={cols}
                        onChange={(e) => setCols(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                      />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] text-slate-500">Số hàng</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={rows}
                        onChange={(e) => setRows(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                      />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500">Số mặt &amp; Lật gương</label>
                    <select
                      value={duplexMode}
                      onChange={(e) => setDuplexMode(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="simplex">1 Mặt (Simplex)</option>
                      <option value="workAndTurn">2 Mặt — Trở nhíp</option>
                      <option value="workAndTumble">2 Mặt — Trở đít</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500">Đối đầu 180°</label>
                    <select
                      value={inkingAxis}
                      onChange={(e) => setInkingAxis(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <option value="none">Tắt</option>
                      <option value="row">Theo hàng</option>
                      <option value="col">Theo cột</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Bleed (mm)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={bleedMm}
                      onChange={(e) => setBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Gap X</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={gutterX}
                      onChange={(e) => setGutterX(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Gap Y</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={gutterY}
                      onChange={(e) => setGutterY(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                    />
                  </div>
                </div>
              </div>
            ) : mode === 'sticker' ? (
              <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800">3. Cấu hình Bình Bài Bế Tem</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#E6F4EF] text-[#146C53] text-[10px] font-bold">
                    {stickerUnit === 'sheet' ? 'Nguyên tấm decal' : 'Từng tem'}
                  </span>
                </div>

                {/* ĐƠN VỊ BÌNH: Từng tem vs Nguyên tấm decal (Exact Images 3 & 4) */}
                <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                  <label className="text-[11px] font-bold text-slate-600">ĐƠN VỊ BÌNH</label>
                  <select
                    value={stickerUnit}
                    onChange={(e) => {
                      const val = e.target.value;
                      setStickerUnit(val);
                      if (val === 'sheet') {
                        setStickerLayout('optimal');
                        setStickerTrimMarks('guillotine');
                        setGutterX(0);
                        setGutterY(0);
                      } else {
                        setStickerLayout('nesting');
                        setStickerTrimMarks('none');
                        setGutterX(2);
                        setGutterY(2);
                      }
                    }}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                  >
                    <option value="single">Từng tem (Bế rời / Nesting)</option>
                    <option value="sheet">Nguyên tấm decal (Sticker Sheet)</option>
                  </select>
                </div>

                {/* TÁC VỤ */}
                <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                  <label className="text-[11px] font-bold text-slate-600">TÁC VỤ</label>
                  <select
                    value={collation === 'stepAndRepeat' ? 'stepAndRepeat' : 'sequential'}
                    onChange={(e) => setCollation(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                  >
                    <option value="sequential">Dàn nhiều mẫu (N-Up)</option>
                    <option value="stepAndRepeat">Bình trang (S&amp;R — 1 mẫu/tờ)</option>
                  </select>
                </div>

                {/* CÁCH THỨC RÁP (Appears when ĐƠN VỊ BÌNH = Nguyên tấm decal, Image 4) */}
                {stickerUnit === 'sheet' && (
                  <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                    <label className="text-[11px] font-bold text-slate-600">CÁCH THỨC RÁP</label>
                    <select
                      value={collation}
                      onChange={(e) => setCollation(e.target.value)}
                      className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                    >
                      <option value="sequential">Xếp lần lượt</option>
                      <option value="cutAndStack">Xếp chồng (Cut &amp; Stack)</option>
                      <option value="ratioStack">Ghép theo tỷ lệ SL</option>
                    </select>
                  </div>
                )}

                {/* CÁCH XẾP & HÌNH DÁNG DAO BẾ */}
                <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                  <label className="text-[11px] font-bold text-slate-600">CÁCH XẾP</label>
                  <select
                    value={stickerLayout}
                    onChange={(e) => setStickerLayout(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                  >
                    {stickerUnit === 'single' && (
                      <option value="nesting">Xếp tối ưu (Lồng ghép tự do 1:1)</option>
                    )}
                    <option value="optimal">Xếp tối ưu (Trộn 0°+90°)</option>
                    <option value="honeycomb">Tổ ong so le (Honeycomb)</option>
                    <option value="simple">Lưới đơn giản</option>
                  </select>
                </div>

                <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                  <label className="text-[11px] font-bold text-slate-600">DAO BẾ</label>
                  <select
                    value={stickerShape}
                    onChange={(e) => setStickerShape(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                  >
                    <option value="pdfContour">Theo CutContour PDF</option>
                    <option value="rect">Chữ nhật / Bo góc</option>
                    <option value="circle">Hình tròn</option>
                    <option value="oval">Hình Oval / Elip</option>
                  </select>
                </div>

                {/* HỞ TEM (Từng tem) vs KHOẢNG CÁCH TẤM + BLEED + 👁️ (Nguyên tấm decal) */}
                {stickerUnit === 'single' ? (
                  <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                    <label className="text-[11px] font-bold text-slate-600">HỞ TEM</label>
                    <div className="relative flex items-center">
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={gutterX}
                        onChange={(e) => {
                          const v = Math.max(0, parseFloat(e.target.value) || 0);
                          setGutterX(v);
                          setGutterY(v);
                        }}
                        className="w-full bg-white border border-slate-200 rounded-lg pl-2.5 pr-9 py-1.5 text-xs font-mono"
                      />
                      <span className="absolute right-2.5 text-[10px] font-mono text-slate-400">MM</span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                    <label className="text-[10px] font-bold text-slate-600 leading-tight">KHOẢNG CÁCH TẤM</label>
                    <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
                      <div className="relative flex items-center">
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={gutterX}
                          onChange={(e) => {
                            const v = Math.max(0, parseFloat(e.target.value) || 0);
                            setGutterX(v);
                            setGutterY(v);
                          }}
                          title="Khoảng cách giữa các tấm decal (mm)"
                          className="w-full bg-white border border-slate-200 rounded-lg pl-2 pr-7 py-1.5 text-xs font-mono"
                        />
                        <span className="absolute right-1.5 text-[9px] font-mono text-slate-400">MM</span>
                      </div>
                      <div className="relative flex items-center">
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={bleedMm}
                          onChange={(e) => setBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                          title="Tràn lề Bleed (mm)"
                          className="w-full bg-white border border-slate-200 rounded-lg pl-2 pr-7 py-1.5 text-xs font-mono"
                        />
                        <span className="absolute right-1.5 text-[9px] font-mono text-slate-400">Bleed</span>
                      </div>
                      <button
                        onClick={() => setShowBleedOverlay((v) => !v)}
                        title="Bật/Tắt xem trước đường Tràn lề (Bleed)"
                        className={`p-1.5 rounded-lg border text-xs cursor-pointer ${
                          showBleedOverlay
                            ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                            : 'bg-white border-slate-200 text-slate-400'
                        }`}
                      >
                        👁️
                      </button>
                    </div>
                  </div>
                )}

                {/* SL MỖI LOẠI / SỐ TẤM DECAL (with ⌄ drawer toggle) */}
                <div className="grid grid-cols-[105px_1fr] items-center gap-2">
                  <label className="text-[11px] font-bold text-slate-600">
                    {stickerUnit === 'sheet' ? 'SỐ TẤM DECAL' : 'SL MỖI LOẠI'}
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={stickerQtyInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setStickerQtyInput(val);
                        const trimmed = val.trim();
                        if (!trimmed || trimmed === '0') {
                          setStickerAutoFillSheet(true);
                        } else {
                          const n = parseInt(trimmed, 10);
                          if (n > 0) {
                            setStickerAutoFillSheet(false);
                            setGangItems((prev) => prev.map((it) => ({ ...it, quantity: n })));
                          }
                        }
                      }}
                      placeholder="Trống = Tự lấp đầy tờ"
                      className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
                    />
                    <button
                      onClick={() => setShowStickerQtyTable((v) => !v)}
                      title="Mở bảng chỉnh số lượng riêng từng mẫu"
                      className="px-2 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs cursor-pointer shrink-0"
                    >
                      {showStickerQtyTable ? '⌃' : '⌄'}
                    </button>
                  </div>
                </div>

                {showStickerQtyTable && gangItems.length > 0 && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-2 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-semibold">
                      <span>Số lượng in từng mẫu:</span>
                      <label className="flex items-center gap-1 text-[#146C53] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={stickerAutoFillSheet}
                          onChange={(e) => setStickerAutoFillSheet(e.target.checked)}
                          className="accent-[#146C53]"
                        />
                        Tự lấp đầy khoảng trống cuối tờ
                      </label>
                    </div>
                    {gangItems.map((it, idx) => (
                      <div key={it.id} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-slate-700 font-medium">
                          #{idx + 1}. {it.name}
                        </span>
                        <input
                          type="number"
                          min="1"
                          value={it.quantity}
                          onChange={(e) => updateItemQuantity(idx, e.target.value)}
                          className="w-16 bg-white border border-slate-300 rounded px-1.5 py-0.5 text-[11px] font-mono text-right font-bold text-[#146C53]"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {stickerShape === 'rect' && (
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] text-slate-600">Bo góc tem (mm):</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={cornerRadiusMm}
                      onChange={(e) => setCornerRadiusMm(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-16 bg-white border border-slate-200 rounded px-2 py-0.5 text-xs font-mono text-right"
                    />
                  </div>
                )}

                {/* Accordion: 🎛️ THIẾT LẬP MỞ RỘNG (Exact Image 5 UX) */}
                <button
                  onClick={() => setShowExtendedStickerSettings((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-bold text-slate-800 cursor-pointer mt-1"
                >
                  <span className="flex items-center gap-1.5">
                    <span>🎛️</span>
                    <span>THIẾT LẬP MỞ RỘNG</span>
                  </span>
                  <span className="text-[11px] font-semibold text-slate-500">
                    {showExtendedStickerSettings ? 'Đóng lại ⌃' : 'Mở rộng ⌄'}
                  </span>
                </button>

                {showExtendedStickerSettings && (
                  <div className="flex flex-col gap-2.5 bg-slate-50/70 border border-slate-200/90 rounded-xl p-2.5">
                    {/* Sub-accordion 1: 🎯 ĐỊNH VỊ & CẮT */}
                    <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-col gap-2">
                      <button
                        onClick={() =>
                          setOpenStickerSubSection((s) => (s === 'pont' ? null : 'pont'))
                        }
                        className="w-full flex items-center justify-between text-[11px] font-extrabold text-indigo-900 cursor-pointer"
                      >
                        <span>🎯 ĐỊNH VỊ &amp; CẮT</span>
                        <span>{openStickerSubSection === 'pont' ? '⌄' : '›'}</span>
                      </button>
                      {openStickerSubSection === 'pont' && (
                        <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                          <div className="grid grid-cols-[95px_1fr] items-center gap-2">
                            <label className="text-[10px] font-bold text-slate-500">BOONG ĐỊNH VỊ</label>
                            <select
                              value={pontType}
                              onChange={(e) => setPontType(e.target.value)}
                              className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold"
                            >
                              <option value="circle5mm">Boong 5mm (Tròn đặc)</option>
                              <option value="circleHollow">Boong Tròn rỗng</option>
                              <option value="graphtec">Graphtec (Chữ L)</option>
                              <option value="none">Không dùng boong</option>
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[10px] text-slate-500">Lề đặt boong (mm)</label>
                              <input
                                type="number"
                                min="5"
                                value={pontMarginMm}
                                onChange={(e) => setPontMarginMm(Math.max(5, parseFloat(e.target.value) || 10))}
                                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                              />
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[10px] text-slate-500">Đường kính (mm)</label>
                              <input
                                type="number"
                                min="3"
                                max="10"
                                value={pontSizeMm}
                                onChange={(e) => setPontSizeMm(Math.max(3, parseFloat(e.target.value) || 5))}
                                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                              />
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-[#146C53]"
                              checked={avoidCornerMarks}
                              onChange={(e) => setAvoidCornerMarks(e.target.checked)}
                            />
                            Tránh vùng góc boong (nhét thêm tem dải giữa)
                          </label>
                        </div>
                      )}
                    </div>

                    {/* Sub-accordion 2: 🏷️ THÔNG TIN SẢN PHẨM (REPORT) */}
                    <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-col gap-2">
                      <button
                        onClick={() =>
                          setOpenStickerSubSection((s) => (s === 'report' ? null : 'report'))
                        }
                        className="w-full flex items-center justify-between text-[11px] font-extrabold text-indigo-900 cursor-pointer"
                      >
                        <span>🏷️ THÔNG TIN SẢN PHẨM (REPORT)</span>
                        <span>{openStickerSubSection === 'report' ? '⌄' : '›'}</span>
                      </button>
                      {openStickerSubSection === 'report' && (
                        <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-100 text-[11px] text-slate-600">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-[#146C53]"
                              checked={showSlugLine}
                              onChange={(e) => setShowSlugLine(e.target.checked)}
                            />
                            In dòng thông tin bài in (Slug Line) ở chân tờ
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-[#146C53]"
                              checked={showSafeArea}
                              onChange={(e) => setShowSafeArea(e.target.checked)}
                            />
                            Hiển thị vùng an toàn ({safeInsetMm} mm)
                          </label>
                        </div>
                      )}
                    </div>

                    {/* Sub-accordion 3: 💾 XUẤT & LƯU FILE */}
                    <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-col gap-2">
                      <button
                        onClick={() =>
                          setOpenStickerSubSection((s) => (s === 'export' ? null : 'export'))
                        }
                        className="w-full flex items-center justify-between text-[11px] font-extrabold text-indigo-900 cursor-pointer"
                      >
                        <span>💾 XUẤT &amp; LƯU FILE</span>
                        <span>{openStickerSubSection === 'export' ? '⌄' : '›'}</span>
                      </button>
                      {openStickerSubSection === 'export' && (
                        <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-100 text-[11px] text-slate-600">
                          <label className="flex items-center gap-2 font-semibold text-[#146C53] cursor-pointer">
                            <input
                              type="checkbox"
                              className="accent-[#146C53]"
                              checked={splitStickerPreview}
                              onChange={(e) => setSplitStickerPreview(e.target.checked)}
                            />
                            Tách xem song song Bài In + Khuôn Bế
                          </label>
                          {stickerShape === 'rect' && (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                className="accent-[#146C53]"
                                checked={singleCut1Dao}
                                onChange={(e) => setSingleCut1Dao(e.target.checked)}
                              />
                              Cắt 1 dao (Gộp nét trùng khi Gap = 0)
                            </label>
                          )}
                        </div>
                      )}
                    </div>

                    {/* CÁCH CHIA CỤM (Cluster Splitting for long sheets) */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-slate-600">CÁCH CHIA CỤM (CHỐNG LỆCH MÁY BẾ)</label>
                      <select
                        value={clusterSplit}
                        onChange={(e) => setClusterSplit(e.target.value)}
                        className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                      >
                        <option value="none">Không chia cụm (4 boong góc tờ)</option>
                        <option value="split2H">Chia 2 cụm Ngang (8 boong — Nửa trên &amp; Nửa dưới)</option>
                        <option value="split2V">Chia 2 cụm Dọc (8 boong — Trái &amp; Phải)</option>
                        <option value="split3H">Chia 3 cụm Ngang (12 boong — Khổ dài)</option>
                      </select>
                    </div>

                    {/* CANH KHỐI SAU KHI XẾP */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-slate-600">CANH KHỐI SAU KHI XẾP</label>
                      <select
                        value={alignment}
                        onChange={(e) => setAlignment(e.target.value)}
                        className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                      >
                        <option value="center">Canh Giữa trung tâm</option>
                        <option value="top">Canh Đỉnh trên (Nhíp trên)</option>
                        <option value="bottom">Canh Đáy dưới (Nhíp dưới)</option>
                      </select>
                    </div>

                    {/* DẤU XÉN (TRIM MARKS) + Button ⚙️ to open Modal (Exact Image 5 & 6) */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold text-slate-600">DẤU XÉN (TRIM MARKS)</label>
                        <button
                          onClick={() => setShowTrimMarkModal(true)}
                          title="Tuỳ chỉnh kiểu và kích thước Dấu Xén"
                          className="text-xs text-slate-500 hover:text-[#146C53] cursor-pointer font-bold px-1"
                        >
                          ⚙️ Tuỳ chỉnh
                        </button>
                      </div>
                      <select
                        value={stickerTrimMarks}
                        onChange={(e) => setStickerTrimMarks(e.target.value)}
                        className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800"
                      >
                        <option value="none">Không đánh dấu xén (Chỉ dùng Boong bế)</option>
                        <option value="guillotine">Xén thành phẩm (dao thẳng)</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* Color-Coded Pastel Mini-Map Preview Card (Exact Images 3 & 4) */}
                {plan.sheets.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-[#FAFBF9] p-3 flex flex-col items-center gap-2 mt-1">
                    {stickerUnit === 'sheet' ? (
                      <div className="text-center flex flex-col gap-0.5 text-[11px]">
                        <div className="font-semibold text-slate-700">
                          {plan.sheets.length} bố cục · Đã xếp{' '}
                          <span className="font-bold text-[#146C53]">
                            {plan.summary.totalPlacedItems || plan.summary.itemsPerSheet}/
                            {Math.max(plan.summary.totalNeededItems || 1, plan.summary.totalPlacedItems || 1)}
                          </span>{' '}
                          tem
                        </div>
                        <div className="text-slate-600">
                          Đã xếp: <strong className="text-slate-900">{plan.summary.itemsPerSheet}</strong> tem/tờ · Cần in:{' '}
                          <strong className="text-indigo-700">{plan.summary.physicalSheets}</strong> tờ
                        </div>
                        <div className="text-slate-600">
                          Tem thành phẩm:{' '}
                          <strong className="text-[#146C53] font-mono">
                            {plan.summary.trimW.toFixed(1)} × {plan.summary.trimH.toFixed(1)} mm
                          </strong>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs font-semibold text-slate-700">
                        Sức chứa:{' '}
                        <strong className="text-slate-950 font-extrabold">
                          {plan.sheets[Math.min(currentSheetIndex, plan.sheets.length - 1)]?.placements?.length ||
                            plan.summary.itemsPerSheet}
                        </strong>{' '}
                        tem/tờ
                        {isRecomputingPlan && <span className="ml-1.5 text-violet-600 animate-pulse">⏳ đang tính lại...</span>}
                      </div>
                    )}

                    {plan.sheets.length > 1 && (
                      <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-700">
                        <button
                          disabled={currentSheetIndex <= 0}
                          onClick={() => setCurrentSheetIndex((i) => Math.max(0, i - 1))}
                          className="px-2 py-0.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        >
                          ◀
                        </button>
                        <span>
                          {stickerUnit === 'sheet'
                            ? `Bố cục ${currentSheetIndex + 1}/${plan.sheets.length} · In 1 tờ`
                            : `tờ ${currentSheetIndex + 1} / ${plan.sheets.length}`}
                        </span>
                        <button
                          disabled={currentSheetIndex >= plan.sheets.length - 1}
                          onClick={() => setCurrentSheetIndex((i) => Math.min(plan.sheets.length - 1, i + 1))}
                          className="px-2 py-0.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        >
                          ▶
                        </button>
                      </div>
                    )}

                    {/* Mini-Map SVG with Pastel Color per Design Index */}
                    {(() => {
                      const curSheet =
                        plan.sheets[Math.min(currentSheetIndex, Math.max(0, plan.sheets.length - 1))];
                      if (!curSheet) return null;
                      const pastelPalettes = [
                        { fill: '#dbeafe', stroke: '#3b82f6', text: '#1d4ed8' },
                        { fill: '#d1fae5', stroke: '#10b981', text: '#047857' },
                        { fill: '#fce7f3', stroke: '#ec4899', text: '#be185d' },
                        { fill: '#fef3c7', stroke: '#f59e0b', text: '#b45309' },
                        { fill: '#ede9fe', stroke: '#8b5cf6', text: '#6d28d9' },
                        { fill: '#ffedd5', stroke: '#f97316', text: '#c2410c' },
                        { fill: '#cffafe', stroke: '#06b6d4', text: '#0e7490' },
                        { fill: '#fae8ff', stroke: '#d946ef', text: '#a21caf' },
                      ];
                      return (
                        <svg
                          viewBox={`-6 -6 ${plan.sheetDim.width + 12} ${plan.sheetDim.height + 12}`}
                          className="w-36 h-44 bg-white rounded-lg border border-slate-200 shadow-2xs"
                        >
                          <rect
                            x="0"
                            y="0"
                            width={plan.sheetDim.width}
                            height={plan.sheetDim.height}
                            fill="#ffffff"
                            stroke="#94a3b8"
                            strokeWidth="2"
                            strokeDasharray="6 4"
                          />
                          {curSheet.placements.map((p, pIdx) => {
                            const pal = pastelPalettes[p.pageIndex % pastelPalettes.length];
                            const srcMeta = pdfPages[p.pageIndex];
                            const contours = srcMeta?.extractedContours || [];
                            if (stickerUnit === 'single' && stickerShape === 'pdfContour' && contours.length > 0) {
                              const effW = srcMeta.hasExplicitTrimBox ? srcMeta.trimWmm : srcMeta.mediaWmm;
                              const effH = srcMeta.hasExplicitTrimBox ? srcMeta.trimHmm : srcMeta.mediaHmm;
                              const offL = srcMeta.hasExplicitTrimBox ? srcMeta.trimOffsetLeftMm || 0 : 0;
                              const offT = srcMeta.hasExplicitTrimBox ? srcMeta.trimOffsetTopMm || 0 : 0;
                              const rot = ((p.rotate % 360) + 360) % 360;
                              const isRot90 = rot === 90 || rot === 270;
                              const sx = (isRot90 ? p.trimH : p.trimW) / Math.max(1, effW);
                              const sy = (isRot90 ? p.trimW : p.trimH) / Math.max(1, effH);
                              const ptsStr = contours[0].ptsMm
                                .filter((_, i) => i % 3 === 0)
                                .map(([mx, my]) => {
                                  const ux = (mx - offL) * sx;
                                  const uy = (my - offT) * sy;
                                  let gx = p.x + ux;
                                  let gy = p.y + uy;
                                  if (rot === 90) {
                                    gx = p.x + uy;
                                    gy = p.y + p.trimH - ux;
                                  } else if (rot === 180) {
                                    gx = p.x + p.trimW - ux;
                                    gy = p.y + p.trimH - uy;
                                  } else if (rot === 270) {
                                    gx = p.x + p.trimW - uy;
                                    gy = p.y + ux;
                                  }
                                  return `${gx.toFixed(1)},${gy.toFixed(1)}`;
                                })
                                .join(' ');
                              return (
                                <g key={pIdx}>
                                  <polygon
                                    points={ptsStr}
                                    fill={pal.fill}
                                    stroke={pal.stroke}
                                    strokeWidth="2.2"
                                  />
                                  <text
                                    x={p.x + p.trimW / 2}
                                    y={p.y + p.trimH / 2}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fill={pal.text}
                                    fontSize={Math.max(11, Math.min(22, Math.min(p.trimW, p.trimH) * 0.32))}
                                    fontWeight="bold"
                                  >
                                    {p.pageIndex + 1}
                                  </text>
                                </g>
                              );
                            }
                            return (
                              <g key={pIdx}>
                                <rect
                                  x={p.x}
                                  y={p.y}
                                  width={p.trimW}
                                  height={p.trimH}
                                  rx={stickerShape === 'circle' ? Math.min(p.trimW, p.trimH) / 2 : 3}
                                  fill={pal.fill}
                                  stroke={pal.stroke}
                                  strokeWidth="2"
                                />
                                <text
                                  x={p.x + p.trimW / 2}
                                  y={p.y + p.trimH / 2}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fill={pal.text}
                                  fontSize={Math.max(11, Math.min(22, Math.min(p.trimW, p.trimH) * 0.32))}
                                  fontWeight="bold"
                                >
                                  {p.pageIndex + 1}
                                </text>
                              </g>
                            );
                          })}
                          {(curSheet.pontMarks || []).map((pm, mIdx) => (
                            <circle
                              key={`pm-${mIdx}`}
                              cx={pm.cx}
                              cy={pm.cy}
                              r={Math.max(4, pm.size)}
                              fill="#e11d48"
                            />
                          ))}
                        </svg>
                      );
                    })()}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-800">3. Cấu hình Bình Sách</span>
                  <button
                    onClick={() => setShowBook3D(true)}
                    disabled={pdfPages.length === 0}
                    className="px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-xs"
                    title="Mở cuốn sách 3D để lật kiểm tra thứ tự trang & gáy đóng sách"
                  >
                    🧊 Xem Sách 3D
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={bookletStyle}
                    onChange={(e) => setBookletStyle(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-800"
                  >
                    <option value="saddleStitch">Bấm kim giữa</option>
                    <option value="perfectBound">Đóng keo gáy</option>
                    <option value="wireO">Gáy xoắn (Wire-O)</option>
                    <option value="zine8">Zine 8 trang</option>
                  </select>
                  <select
                    value={bookletBinding}
                    onChange={(e) => setBookletBinding(e.target.value)}
                    disabled={bookletStyle === 'wireO' || bookletStyle === 'zine8'}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs disabled:bg-slate-50 disabled:text-slate-400"
                  >
                    <option value="left">Mở Trái</option>
                    <option value="right">Mở Phải</option>
                  </select>
                </div>

                {bookletStyle === 'perfectBound' && (
                  <div className="flex items-center justify-between gap-2 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200">
                    <label className="text-[11px] text-slate-600">Số trang / tay sách:</label>
                    <select
                      value={pagesPerSignature}
                      onChange={(e) => setPagesPerSignature(Number(e.target.value))}
                      className="bg-white border border-slate-200 rounded px-2 py-0.5 text-xs font-mono font-bold text-[#146C53]"
                    >
                      <option value={4}>4 trang (1 tờ)</option>
                      <option value={8}>8 trang (2 tờ)</option>
                      <option value={16}>16 trang (4 tờ)</option>
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Creep (mm/tờ)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      disabled={bookletStyle === 'wireO' || bookletStyle === 'zine8'}
                      value={bookletCreep}
                      onChange={(e) => setBookletCreep(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono disabled:bg-slate-50 disabled:text-slate-400"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Bleed 3 mép</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={bleedMm}
                      onChange={(e) => setBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                    />
                  </div>
                </div>

                {(bookletStyle === 'saddleStitch' || bookletStyle === 'perfectBound') && (
                  <label className="flex items-center justify-between gap-2 text-[11px] text-slate-600 cursor-pointer">
                    <span>Giữ 2 trang bìa sau ở cuối sách</span>
                    <input
                      type="checkbox"
                      className="accent-[#146C53]"
                      checked={coverPagesAtEnd > 0}
                      onChange={(e) => setCoverPagesAtEnd(e.target.checked ? 2 : 0)}
                    />
                  </label>
                )}
              </div>
            )}

            {/* Marks */}
            <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">4. Dấu xén &amp; Báo cáo</span>
                <button
                  onClick={() => setShowTrimMarkModal(true)}
                  className="text-[11px] font-semibold text-[#146C53] hover:underline cursor-pointer"
                >
                  ⚙️ Tuỳ chỉnh Dấu Xén
                </button>
              </div>
              <div className="grid grid-cols-[1.45fr_1fr_1fr] gap-2">
                <select
                  value={markStyle}
                  onChange={(e) => setMarkStyle(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs"
                >
                  <option value="western">Bon 1 vạch</option>
                  <option value="tonbo">Tonbo Nhật</option>
                  <option value="none">Tắt bon</option>
                </select>
                <input
                  type="number"
                  min="1"
                  value={markLength}
                  onChange={(e) => setMarkLength(Math.max(1, parseFloat(e.target.value) || 5))}
                  title="Chiều dài bon (mm)"
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                />
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={markOffset}
                  onChange={(e) => setMarkOffset(Math.max(0.5, parseFloat(e.target.value) || 3))}
                  title="Khoảng cách bon (mm)"
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={registrationMarks} onChange={(e) => setRegistrationMarks(e.target.checked)} />
                  Ốc chồng màu
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={registrationColor} onChange={(e) => setRegistrationColor(e.target.checked)} />
                  Registration 4 màu
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={showSlugLine} onChange={(e) => setShowSlugLine(e.target.checked)} />
                  Slug chân tờ
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={showBleedOverlay} onChange={(e) => setShowBleedOverlay(e.target.checked)} />
                  Soi Bleed đỏ
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={showSafeArea} onChange={(e) => setShowSafeArea(e.target.checked)} />
                  Vùng an toàn
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-slate-500">Safe (mm):</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={safeInsetMm}
                    onChange={(e) => setSafeInsetMm(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-12 bg-white border border-slate-200 rounded px-1.5 py-0.5 text-[11px] font-mono"
                  />
                </div>
              </div>
            </div>

                {/* Job Checks Section (compact inside Settings Panel) */}
                {plan.jobChecks && plan.jobChecks.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        KIỂM TRA BÀI (JOB CHECKS)
                      </span>
                      {(() => {
                        const warnCount = plan.jobChecks.filter((c) => c.level !== 'ok').length;
                        return (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              warnCount === 0
                                ? 'bg-[#E6F4EF] text-[#146C53]'
                                : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}
                          >
                            {warnCount === 0 ? 'Đạt chuẩn' : `${warnCount} lưu ý`}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-0.5">
                      {plan.jobChecks.map((chk) => (
                        <div
                          key={chk.id}
                          className={`rounded-lg px-2 py-1.5 border text-[10px] ${
                            chk.level === 'error'
                              ? 'bg-rose-50 border-rose-200 text-rose-800'
                              : chk.level === 'warn'
                              ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                              : 'bg-[#FAFBF9] border-slate-200 text-slate-700'
                          }`}
                        >
                          <div className="font-bold">{chk.title}</div>
                          <div className="opacity-80 mt-0.5">{chk.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Export Buttons */}
                <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
                  {mode === 'sticker' ? (
                    <>
                      <button
                        onClick={() => handleDownload('print')}
                        disabled={loading || sourceFiles.length === 0}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                          loading || sourceFiles.length === 0
                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                            : 'bg-[#146C53] hover:bg-[#0f5440] text-white shadow-xs'
                        }`}
                      >
                        {loading ? 'Đang xuất...' : '🖨️ Xuất File IN (PDF + Boong)'}
                      </button>
                      <button
                        onClick={() => handleDownload('cut')}
                        disabled={loading || sourceFiles.length === 0}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                          loading || sourceFiles.length === 0
                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                            : 'bg-rose-600 hover:bg-rose-500 text-white shadow-xs'
                        }`}
                      >
                        ✂️ Xuất File BẾ (CutContour PDF)
                      </button>
                      <button
                        onClick={() => handleDownload('svg')}
                        disabled={loading || sourceFiles.length === 0}
                        className="w-full py-2 rounded-xl bg-[#E6F4EF] hover:bg-[#d5ece4] text-[#146C53] text-xs font-bold cursor-pointer disabled:opacity-40"
                      >
                        🧩 Xuất File BẾ (.SVG)
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleDownload('print')}
                      disabled={loading || sourceFiles.length === 0}
                      className={`w-full py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                        loading || sourceFiles.length === 0
                          ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          : 'bg-[#146C53] hover:bg-[#0f5440] text-white shadow-xs'
                      }`}
                    >
                      {loading ? 'Đang xuất Vector PDF...' : '⚡ Xuất PDF Bình Bài (CMYK)'}
                    </button>
                  )}
                </div>
              </aside>
            )}
          </>
        )}

        {/* 4B. FAR-RIGHT MODULE TOOLS DOCK (242px flush white panel — PrintKit 2.0 Vector Icons) */}
        <aside className="w-[242px] bg-white border-l border-[#E2E8F0] p-2.5 flex flex-col gap-3 shrink-0 h-full overflow-y-auto select-none">
          <div className="relative">
            <PkIcon name="search" className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
              placeholder="Tìm công cụ..."
              className="w-full h-8 bg-[#F3F5F7] border border-[#E2E8F0] focus:bg-white focus:border-[#087F5B] focus:outline-none rounded-md pl-8 pr-2.5 text-xs text-[#17212F] placeholder:text-[#94A3B8]"
            />
          </div>

          {[
            {
              group: 'BÀN LÀM VIỆC',
              items: [
                {
                  id: 'viewer',
                  label: 'Xem trang PDF gốc',
                  icon: 'eye',
                  badge: 'Gốc',
                  tip: 'Kiểm tra từng trang PDF gốc, kích thước và TrimBox',
                },
              ],
            },
            {
              group: 'BÌNH BÀI IN',
              items: [
                {
                  id: 'namecard',
                  label: 'Bình Cắt Xén',
                  icon: 'grid',
                  badge: 'N-Up',
                  tip: 'Xếp tối ưu Namecard, Tờ rơi, Voucher (Dutch Cut, 2 mặt)',
                },
                {
                  id: 'sticker',
                  label: 'Bình Tem Bế',
                  icon: 'sticker',
                  badge: 'Boong',
                  tip: 'Lồng ghép 1:1 tem nhãn Decal + Boong định vị máy cắt',
                },
                {
                  id: 'booklet',
                  label: 'Bình Sách & Tạp chí',
                  icon: 'book',
                  badge: '3D',
                  tip: 'Đảo trang đóng ghim, keo gáy, Wire-O, Zine + Xem 3D',
                },
              ],
            },
            {
              group: 'CHUẨN HÓA & ĐƯỜNG CẮT',
              items: [
                {
                  id: 'bleed',
                  label: 'Bù xén - Tạo đường cắt',
                  icon: 'blade',
                  badge: 'Trace',
                  tip: 'Tách nhiều tem 300 DPI, tạo CutContour & Bleed Bézier',
                },
              ],
            },
            {
              group: 'XỬ LÝ FILE (FILE PREP)',
              items: [
                {
                  id: 'resize',
                  label: 'Co giãn trang (Resize)',
                  icon: 'resize',
                  badge: 'PRO',
                  tip: 'Đổi khổ trang PDF hàng loạt và tự động thêm Bleed',
                },
                {
                  id: 'organizer',
                  label: 'Xáo trộn trang',
                  icon: 'shuffle',
                  badge: 'Pages',
                  tip: 'Kéo thả đổi vị trí, xoay, nhân bản và bù trang trắng',
                },
                {
                  id: 'crop',
                  label: 'Cắt khổ trang (Crop)',
                  icon: 'crop',
                  badge: 'Crop',
                  tip: 'Cắt bỏ lề thừa, bon cũ theo 4 cạnh hoặc vùng mực',
                },
                {
                  id: 'trimShift',
                  label: 'Trim & Shift',
                  icon: 'shift',
                  badge: 'PRO',
                  tip: 'Dịch chuyển nội dung trang Chẵn / Lẻ để chừa lề gáy',
                },
              ],
            },
            {
              group: 'KHUÔN BẾ BAO BÌ',
              items: [
                {
                  id: 'dieline',
                  label: 'Khuôn Bế 2D & 3D',
                  icon: 'box',
                  badge: '3D',
                  tip: 'Thiết kế khuôn hộp giấy 2D và gập mô phỏng 3D',
                },
                {
                  id: 'library',
                  label: 'Thư viện mẫu ECMA',
                  icon: 'layers',
                  badge: '5 mẫu',
                  tip: 'Chọn nhanh khuôn hộp chuẩn ngành bao bì ECMA',
                },
              ],
            },
          ].map((grp) => {
            const q = toolSearch.trim().toLowerCase();
            const visibleItems = grp.items.filter(
              (it) => !q || it.label.toLowerCase().includes(q) || it.badge.toLowerCase().includes(q)
            );
            if (visibleItems.length === 0) return null;
            return (
              <div key={grp.group} className="flex flex-col gap-0.5">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                  {grp.group}
                </div>
                {visibleItems.map((tool) => {
                  const active = activeStudio === tool.id;
                  return (
                    <button
                      key={tool.id}
                      title={tool.tip}
                      onClick={() => {
                        setActiveStudio(tool.id);
                        setShowSettingsPanel(tool.id !== 'viewer');
                        setCurrentSheetIndex(0);
                      }}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md border text-left transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#DDF5EC] border-[#087F5B]/35 text-[#064E3B]'
                          : 'bg-transparent border-transparent hover:bg-[#F3F5F7] text-[#17212F]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <PkIcon
                          name={tool.icon}
                          className={`w-4 h-4 shrink-0 ${active ? 'text-[#087F5B]' : 'text-[#64748B]'}`}
                        />
                        <span className="text-[12.5px] font-medium truncate">{tool.label}</span>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 ${
                          active
                            ? 'bg-[#087F5B] text-white'
                            : tool.badge === 'PRO'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200/80'
                            : 'bg-[#F3F5F7] text-[#64748B]'
                        }`}
                      >
                        {tool.badge}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </aside>
      </div>

      {/* Popup Modal: Tuỳ chỉnh Dấu Xén (Exact Image 6 UX) */}
      {showTrimMarkModal && (
        <div
          onClick={() => setShowTrimMarkModal(false)}
          className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-2xs flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-5 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <h3 className="text-sm font-extrabold text-slate-900">Tuỳ chỉnh Dấu Xén</h3>
              <button
                onClick={() => setShowTrimMarkModal(false)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 text-base cursor-pointer"
              >
                ×
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-slate-700">Kiểu Dấu Xén</span>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  onClick={() => setMarkStyle('western')}
                  className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                    markStyle === 'western'
                      ? 'bg-indigo-50/70 border-indigo-600 ring-2 ring-indigo-500/15'
                      : 'bg-white border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-900">Tiêu chuẩn</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">Nét đơn ở góc (Western)</div>
                </button>
                <button
                  onClick={() => setMarkStyle('tonbo')}
                  className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                    markStyle === 'tonbo'
                      ? 'bg-indigo-50/70 border-indigo-600 ring-2 ring-indigo-500/15'
                      : 'bg-white border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-900">Nét đôi (Nhật)</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">Trim + Bleed (トンボ)</div>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold text-slate-700">Kích Thước Dấu Xén (mm)</span>
              <div className="grid grid-cols-3 gap-2.5">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-500">Khoảng cách tới bài</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={markOffset}
                    onChange={(e) => setMarkOffset(Math.max(0, parseFloat(e.target.value) || 1))}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-500">Độ dài dấu</label>
                  <input
                    type="number"
                    min="1"
                    step="0.5"
                    value={markLength}
                    onChange={(e) => setMarkLength(Math.max(1, parseFloat(e.target.value) || 2))}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-500">Độ dày nét (pt)</label>
                  <input
                    type="number"
                    min="0.1"
                    max="2"
                    step="0.05"
                    value={markThicknessPt}
                    onChange={(e) => setMarkThicknessPt(Math.max(0.1, parseFloat(e.target.value) || 0.25))}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <button
                onClick={() => {
                  setMarkStyle('western');
                  setMarkOffset(1);
                  setMarkLength(2);
                  setMarkThicknessPt(0.25);
                }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                Khôi phục mặc định
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTrimMarkModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-bold text-slate-700 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  onClick={() => {
                    if (mode === 'sticker' && stickerTrimMarks === 'none') {
                      setStickerTrimMarks('guillotine');
                    }
                    setShowTrimMarkModal(false);
                  }}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold cursor-pointer shadow-xs"
                >
                  Áp dụng
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
