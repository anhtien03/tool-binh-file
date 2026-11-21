import React, { useState, useMemo, useEffect } from 'react';
import PdfCanvasPreview from './PdfCanvasPreview';
import DielineStudio from './DielineStudio';
import { PAPER_SIZES, computeImpositionPlan } from '../engine/impositionEngine';
import { exportImposedPdf } from '../engine/pdfExporter';

export default function PdfEditor() {
  // --- Top-level Studio Switcher ('impose' | 'dieline3d') ---
  const [activeStudio, setActiveStudio] = useState('impose');

  // --- Multi-File & Gang-Run State ---
  const [sourceFiles, setSourceFiles] = useState([]); // [{ id, file }]
  const [pdfPages, setPdfPages] = useState([]); // Flattened global pages
  const [gangItems, setGangItems] = useState([]); // [{ id, name, frontIndex, backIndex, quantity }]

  // --- Core Imposition Mode ---
  const [mode, setMode] = useState('grid'); // 'grid' | 'booklet'
  const [paperSizeKey, setPaperSizeKey] = useState('A3');
  const [customPaperWidth, setCustomPaperWidth] = useState('325');
  const [customPaperHeight, setCustomPaperHeight] = useState('430');
  const [orientation, setOrientation] = useState('landscape');

  // --- PrynX Grid / Guillotine Settings ---
  const [layoutType, setLayoutType] = useState('optimal'); // 'optimal' (Dutch Cut) | 'simple' | 'manual'
  const [collation, setCollation] = useState('stepAndRepeat'); // 'stepAndRepeat' | 'sequential' | 'cutAndStack'
  const [stackSplit, setStackSplit] = useState(0); // 0 = không chia cọc
  const [duplexMode, setDuplexMode] = useState('simplex'); // 'simplex' | 'workAndTurn' | 'workAndTumble'
  const [inkingAxis, setInkingAxis] = useState('none'); // 'none' | 'row' | 'col'
  const [alignment, setAlignment] = useState('center'); // 'center' | 'bottom-center' | 'top-left'
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(5);
  const [gutterX, setGutterX] = useState(2);
  const [gutterY, setGutterY] = useState(2);
  const [bleedMm, setBleedMm] = useState(1.5);
  const [keepOriginalSize, setKeepOriginalSize] = useState(true);

  // --- Booklet Settings ---
  const [bookletStyle, setBookletStyle] = useState('saddleStitch'); // 'saddleStitch' | 'perfectBound'
  const [bookletBinding, setBookletBinding] = useState('left'); // 'left' | 'right'
  const [bookletCreep, setBookletCreep] = useState(0.2); // mm per sheet

  // --- Margins & Marks ---
  const [marginTop, setMarginTop] = useState(10);
  const [marginBottom, setMarginBottom] = useState(10);
  const [marginLeft, setMarginLeft] = useState(10);
  const [marginRight, setMarginRight] = useState(10);
  const [marginIncludesMarks, setMarginIncludesMarks] = useState(false);

  const [markStyle, setMarkStyle] = useState('western'); // 'none' | 'western' | 'tonbo'
  const [markLength, setMarkLength] = useState(5);
  const [markOffset, setMarkOffset] = useState(3);
  const [registrationMarks, setRegistrationMarks] = useState(true);
  const [registrationColor, setRegistrationColor] = useState(false); // false = K100, true = C100M100Y100K100
  const [showSlugLine, setShowSlugLine] = useState(true);
  const [showBleedOverlay, setShowBleedOverlay] = useState(true);

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

  // Add one or multiple PDF files
  const handleAddFiles = (fileList) => {
    const valid = Array.from(fileList || []).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (valid.length === 0) return;

    const newEntries = valid.map((file, i) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
      file,
    }));
    setSourceFiles((prev) => [...prev, ...newEntries]);
    setError(null);
    setSuccess(false);
  };

  // Sync gangItems whenever pages are parsed from sourceFiles
  const handlePagesSynced = (flatPages, fileGroups) => {
    setPdfPages(flatPages);
    setCurrentSheetIndex(0);

    if (flatPages.length === 0) {
      setGangItems([]);
      return;
    }

    // Build logical items from fileGroups (preserving quantities for existing files where possible)
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

  // Merge two adjacent 1-sided items (e.g. Front.pdf + Back.pdf) into 1 two-sided item
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

  // Split a 2-sided item back into two 1-sided items
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

  const clearAllFiles = () => {
    setSourceFiles([]);
    setPdfPages([]);
    setGangItems([]);
    setError(null);
    setSuccess(false);
  };

  // Single Source of Truth: compute deterministic SheetPlan[]
  const config = useMemo(
    () => ({
      mode,
      paperSizeKey,
      customPaperWidth,
      customPaperHeight,
      orientation,
      layoutType,
      collation,
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
      gangItems,
    ]
  );

  const plan = useMemo(() => computeImpositionPlan(pdfPages, config), [pdfPages, config]);

  // Clamp sheet index if plan shrinks
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

  if (activeStudio === 'dieline3d') {
    return <DielineStudio onSwitchToImpose={() => setActiveStudio('impose')} />;
  }

  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-[#0c0d10] text-slate-100 font-sans">
      {/* 1. PrynX-Style Dark Sidebar */}
      <div className="w-full lg:w-[400px] bg-[#13151a] border-b lg:border-b-0 lg:border-r border-slate-800/80 p-5 flex flex-col gap-4 overflow-y-auto max-h-screen">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-600 text-white font-black text-base shadow-lg shadow-emerald-600/20">
              PX
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white">Bình Bài In Pro</h1>
              <p className="text-[11px] text-slate-400">Vector Imposition · Dutch Cut · Smart Bleed</p>
            </div>
          </div>
          <button
            onClick={() => setActiveStudio('dieline3d')}
            className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-[11px] font-bold transition-colors cursor-pointer shrink-0"
          >
            Khuôn Bế 3D →
          </button>
        </div>

        {/* Multi-File Upload & Gang-Run Item List */}
        <div className="flex flex-col gap-2 bg-slate-900/50 p-3 rounded-xl border border-slate-800/80">
          <div className="relative border border-dashed border-slate-700 hover:border-emerald-500 rounded-xl p-3 flex flex-col items-center justify-center cursor-pointer bg-slate-950/50 transition-colors">
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
            <span className="text-xs font-semibold text-slate-200">
              {sourceFiles.length > 0
                ? `➕ Thêm file PDF nữa (đang có ${sourceFiles.length} file · ${pdfPages.length} trang)`
                : '📄 Chọn 1 hoặc nhiều file PDF để ghép bình'}
            </span>
            {firstPage && (
              <span className="text-[11px] text-slate-400 font-mono mt-0.5">
                Gốc: {firstPage.mediaWmm.toFixed(1)}×{firstPage.mediaHmm.toFixed(1)}mm → TP: {plan.summary.trimW}×{plan.summary.trimH}mm
              </span>
            )}
          </div>

          {gangItems.length > 0 && (
            <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
                <span>Danh sách mẫu ({gangItems.length} mẫu):</span>
                <button onClick={clearAllFiles} className="text-rose-400 hover:text-rose-300 cursor-pointer">
                  Xóa hết
                </button>
              </div>
              {gangItems.map((item, idx) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-1.5 bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-slate-200" title={item.name}>
                      {idx + 1}. {item.name}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                          item.backIndex !== null
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {item.backIndex !== null ? '2 Mặt' : '1 Mặt'}
                      </span>
                      {item.backIndex === null && idx < gangItems.length - 1 && gangItems[idx + 1].backIndex === null && (
                        <button
                          onClick={() => mergeWithNextItem(idx)}
                          title="Ghép mẫu này (Mặt trước) với mẫu kế tiếp (Mặt sau) thành 1 card 2 mặt"
                          className="text-[10px] text-amber-400 hover:underline cursor-pointer"
                        >
                          Ghép 2 mặt ↓
                        </button>
                      )}
                      {item.backIndex !== null && (
                        <button
                          onClick={() => splitItem(idx)}
                          title="Tách thành 2 mẫu 1 mặt riêng"
                          className="text-[10px] text-sky-400 hover:underline cursor-pointer"
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
                      title="Số lượng đặt in"
                      className="w-14 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-right text-amber-300"
                    />
                  )}
                  <button
                    onClick={() => removeGangItem(idx)}
                    className="text-slate-500 hover:text-rose-400 px-1 cursor-pointer"
                    title="Bỏ mẫu này"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mode Tabs */}
        <div className="grid grid-cols-2 gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => {
              setMode('grid');
              setCurrentSheetIndex(0);
            }}
            className={`py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              mode === 'grid' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Bình Bài Xén (N-Up)
          </button>
          <button
            onClick={() => {
              setMode('booklet');
              setCurrentSheetIndex(0);
            }}
            className={`py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              mode === 'booklet' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Bình Sách (Booklet)
          </button>
        </div>

        {/* Paper Settings */}
        <div className="flex flex-col gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
          <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">1. Khổ giấy & Lề</h3>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={paperSizeKey}
              onChange={(e) => setPaperSizeKey(e.target.value)}
              className="col-span-2 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
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
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
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
                className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
              />
              <input
                type="number"
                value={customPaperHeight}
                onChange={(e) => setCustomPaperHeight(e.target.value)}
                placeholder="Cao (mm)"
                className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
              />
            </div>
          )}

          <div className="grid grid-cols-4 gap-1.5">
            {[
              ['Trên', marginTop, setMarginTop],
              ['Dưới/Nhíp', marginBottom, setMarginBottom],
              ['Trái', marginLeft, setMarginLeft],
              ['Phải', marginRight, setMarginRight],
            ].map(([label, val, setter]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">{label}</label>
                <input
                  type="number"
                  min="0"
                  value={val}
                  onChange={(e) => setter(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={marginIncludesMarks}
              onChange={(e) => setMarginIncludesMarks(e.target.checked)}
              className="rounded border-slate-700 bg-slate-900"
            />
            Lề bao gồm cả bon cắt (tránh vùng không in được)
          </label>
        </div>

        {/* Mode-specific settings */}
        {mode === 'grid' ? (
          <div className="flex flex-col gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">2. Thuật toán Bình Bài Xén</h3>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Cách xếp lưới</label>
                <select
                  value={layoutType}
                  onChange={(e) => setLayoutType(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="optimal">Tối ưu Dutch Cut (0°+90°)</option>
                  <option value="simple">Lưới đơn giản (0°/90°)</option>
                  <option value="manual">Tùy chỉnh Cột × Hàng</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Cách thức ráp</label>
                <select
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="stepAndRepeat">Step & Repeat (Lặp mẫu)</option>
                  <option value="sequential">N-Up (Ghép nhiều mẫu)</option>
                  <option value="ratioStack">Ratio Stack (Chia tỷ lệ SL)</option>
                  <option value="cutAndStack">Cut & Stack (Úp xấp)</option>
                </select>
              </div>
            </div>

            {collation === 'cutAndStack' && (
              <div className="flex items-center justify-between gap-2 bg-slate-950/60 px-2.5 py-1.5 rounded-lg border border-slate-800">
                <label className="text-[11px] text-slate-300">Chia cọc xén (tờ/cọc, 0 = tất cả):</label>
                <input
                  type="number"
                  min="0"
                  value={stackSplit}
                  onChange={(e) => setStackSplit(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-right"
                />
              </div>
            )}

            {layoutType === 'manual' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-400">Số cột</label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={cols}
                    onChange={(e) => setCols(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-400">Số hàng</label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={rows}
                    onChange={(e) => setRows(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Số mặt & Lật gương</label>
                <select
                  value={duplexMode}
                  onChange={(e) => setDuplexMode(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="simplex">1 Mặt (Simplex)</option>
                  <option value="workAndTurn">2 Mặt — Trở nhíp (Mirror X)</option>
                  <option value="workAndTumble">2 Mặt — Trở đít (Mirror Y+180°)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Đối đầu 180° (INKING)</label>
                <select
                  value={inkingAxis}
                  onChange={(e) => setInkingAxis(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="none">Tắt</option>
                  <option value="row">Theo hàng</option>
                  <option value="col">Theo cột</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Tràn lề (Bleed)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={bleedMm}
                  onChange={(e) => setBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Hở X (Gap)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={gutterX}
                  onChange={(e) => setGutterX(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Hở Y (Gap)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={gutterY}
                  onChange={(e) => setGutterY(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] text-slate-400">Canh khối:</label>
              <select
                value={alignment}
                onChange={(e) => setAlignment(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs"
              >
                <option value="center">Giữa tờ (In nhanh 2 mặt)</option>
                <option value="bottom-center">Giữa-Đáy (Nhíp Offset)</option>
                <option value="top-left">Góc Trên-Trái</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">2. Cấu hình Bình Sách</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Kiểu đóng</label>
                <select
                  value={bookletStyle}
                  onChange={(e) => setBookletStyle(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="saddleStitch">Bấm kim giữa</option>
                  <option value="perfectBound">Đóng keo (Tay sách 4p)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400">Chiều mở gáy</label>
                <select
                  value={bookletBinding}
                  onChange={(e) => setBookletBinding(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value="left">Mở Trái (VN/Quốc tế)</option>
                  <option value="right">Mở Phải (Nhật/Manga)</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Bù Creep (mm/tờ)</label>
                <input
                  type="number"
                  min="0"
                  step="0.05"
                  value={bookletCreep}
                  onChange={(e) => setBookletCreep(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Bleed 3 mép ngoài (mm)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={bleedMm}
                  onChange={(e) => setBleedMm(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        )}

        {/* Marks & Output Settings */}
        <div className="flex flex-col gap-2.5 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
          <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">3. Dấu xén & Báo cáo tờ in</h3>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={markStyle}
              onChange={(e) => setMarkStyle(e.target.value)}
              className="col-span-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
            >
              <option value="western">Bon 1 vạch</option>
              <option value="tonbo">Tonbo Nhật</option>
              <option value="none">Tắt bon</option>
            </select>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400">Dài:</span>
              <input
                type="number"
                min="1"
                value={markLength}
                onChange={(e) => setMarkLength(Math.max(1, parseFloat(e.target.value) || 5))}
                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400">Cách:</span>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={markOffset}
                onChange={(e) => setMarkOffset(Math.max(0.5, parseFloat(e.target.value) || 3))}
                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={registrationMarks} onChange={(e) => setRegistrationMarks(e.target.checked)} />
              Ốc chồng màu (4 cạnh)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={registrationColor} onChange={(e) => setRegistrationColor(e.target.checked)} />
              Màu Registration 4 bản
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showSlugLine} onChange={(e) => setShowSlugLine(e.target.checked)} />
              Báo cáo chân tờ (Slug)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showBleedOverlay} onChange={(e) => setShowBleedOverlay(e.target.checked)} />
              Soi khung Bleed đỏ
            </label>
          </div>
        </div>
      </div>

      {/* 2. Main Preview Workspace */}
      <div className="flex-1 flex flex-col p-6 gap-4 justify-between overflow-y-auto">
        {/* Top Bar + Live Stats */}
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-emerald-400 font-bold">
              {plan.summary.itemsPerSheet} con/tờ
              {plan.summary.secondaryCount > 0 && ` (${plan.summary.primaryCount} ngang + ${plan.summary.secondaryCount} dọc)`}
            </span>
            <span className="px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-amber-400">
              Hiệu suất giấy: {plan.summary.utilizationPct}%
            </span>
            <span className="px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300">
              Khổ: {plan.sheetDim.width}×{plan.sheetDim.height}mm
            </span>
            {plan.summary.ratioSheetsNeeded > 0 && (
              <span className="px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-xs font-mono text-emerald-300 font-bold">
                Cần in: {plan.summary.ratioSheetsNeeded} tờ
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-full px-3 py-1">
              <button onClick={() => setZoom(Math.max(0.5, zoom - 0.15))} className="text-xs px-1.5 text-slate-300 hover:text-white cursor-pointer">
                −
              </button>
              <span className="text-xs font-mono text-slate-200 min-w-[42px] text-center">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(Math.min(2.5, zoom + 0.15))} className="text-xs px-1.5 text-slate-300 hover:text-white cursor-pointer">
                +
              </button>
              <button onClick={() => setZoom(1.0)} className="text-[11px] text-emerald-400 font-bold pl-1 cursor-pointer">
                100%
              </button>
            </div>

            <button
              onClick={handleDownload}
              disabled={loading || sourceFiles.length === 0}
              className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all cursor-pointer ${
                loading || sourceFiles.length === 0
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
              }`}
            >
              {loading ? 'Đang xuất Vector PDF...' : '⚡ Xuất PDF Bình Bài (CMYK)'}
            </button>
          </div>
        </div>

        {error && <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-300 text-xs">⚠️ {error}</div>}
        {success && (
          <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-xs">
            🎉 Đã xuất file PDF vector chuẩn CMYK (giữ nguyên Bleed & Smart Clipping)!
          </div>
        )}

        <div className="flex-1 flex items-center justify-center">
          <PdfCanvasPreview
            sourceFiles={sourceFiles}
            plan={plan}
            margins={{ top: marginTop, bottom: marginBottom, left: marginLeft, right: marginRight }}
            bleedMm={bleedMm}
            showBleedOverlay={showBleedOverlay}
            currentSheetIndex={currentSheetIndex}
            setCurrentSheetIndex={setCurrentSheetIndex}
            onPagesSynced={handlePagesSynced}
            zoom={zoom}
          />
        </div>
      </div>
    </div>
  );
}
