import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Enables smooth left-click drag-to-pan on any scrollable (`overflow-auto`) viewport.
 * Uses window-level mousemove/mouseup listeners while dragging so panning never stalls
 * when the pointer leaves the container bounds.
 */
export function useDragPan(externalRef = null) {
  const internalRef = useRef(null);
  const targetRef = externalRef || internalRef;
  const [isPanning, setIsPanning] = useState(false);
  const panStateRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });

  useEffect(() => {
    const handleMouseMove = (e) => {
      const el = targetRef.current;
      if (!panStateRef.current.active || !el) return;
      const dx = e.clientX - panStateRef.current.startX;
      const dy = e.clientY - panStateRef.current.startY;
      el.scrollLeft = panStateRef.current.scrollLeft - dx;
      el.scrollTop = panStateRef.current.scrollTop - dy;
    };

    const stopPanning = () => {
      if (panStateRef.current.active) {
        panStateRef.current.active = false;
        setIsPanning(false);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopPanning);
    window.addEventListener('blur', stopPanning);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopPanning);
      window.removeEventListener('blur', stopPanning);
    };
  }, [targetRef]);

  const onMouseDown = useCallback(
    (e) => {
      if (e.button !== 0 || !targetRef.current) return;
      if (e.target && e.target.closest('button, input, select, textarea, a, label')) return;
      e.preventDefault();
      panStateRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: targetRef.current.scrollLeft,
        scrollTop: targetRef.current.scrollTop,
      };
      setIsPanning(true);
    },
    [targetRef]
  );

  return {
    ref: targetRef,
    isPanning,
    onMouseDown,
  };
}
