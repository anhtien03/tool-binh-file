import React, { useState, useMemo, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { DIELINE_TEMPLATES, generateDieline, exportDielineSvg } from '../engine/dielineEngine';
import { exportDielinePdf, exportImposedDielinePdf } from '../engine/dielinePdfExporter';
import { PAPER_SIZES, solveDutchCut, solveSimpleGrid } from '../engine/impositionEngine';
import Box3DViewer, { PAPER_MATERIALS } from './Box3DViewer';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export default function DielineStudio({
  templateId,
  onChangeTemplate,
  onOpenLibrary,
  onOpenImpose,
}) {
  const tpl = DIELINE_TEMPLATES[templateId] || DIELINE_TEMPLATES.ste;
  const [params, setParams] = useState(tpl.defaults);
  const [dimensionMode, setDimensionMode] = useState('production'); // 'production' | 'inner' | 'outer'
  const [materialKey, setMaterialKey] = useState('ivory');
  const [canvasMode, setCanvasMode] = useState('2d'); // '2d' | '3d' | 'split' | 'impose'
  const [zoom2D, setZoom2D] = useState(1.0);

  // Dieline Sheet Imposition Settings (for 'impose' tab)
  const [imposePaperKey, setImposePaperKey] = useState('K65x86');
  const [imposeGapMm, setImposeGapMm] = useState(5);
  const [imposeMarginMm, setImposeMarginMm] = useState(10);
  const [imposeDutchCut, setImposeDutchCut] = useState(true);
  const [imposeFlip180, setImposeFlip180] = useState(true);

  // 3D Controls
  const [foldProgress, setFoldProgress] = useState(0.92);
  const [isAnimating, setIsAnimating] = useState(false);
  const [cameraPreset, setCameraPreset] = useState('iso');
  const [autoRotate, setAutoRotate] = useState(false);
  const [showEdges3D, setShowEdges3D] = useState(true);

  // Artwork & Export
  const [artworkDataUrl, setArtworkDataUrl] = useState(null);
  const [artworkName, setArtworkName] = useState('');
  const [exporting, setExporting] = useState(false);

  // Sync defaults when user switches template from Library
  useEffect(() => {
    setParams(DIELINE_TEMPLATES[templateId]?.defaults || DIELINE_TEMPLATES.ste.defaults);
  }, [templateId]);

  const dieline = useMemo(() => generateDieline(templateId, params, dimensionMode), [templateId, params, dimensionMode]);

  // Compute full imposed sheet plan for THIS dieline on the selected press sheet
  const dielineSheetPlan = useMemo(() => {
    const pPreset = PAPER_SIZES[imposePaperKey] || PAPER_SIZES.K65x86;
    const sheetW = Math.max(pPreset.width, pPreset.height);
    const sheetH = Math.min(pPreset.width, pPreset.height);
    const margin = Math.max(0, Number(imposeMarginMm) || 0);
    const gap = Math.max(0, Number(imposeGapMm) || 0);
    const availW = Math.max(20, sheetW - margin * 2);
    const availH = Math.max(20, sheetH - margin * 2);
    const bw = dieline.bounds.width;
    const bh = dieline.bounds.height;

    const solved = imposeDutchCut
      ? solveDutchCut(availW, availH, bw, bh, gap, gap, gap)
      : solveSimpleGrid(availW, availH, bw, bh, gap, gap);

    const rawPlacements = [];
    for (let r = 0; r < solved.primary.rows; r++) {
      for (let c = 0; c < solved.primary.cols; c++) {
        const rot = imposeFlip180 && (r + c) % 2 === 1 ? 180 : 0;
        rawPlacements.push({ x: c * (bw + gap), y: r * (bh + gap), w: bw, h: bh, rotate: rot });
      }
    }
    const hasPrimary = solved.primary.cols > 0 && solved.primary.rows > 0;
    const offX = solved.splitAxis === 'vertical' && hasPrimary ? solved.usedPrimarySpan + solved.subBlockGap : 0;
    const offY = solved.splitAxis === 'horizontal' && hasPrimary ? solved.usedPrimarySpan + solved.subBlockGap : 0;

    for (let r = 0; r < solved.secondary.rows; r++) {
      for (let c = 0; c < solved.secondary.cols; c++) {
        const rot = imposeFlip180 && (r + c) % 2 === 1 ? 270 : 90;
        rawPlacements.push({ x: offX + c * (bh + gap), y: offY + r * (bw + gap), w: bh, h: bw, rotate: rot });
      }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of rawPlacements) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + p.w > maxX) maxX = p.x + p.w;
      if (p.y + p.h > maxY) maxY = p.y + p.h;
    }
    const dx = margin + (availW - (maxX - minX)) / 2 - minX;
    const dy = margin + (availH - (maxY - minY)) / 2 - minY;
    const placements = rawPlacements.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));

    const areaBlank = bw * bh;
    const utilPct = Math.min(100, Math.round(((placements.length * areaBlank) / (sheetW * sheetH)) * 1000) / 10);
    const wastePct = Math.max(0, Math.round((100 - utilPct) * 10) / 10);

    return {
      sheetDim: { width: sheetW, height: sheetH },
      placements,
      count: placements.length,
      utilPct,
      wastePct,
    };
  }, [dieline, imposePaperKey, imposeGapMm, imposeMarginMm, imposeDutchCut, imposeFlip180]);

  const sheetStats = {
    count: dielineSheetPlan.count,
    utilPct: dielineSheetPlan.utilPct,
    wastePct: dielineSheetPlan.wastePct,
    sheetLabel: `${dielineSheetPlan.sheetDim.width}×${dielineSheetPlan.sheetDim.height}`,
  };

  useEffect(() => {
    if (!isAnimating) return;
    let raf = 0;
    let dir = foldProgress >= 0.99 ? -1 : 1;
    let cur = foldProgress;
    const tick = () => {
      cur += dir * 0.012;
      if (cur >= 1) {
        cur = 1;
        dir = -1;
      } else if (cur <= 0) {
        cur = 0;
        dir = 1;
      }
      setFoldProgress(cur);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isAnimating]);

  const updateParam = (key, value) => {
    setParams((prev) => ({ ...prev, [key]: Math.max(0, parseFloat(value) || 0) }));
  };

  const handleArtworkUpload = async (file) => {
    if (!file) return;
    setArtworkName(file.name);
    if (file.type === 'application/pdf') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      setArtworkDataUrl(canvas.toDataURL('image/png'));
    } else {
      const reader = new FileReader();
      reader.onload = () => setArtworkDataUrl(reader.result);
      reader.readAsDataURL(file);
    }
  };

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const bytes =
        canvasMode === 'impose'
          ? await exportImposedDielinePdf(dieline, dielineSheetPlan.sheetDim, dielineSheetPlan.placements)
          : await exportDielinePdf(dieline, artworkDataUrl);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        canvasMode === 'impose'
          ? `BinhKhuon_${tpl.code}_${dielineSheetPlan.count}up_${dielineSheetPlan.sheetDim.width}x${dielineSheetPlan.sheetDim.height}.pdf`
          : `${tpl.code}_${params.L}x${params.W}x${params.H}mm.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const handleExportSvg = () => {
    const svgText = exportDielineSvg(dieline);
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tpl.code}_${params.L}x${params.W}x${params.H}mm.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const matInfo = PAPER_MATERIALS[materialKey] || PAPER_MATERIALS.ivory;

  return (
    <div className="flex flex-col lg:flex-row gap-3 flex-1 min-w-0">
      {/* 1. LEFT: CENTER MAIN CANVAS */}
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 flex flex-col overflow-hidden shadow-xs min-h-[580px]">
        {/* Canvas Top Bar */}
        <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-white">
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            {[
              ['2d', 'Khuôn 2D'],
              ['3d', 'Mô phỏng 3D'],
              ['split', 'Song song 2D + 3D'],
              ['impose', 'Bình khuôn'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasMode(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  canvasMode === k ? 'bg-white text-[#146C53] shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {canvasMode !== '3d' && (
            <div className="flex items-center gap-1 bg-slate-100 rounded-lg px-2 py-1 text-xs font-mono text-slate-600">
              <button onClick={() => setZoom2D(1.0)} className="px-1.5 hover:text-[#146C53] font-sans font-semibold cursor-pointer">
                Fit
              </button>
              <button onClick={() => setZoom2D(2.0)} className="px-1.5 hover:text-[#146C53] text-[11px] cursor-pointer">
                200%
              </button>
              <button onClick={() => setZoom2D((z) => Math.max(0.4, Math.round((z - 0.2) * 100) / 100))} className="px-1.5 hover:text-slate-900 cursor-pointer">
                −
              </button>
              <span className="min-w-[44px] text-center font-bold text-[#146C53]">{Math.round(zoom2D * 100)}%</span>
              <button onClick={() => setZoom2D((z) => Math.min(8.0, Math.round((z + 0.2) * 100) / 100))} className="px-1.5 hover:text-slate-900 cursor-pointer">
                +
              </button>
            </div>
          )}
        </div>

        {/* Canvas Body */}
        <div className={`flex-1 grid ${canvasMode === 'split' ? 'grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-slate-200' : 'grid-cols-1'}`}>
          {(canvasMode === '2d' || canvasMode === 'split') && (
            <div
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 0.2 : -0.2;
                setZoom2D((z) => Math.round(Math.min(8.0, Math.max(0.4, z + delta)) * 100) / 100);
              }}
              title="Cuộn chuột để Phóng to / Thu nhỏ khuôn 2D"
              className="relative flex p-4 overflow-auto min-h-[580px]"
              style={{
                backgroundColor: '#fcfdfc',
                backgroundImage:
                  'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            >
              {/* Spec Header */}
              <div className="absolute top-3 left-4 text-[11px] font-mono font-semibold text-slate-500">
                {tpl.code} — L{dieline.params.L}×W{dieline.params.W}×H{dieline.params.H} mm · CAL {dieline.params.thickness}
              </div>

              <div className="m-auto shrink-0">
                <svg
                  viewBox={`-18 -18 ${dieline.bounds.width + 36} ${dieline.bounds.height + 36}`}
                  style={{ width: `${Math.round(680 * zoom2D)}px`, height: 'auto' }}
                  className="block"
                >
                  {/* Overall bounding Bleed indicator */}
                  <rect
                    x="-2"
                    y="-2"
                    width={dieline.bounds.width + 4}
                    height={dieline.bounds.height + 4}
                    fill="none"
                    stroke="#16a34a"
                    strokeWidth="0.45"
                    strokeDasharray="2 2"
                    opacity="0.55"
                  />
                  {artworkDataUrl && (
                    <image
                      href={artworkDataUrl}
                      x="0"
                      y="0"
                      width={dieline.bounds.width}
                      height={dieline.bounds.height}
                      preserveAspectRatio="none"
                      opacity="0.78"
                    />
                  )}
                  {dieline.creaseSegments.map(([a, b], i) => (
                    <line
                      key={`cr-${i}`}
                      x1={a[0]}
                      y1={a[1]}
                      x2={b[0]}
                      y2={b[1]}
                      stroke="#dc2626"
                      strokeWidth="0.7"
                      strokeDasharray="3 2"
                    />
                  ))}
                  {dieline.cutSegments.map(([a, b], i) => (
                    <line key={`ct-${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#1d4ed8" strokeWidth="0.9" />
                  ))}

                  {/* Dimension Callout Top */}
                  <line x1="0" y1="-9" x2={dieline.bounds.width} y2="-9" stroke="#0284c7" strokeWidth="0.5" />
                  <text
                    x={dieline.bounds.width / 2}
                    y="-12"
                    textAnchor="middle"
                    fill="#0284c7"
                    fontSize="6"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {dieline.bounds.width} mm
                  </text>

                  {/* Dimension Callout Left */}
                  <line x1="-9" y1="0" x2="-9" y2={dieline.bounds.height} stroke="#0284c7" strokeWidth="0.5" />
                  <text
                    x="-12"
                    y={dieline.bounds.height / 2}
                    textAnchor="middle"
                    fill="#0284c7"
                    fontSize="6"
                    fontFamily="monospace"
                    fontWeight="bold"
                    transform={`rotate(-90 -12 ${dieline.bounds.height / 2})`}
                  >
                    {dieline.bounds.height} mm
                  </text>
                </svg>
              </div>

              {/* Floating Bottom-Left Legend Pill */}
              <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur border border-slate-200 rounded-full px-3.5 py-1.5 flex items-center gap-3 text-[11px] font-semibold text-slate-600 shadow-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 border-t border-dashed border-emerald-600 inline-block" /> Bleed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 bg-blue-700 inline-block" /> Trim / Cut
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 border-t border-dashed border-red-600 inline-block" /> Crease
                </span>
              </div>
            </div>
          )}

          {(canvasMode === '3d' || canvasMode === 'split') && (
            <div className="relative flex flex-col min-h-[500px] bg-[#eef2f0]">
              {/* Floating Top Pill (Specs & Camera Angles) */}
              <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
                <div className="pointer-events-auto bg-white/92 backdrop-blur border border-slate-200 rounded-full px-3 py-1 text-[10px] font-mono text-slate-700 shadow-xs">
                  Cal {dieline.params.thickness} · Lọt lòng {dieline.params.inner.L}×{dieline.params.inner.W}×{dieline.params.inner.H} · Phủ bì {dieline.params.outer.L}×{dieline.params.outer.W}×{dieline.params.outer.H}
                </div>
                <div className="pointer-events-auto bg-white/92 backdrop-blur border border-slate-200 rounded-full p-1 flex flex-wrap items-center gap-0.5 text-[10px] font-semibold shadow-xs">
                  {[
                    ['iso', 'Phối cảnh'],
                    ['front', 'Trước'],
                    ['back', 'Sau'],
                    ['left', 'Trái'],
                    ['right', 'Phải'],
                    ['top', 'Trên'],
                    ['bottom', 'Dưới'],
                  ].map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setCameraPreset(k)}
                      className={`px-2 py-0.5 rounded-full cursor-pointer ${
                        cameraPreset === k ? 'bg-[#146C53] text-white' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="w-px h-3 bg-slate-200 mx-1" />
                  <button
                    onClick={() => setAutoRotate((v) => !v)}
                    className={`px-2 py-0.5 rounded-full cursor-pointer ${
                      autoRotate ? 'bg-[#E6F4EF] text-[#146C53]' : 'text-slate-500'
                    }`}
                  >
                    Tự xoay
                  </button>
                  <button
                    onClick={() => setShowEdges3D((v) => !v)}
                    className={`px-2 py-0.5 rounded-full cursor-pointer ${
                      showEdges3D ? 'bg-[#E6F4EF] text-[#146C53]' : 'text-slate-500'
                    }`}
                  >
                    Nét bế
                  </button>
                </div>
              </div>

              <Box3DViewer
                dieline={dieline}
                foldProgress={foldProgress}
                materialKey={materialKey}
                artworkDataUrl={artworkDataUrl}
                cameraPreset={cameraPreset}
                autoRotate={autoRotate}
                showEdges={showEdges3D}
              />

              {/* Floating Bottom Pill (Fold Playback) */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-white/95 backdrop-blur border border-slate-200 rounded-full px-4 py-1.5 flex items-center gap-3 shadow-md max-w-[95%]">
                <button
                  onClick={() => setIsAnimating((v) => !v)}
                  className="px-3 py-1 rounded-full bg-[#146C53] text-white text-xs font-bold cursor-pointer shrink-0"
                >
                  {isAnimating ? '⏸ Dừng' : '▶ Chạy'}
                </button>
                <button
                  onClick={() => {
                    setIsAnimating(false);
                    setFoldProgress(0);
                  }}
                  className="px-2.5 py-1 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer shrink-0"
                >
                  Đặt phẳng
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={foldProgress}
                  onChange={(e) => {
                    setIsAnimating(false);
                    setFoldProgress(parseFloat(e.target.value));
                  }}
                  className="w-32 sm:w-44 accent-[#146C53] cursor-pointer"
                />
                <span className="text-xs font-mono font-bold text-[#146C53] min-w-[38px] text-right">
                  {Math.round(foldProgress * 100)}%
                </span>
              </div>
            </div>
          )}

          {canvasMode === 'impose' && (
            <div className="flex flex-col min-h-[520px] bg-[#fafbf9]">
              {/* Impose Controls Bar */}
              <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex flex-wrap items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500 font-semibold">Khổ tờ in:</span>
                  <select
                    value={imposePaperKey}
                    onChange={(e) => setImposePaperKey(e.target.value)}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold text-slate-800"
                  >
                    <option value="K65x86">Offset K65 × 86 cm</option>
                    <option value="K79x109">Offset K79 × 109 cm</option>
                    <option value="A2">A2 (420 × 594 mm)</option>
                    <option value="SRA3">SRA3 (320 × 450 mm)</option>
                    <option value="A3">A3 (297 × 420 mm)</option>
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Hở (mm):</span>
                  <input
                    type="number"
                    min="0"
                    value={imposeGapMm}
                    onChange={(e) => setImposeGapMm(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-14 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Lề (mm):</span>
                  <input
                    type="number"
                    min="0"
                    value={imposeMarginMm}
                    onChange={(e) => setImposeMarginMm(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-14 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                  />
                </div>
                <label className="flex items-center gap-1.5 text-slate-700 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={imposeDutchCut} onChange={(e) => setImposeDutchCut(e.target.checked)} />
                  Trộn 0°+90°
                </label>
                <label className="flex items-center gap-1.5 text-slate-700 cursor-pointer">
                  <input type="checkbox" className="accent-[#146C53]" checked={imposeFlip180} onChange={(e) => setImposeFlip180(e.target.checked)} />
                  Đối đầu 180°
                </label>
                <span className="ml-auto px-2.5 py-1 rounded-full bg-[#E6F4EF] text-[#146C53] font-mono font-bold">
                  {dielineSheetPlan.count} khuôn/tờ · {dielineSheetPlan.utilPct}%
                </span>
              </div>

              {/* Imposed Sheet SVG Preview */}
              <div
                onWheel={(e) => {
                  e.preventDefault();
                  const delta = e.deltaY < 0 ? 0.15 : -0.15;
                  setZoom2D((z) => Math.round(Math.min(4.0, Math.max(0.4, z + delta)) * 100) / 100);
                }}
                title="Cuộn chuột để Phóng to / Thu nhỏ sơ đồ bình khuôn"
                className="flex-1 flex p-6 overflow-auto max-h-[520px]"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
                  backgroundSize: '24px 24px',
                }}
              >
                <div className="m-auto shrink-0">
                  <svg
                    viewBox={`-12 -12 ${dielineSheetPlan.sheetDim.width + 24} ${dielineSheetPlan.sheetDim.height + 24}`}
                    style={{ width: `${Math.round(620 * zoom2D)}px`, height: 'auto' }}
                    className="block drop-shadow-md"
                  >
                    {/* Physical Sheet */}
                    <rect
                      x="0"
                      y="0"
                      width={dielineSheetPlan.sheetDim.width}
                      height={dielineSheetPlan.sheetDim.height}
                      fill="#ffffff"
                      stroke="#64748b"
                      strokeWidth="1.2"
                    />
                    {/* Printable Margin Box */}
                    <rect
                      x={imposeMarginMm}
                      y={imposeMarginMm}
                      width={Math.max(0, dielineSheetPlan.sheetDim.width - imposeMarginMm * 2)}
                      height={Math.max(0, dielineSheetPlan.sheetDim.height - imposeMarginMm * 2)}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="0.6"
                      strokeDasharray="4 3"
                    />
                    {/* Each placed dieline */}
                    {dielineSheetPlan.placements.map((p, idx) => {
                      const bw = dieline.bounds.width;
                      const bh = dieline.bounds.height;
                      const transform =
                        p.rotate === 90
                          ? `translate(${p.x + bh}, ${p.y}) rotate(90)`
                          : p.rotate === 180
                          ? `translate(${p.x + bw}, ${p.y + bh}) rotate(180)`
                          : p.rotate === 270
                          ? `translate(${p.x}, ${p.y + bw}) rotate(270)`
                          : `translate(${p.x}, ${p.y})`;
                      return (
                        <g key={idx} transform={transform}>
                          {dieline.creaseSegments.map(([a, b], i) => (
                            <line
                              key={`cr-${i}`}
                              x1={a[0]}
                              y1={a[1]}
                              x2={b[0]}
                              y2={b[1]}
                              stroke="#dc2626"
                              strokeWidth="0.8"
                              strokeDasharray="3 2"
                            />
                          ))}
                          {dieline.cutSegments.map(([a, b], i) => (
                            <line key={`ct-${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#1d4ed8" strokeWidth="1" />
                          ))}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 2. MIDDLE-RIGHT SETTINGS & SUMMARY SIDEBAR (~345px) */}
      <aside className="w-full lg:w-[345px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between gap-4 overflow-y-auto max-h-[calc(100vh-80px)] shrink-0 shadow-xs">
        <div className="flex flex-col gap-3.5">
          {/* Selected Template Card */}
          <div className="rounded-xl border border-slate-200 bg-[#FAFBF9] p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">MẪU ĐANG CHỌN</span>
              <span className="px-1.5 py-0.5 rounded bg-[#E6F4EF] text-[#146C53] text-[10px] font-mono font-bold">
                {tpl.code}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-bold text-slate-800">{tpl.shortName}</div>
                <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{tpl.name}</div>
              </div>
              <button
                onClick={onOpenLibrary}
                className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:border-[#146C53] text-xs font-semibold text-[#146C53] cursor-pointer shrink-0"
              >
                Đổi
              </button>
            </div>
            <select
              value={templateId}
              onChange={(e) => onChangeTemplate(e.target.value)}
              className="mt-2 w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700"
            >
              {Object.values(DIELINE_TEMPLATES).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortName} ({t.code})
                </option>
              ))}
            </select>
          </div>

          {/* Dimensions */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800">Kích thước (mm)</span>
              <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg text-[10px] font-semibold">
                {[
                  ['production', 'SX'],
                  ['inner', 'Lọt lòng'],
                  ['outer', 'Phủ bì'],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setDimensionMode(k)}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      dimensionMode === k ? 'bg-white text-[#146C53] shadow-xs font-bold' : 'text-slate-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ['Dài (L)', 'L'],
                ['Rộng (W)', 'W'],
                ['Cao (H)', 'H'],
              ].map(([label, key]) => (
                <div key={key} className="flex flex-col gap-0.5">
                  <label className="text-[10px] text-slate-500">{label}</label>
                  <input
                    type="number"
                    min="10"
                    value={params[key]}
                    onChange={(e) => updateParam(key, e.target.value)}
                    className="bg-white border border-slate-200 focus:border-[#146C53] rounded-lg px-2 py-1 text-xs font-mono font-semibold"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Paper & Caliper */}
          <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
            <span className="text-xs font-bold text-slate-800">Loại giấy &amp; Thông số kỹ thuật</span>
            <select
              value={materialKey}
              onChange={(e) => setMaterialKey(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
            >
              {Object.entries(PAPER_MATERIALS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500">Độ dày (mm)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.05"
                  value={params.thickness}
                  onChange={(e) => updateParam('thickness', e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500">Mép dán</label>
                <input
                  type="number"
                  min="8"
                  value={params.glueTab}
                  onChange={(e) => updateParam('glueTab', e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500">Tai gài</label>
                <input
                  type="number"
                  min="0"
                  disabled={templateId === 'tray' || templateId === 'sleeve' || templateId === 'bag'}
                  value={params.tuckFlap}
                  onChange={(e) => updateParam('tuckFlap', e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono disabled:bg-slate-50 disabled:text-slate-400"
                />
              </div>
            </div>
          </div>

          {/* Artwork Upload */}
          <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-100">
            <span className="text-xs font-bold text-slate-800">Ốp thiết kế lên mặt hộp</span>
            <div className="flex items-center gap-2">
              <label className="flex-1 text-center py-1.5 px-3 rounded-xl border border-dashed border-slate-300 hover:border-[#146C53] bg-[#FAFBF9] text-xs font-medium text-slate-600 cursor-pointer truncate">
                {artworkName ? `🎨 ${artworkName}` : '⬆️ Chọn ảnh / PDF bản trải'}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => handleArtworkUpload(e.target.files[0])}
                />
              </label>
              {artworkDataUrl && (
                <button
                  onClick={() => {
                    setArtworkDataUrl(null);
                    setArtworkName('');
                  }}
                  className="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-xs font-semibold text-rose-600 cursor-pointer"
                >
                  Xóa
                </button>
              )}
            </div>
          </div>

          {/* Live Summary */}
          <div className="divide-y divide-slate-100 text-xs pt-2 border-t border-slate-100">
            <div className="py-1.5 flex justify-between gap-2">
              <span className="text-slate-500">Khổ phôi trải</span>
              <span className="font-mono font-bold text-slate-800">
                {dieline.bounds.width} × {dieline.bounds.height} mm
              </span>
            </div>
            <div className="py-1.5 flex justify-between gap-2">
              <span className="text-slate-500">Xếp tờ ({sheetStats.sheetLabel})</span>
              <span className="font-mono font-bold text-[#146C53]">{sheetStats.count} khuôn/tờ</span>
            </div>
            <div className="py-1.5 flex justify-between gap-2">
              <span className="text-slate-500">Hao phí tờ</span>
              <span className="font-mono font-semibold text-amber-600">{sheetStats.wastePct}%</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-3 border-t border-slate-100">
          <button
            onClick={handleExportPdf}
            disabled={exporting}
            className="w-full py-2.5 rounded-xl bg-[#146C53] hover:bg-[#0f5440] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
          >
            {exporting
              ? 'Đang xuất PDF...'
              : canvasMode === 'impose'
              ? '📐 Xuất PDF Tờ Bình Khuôn 1:1'
              : '📐 Xuất Khuôn Bế PDF 1:1'}
          </button>
          <button
            onClick={handleExportSvg}
            className="w-full py-2 rounded-xl bg-[#E6F4EF] hover:bg-[#d5ece4] text-[#146C53] text-xs font-bold transition-colors cursor-pointer"
          >
            🧩 Xuất SVG Vector (AI / Corel)
          </button>
        </div>
      </aside>
    </div>
  );
}
