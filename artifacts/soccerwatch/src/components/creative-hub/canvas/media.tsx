import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImageIcon } from "lucide-react";
import type { SceneLayer } from "@workspace/api-zod";
import { sourceTimeAt, videoParts } from "./layout";
import { roundRectPath } from "./shapes";

type ImageLayer = Extract<SceneLayer, { kind: "image" }>;
type VideoLayer = Extract<SceneLayer, { kind: "video" }>;

/** A neutral slot: nothing to show yet (no URL, still loading elsewhere, or it failed). */
export function MediaPlaceholder({ layer }: { layer: ImageLayer | VideoLayer }) {
  const icon = Math.max(16, Math.min(layer.w, layer.h) * 0.28);
  const Icon = layer.kind === "video" ? Film : ImageIcon;
  return (
    <div className="absolute inset-0 grid place-items-center" data-testid="scene-canvas-placeholder"
      style={{
        background: "repeating-linear-gradient(135deg, rgba(138,147,166,0.16) 0 18px, rgba(138,147,166,0.08) 18px 36px)",
        borderRadius: layer.kind === "image" ? layer.radius ?? 0 : 0,
      }}>
      <Icon aria-hidden style={{ width: icon, height: icon, color: "rgba(242,244,248,0.45)" }} />
    </div>
  );
}

const clipFor = (layer: ImageLayer | VideoLayer) =>
  layer.kind === "image" && layer.radius ? `path('${roundRectPath(0, 0, layer.w, layer.h, layer.radius)}')` : undefined;

/** `quiet`: draw nothing instead of the placeholder (a background plate whose file is missing, as the export skips it). */
export function ImageView({ layer, url, quiet = false }: { layer: ImageLayer | VideoLayer; url: string | null; quiet?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return quiet ? null : <MediaPlaceholder layer={layer} />;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ clipPath: clipFor(layer) }}>
      <img src={url} alt="" draggable={false} onError={() => setFailed(url)}
        className="pointer-events-none h-full w-full select-none"
        style={{ objectFit: layer.fit ?? "cover", objectPosition: "center" }} />
    </div>
  );
}

const clampRate = (r: number) => Math.max(0.0625, Math.min(16, r));

/**
 * A footage layer as a <video>, kept on the scene clock: at scene time t it
 * shows source time trimIn + (t − start) × speed, slowed inside the slow-motion
 * window, holding the last frame past the trim. Playing, it runs at the part's
 * speed and is pulled back when it drifts; paused, it seeks.
 */
export function VideoView({ layer, url, timeMs, playing }: { layer: VideoLayer; url: string | null; timeMs: number; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sourceMs, setSourceMs] = useState<number | null>(null);
  const windowMs = (layer.endMs ?? Number.POSITIVE_INFINITY) - (layer.startMs ?? 0);
  const parts = useMemo(
    () => videoParts(layer, sourceMs, Number.isFinite(windowMs) ? windowMs : 60_000),
    [layer, sourceMs, windowMs],
  );

  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    const at = sourceTimeAt(parts, timeMs - (layer.startMs ?? 0));
    const expected = at.srcMs / 1000;
    const active = playing && !at.ended && timeMs >= (layer.startMs ?? 0);
    if (active) {
      v.playbackRate = clampRate(at.speed);
      if (Math.abs(v.currentTime - expected) > 0.35) v.currentTime = expected;
      if (v.paused) {
        void v.play().catch(() => {
          // Autoplay with sound refused: play it muted rather than not at all.
          v.muted = true;
          void v.play().catch(() => {});
        });
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - expected) > 0.04 && v.readyState >= 1) v.currentTime = expected;
    }
  }, [timeMs, playing, parts, url, layer.startMs]);

  if (!url || failed === url) return <MediaPlaceholder layer={layer} />;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <video ref={ref} src={url} muted={layer.muted || !playing} playsInline preload="auto" disablePictureInPicture
        onError={() => setFailed(url)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setSourceMs(Number.isFinite(d) && d > 0 ? d * 1000 : null);
          const at = sourceTimeAt(parts, timeMs - (layer.startMs ?? 0));
          e.currentTarget.currentTime = at.srcMs / 1000;
        }}
        className="pointer-events-none h-full w-full select-none"
        style={{ objectFit: layer.fit ?? "cover", objectPosition: "center" }} />
    </div>
  );
}
