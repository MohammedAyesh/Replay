import { cn } from "@/lib/utils";
import type { Frame } from "@/lib/cropFrame";

export function FrameSizeSlider({
  zoom,
  onChange,
  frame,
  maxZoom,
  compact,
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  frame: Frame;
  maxZoom: number;
  compact?: boolean;
}) {
  const coveredW = Math.max(
    0,
    Math.min(1, (Math.min(1, frame.x + frame.w) - Math.max(0, frame.x)) / frame.w),
  );
  const coveredH = Math.max(
    0,
    Math.min(1, (Math.min(1, frame.y + frame.h) - Math.max(0, frame.y)) / frame.h),
  );
  const blackPct = Math.round((1 - coveredW * coveredH) * 100);
  return (
    <div
      className={cn(
        "pointer-events-auto rounded-2xl bg-black/60 backdrop-blur-sm px-3 py-2",
        compact ? "w-56" : "w-full max-w-sm",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/60">Frame size</span>
        <span className="text-[10px] tabular-nums text-white/70">
          {zoom.toFixed(2)}x{blackPct > 0 ? ` · ${blackPct}% black` : ""}
        </span>
      </div>
      <input
        type="range"
        min={0.4}
        max={maxZoom}
        step={0.02}
        value={zoom}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        className="w-full accent-primary"
        aria-label="Frame size"
      />
    </div>
  );
}