import React, { useState, useMemo, useEffect } from 'react';
import PdfCanvasPreview from './PdfCanvasPreview';
import DielineStudio from './DielineStudio';
import TemplateLibrary from './TemplateLibrary';
import { PAPER_SIZES, computeImpositionPlan } from '../engine/impositionEngine';
import { exportImposedPdf } from '../engine/pdfExporter';

export default function PdfEditor() {
  // --- Top-Level Navigation ('library' | 'dieline' | 'impose') ---
  const [activeStudio, setActiveStudio] = useState('impose');
  const [selectedTemplateId, setSelectedTemplateId] = useState('ste');

  // --- Multi-File & Gang-Run State ---
  const [sourceFiles, setSourceFiles] = useState([]);
  const [pdfPages, setPdfPages] = useState([]);
  const [gangItems, setGangItems] = useState([]);

  // --- Core Imposition Mode ---
  const [mode, setMode] = useState('grid');
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

  useEffect(() => {
    const preventDefault = (e) => e.preventDefault();
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
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

  const updateItemQuantity = (idx, qty) => {
    setGangItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, quantity: Math.max(1, parseInt(qty, 10) || 1) } : it))
    );
  };

  const applyNamecardPreset = (presetKey) => {
    setMode('grid');
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

  const config = useMemo(
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
      markThicknessPt: 0.25,
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
      gangItems,
    ]
  );

  const plan = useMemo(() => computeImpositionPlan(pdfPages, config), [pdfPages, config]);

  useEffect(() => {
    if (plan.sheets.length > 0 && currentSheetIndex >= plan.sheets.length) {
      setCurrentSheetIndex(0);
    }
  }, [plan.sheets.length, currentSheetIndex]);

  const handleDownload = async () => {
    if (sourceFiles.length === 0 || plan.sheets.length === 0) {
      setError('Vui lòng chọn ít nhất 1 file PDF trước khi xuất!');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const pdfBytesOutput = await exportImposedPdf(sourceFiles, plan, config);
      const blob = new Blob([pdfBytesOutput], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = sourceFiles.length > 1 ? `GangRun_${sourceFiles.length}files.pdf` : sourceFiles[0].file.name;
      a.download = `Imposed_${baseName}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setSuccess(true);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Đã xảy ra lỗi khi xuất PDF vector.');
    } finally {
      setLoading(false);
    }
  };

  const firstPage = pdfPages[0];

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F5] text-slate-900 font-sans">
      {/* GLOBAL DEEP FOREST GREEN TOP APP BAR (#112A24) */}
      <header className="h-14 bg-[#112A24] text-white px-4 sm:px-6 flex items-center justify-between gap-4 shrink-0 shadow-sm sticky top-0 z-30">
        <div className="flex items-center gap-6">
          {/* Brand */}
          <button
            onClick={() => setActiveStudio('library')}
            className="flex items-center gap-2.5 cursor-pointer group"
          >
            <div className="w-7 h-7 rounded-lg bg-[#146C53] border border-emerald-400/30 flex items-center justify-center font-black text-xs text-white">
              TB
            </div>
            <span className="font-bold tracking-wide text-sm text-white group-hover:text-emerald-200 transition-colors">
              Toolbinhfile
            </span>
          </button>

          {/* Center Nav */}
          <nav className="flex items-center gap-1 text-xs font-semibold">
            {[
              ['library', 'Thư viện hộp'],
              ['dieline', 'Khuôn 2D & 3D'],
              ['impose', 'Bình Bài In'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveStudio(key)}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  activeStudio === key
                    ? 'bg-[#146C53] text-white'
                    : 'text-emerald-100/75 hover:text-white hover:bg-white/10'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Right Quick Action */}
        <div className="flex items-center gap-2">
          {activeStudio === 'impose' && (
            <button
              onClick={handleDownload}
              disabled={loading || sourceFiles.length === 0}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                loading || sourceFiles.length === 0
                  ? 'bg-white/10 text-emerald-100/40 cursor-not-allowed'
                  : 'bg-[#146C53] hover:bg-[#198768] text-white shadow-xs'
              }`}
            >
              {loading ? 'Đang xuất...' : 'Xuất PDF Bình Bài'}
            </button>
          )}
        </div>
      </header>

      {/* BODY CONTENT */}
      {activeStudio === 'library' && (
        <TemplateLibrary
          onSelectTemplate={(id) => {
            setSelectedTemplateId(id);
            setActiveStudio('dieline');
          }}
          onOpenImpose={() => setActiveStudio('impose')}
        />
      )}

      {activeStudio === 'dieline' && (
        <DielineStudio
          templateId={selectedTemplateId}
          onChangeTemplate={(id) => setSelectedTemplateId(id)}
          onOpenLibrary={() => setActiveStudio('library')}
          onOpenImpose={() => setActiveStudio('impose')}
        />
      )}

      {activeStudio === 'impose' && (
        <div className="flex flex-col lg:flex-row gap-4 p-4 flex-1">
          {/* 1. LEFT PARAMETER SIDEBAR (~330px) */}
          <aside className="w-full lg:w-[340px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-88px)] shrink-0 shadow-xs">
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

              {gangItems.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Danh sách mẫu ({gangItems.length}):</span>
                    <button onClick={clearAllFiles} className="text-rose-600 hover:underline font-semibold cursor-pointer">
                      Xóa hết
                    </button>
                  </div>
                  {gangItems.map((item, idx) => (
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
                  ))}
                </div>
              )}
            </div>

            {/* Mode Switcher */}
            <div className="grid grid-cols-2 gap-1 bg-slate-100 p-1 rounded-xl">
              <button
                onClick={() => {
                  setMode('grid');
                  setCurrentSheetIndex(0);
                }}
                className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  mode === 'grid' ? 'bg-white text-[#146C53] shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                Bình Bài Xén (N-Up)
              </button>
              <button
                onClick={() => {
                  setMode('booklet');
                  setCurrentSheetIndex(0);
                }}
                className={`py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  mode === 'booklet' ? 'bg-white text-[#146C53] shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                Bình Sách (Booklet)
              </button>
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
            ) : (
              <div className="flex flex-col gap-2.5 pt-2 border-t border-slate-100">
                <span className="text-xs font-bold text-slate-800">3. Cấu hình Bình Sách</span>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={bookletStyle}
                    onChange={(e) => setBookletStyle(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                  >
                    <option value="saddleStitch">Bấm kim giữa</option>
                    <option value="perfectBound">Đóng keo (Tay 4p)</option>
                  </select>
                  <select
                    value={bookletBinding}
                    onChange={(e) => setBookletBinding(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                  >
                    <option value="left">Mở Trái</option>
                    <option value="right">Mở Phải</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] text-slate-500">Creep (mm/tờ)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={bookletCreep}
                      onChange={(e) => setBookletCreep(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
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
              </div>
            )}

            {/* Marks */}
            <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
              <span className="text-xs font-bold text-slate-800">4. Dấu xén &amp; Báo cáo</span>
              <div className="grid grid-cols-3 gap-2">
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
          </aside>

          {/* 2. CENTER WORKSPACE */}
          <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-3 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                <span className="px-2.5 py-1 rounded-lg bg-[#E6F4EF] text-[#146C53] font-bold">
                  {plan.summary.itemsPerSheet} con/tờ
                  {plan.summary.secondaryCount > 0 && ` (${plan.summary.primaryCount} ngang + ${plan.summary.secondaryCount} dọc)`}
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 font-semibold">
                  Hiệu suất: {plan.summary.utilizationPct}%
                </span>
                {plan.summary.ratioSheetsNeeded > 0 && (
                  <span className="px-2.5 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 font-bold">
                    Cần in: {plan.summary.ratioSheetsNeeded} tờ
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 bg-slate-100 rounded-lg px-2 py-1 text-xs font-mono text-slate-600">
                <button onClick={() => setZoom(1.0)} className="px-1.5 hover:text-[#146C53] font-sans font-semibold cursor-pointer">
                  Fit
                </button>
                <button onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} className="px-1.5 hover:text-slate-900 cursor-pointer">
                  −
                </button>
                <span className="min-w-[40px] text-center font-bold">{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((z) => Math.min(4.0, Math.round((z + 0.15) * 100) / 100))} className="px-1.5 hover:text-slate-900 cursor-pointer">
                  +
                </button>
              </div>
            </div>

            {error && <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs">⚠️ {error}</div>}
            {success && (
              <div className="p-2.5 rounded-xl bg-[#E6F4EF] border border-emerald-200 text-[#146C53] text-xs font-semibold">
                🎉 Đã xuất file PDF vector chuẩn CMYK (giữ nguyên Bleed &amp; Smart Clipping)!
              </div>
            )}

            <div className="flex-1 min-w-0 w-full flex items-center justify-center">
              <PdfCanvasPreview
                sourceFiles={sourceFiles}
                plan={plan}
                margins={{ top: marginTop, bottom: marginBottom, left: marginLeft, right: marginRight }}
                bleedMm={bleedMm}
                showBleedOverlay={showBleedOverlay}
                showSafeArea={showSafeArea}
                safeInsetMm={safeInsetMm}
                currentSheetIndex={currentSheetIndex}
                setCurrentSheetIndex={setCurrentSheetIndex}
                onPagesSynced={handlePagesSynced}
                zoom={zoom}
                onZoomChange={setZoom}
              />
            </div>
          </main>

          {/* 3. RIGHT SUMMARY SIDEBAR (~260px) */}
          <aside className="w-full lg:w-[260px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between gap-4 shrink-0 shadow-xs">
            <div className="flex flex-col gap-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">BẢN BÌNH BÀI</span>
                <h3 className="text-sm font-bold text-slate-800 mt-0.5">Tóm tắt thông số</h3>
              </div>

              <div className="divide-y divide-slate-100 text-xs">
                <div className="py-2 flex justify-between">
                  <span className="text-slate-500">Khổ giấy in</span>
                  <span className="font-mono font-bold text-slate-800">
                    {plan.sheetDim.width}×{plan.sheetDim.height} mm
                  </span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-500">Thành phẩm</span>
                  <span className="font-mono font-semibold text-slate-800">
                    {plan.summary.trimW}×{plan.summary.trimH} mm
                  </span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-500">Số con / tờ</span>
                  <span className="font-mono font-bold text-[#146C53]">{plan.summary.itemsPerSheet} con</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-500">Số tờ PDF xuất</span>
                  <span className="font-mono font-semibold text-slate-800">{plan.sheets.length} trang</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-500">Hao phí giấy</span>
                  <span className="font-mono font-semibold text-amber-600">
                    {Math.max(0, Math.round((100 - plan.summary.utilizationPct) * 10) / 10)}%
                  </span>
                </div>
              </div>

              {/* Job Checks Section */}
              {plan.jobChecks && plan.jobChecks.length > 0 && (
                <div className="pt-3 border-t border-slate-100 flex flex-col gap-2">
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

                  <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-0.5">
                    {plan.jobChecks.map((chk) => (
                      <div
                        key={chk.id}
                        className={`rounded-lg px-2.5 py-2 border text-[11px] ${
                          chk.level === 'error'
                            ? 'bg-rose-50 border-rose-200 text-rose-800'
                            : chk.level === 'warn'
                            ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                            : 'bg-[#FAFBF9] border-slate-200 text-slate-700'
                        }`}
                      >
                        <div className="font-bold flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              chk.level === 'error'
                                ? 'bg-rose-500'
                                : chk.level === 'warn'
                                ? 'bg-amber-500'
                                : 'bg-[#146C53]'
                            }`}
                          />
                          <span>{chk.title}</span>
                        </div>
                        <div className="text-[10px] opacity-80 mt-0.5 leading-relaxed">{chk.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={handleDownload}
                disabled={loading || sourceFiles.length === 0}
                className={`w-full py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                  loading || sourceFiles.length === 0
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-[#146C53] hover:bg-[#0f5440] text-white shadow-xs'
                }`}
              >
                {loading ? 'Đang xuất Vector PDF...' : '⚡ Xuất PDF Bình Bài (CMYK)'}
              </button>
              <button
                onClick={() => setActiveStudio('library')}
                className="w-full py-2 rounded-xl border border-slate-200 hover:border-[#146C53] text-slate-700 text-xs font-semibold cursor-pointer"
              >
                Mở Thư viện Khuôn Bế →
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
