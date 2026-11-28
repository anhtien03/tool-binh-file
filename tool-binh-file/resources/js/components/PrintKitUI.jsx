import React from 'react';

/**
 * Crisp 16-18px Desktop Vector Icons for PrintKit Professional 2.0
 */
export function PkIcon({ name, className = 'w-4 h-4' }) {
  const props = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.85,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
  };

  switch (name) {
    case 'folder':
      return (
        <svg {...props}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      );
    case 'file':
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
    case 'download':
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...props}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'sticker':
      return (
        <svg {...props}>
          <path d="M12 3a9 9 0 1 0 9 9c0-.5-.4-1-1-1h-3a4 4 0 0 1-4-4V4c0-.6-.5-1-1-1z" />
          <path d="M13 3.1A9 9 0 0 1 20.9 11" />
        </svg>
      );
    case 'book':
      return (
        <svg {...props}>
          <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H12v17H4.5A2.5 2.5 0 0 0 2 22V5.5z" />
          <path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H12v17h7.5a2.5 2.5 0 0 1 2.5 2V5.5z" />
        </svg>
      );
    case 'blade':
      return (
        <svg {...props}>
          <path d="M14.5 3.5l6 6-9.5 9.5H5v-6l9.5-9.5z" />
          <line x1="11.5" y1="6.5" x2="17.5" y2="12.5" />
        </svg>
      );
    case 'resize':
      return (
        <svg {...props}>
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      );
    case 'shuffle':
      return (
        <svg {...props}>
          <polyline points="16 3 21 3 21 8" />
          <line x1="4" y1="20" x2="21" y2="3" />
          <polyline points="21 16 21 21 16 21" />
          <line x1="15" y1="15" x2="21" y2="21" />
          <line x1="4" y1="4" x2="9" y2="9" />
        </svg>
      );
    case 'crop':
      return (
        <svg {...props}>
          <path d="M6 2v14a2 2 0 0 0 2 2h14" />
          <path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
      );
    case 'shift':
      return (
        <svg {...props}>
          <polyline points="5 9 2 12 5 15" />
          <polyline points="9 5 12 2 15 5" />
          <polyline points="15 19 12 22 9 19" />
          <polyline points="19 9 22 12 19 15" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <line x1="12" y1="2" x2="12" y2="22" />
        </svg>
      );
    case 'box':
      return (
        <svg {...props}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...props}>
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      );
    case 'ruler':
      return (
        <svg {...props}>
          <path d="M3 7h18v10H3z" />
          <line x1="7" y1="7" x2="7" y2="11" />
          <line x1="11" y1="7" x2="11" y2="13" />
          <line x1="15" y1="7" x2="15" y2="11" />
          <line x1="19" y1="7" x2="19" y2="11" />
        </svg>
      );
    case 'cube':
      return (
        <svg {...props}>
          <path d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z" />
          <path d="M12 22V12" />
          <path d="M20.5 7L12 12 3.5 7" />
        </svg>
      );
    case 'panelLeft':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      );
    case 'sliders':
      return (
        <svg {...props}>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="9" cy="6" r="2" fill="currentColor" />
          <circle cx="15" cy="12" r="2" fill="currentColor" />
          <circle cx="11" cy="18" r="2" fill="currentColor" />
        </svg>
      );
    case 'search':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
        </svg>
      );
    case 'zoomIn':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
          <line x1="11" y1="8" x2="11" y2="14" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      );
    case 'zoomOut':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      );
    case 'maximize':
      return (
        <svg {...props}>
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <polyline points="21 15 21 21 15 21" />
          <polyline points="3 9 3 3 9 3" />
        </svg>
      );
    case 'close':
      return (
        <svg {...props}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'hash':
      return (
        <svg {...props}>
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="4" y1="15" x2="20" y2="15" />
          <line x1="10" y1="3" x2="8" y2="21" />
          <line x1="16" y1="3" x2="14" y2="21" />
        </svg>
      );
    case 'database':
      return (
        <svg {...props}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case 'preflight':
      return (
        <svg {...props}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case 'calculator':
      return (
        <svg {...props}>
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <line x1="8" y1="6" x2="16" y2="6" />
          <line x1="8" y1="10" x2="8" y2="10.01" />
          <line x1="12" y1="10" x2="12" y2="10.01" />
          <line x1="16" y1="10" x2="16" y2="10.01" />
          <line x1="8" y1="14" x2="8" y2="14.01" />
          <line x1="12" y1="14" x2="12" y2="14.01" />
          <line x1="16" y1="14" x2="16" y2="14.01" />
          <line x1="8" y1="18" x2="16" y2="18" />
        </svg>
      );
    case 'chevronsRight':
      return (
        <svg {...props}>
          <polyline points="13 17 18 12 13 7" />
          <polyline points="6 17 11 12 6 7" />
        </svg>
      );
    case 'chevronsLeft':
      return (
        <svg {...props}>
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </svg>
      );
    case 'chevronDown':
      return (
        <svg {...props}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );
    case 'chevronUp':
      return (
        <svg {...props}>
          <polyline points="18 15 12 9 6 15" />
        </svg>
      );
    case 'focus':
      return (
        <svg {...props}>
          <path d="M4 9V5a1 1 0 0 1 1-1h4" />
          <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
          <path d="M4 15v4a1 1 0 0 0 1 1h4" />
          <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case 'save':
      return (
        <svg {...props}>
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...props}>
          <polyline points="9 14 4 9 9 4" />
          <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
        </svg>
      );
    case 'scissors':
      return (
        <svg {...props}>
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
      );
    case 'upload':
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

/**
 * Pinned Viewport Millimeter Rulers (Top + Left) like PryntX / Photoshop.
 * Spans the full pasteboard edge with negative & positive mm ticks anchored to `originPx` (0 mm = sheet top-left).
 */
export function PrepressRulerBar({
  orientation = 'horizontal',
  viewportPx = 800,
  originPx = 40,
  pxPerMm = 2,
  cursorMm = null,
}) {
  const safePxPerMm = Math.max(0.2, pxPerMm || 2);
  const safeVp = Math.max(100, viewportPx || 800);
  const majorStep =
    safePxPerMm >= 6 ? 10 : safePxPerMm >= 2.5 ? 20 : safePxPerMm >= 1.1 ? 50 : 100;
  const minorStep = majorStep / 5;

  const minMm = Math.floor((-originPx / safePxPerMm) / minorStep) * minorStep;
  const maxMm = Math.ceil(((safeVp - originPx) / safePxPerMm) / minorStep) * minorStep;

  const ticks = [];
  for (let mm = minMm; mm <= maxMm + 0.01 && ticks.length < 400; mm += minorStep) {
    const pos = Math.round(originPx + mm * safePxPerMm);
    if (pos < -20 || pos > safeVp + 20) continue;
    const roundedMm = Math.round(mm);
    const isMajor = Math.abs(roundedMm % majorStep) === 0;
    ticks.push({ mm: roundedMm, pos, isMajor });
  }

  if (orientation === 'horizontal') {
    return (
      <div className="relative h-5 flex-1 bg-[#F8FAFC] border-b border-[#CBD5E1] select-none overflow-hidden">
        {ticks.map((t) => (
          <div
            key={t.mm}
            className={`absolute bottom-0 border-l ${t.mm === 0 ? 'border-[#087F5B]' : 'border-[#94A3B8]'}`}
            style={{ left: `${t.pos}px`, height: t.isMajor ? '12px' : '5px' }}
          >
            {t.isMajor && (
              <span
                className={`absolute -top-2 left-1 text-[9px] font-mono leading-none ${t.mm === 0 ? 'text-[#087F5B] font-bold' : 'text-[#475569]'
                  }`}
              >
                {t.mm}
              </span>
            )}
          </div>
        ))}
        {cursorMm !== null && (
          <div
            className="absolute top-0 bottom-0 w-[1.5px] bg-[#087F5B] pointer-events-none"
            style={{ left: `${Math.round(originPx + cursorMm * safePxPerMm)}px` }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative w-5 flex-1 bg-[#F8FAFC] border-r border-[#CBD5E1] select-none overflow-hidden">
      {ticks.map((t) => (
        <div
          key={t.mm}
          className={`absolute right-0 border-t ${t.mm === 0 ? 'border-[#087F5B]' : 'border-[#94A3B8]'}`}
          style={{ top: `${t.pos}px`, width: t.isMajor ? '12px' : '5px' }}
        >
          {t.isMajor && (
            <span
              className={`absolute right-2.5 top-0.5 text-[9px] font-mono leading-none origin-top-right -rotate-90 whitespace-nowrap ${t.mm === 0 ? 'text-[#087F5B] font-bold' : 'text-[#475569]'
                }`}
            >
              {t.mm}
            </span>
          )}
        </div>
      ))}
      {cursorMm !== null && (
        <div
          className="absolute left-0 right-0 h-[1.5px] bg-[#087F5B] pointer-events-none"
          style={{ top: `${Math.round(originPx + cursorMm * safePxPerMm)}px` }}
        />
      )}
    </div>
  );
}
