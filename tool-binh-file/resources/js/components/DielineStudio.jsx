import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { DIELINE_TEMPLATES, generateDieline, exportDielineSvg } from '../engine/dielineEngine';
import { exportDielinePdf, exportImposedDielinePdf } from '../engine/dielinePdfExporter';
import { PAPER_SIZES, solveDutchCut, solveSimpleGrid } from '../engine/impositionEngine';
import Box3DViewer, { PAPER_MATERIALS, FINISH_MODES } from './Box3DViewer';

const PANEL_VI_LABELS = {
  back: 'Mặt sau',
  front: 'Mặt trước',
  left: 'Mặt trái',
  right: 'Mặt phải',
  glue: 'Tai dán',
  top: 'Nắp trên',
  top_tuck: 'Lưỡi gài trên',
  top_lid: 'Nắp trên',
  bottom: 'Nắp đáy',
  bot_tuck: 'Lưỡi gài đáy',
  bottom_lid: 'Nắp đáy',
  dust_tl: 'Tai bụi trên',
  dust_tr: 'Tai bụi trên',
  dust_bl: 'Tai bụi dưới',
  dust_br: 'Tai bụi dưới',
  base: 'Đáy hộp',
  wall_top: 'Vách trên',
  wall_bot: 'Vách dưới',
  wall_left: 'Vách trái',
  wall_right: 'Vách phải',
  bot_main: 'Đáy gập',
};

function friendlyPanelName(node) {
  if (node.label) return node.label;
  if (node.name) return node.name;
  const id = String(node.id || '').toLowerCase();
  for (const [k, v] of Object.entries(PANEL_VI_LABELS)) {
    if (id === k || id.includes(k)) return v;
  }
  return id.replace(/[_-]+/g, ' ').trim() || 'Mặt hộp';
}

