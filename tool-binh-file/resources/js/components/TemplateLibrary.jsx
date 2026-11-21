import React, { useState, useMemo } from 'react';
import { DIELINE_CATEGORIES, DIELINE_TEMPLATES, generateDieline } from '../engine/dielineEngine';

function DielineMiniThumbnail({ templateId }) {
  const dieline = useMemo(() => generateDieline(templateId, DIELINE_TEMPLATES[templateId].defaults), [templateId]);
  const pad = 12;
  return (
    <div
      className="relative w-full h-44 rounded-xl border border-slate-200/80 flex items-center justify-center p-4 overflow-hidden"
      style={{
        backgroundColor: '#fafbf9',
        backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      }}
    >
      <svg
        viewBox={`${-pad} ${-pad} ${dieline.bounds.width + pad * 2} ${dieline.bounds.height + pad * 2}`}
        className="w-full h-full max-h-36 drop-shadow-sm"
      >
        {dieline.creaseSegments.map(([a, b], i) => (
          <line
            key={`cr-${i}`}
            x1={a[0]}
            y1={a[1]}
            x2={b[0]}
            y2={b[1]}
            stroke="#dc2626"
            strokeWidth="1.2"
            strokeDasharray="4 3"
          />
        ))}
        {dieline.cutSegments.map(([a, b], i) => (
          <line key={`ct-${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#1d4ed8" strokeWidth="1.4" />
        ))}
      </svg>
      <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-white/90 border border-slate-200 text-[10px] font-mono font-semibold text-slate-600">
        {DIELINE_TEMPLATES[templateId].code}
      </span>
    </div>
  );
}

export default function TemplateLibrary({ onSelectTemplate, onOpenImpose, onOpenBooklet }) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('default'); // 'default' | 'name' | 'code'

  const allTemplates = useMemo(() => Object.values(DIELINE_TEMPLATES), []);

  const categoryCounts = useMemo(() => {
    const counts = { all: allTemplates.length };
    for (const cat of DIELINE_CATEGORIES) {
      if (cat.id !== 'all') {
        counts[cat.id] = allTemplates.filter((t) => t.category === cat.id).length;
      }
    }
    return counts;
  }, [allTemplates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allTemplates.filter((t) => {
      if (selectedCategory !== 'all' && t.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.code.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    });

    if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    } else if (sortBy === 'code') {
      list = [...list].sort((a, b) => a.code.localeCompare(b.code));
    }
    return list;
  }, [allTemplates, selectedCategory, search, sortBy]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      {/* Header Intro */}
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#146C53]">
            THƯ VIỆN KHUÔN BẾ &amp; BÌNH BÀI
          </span>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">Chọn mẫu khuôn bế chuẩn ECMA hoặc bình bài PDF</h2>
          <p className="text-sm text-slate-500 mt-1">
            Tùy chỉnh kích thước mm theo thời gian thực, mô phỏng gấp 3D, xuất PDF/SVG 1:1 hoặc chuyển thẳng sang bình bài in.
          </p>
        </div>
        <button
          onClick={onOpenImpose}
          className="px-4 py-2.5 rounded-xl bg-[#146C53] hover:bg-[#0f5440] text-white text-xs font-bold shadow-sm transition-colors cursor-pointer shrink-0"
        >
          Mở công cụ Bình Bài In (Namecard / Sách / Gang-Run) →
        </button>
      </div>

      {/* 2-Column Library Layout */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Left Category Sidebar */}
        <aside className="w-full lg:w-64 bg-white rounded-2xl border border-slate-200 p-3 shrink-0 shadow-xs">
          <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">NHÓM MẪU</div>
          <div className="flex flex-col gap-1 mt-1">
            {DIELINE_CATEGORIES.map((cat) => {
              const active = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer relative ${
                    active
                      ? 'bg-[#E6F4EF] text-[#146C53]'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {active && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-[#146C53]" />}
                  <span>{cat.name}</span>
                  <span className={`tabular-nums text-[11px] ${active ? 'text-[#146C53] font-bold' : 'text-slate-400'}`}>
                    {categoryCounts[cat.id] || 0}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Quick Imposition Shortcuts */}
          <div className="mt-4 pt-3 border-t border-slate-100">
            <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              CÔNG CỤ BÌNH BÀI
            </div>
            <button
              onClick={onOpenImpose}
              className="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center justify-between cursor-pointer"
            >
              <span>Bình Namecard / Tem nhãn</span>
              <span className="text-[#146C53]">→</span>
            </button>
            <button
              onClick={onOpenBooklet || onOpenImpose}
              className="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center justify-between cursor-pointer"
            >
              <span>Bình Sách (Booklet)</span>
              <span className="text-[#146C53]">→</span>
            </button>
          </div>
        </aside>

        {/* Right Content Area */}
        <div className="flex-1 w-full">
          {/* Search & Sort Bar */}
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="relative flex-1">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm kiếm mẫu theo tên hoặc mã ECMA..."
                className="w-full bg-white border border-slate-200 focus:border-[#146C53] focus:outline-none rounded-full px-4 py-2.5 text-sm text-slate-800 shadow-xs"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-white border border-slate-200 rounded-full px-4 py-2.5 text-xs font-semibold text-slate-700 focus:outline-none focus:border-[#146C53] cursor-pointer"
            >
              <option value="default">Sắp xếp: Mặc định</option>
              <option value="name">Tên: A → Z</option>
              <option value="code">Mã ECMA: A → Z</option>
            </select>
          </div>

          {/* Section Header */}
          <div className="flex items-baseline justify-between border-b border-slate-200 pb-2.5 mb-4">
            <h3 className="text-base font-bold text-slate-800">
              {DIELINE_CATEGORIES.find((c) => c.id === selectedCategory)?.name}
            </h3>
            <span className="text-xs text-slate-400 font-medium">{filtered.length} mẫu</span>
          </div>

          {/* 3-Column Card Grid */}
          {filtered.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">
              Không tìm thấy mẫu khuôn nào khớp với "{search}".
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map((tpl) => (
                <div
                  key={tpl.id}
                  onClick={() => onSelectTemplate(tpl.id)}
                  className="group bg-white rounded-2xl border border-slate-200 hover:border-[#146C53] hover:shadow-md transition-all p-3.5 flex flex-col justify-between cursor-pointer"
                >
                  <div>
                    <DielineMiniThumbnail templateId={tpl.id} />
                    <div className="mt-3 px-1">
                      <h4 className="text-sm font-bold text-slate-800 group-hover:text-[#146C53] transition-colors leading-snug">
                        {tpl.name} ({tpl.code})
                      </h4>
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{tpl.description}</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between px-1">
                    <span className="text-[11px] font-mono text-slate-400">
                      {tpl.defaults.L}×{tpl.defaults.W}×{tpl.defaults.H}mm
                    </span>
                    <span className="text-xs font-bold text-[#146C53] group-hover:translate-x-0.5 transition-transform">
                      Tùy chỉnh mẫu →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
