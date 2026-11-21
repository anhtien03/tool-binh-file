import React, { useState, useMemo, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { DIELINE_TEMPLATES, generateDieline } from '../engine/dielineEngine';
import { exportDielinePdf } from '../engine/dielinePdfExporter';
import Box3DViewer, { PAPER_MATERIALS } from './Box3DViewer';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export default function DielineStudio({ onSwitchToImpose }) {
  const [templateId, setTemplateId] = useState('rte');
  const [params, setParams] = useState(DIELINE_TEMPLATES.rte.defaults);
  const [foldProgress, setFoldProgress] = useState(0.95);
  const [isAnimating, setIsAnimating] = useState(false);
  const [materialKey, setMaterialKey] = useState('ivory');
  const [viewMode, setViewMode] = useState('3d'); // '3d' | '2d' | 'split'
  const [cameraPreset, setCameraPreset] = useState('iso');
  const [artworkDataUrl, setArtworkDataUrl] = useState(null);
  const [artworkName, setArtworkName] = useState('');
  const [exporting, setExporting] = useState(false);

  const dieline = useMemo(() => generateDieline(templateId, params), [templateId, params]);

  // Auto fold/unfold animation loop
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

  const handleTemplateChange = (id) => {
    setTemplateId(id);
    setParams(DIELINE_TEMPLATES[id].defaults);
  };

  const updateParam = (key, value) => {
    setParams((prev) => ({ ...prev, [key]: Math.max(0, parseFloat(value) || 0) }));
  };

  // Upload PNG/JPG/PDF artwork and map onto 3D box faces
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
      const bytes = await exportDielinePdf(dieline, artworkDataUrl);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `KhuonBe_${templateId}_${params.L}x${params.W}x${params.H}mm.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-[#0c0d10] text-slate-100 font-sans">
      {/* Sidebar */}
      <div className="w-full lg:w-[400px] bg-[#13151a] border-b lg:border-b-0 lg:border-r border-slate-800/80 p-5 flex flex-col gap-4 overflow-y-auto max-h-screen">
        {/* Top Module Switcher */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500 text-slate-950 font-black flex items-center justify-center shadow-lg shadow-amber-500/20">
              3D
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Khuôn Bế & Mockup 3D</h1>
              <p className="text-[11px] text-slate-400">Parametric Dieline · Gấp 3D · Xuất PDF 1:1</p>
            </div>
          </div>
          <button
            onClick={onSwitchToImpose}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-emerald-400 cursor-pointer"
          >
            ← Bình Bài In
          </button>
        </div>

        {/* 1. Template Selector */}
        <div className="flex flex-col gap-2 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400">1. Chọn mẫu khuôn hộp</h3>
          <div className="flex flex-col gap-1.5">
            {Object.values(DIELINE_TEMPLATES).map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => handleTemplateChange(tpl.id)}
                className={`text-left px-3 py-2 rounded-lg border transition-all cursor-pointer ${
                  templateId === tpl.id
                    ? 'bg-amber-500/15 border-amber-500/60 text-white'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="text-xs font-bold">{tpl.shortName}</div>
                <div className="text-[10px] opacity-75 mt-0.5">{tpl.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 2. Dimensions (mm) */}
        <div className="flex flex-col gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400">2. Thông số kích thước (mm)</h3>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Dài (L)', 'L'],
              ['Rộng (W)', 'W'],
              ['Cao (H)', 'H'],
            ].map(([label, key]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">{label}</label>
                <input
                  type="number"
                  min="10"
                  value={params[key]}
                  onChange={(e) => updateParam(key, e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-[10px] text-slate-400">Dày giấy</label>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={params.thickness}
                onChange={(e) => updateParam('thickness', e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="text-[10px] text-slate-400">Mép dán</label>
              <input
                type="number"
                min="8"
                value={params.glueTab}
                onChange={(e) => updateParam('glueTab', e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono"
              />
            </div>
            {templateId !== 'tray' && (
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-400">Tai gài</label>
                <input
                  type="number"
                  min="8"
                  value={params.tuckFlap}
                  onChange={(e) => updateParam('tuckFlap', e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono"
                />
              </div>
            )}
          </div>
        </div>

        {/* 3. Fold & Material & Artwork */}
        <div className="flex flex-col gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800/80">
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400">3. Gấp 3D & Chất liệu / Thiết kế</h3>

          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">Độ gấp hộp</span>
              <span className="font-mono text-amber-400 font-bold">{Math.round(foldProgress * 100)}%</span>
            </div>
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
              className="w-full accent-amber-500 cursor-pointer"
            />
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => {
                  setIsAnimating(false);
                  setFoldProgress(0);
                }}
                className="py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] cursor-pointer"
              >
                Trải phẳng 0%
              </button>
              <button
                onClick={() => setIsAnimating((v) => !v)}
                className={`py-1 rounded text-[11px] font-bold cursor-pointer ${
                  isAnimating ? 'bg-rose-600 text-white' : 'bg-amber-500 text-slate-950'
                }`}
              >
                {isAnimating ? '⏸ Dừng' : '▶ Tự gấp'}
              </button>
              <button
                onClick={() => {
                  setIsAnimating(false);
                  setFoldProgress(1);
                }}
                className="py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] cursor-pointer"
              >
                Đóng hộp 100%
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-400">Chất liệu giấy</label>
            <select
              value={materialKey}
              onChange={(e) => setMaterialKey(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
            >
              {Object.entries(PAPER_MATERIALS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-slate-400">Ốp file thiết kế (PNG / JPG / PDF) lên mặt hộp</label>
            <div className="flex items-center gap-2">
              <label className="flex-1 text-center py-2 px-3 rounded-lg border border-dashed border-slate-700 hover:border-amber-500 bg-slate-950/60 text-xs cursor-pointer truncate">
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
                  className="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-rose-900/60 text-xs text-rose-300 cursor-pointer"
                >
                  Xóa
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col p-6 gap-4 overflow-y-auto">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-amber-400 font-bold">
              Bản trải: {dieline.bounds.width} × {dieline.bounds.height} mm
            </span>
            <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-xs">
              {[
                ['3d', 'Xem 3D'],
                ['2d', 'Khuôn 2D'],
                ['split', 'Song song 2D + 3D'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setViewMode(k)}
                  className={`px-3 py-1 rounded-md font-semibold cursor-pointer ${
                    viewMode === k ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {viewMode !== '2d' && (
              <div className="flex gap-1 text-[11px]">
                {[
                  ['iso', 'Góc 3/4'],
                  ['front', 'Mặt trước'],
                  ['top', 'Từ trên'],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setCameraPreset(k)}
                    className={`px-2.5 py-1 rounded-lg border cursor-pointer ${
                      cameraPreset === k
                        ? 'bg-slate-800 border-amber-500/60 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleExportPdf}
            disabled={exporting}
            className="px-5 py-2.5 rounded-xl text-sm font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-lg shadow-amber-500/20 cursor-pointer"
          >
            {exporting ? 'Đang tạo PDF...' : '📐 Xuất Khuôn Bế PDF 1:1'}
          </button>
        </div>

        {/* View Area */}
        <div className={`grid gap-4 flex-1 items-center ${viewMode === 'split' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}>
          {(viewMode === '2d' || viewMode === 'split') && (
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center h-[520px]">
              <svg
                viewBox={`-10 -10 ${dieline.bounds.width + 20} ${dieline.bounds.height + 20}`}
                className="w-full h-full max-h-[440px]"
              >
                {artworkDataUrl && (
                  <image
                    href={artworkDataUrl}
                    x="0"
                    y="0"
                    width={dieline.bounds.width}
                    height={dieline.bounds.height}
                    preserveAspectRatio="none"
                    opacity="0.75"
                  />
                )}
                {dieline.creaseSegments.map(([a, b], i) => (
                  <line
                    key={`cr-${i}`}
                    x1={a[0]}
                    y1={a[1]}
                    x2={b[0]}
                    y2={b[1]}
                    stroke="#38bdf8"
                    strokeWidth="0.8"
                    strokeDasharray="3 2"
                  />
                ))}
                {dieline.cutSegments.map(([a, b], i) => (
                  <line key={`ct-${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#f43f5e" strokeWidth="1" />
                ))}
              </svg>
              <div className="flex gap-4 mt-2 text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-0.5 bg-rose-500 inline-block" /> Đường cắt (CutContour)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-0.5 border-t border-dashed border-sky-400 inline-block" /> Đường cấn gấp (Crease)
                </span>
              </div>
            </div>
          )}

          {(viewMode === '3d' || viewMode === 'split') && (
            <Box3DViewer
              dieline={dieline}
              foldProgress={foldProgress}
              materialKey={materialKey}
              artworkDataUrl={artworkDataUrl}
              cameraPreset={cameraPreset}
            />
          )}
        </div>
      </div>
    </div>
  );
}
