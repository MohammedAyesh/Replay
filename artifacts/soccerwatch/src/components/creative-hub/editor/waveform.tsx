import { useMemo, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { dragMusicStart, grabInWindow, waveformBars, windowOnTrack } from "@/lib/creative-music";
import { cn } from "@/lib/utils";

/**
 * A track's waveform. With `onStartChange` it is the start-point picker: the
 * highlighted window is the part the video plays; drag it (or tap anywhere) to
 * move it, arrow keys nudge it by half a second. Time runs left to right in
 * both languages, as on the timeline.
 */
export function Waveform({
  peaks, trackMs, sceneMs, startMs = 0, onStartChange, progressMs, bars = 72, height = 48, label, className, testId,
}: {
  peaks: number[];
  trackMs: number;
  /** The scene's length: draws the window when given. */
  sceneMs?: number;
  startMs?: number;
  onStartChange?: (startMs: number) => void;
  /** A play position to mark (ms into the track). */
  progressMs?: number | null;
  bars?: number;
  height?: number;
  label?: string;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<number | null>(null);
  const shown = useMemo(() => waveformBars(peaks, bars), [peaks, bars]);
  const win = sceneMs ? windowOnTrack(startMs, trackMs, sceneMs) : null;
  const interactive = !!onStartChange && !!sceneMs && trackMs > 0;

  const frac = (e: ReactPointerEvent<HTMLElement>) => {
    const box = ref.current?.getBoundingClientRect();
    return box && box.width ? (e.clientX - box.left) / box.width : 0;
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = frac(e);
    grab.current = grabInWindow(f, startMs, trackMs, sceneMs!) ?? 0;
    onStartChange!(dragMusicStart(f, grab.current, trackMs, sceneMs!));
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || grab.current === null) return;
    onStartChange!(dragMusicStart(frac(e), grab.current, trackMs, sceneMs!));
  };
  const up = () => { grab.current = null; };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const step = e.shiftKey ? 5000 : 500;
    const by = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : e.key === "Home" ? -Infinity : null;
    if (by === null) return;
    e.preventDefault();
    onStartChange!(dragMusicStart(Number.isFinite(by) ? (startMs + by) / trackMs : 0, 0, trackMs, sceneMs!));
  };

  return (
    <div dir="ltr" className={cn("relative select-none", className)} data-testid={testId}>
      <div
        ref={ref}
        role={interactive ? "slider" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={label}
        aria-valuemin={interactive ? 0 : undefined}
        aria-valuemax={interactive ? Math.round(trackMs / 1000) : undefined}
        aria-valuenow={interactive ? Math.round(startMs / 1000) : undefined}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
        className={cn("relative flex items-center gap-px overflow-hidden rounded-lg bg-raised/70 px-1", interactive && "cursor-grab touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-turf")}
        style={{ height }}
      >
        {shown.map((v, i) => {
          const at = (i + 0.5) / shown.length;
          const inside = !win || (at >= win.left && at <= win.left + win.width);
          return (
            <span key={i} aria-hidden
              className={cn("flex-1 rounded-full", inside ? "bg-turf" : "bg-muted-text/40")}
              style={{ height: `${Math.round(v * 100)}%`, minWidth: 1 }} />
          );
        })}
        {win ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 rounded-md border-2 border-turf bg-turf/10"
            style={{ left: `${win.left * 100}%`, width: `${Math.max(win.width * 100, 1.5)}%` }} />
        ) : null}
        {progressMs !== null && progressMs !== undefined && trackMs > 0 ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-floodlight"
            style={{ left: `${Math.min(100, (progressMs / trackMs) * 100)}%` }} />
        ) : null}
      </div>
    </div>
  );
}