function flattenPanels(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node.polygon) && node.polygon.length >= 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of node.polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const w = Math.round((maxX - minX) * 10) / 10;
    const h = Math.round((maxY - minY) * 10) / 10;
    out.push({
      id: node.id || `p-${out.length}`,
      label: friendlyPanelName(node),
      polygon: node.polygon,
      pointsStr: node.polygon.map(([x, y]) => `${x},${y}`).join(' '),
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      minX,
      minY,
      maxX,
      maxY,
      w,
      h,
      area: w * h,
    });
  }
  for (const ch of node.children || []) {
    flattenPanels(ch, out);
  }
  return out;
}

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
  const [finishMode, setFinishMode] = useState('standard');
  const [hoveredPanelId, setHoveredPanelId] = useState(null);
  const [showPanelLabels2D, setShowPanelLabels2D] = useState(true);
  const box3DRef = useRef(null);

  // Artwork & Export (Outer + Inner)
  const [artworkDataUrl, setArtworkDataUrl] = useState(null);
  const [artworkName, setArtworkName] = useState('');
  const [innerArtworkDataUrl, setInnerArtworkDataUrl] = useState(null);
  const [innerArtworkName, setInnerArtworkName] = useState('');
  const [exporting, setExporting] = useState(false);

  // Sync defaults when user switches template from Library
  useEffect(() => {
    setParams(DIELINE_TEMPLATES[templateId]?.defaults || DIELINE_TEMPLATES.ste.defaults);
  }, [templateId]);

  const dieline = useMemo(() => generateDieline(templateId, params, dimensionMode), [templateId, params, dimensionMode]);
  const flatPanels = useMemo(() => flattenPanels(dieline.rootPanel), [dieline]);
  const hoveredPanel = useMemo(
    () => flatPanels.find((p) => p.id === hoveredPanelId) || null,
    [flatPanels, hoveredPanelId]
  );

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

  const renderUploadToDataUrl = async (file) => {
    if (file.type === 'application/pdf') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
      const pdf = await pdfjsLib.getDocument({
        data: bytes,
        cMapUrl: isLocal ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
        cMapPacked: true,
      }).promise;
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      return canvas.toDataURL('image/png');
    }
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  };

  const handleArtworkUpload = async (file, side = 'outer') => {
    if (!file) return;
    const url = await renderUploadToDataUrl(file);
    if (side === 'inner') {
      setInnerArtworkName(file.name);
      setInnerArtworkDataUrl(url);
    } else {
      setArtworkName(file.name);
      setArtworkDataUrl(url);
    }
  };

  const handleCapturePng3D = () => {
    const dataUrl = box3DRef.current?.capturePng?.(true);
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `Mockup3D_${tpl.code}_${params.L}x${params.W}x${params.H}mm.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleExportGlb = async () => {
    try {
      const buffer = await box3DRef.current?.exportGlb?.();
      if (!buffer) return;
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tpl.code}_${params.L}x${params.W}x${params.H}mm.glb`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export GLB error:', err);
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
    <div className="flex flex-1 min-w-0 h-full overflow-hidden">
      {/* 1. LEFT: CENTER MAIN CANVAS */}
      <main className="flex-1 min-w-0 bg-[#1e232a] flex flex-col overflow-hidden">
        {/* Canvas Top Bar */}
        <div className="min-h-[40px] px-3 py-1 bg-[#F8FAFC] border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1 bg-[#E2E8F0]/70 p-0.5 rounded-lg">
            {[
              ['2d', 'Khuôn 2D'],
              ['3d', 'Mô phỏng 3D'],
              ['split', 'Song song 2D + 3D'],
              ['impose', 'Bình khuôn'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasMode(k)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  canvasMode === k ? 'bg-white text-[#087F5B] shadow-2xs' : 'text-[#64748B] hover:text-[#17212F]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {(canvasMode === '2d' || canvasMode === 'split') && (
              <button
                onClick={() => setShowPanelLabels2D((v) => !v)}
                className={`px-2 py-1 rounded-md border text-[11px] font-semibold cursor-pointer ${
                  showPanelLabels2D
                    ? 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'
                    : 'bg-white border-[#E2E8F0] text-[#64748B]'
                }`}
              >
                Nhãn mặt hộp
              </button>
            )}
            {canvasMode !== '3d' && (
              <div className="flex items-center gap-1 bg-white border border-[#E2E8F0] rounded-md px-1.5 py-0.5 text-xs font-mono text-[#64748B]">
                <button onClick={() => setZoom2D(1.0)} className="px-1.5 hover:text-[#087F5B] font-sans font-semibold cursor-pointer">
                  Fit
                </button>
                <button onClick={() => setZoom2D(2.0)} className="px-1.5 hover:text-[#087F5B] text-[11px] cursor-pointer">
                  200%
                </button>
                <button onClick={() => setZoom2D((z) => Math.max(0.4, Math.round((z - 0.2) * 100) / 100))} className="px-1.5 hover:text-[#17212F] cursor-pointer">
                  −
                </button>
                <span className="min-w-[44px] text-center font-bold text-[#087F5B]">{Math.round(zoom2D * 100)}%</span>
                <button onClick={() => setZoom2D((z) => Math.min(8.0, Math.round((z + 0.2) * 100) / 100))} className="px-1.5 hover:text-[#17212F] cursor-pointer">
                  +
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Canvas Body */}
        <div className={`flex-1 min-h-0 grid ${canvasMode === 'split' ? 'grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-[#334155]' : 'grid-cols-1'}`}>
          {(canvasMode === '2d' || canvasMode === 'split') && (
            <div
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 0.2 : -0.2;
                setZoom2D((z) => Math.round(Math.min(8.0, Math.max(0.4, z + delta)) * 100) / 100);
              }}
              title="Cuộn chuột để Phóng to / Thu nhỏ khuôn 2D · Rê chuột lên từng mặt để xem thông số"
              className="relative flex p-6 overflow-auto bg-[#1e232a]"
            >
              {/* Top-left Spec & Hover Pill */}
              <div className="sticky top-0 left-0 z-10 h-0 flex items-start justify-between w-full pointer-events-none">
                <div className="bg-slate-900/85 backdrop-blur border border-slate-700 rounded-md px-2.5 py-1 text-[11px] font-mono text-slate-200 shadow-sm">
                  {tpl.code} · {dieline.bounds.width}×{dieline.bounds.height} mm
                  {hoveredPanel && (
                    <span className="ml-2 text-emerald-300 font-bold">
                      · [{hoveredPanel.label}: {hoveredPanel.w}×{hoveredPanel.h} mm]
                    </span>
                  )}
                </div>
              </div>

              <div className="m-auto shrink-0">
                <svg
                  viewBox={`-22 -22 ${dieline.bounds.width + 44} ${dieline.bounds.height + 44}`}
                  style={{ width: `${Math.round(620 * zoom2D)}px`, height: 'auto' }}
                  className="block select-none"
                >
                  {/* 1. Pacora-style glowing Bleed Silhouette around box panels */}
                  <g fill="none" stroke="#38bdf8" strokeWidth="4.2" strokeLinejoin="round" opacity="0.28">
                    {flatPanels.map((fp) => (
                      <polygon key={`bl-glow-${fp.id}`} points={fp.pointsStr} />
                    ))}
                  </g>
                  <g fill="none" stroke="#38bdf8" strokeWidth="1.2" strokeLinejoin="round" opacity="0.85">
                    {flatPanels.map((fp) => (
                      <polygon key={`bl-line-${fp.id}`} points={fp.pointsStr} />
                    ))}
                  </g>

                  {/* 2. Interactive Cream Paper Panels (hover highlights both 2D and 3D!) */}
                  {flatPanels.map((fp) => {
                    const isHover = hoveredPanelId === fp.id;
                    return (
                      <polygon
                        key={`fill-${fp.id}`}
                        points={fp.pointsStr}
                        fill={isHover ? '#fde8ea' : '#f7f5ef'}
                        stroke="none"
                        className="cursor-pointer transition-colors duration-100"
                        onMouseEnter={() => setHoveredPanelId(fp.id)}
                        onMouseLeave={() => setHoveredPanelId((cur) => (cur === fp.id ? null : cur))}
                      />
                    );
                  })}

                  {/* 3. Artwork overlay clipped to dieline bounds */}
                  {artworkDataUrl && (
                    <image
                      href={artworkDataUrl}
                      x="0"
                      y="0"
                      width={dieline.bounds.width}
                      height={dieline.bounds.height}
                      preserveAspectRatio="none"
                      opacity="0.72"
                      className="pointer-events-none"
                    />
                  )}

                  {/* 4. Crease (Red Dashed) & Cut (Dark Ink / Blue) */}
                  {dieline.creaseSegments.map(([a, b], i) => (
                    <line
                      key={`cr-${i}`}
                      x1={a[0]}
                      y1={a[1]}
                      x2={b[0]}
                      y2={b[1]}
                      stroke="#dc2626"
                      strokeWidth="0.75"
                      strokeDasharray="3 2"
                      className="pointer-events-none"
                    />
                  ))}
                  {dieline.cutSegments.map(([a, b], i) => (
                    <line
                      key={`ct-${i}`}
                      x1={a[0]}
                      y1={a[1]}
                      x2={b[0]}
                      y2={b[1]}
                      stroke="#0f172a"
                      strokeWidth="0.95"
                      className="pointer-events-none"
                    />
                  ))}

                  {/* 5. Pacora-style Floating White Label Pills + Dimensions inside each panel */}
                  {showPanelLabels2D &&
                    flatPanels.map((fp) => {
                      if (fp.w < 14 || fp.h < 12) return null;
                      const isHover = hoveredPanelId === fp.id;
                      const pillW = Math.min(fp.w * 0.86, Math.max(22, fp.label.length * 3.1 + 8));
                      const pillH = 9.5;
                      const dimText = `${fp.w}×${fp.h}`;
                      const showDim = fp.w >= 26 && fp.h >= 24;
                      return (
                        <g key={`lbl-${fp.id}`} className="pointer-events-none">
                          <rect
                            x={fp.cx - pillW / 2}
                            y={fp.cy - (showDim ? 6.5 : pillH / 2)}
                            width={pillW}
                            height={pillH}
                            rx="3.5"
                            fill={isHover ? '#087F5B' : '#ffffff'}
                            fillOpacity="0.94"
                            stroke={isHover ? '#064E3B' : '#cbd5e1'}
                            strokeWidth="0.45"
                          />
                          <text
                            x={fp.cx}
                            y={fp.cy - (showDim ? 1.8 : -0.2)}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill={isHover ? '#ffffff' : '#1e293b'}
                            fontSize="4.2"
                            fontWeight="700"
                            fontFamily="Inter, sans-serif"
                          >
                            {fp.label}
                          </text>
                          {showDim && (
                            <g>
                              <rect
                                x={fp.cx - 15}
                                y={fp.cy + 4.2}
                                width="30"
                                height="7.5"
                                rx="3"
                                fill="#ffffff"
                                fillOpacity="0.92"
                                stroke="#93c5fd"
                                strokeWidth="0.45"
                              />
                              <text
                                x={fp.cx}
                                y={fp.cy + 8.1}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="#2563eb"
                                fontSize="3.8"
                                fontWeight="700"
                                fontFamily="monospace"
                              >
                                {dimText}
                              </text>
                            </g>
                          )}
                        </g>
                      );
                    })}

                  {/* 6. Outer Overall Dimensions */}
                  <line x1="0" y1="-10" x2={dieline.bounds.width} y2="-10" stroke="#94a3b8" strokeWidth="0.55" />
                  <text
                    x={dieline.bounds.width / 2}
                    y="-13.5"
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize="5.8"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {dieline.bounds.width} mm
                  </text>

                  <line x1="-10" y1="0" x2="-10" y2={dieline.bounds.height} stroke="#94a3b8" strokeWidth="0.55" />
                  <text
                    x="-13.5"
                    y={dieline.bounds.height / 2}
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize="5.8"
                    fontFamily="monospace"
                    fontWeight="bold"
                    transform={`rotate(-90 -13.5 ${dieline.bounds.height / 2})`}
                  >
                    {dieline.bounds.height} mm
                  </text>
                </svg>
              </div>

              {/* Floating Bottom-Left Legend Pill */}
              <div className="absolute bottom-3 left-3 bg-slate-900/90 backdrop-blur border border-slate-700 rounded-full px-3.5 py-1.5 flex items-center gap-3 text-[11px] font-semibold text-slate-200 shadow-sm">
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 bg-sky-400 inline-block" /> Bleed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 bg-white inline-block" /> Cut / Trim
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 border-t border-dashed border-red-400 inline-block" /> Crease
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
                      showEdges3D ? 'bg-[#DDF5EC] text-[#064E3B]' : 'text-slate-500'
                    }`}
                  >
                    Nét bế
                  </button>
                  <span className="w-px h-3 bg-slate-200 mx-1" />
                  <button
                    onClick={handleCapturePng3D}
                    title="Chụp ảnh Mockup 3D nền trong suốt (.PNG)"
                    className="px-2 py-0.5 rounded-full bg-slate-100 hover:bg-[#DDF5EC] text-[#17212F] hover:text-[#064E3B] cursor-pointer"
                  >
                    📸 PNG 3D
                  </button>
                  <button
                    onClick={handleExportGlb}
                    title="Xuất file mô hình 3D (.GLB) gửi khách xem trên điện thoại/Blender"
                    className="px-2 py-0.5 rounded-full bg-slate-100 hover:bg-[#DDF5EC] text-[#17212F] hover:text-[#064E3B] cursor-pointer"
                  >
                    📦 .GLB
                  </button>
                </div>
              </div>

              <Box3DViewer
                ref={box3DRef}
                dieline={dieline}
                foldProgress={foldProgress}
                materialKey={materialKey}
                finishMode={finishMode}
                artworkDataUrl={artworkDataUrl}
                innerArtworkDataUrl={innerArtworkDataUrl}
                cameraPreset={cameraPreset}
                autoRotate={autoRotate}
                showEdges={showEdges3D}
                hoveredPanelId={hoveredPanelId}
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

      {/* 2. MIDDLE-RIGHT SETTINGS & SUMMARY SIDEBAR */}
      <aside className="w-[288px] xl:w-[320px] bg-white border-l border-[#E2E8F0] p-3.5 flex flex-col justify-between gap-3.5 overflow-y-auto h-full shrink-0">
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
            <select
              value={finishMode}
              onChange={(e) => setFinishMode(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
              title="Hiệu ứng gia công bề mặt 3D (Cán mờ / Cán bóng / Ép kim)"
            >
              {Object.entries(FINISH_MODES).map(([k, fm]) => (
                <option key={k} value={k}>
                  Gia công 3D: {fm.name}
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

          {/* Artwork Upload (Outer + Inner 2-sided 3D) */}
          <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-100">
            <span className="text-xs font-bold text-slate-800">Ốp thiết kế lên hộp (Ngoài &amp; Trong)</span>
            <div className="flex items-center gap-1.5">
              <label className="flex-1 text-center py-1.5 px-2.5 rounded-lg border border-dashed border-slate-300 hover:border-[#087F5B] bg-[#FAFBF9] text-[11px] font-medium text-slate-700 cursor-pointer truncate">
                {artworkName ? `Ngoài: ${artworkName}` : '+ Mặt ngoài (PNG / PDF)'}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => handleArtworkUpload(e.target.files[0], 'outer')}
                />
              </label>
              {artworkDataUrl && (
                <button
                  onClick={() => {
                    setArtworkDataUrl(null);
                    setArtworkName('');
                  }}
                  className="px-2 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-[11px] font-semibold text-rose-600 cursor-pointer"
                >
                  Xóa
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <label className="flex-1 text-center py-1.5 px-2.5 rounded-lg border border-dashed border-slate-300 hover:border-[#087F5B] bg-[#FAFBF9] text-[11px] font-medium text-slate-700 cursor-pointer truncate">
                {innerArtworkName ? `Trong: ${innerArtworkName}` : '+ Mặt trong hộp (Tùy chọn)'}
                <input
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => handleArtworkUpload(e.target.files[0], 'inner')}
                />
              </label>
              {innerArtworkDataUrl && (
                <button
                  onClick={() => {
                    setInnerArtworkDataUrl(null);
                    setInnerArtworkName('');
                  }}
                  className="px-2 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-[11px] font-semibold text-rose-600 cursor-pointer"
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
