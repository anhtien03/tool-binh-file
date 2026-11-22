import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 3D flip-book preview of the FINISHED booklet (reading order, not imposed order).
 * Pure CSS 3D (perspective + preserve-3d) so page images stay crisp and no WebGL is needed.
 *
 * props:
 *  - pages: pdfPages [{ dataUrl, mediaWmm, mediaHmm, hasExplicitTrimBox, trimWmm, trimHmm, trimOffsetLeftMm, trimOffsetTopMm }]
 *  - bleedMm: bleed assumed when the PDF has no TrimBox
 *  - binding: 'left' | 'right'
 *  - bookletStyle: 'saddleStitch' | 'perfectBound' | 'wireO' | 'zine8'
 *  - onClose()
 */
export default function Book3DViewer({ pages = [], bleedMm = 0, binding = 'left', bookletStyle = 'saddleStitch', onClose }) {
  const isWire = bookletStyle === 'wireO';
  const isRight = binding === 'right' && !isWire && bookletStyle !== 'zine8';

  // Pad to a multiple of 4 (saddle / perfect / zine) or 2 (wire-o) exactly like the imposition engine
  const unit = isWire ? 2 : 4;
  const totalPages = Math.max(unit, Math.ceil(Math.max(1, pages.length) / unit) * unit);
  const leafCount = totalPages / 2;

  // Trim size from the first real page
  const trim = useMemo(() => {
    const p = pages[0];
    if (!p) return { w: 148, h: 210, mediaW: 148, mediaH: 210, offL: 0, offT: 0 };
    const mediaW = p.mediaWmm || 148;
    const mediaH = p.mediaHmm || 210;
    if (p.hasExplicitTrimBox && p.trimWmm > 1 && p.trimHmm > 1) {
      return { w: p.trimWmm, h: p.trimHmm, mediaW, mediaH, offL: p.trimOffsetLeftMm || 0, offT: p.trimOffsetTopMm || 0 };
    }
    const b = Math.max(0, Number(bleedMm) || 0);
    const w = Math.max(10, mediaW - 2 * b);
    const h = Math.max(10, mediaH - 2 * b);
    return { w, h, mediaW, mediaH, offL: (mediaW - w) / 2, offT: (mediaH - h) / 2 };
  }, [pages, bleedMm]);

  const [flipped, setFlipped] = useState(0); // number of leaves turned
  const [rotX, setRotX] = useState(18);
  const [rotY, setRotY] = useState(isRight ? 12 : -12);
  const [zoom, setZoom] = useState(1);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const dragRef = useRef(null);
  const justDraggedRef = useRef(false);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const go = (n) => setFlipped(Math.max(0, Math.min(leafCount, n)));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      const fwd = isRight ? 'ArrowLeft' : 'ArrowRight';
      const back = isRight ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd) setFlipped((f) => Math.min(leafCount, f + 1));
      if (e.key === back) setFlipped((f) => Math.max(0, f - 1));
      if (e.key === 'Home') setFlipped(0);
      if (e.key === 'End') setFlipped(leafCount);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leafCount, isRight, onClose]);

  // Fit an open spread (2 pages wide) into ~80% x 62% of the viewport
  const pxPerMm = Math.max(0.5, Math.min((vp.w * 0.8) / (trim.w * 2), (vp.h * 0.62) / trim.h)) * zoom;
  const W = trim.w * pxPerMm;
  const H = trim.h * pxPerMm;
  const leafGap = Math.max(0.25, Math.min(1.2, 40 / leafCount)); // px stacking per leaf (visual paper thickness)

  // Center the closed book on screen: closed-front shows only the right half, closed-back only the left half
  const shiftX = flipped === 0 ? -W / 2 : flipped === leafCount ? W / 2 : 0;
  const shift = isRight ? -shiftX : shiftX;

  const pageStyle = (pageIdx) => {
    const pg = pages[pageIdx];
    if (!pg?.dataUrl) return { background: '#ffffff' };
    const sizeX = (trim.mediaW / trim.w) * 100;
    const sizeY = (trim.mediaH / trim.h) * 100;
    const posX = trim.mediaW - trim.w > 0.01 ? (trim.offL / (trim.mediaW - trim.w)) * 100 : 50;
    const posY = trim.mediaH - trim.h > 0.01 ? (trim.offT / (trim.mediaH - trim.h)) * 100 : 50;
    return {
      backgroundColor: '#ffffff',
      backgroundImage: `url(${pg.dataUrl})`,
      backgroundSize: `${sizeX}% ${sizeY}%`,
      backgroundPosition: `${posX}% ${posY}%`,
      backgroundRepeat: 'no-repeat',
    };
  };

  // Gutter shading: darker towards the spine for a real-paper look
  const gutterShade = (spineOnLeft) => ({
    background: `linear-gradient(${spineOnLeft ? 'to right' : 'to left'}, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.08) 6%, rgba(0,0,0,0) 14%, rgba(0,0,0,0) 92%, rgba(0,0,0,0.05) 100%)`,
  });

  const renderFace = (pageIdx, spineOnLeft, isBack) => {
    const blank = pageIdx >= pages.length;
    return (
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          ...pageStyle(pageIdx),
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          transform: isBack ? 'rotateY(180deg)' : 'none',
          boxShadow: '0 0 0 0.5px rgba(15,23,42,0.18)',
        }}
      >
        {blank && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-300 italic select-none">
            (trang trắng)
          </div>
        )}
        <div className="absolute inset-0 pointer-events-none" style={gutterShade(spineOnLeft)} />
        <div
          className="absolute bottom-1 text-[10px] font-mono font-bold text-slate-500/80 bg-white/70 px-1 rounded select-none"
          style={spineOnLeft ? { right: 4 } : { left: 4 }}
        >
          {pageIdx + 1}
        </div>
      </div>
    );
  };

  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const turned = i < flipped;
    const zUnturned = (leafCount - i) * leafGap;
    const zTurned = (i + 1) * leafGap;
    const angle = turned ? (isRight ? 180 : -180) : 0;
    const z = turned ? -zTurned : zUnturned;
    // Front face: hinge side is the spine. Left binding -> spine on the left of the front face; after turning, spine on the right.
    leaves.push(
      <div
        key={i}
        onClick={(e) => {
          e.stopPropagation();
          if (justDraggedRef.current) {
            justDraggedRef.current = false; // this click ended a rotate-drag, don't flip
            return;
          }
          go(turned ? i : i + 1);
        }}
        className="absolute top-0 cursor-pointer"
        style={{
          width: W,
          height: H,
          left: isRight ? 0 : W,
          transformOrigin: isRight ? 'right center' : 'left center',
          transformStyle: 'preserve-3d',
          transform: `rotateY(${angle}deg) translateZ(${z}px)`,
          transition: 'transform 0.75s cubic-bezier(0.45, 0.05, 0.25, 1)',
        }}
      >
        {renderFace(2 * i, !isRight, false)}
        {renderFace(2 * i + 1, isRight, true)}
      </div>
    );
  }

  // Spine decorations
  const spineX = W; // spine is always at the center of the 2W stage
  const decorations = [];
  if (isWire) {
    const rings = Math.max(6, Math.round(trim.h / 8.47)); // 3:1 pitch ≈ 8.47mm
    for (let r = 0; r < rings; r++) {
      const y = ((r + 0.5) / rings) * H;
      decorations.push(
        <div
          key={`ring-${r}`}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: spineX - 7,
            top: y - 3,
            width: 14,
            height: 6,
            border: '2px solid #475569',
            background: 'transparent',
            transform: `translateZ(${(leafCount + 2) * leafGap}px) rotateX(70deg)`,
          }}
        />
      );
    }
  } else if (bookletStyle === 'saddleStitch' && flipped > 0 && flipped < leafCount) {
    // Staples are visible on the centre spread
    [0.25, 0.75].forEach((t, k) =>
      decorations.push(
        <div
          key={`staple-${k}`}
          className="absolute pointer-events-none"
          style={{
            left: spineX - 1.5,
            top: t * H - 9,
            width: 3,
            height: 18,
            background: 'linear-gradient(to right, #94a3b8, #e2e8f0, #64748b)',
            borderRadius: 1,
            transform: `translateZ(${(leafCount + 2) * leafGap}px)`,
          }}
        />
      )
    );
  }

  const spreadLabel = (() => {
    if (flipped === 0) return isRight ? 'Bìa trước (trang 1)' : 'Bìa trước (trang 1)';
    if (flipped === leafCount) return `Bìa sau (trang ${totalPages})`;
    const a = 2 * flipped;
    const b = 2 * flipped + 1;
    return `Trang ${a}–${b}`;
  })();

  const onPointerDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, rx: rotX, ry: rotY, moved: false };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setRotY(Math.max(-75, Math.min(75, d.ry + dx * 0.3)));
    setRotX(Math.max(-10, Math.min(75, d.rx - dy * 0.3)));
  };
  const onPointerUp = () => {
    if (dragRef.current) justDraggedRef.current = dragRef.current.moved;
    dragRef.current = null;
  };

  const styleName =
    bookletStyle === 'perfectBound'
      ? 'Đóng keo gáy'
      : bookletStyle === 'wireO'
      ? 'Gáy xoắn Wire-O'
      : bookletStyle === 'zine8'
      ? 'Zine 8 trang'
      : 'Bấm kim giữa';

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-sm flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-5 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-sm font-bold">🧊 Xem 3D cuốn sách thành phẩm</div>
          <div className="text-[11px] text-slate-300">
            {styleName} · {isRight ? 'Mở phải' : 'Mở trái'} · {trim.w.toFixed(1)}×{trim.h.toFixed(1)} mm · {pages.length} trang
            {totalPages > pages.length ? ` (+${totalPages - pages.length} trang trắng cho đủ bội số ${unit})` : ''}
          </div>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold cursor-pointer"
          title="Đóng (Esc)"
        >
          ✕ Đóng
        </button>
      </div>

      <div
        className="flex-1 relative overflow-hidden select-none"
        style={{ perspective: `${Math.max(1200, W * 4)}px`, cursor: dragRef.current ? 'grabbing' : 'grab' }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={(e) => setZoom((z) => Math.max(0.4, Math.min(2.5, Math.round((z + (e.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100)))}
      >
        {pages.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">
            Tải file PDF để xem cuốn sách 3D
          </div>
        ) : (
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: W * 2,
              height: H,
              marginLeft: -W,
              marginTop: -H / 2,
              transformStyle: 'preserve-3d',
              transform: `rotateX(${rotX}deg) rotateY(${rotY}deg) translateX(${shift}px)`,
              transition: dragRef.current ? 'none' : 'transform 0.6s ease',
            }}
          >
            {/* Soft table shadow */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: flipped === 0 ? (isRight ? 0 : W) : flipped === leafCount ? (isRight ? W : 0) : 0,
                width: flipped === 0 || flipped === leafCount ? W : W * 2,
                top: 0,
                height: H,
                transform: 'translateZ(-2px)',
                boxShadow: '0 30px 60px rgba(0,0,0,0.55)',
                transition: 'all 0.6s ease',
              }}
            />
            {leaves}
            {decorations}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 px-5 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        {(() => {
          const btn = 'px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold cursor-pointer disabled:opacity-30';
          const prevBtn = (
            <button key="p" className={btn} disabled={flipped === 0} onClick={() => go(flipped - 1)}>
              {isRight ? '▶' : '◀'} Trang trước
            </button>
          );
          const nextBtn = (
            <button key="n" className={btn} disabled={flipped === leafCount} onClick={() => go(flipped + 1)}>
              Trang sau {isRight ? '◀' : '▶'}
            </button>
          );
          const first = (
            <button key="f" className={btn} onClick={() => go(0)} title="Về bìa trước (Home)">
              Bìa trước
            </button>
          );
          const last = (
            <button key="l" className={btn} onClick={() => go(leafCount)} title="Tới bìa sau (End)">
              Bìa sau
            </button>
          );
          return isRight ? [last, nextBtn, prevBtn, first] : [first, prevBtn, nextBtn, last];
        })()}
        <input
          type="range"
          min={0}
          max={leafCount}
          value={flipped}
          onChange={(e) => go(Number(e.target.value))}
          className="w-48 accent-emerald-400"
          style={isRight ? { direction: 'rtl' } : undefined}
        />
        <span className="min-w-[150px] text-center text-sm font-mono font-bold text-emerald-300">{spreadLabel}</span>
        <button
          className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold cursor-pointer"
          onClick={() => {
            setRotX(18);
            setRotY(isRight ? 12 : -12);
            setZoom(1);
          }}
        >
          ↺ Góc nhìn mặc định
        </button>
        <button
          className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold cursor-pointer"
          onClick={() => {
            setRotX(0);
            setRotY(0);
          }}
        >
          ⬜ Nhìn thẳng
        </button>
        <div className="w-full text-center text-[11px] text-slate-400">
          Bấm vào trang để lật · Kéo chuột để xoay · Lăn chuột để phóng to · Phím ← → để lật · Esc để đóng
        </div>
      </div>
    </div>
  );
}
