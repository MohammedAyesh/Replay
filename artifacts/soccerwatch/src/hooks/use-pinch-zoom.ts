import { useEffect, useRef, useState } from "react";

export function usePinchZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [isZoomed, setIsZoomed] = useState(false);

  const s = useRef({
    scale: 1,
    panX: 0,
    panY: 0,
    lastDist: null as number | null,
    lastMidX: 0,
    lastMidY: 0,
    isPinching: false,
    lastTap: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const st = s.current;

    function getTouchDist(touches: TouchList) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function clampPan() {
      const maxX = (el.clientWidth * (st.scale - 1)) / 2;
      const maxY = (el.clientHeight * (st.scale - 1)) / 2;
      st.panX = Math.max(-maxX, Math.min(maxX, st.panX));
      st.panY = Math.max(-maxY, Math.min(maxY, st.panY));
    }

    function applyTransform() {
      clampPan();
      el.style.transform = `scale(${st.scale}) translate(${st.panX / st.scale}px, ${st.panY / st.scale}px)`;
    }

    function resetZoom() {
      el.style.transition = "transform 0.22s ease";
      st.scale = 1;
      st.panX = 0;
      st.panY = 0;
      el.style.transform = "";
      setIsZoomed(false);
      setTimeout(() => { el.style.transition = ""; }, 230);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        st.isPinching = true;
        st.lastDist = getTouchDist(e.touches);
        st.lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        st.lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        st.lastMidX = e.touches[0].clientX;
        st.lastMidY = e.touches[0].clientY;
        if (st.scale > 1.05) {
          e.preventDefault();
        }
        const now = Date.now();
        if (now - st.lastTap < 280 && st.scale > 1) {
          resetZoom();
        }
        st.lastTap = now;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && st.isPinching) {
        e.preventDefault();
        const newDist = getTouchDist(e.touches);
        const newMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const newMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        if (st.lastDist) {
          st.scale = Math.min(5, Math.max(1, st.scale * (newDist / st.lastDist)));
        }
        st.panX += newMidX - st.lastMidX;
        st.panY += newMidY - st.lastMidY;
        st.lastDist = newDist;
        st.lastMidX = newMidX;
        st.lastMidY = newMidY;

        applyTransform();
        if (st.scale > 1.05) setIsZoomed(true);
      } else if (e.touches.length === 1 && st.scale > 1.05) {
        e.preventDefault();
        st.panX += e.touches[0].clientX - st.lastMidX;
        st.panY += e.touches[0].clientY - st.lastMidY;
        st.lastMidX = e.touches[0].clientX;
        st.lastMidY = e.touches[0].clientY;
        applyTransform();
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        st.lastDist = null;
        st.isPinching = false;
      }
      if (e.touches.length === 0 && st.scale < 1.15) {
        resetZoom();
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [containerRef]);

  return { isZoomed };
}
