import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { MM_TO_PT } from '../engine/impositionEngine.js';
import {
  extractStickerContoursFromImage,
  exportBleedExtendedPdf,
  exportContourTracedPdf,
} from '../engine/bleedContourEngine.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

export default function BleedAndContourStudio({ onOpenStickerImpose }) {
  const [subMode, setSubMode] = useState('contour'); // 'contour' | 'bleed'
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceType, setSourceType] = useState('image');
  const [renderedCanvas, setRenderedCanvas] = useState(null);
  const [sizeMm, setSizeMm] = useState({ w: 150, h: 150 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Contour Tracer Options
  const [offsetMm, setOffsetMm] = useState(2.0);
  const [smoothLevel, setSmoothLevel] = useState(2);
  const [simplifyMm, setSimplifyMm] = useState(0.45);
  const [minAreaMm2, setMinAreaMm2] = useState(4.0);
  const [contoursMm, setContoursMm] = useState([]);

  // 4-Edge Bleed Extension Options
  const [bleedAllMm, setBleedAllMm] = useState(2.0);
  const [bleedEdges, setBleedEdges] = useState({ top: true, bottom: true, left: true, right: true });
  const [fillMode, setFillMode] = useState('mirror'); // 'mirror' | 'stretch' | 'solid'
  const [solidColorHex, setSolidColorHex] = useState('#ffffff');

  const previewCanvasRef = useRef(null);

  const handleUpload = async (file) => {
    if (!file) return;
    setSourceFile(file);
    setError(null);
    setLoading(true);
    try {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        setSourceType('pdf');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const page = await pdf.getPage(1);
        const vp1 = page.getViewport({ scale: 1.0 });
        setSizeMm({
          w: Math.round((vp1.width / MM_TO_PT) * 10) / 10,
          h: Math.round((vp1.height / MM_TO_PT) * 10) / 10,
        });
        const vp = page.getViewport({ scale: Math.min(2.0, 1400 / Math.max(1, vp1.width, vp1.height)) });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        setRenderedCanvas(c);
      } else {
        setSourceType('image');
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

  // Re-trace contours asynchronously so UI never freezes on complex PDFs
  useEffect(() => {
    if (!renderedCanvas || subMode !== 'contour') {
      setContoursMm([]);
      return;
    }
    const timer = setTimeout(() => {
      try {
        const traced = extractStickerContoursFromImage(renderedCanvas, sizeMm.w, sizeMm.h, {
          offsetMm,
          smoothLevel,
          simplifyMm,
          minAreaMm2,
        });
        setContoursMm(traced);
      } catch (err) {
        console.error(err);
        setError('Lỗi khi dò đường bế từ hình ảnh.');
      }
    }, 20);
    return () => clearTimeout(timer);
  }, [renderedCanvas, subMode, sizeMm.w, sizeMm.h, offsetMm, smoothLevel, simplifyMm, minAreaMm2]);

  // Draw live preview canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const maxBox = 520;
    const ratio = window.devicePixelRatio || 2;
    const padMm = subMode === 'contour' ? Math.max(4, offsetMm + 3) : bleedAllMm + 2;
    const totalW = sizeMm.w + padMm * 2;
    const totalH = sizeMm.h + padMm * 2;
    const scale = Math.min(maxBox / totalW, maxBox / totalH);

    const viewW = Math.round(totalW * scale);
    const viewH = Math.round(totalH * scale);
    canvas.width = viewW * ratio;
    canvas.height = viewH * ratio;
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
      // Contour mode: draw image + traced magenta CutContour loops
      ctx.drawImage(renderedCanvas, x0, y0, w0, h0);
      ctx.strokeStyle = '#db2777';
      ctx.lineWidth = 1.6;
      for (const poly of contoursMm) {
        if (poly.length < 2) continue;
        ctx.beginPath();
        poly.forEach(([px, py], i) => {
          const vx = (padMm + px) * scale;
          const vy = (padMm + py) * scale;
          if (i === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }
  }, [renderedCanvas, subMode, sizeMm, offsetMm, contoursMm, bleedAllMm, bleedEdges, fillMode, solidColorHex]);

  const handleExportPdf = async () => {
    if (!renderedCanvas) return;
    setLoading(true);
    try {
      let bytes;
      if (subMode === 'contour') {
        bytes = await exportContourTracedPdf(renderedCanvas, sizeMm.w, sizeMm.h, contoursMm, Math.max(5, offsetMm + 3));
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

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 flex-1 bg-[#F4F6F5]">
      {/* LEFT SIDEBAR */}
      <aside className="w-full lg:w-[340px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-3.5 shrink-0 shadow-xs">
        <div className="grid grid-cols-2 gap-1 bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setSubMode('contour')}
            className={`py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
              subMode === 'contour' ? 'bg-white text-[#146C53] shadow-xs' : 'text-slate-500'
            }`}
          >
            Dò đường bế Sticker
          </button>
          <button
            onClick={() => setSubMode('bleed')}
            className={`py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
              subMode === 'bleed' ? 'bg-white text-[#146C53] shadow-xs' : 'text-slate-500'
            }`}
          >
            Bù tràn lề 4 cạnh
          </button>
        </div>

        {/* File Upload */}
        <div className="relative border border-dashed border-slate-300 hover:border-[#146C53] rounded-xl p-3 text-center cursor-pointer bg-[#FAFBF9]">
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.pdf"
            onChange={(e) => {
              handleUpload(e.target.files[0]);
              e.target.value = '';
            }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="text-xs font-semibold text-slate-700 truncate">
            {loading ? '⏳ Đang xử lý file...' : sourceFile ? `📄 ${sourceFile.name}` : '⬆️ Chọn ảnh PNG sticker hoặc file PDF'}
          </div>
          {renderedCanvas && (
            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
              Kích thước: {sizeMm.w} × {sizeMm.h} mm
            </div>
          )}
        </div>
        {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px]">⚠️ {error}</div>}

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

            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-600">Độ nở / thu viền (Offset)</span>
                <span className="font-mono font-bold text-[#146C53]">{offsetMm > 0 ? `+${offsetMm}` : offsetMm} mm</span>
              </div>
              <input
                type="range"
                min="-2"
                max="6"
                step="0.5"
                value={offsetMm}
                onChange={(e) => setOffsetMm(parseFloat(e.target.value))}
                className="w-full accent-[#146C53]"
              />
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-600">Làm mượt góc (Smoothing)</span>
                <span className="font-mono font-bold text-slate-700">{smoothLevel}x</span>
              </div>
              <input
                type="range"
                min="0"
                max="3"
                step="1"
                value={smoothLevel}
                onChange={(e) => setSmoothLevel(parseInt(e.target.value, 10))}
                className="w-full accent-[#146C53]"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500">Độ bám sát (mm)</label>
                <input
                  type="number"
                  min="0.1"
                  max="3"
                  step="0.1"
                  value={simplifyMm}
                  onChange={(e) => setSimplifyMm(Math.max(0.1, parseFloat(e.target.value) || 0.4))}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-slate-500">Lọc nhiễu (&lt; mm²)</label>
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
      </aside>

      {/* CENTER CANVAS */}
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center justify-center shadow-xs">
        <div
          className="w-full h-[540px] rounded-2xl border border-slate-200 flex items-center justify-center overflow-auto p-4"
          style={{
            backgroundColor: '#fafbf9',
            backgroundImage:
              'linear-gradient(to right, #eef2f1 1px, transparent 1px), linear-gradient(to bottom, #eef2f1 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          <canvas ref={previewCanvasRef} className="bg-white shadow-md rounded border border-slate-200" />
        </div>
        <div className="flex gap-4 mt-2.5 text-[11px] text-slate-500">
          {subMode === 'contour' ? (
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-pink-600 inline-block" /> Đường bế tự động (CutContour)
            </span>
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

      {/* RIGHT SUMMARY SIDEBAR */}
      <aside className="w-full lg:w-[260px] bg-white rounded-2xl border border-slate-200 p-4 flex flex-col justify-between gap-4 shrink-0 shadow-xs">
        <div className="flex flex-col gap-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">XUẤT FILE CHUẨN IN</span>
            <h3 className="text-sm font-bold text-slate-800 mt-0.5">
              {subMode === 'contour' ? 'Tạo CutContour Sticker' : 'Bù tràn lề 4 cạnh'}
            </h3>
          </div>
          <div className="divide-y divide-slate-100 text-xs">
            <div className="py-2 flex justify-between">
              <span className="text-slate-500">Kích thước gốc</span>
              <span className="font-mono font-bold text-slate-800">
                {sizeMm.w} × {sizeMm.h} mm
              </span>
            </div>
            {subMode === 'contour' ? (
              <div className="py-2 flex justify-between">
                <span className="text-slate-500">Số tem nhận diện</span>
                <span className="font-mono font-bold text-[#146C53]">{contoursMm.length} tem</span>
              </div>
            ) : (
              <div className="py-2 flex justify-between">
                <span className="text-slate-500">Khổ sau bù Bleed</span>
                <span className="font-mono font-bold text-[#146C53]">
                  {(sizeMm.w + (bleedEdges.left ? bleedAllMm : 0) + (bleedEdges.right ? bleedAllMm : 0)).toFixed(1)} ×{' '}
                  {(sizeMm.h + (bleedEdges.top ? bleedAllMm : 0) + (bleedEdges.bottom ? bleedAllMm : 0)).toFixed(1)} mm
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-3 border-t border-slate-100">
          <button
            onClick={handleExportPdf}
            disabled={loading || !renderedCanvas}
            className={`w-full py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
              loading || !renderedCanvas
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-[#146C53] hover:bg-[#0f5440] text-white shadow-xs'
            }`}
          >
            {loading
              ? 'Đang xử lý...'
              : subMode === 'contour'
              ? '✂️ Xuất PDF có CutContour'
              : '📐 Xuất PDF đã bù Bleed'}
          </button>
          <button
            onClick={onOpenStickerImpose}
            className="w-full py-2 rounded-xl border border-slate-200 hover:border-[#146C53] text-slate-700 text-xs font-semibold cursor-pointer"
          >
            Sang Bình Tem Bế →
          </button>
        </div>
      </aside>
    </div>
  );
}
