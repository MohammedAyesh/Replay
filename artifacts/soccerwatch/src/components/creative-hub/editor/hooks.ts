import { useEffect, useRef, useState } from "react";
import { canvasHeight } from "@/lib/creative-editor-state";
import type { CreativeFormat } from "@workspace/api-zod";

/** Advance a playhead while playing, looping at the end. */
export function usePlayback(durationMs: number | undefined, playing: boolean, setTimeMs: (fn: (t: number) => number) => void) {
  const setter = useRef(setTimeMs);
  setter.current = setTimeMs;
  useEffect(() => {
    if (!playing || !durationMs) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setter.current((t) => (t + dt) % durationMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);
}

/**
 * Width for a canvas of `format` that fits both the container's width and a
 * share of the viewport's height (more on desktop, less on phones so the
 * tools stay in view).
 */
export function useFitWidth(format: CreativeFormat, { phoneVh = 0.56, desktopVh = 0.78, max = 720 } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 320, vh: typeof window === "undefined" ? 800 : window.innerHeight, wide: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, vh: window.innerHeight, wide: window.matchMedia("(min-width: 1024px)").matches });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const ratio = canvasHeight(format) / 1080;
  const byHeight = (box.vh * (box.wide ? desktopVh : phoneVh)) / ratio;
  const width = Math.max(160, Math.floor(Math.min(box.w, byHeight, max)));
  return { ref, width };
}
