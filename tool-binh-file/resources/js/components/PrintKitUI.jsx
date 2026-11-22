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
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

/**
 * Sticky Millimeter Rulers (Top + Left) for Prepress Canvas Pasteboard
 */
export function PrepressRulerBar({ orientation = 'horizontal', lengthMm = 330, pxPerMm = 2, cursorMm = null }) {
  const safePxPerMm = Math.max(0.2, pxPerMm || 2);
  // Choose smart major tick interval based on zoom density so labels never collide
  const majorStep =
    safePxPerMm >= 6 ? 10 : safePxPerMm >= 2.5 ? 20 : safePxPerMm >= 1.1 ? 50 : 100;
  const minorStep = majorStep / 5;
  const totalPx = Math.max(200, Math.round(lengthMm * safePxPerMm));

  const ticks = [];
  for (let mm = 0; mm <= lengthMm + 0.01; mm += minorStep) {
    const pos = Math.round(mm * safePxPerMm);
    const isMajor = Math.abs(mm % majorStep) < 0.01;
    ticks.push({ mm: Math.round(mm), pos, isMajor });
  }

  if (orientation === 'horizontal') {
    return (
      <div
        className="relative h-5 bg-[#F8FAFC] border-b border-[#CBD5E1] select-none shrink-0 overflow-hidden"
        style={{ width: `${totalPx}px` }}
      >
        {ticks.map((t) => (
          <div
            key={t.mm}
            className="absolute bottom-0 border-l border-[#94A3B8]"
            style={{ left: `${t.pos}px`, height: t.isMajor ? '11px' : '5px' }}
          >
            {t.isMajor && (
              <span className="absolute -top-2 left-1 text-[9px] font-mono text-[#475569] leading-none">
                {t.mm}
              </span>
            )}
          </div>
        ))}
        {cursorMm !== null && cursorMm >= 0 && cursorMm <= lengthMm && (
          <div
            className="absolute top-0 bottom-0 w-[1.5px] bg-[#087F5B] pointer-events-none"
            style={{ left: `${Math.round(cursorMm * safePxPerMm)}px` }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="relative w-5 bg-[#F8FAFC] border-r border-[#CBD5E1] select-none shrink-0 overflow-hidden"
      style={{ height: `${totalPx}px` }}
    >
      {ticks.map((t) => (
        <div
          key={t.mm}
          className="absolute right-0 border-t border-[#94A3B8]"
          style={{ top: `${t.pos}px`, width: t.isMajor ? '11px' : '5px' }}
        >
          {t.isMajor && t.mm > 0 && (
            <span
              className="absolute right-2.5 top-0.5 text-[9px] font-mono text-[#475569] leading-none origin-top-right -rotate-90 whitespace-nowrap"
            >
              {t.mm}
            </span>
          )}
        </div>
      ))}
      {cursorMm !== null && cursorMm >= 0 && cursorMm <= lengthMm && (
        <div
          className="absolute left-0 right-0 h-[1.5px] bg-[#087F5B] pointer-events-none"
          style={{ top: `${Math.round(cursorMm * safePxPerMm)}px` }}
        />
      )}
    </div>
  );
}
