import { useEffect, useRef, useState, type ReactNode } from "react";
import { Film, ImageOff } from "lucide-react";
import type { MediaSource } from "@workspace/api-zod";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { browserUrl, type RecordingWindow } from "@/lib/creative-hub-library-api";
import { cn } from "@/lib/utils";

/** The best still for a library item: the media route first, the list's own thumbnail as a fallback. */
export function stillUrls(academyId: number, src: MediaSource | null, fallback: string | null): string[] {
  const out: string[] = [];
  const main = src ? browserUrl(creativeMediaUrl(academyId, src, "still")) : null;
  if (main) out.push(main);
  const fb = browserUrl(fallback);
  if (fb && fb !== main) out.push(fb);
  return out;
}

export function videoUrlFor(academyId: number, src: MediaSource, fallback: string | null = null): string | null {
  return browserUrl(creativeMediaUrl(academyId, src, "video")) ?? browserUrl(fallback);
}

export const secondsLabel = (ms: number | null | undefined) => (ms ? Math.max(1, Math.round(ms / 1000)) : null);

export function formatLength(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `0:${String(s).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** A thumbnail tile; tries each URL in turn, then shows a placeholder. */
export function Thumb({ urls, video, length, className, children }: {
  urls: string[];
  video?: boolean;
  length?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const [at, setAt] = useState(0);
  const key = urls.join("|");
  useEffect(() => setAt(0), [key]);
  const url = urls[at];
  return (
    <span className={cn("relative block overflow-hidden rounded-xl bg-raised", className)}>
      {url
        ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setAt((i) => i + 1)} />
        : <span className="grid h-full w-full place-items-center text-muted-text"><ImageOff className="h-5 w-5" aria-hidden /></span>}
      {(video || length) && (
        <span className="absolute bottom-1.5 start-1.5 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white" dir="ltr">
          {video && <Film className="h-3 w-3" aria-hidden />}
          {length}
        </span>
      )}
      {children}
    </span>
  );
}

/**
 * Plays a library item. A recording window plays only its stretch: if the
 * URL serves the whole recording, the player seeks to the window and loops it.
 */
export function PreviewVideo({ url, window, poster, className }: { url: string; window?: RecordingWindow | null; poster?: string | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let destroy: (() => void) | null = null;
    let cancelled = false;
    const isHls = /\.m3u8(\?|$)/i.test(url) || url.includes("m3u8");
    if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        const hls = new Hls({ startPosition: window ? window.fromMs / 1000 : -1 });
        hls.loadSource(url);
        hls.attachMedia(video);
        destroy = () => hls.destroy();
      });
    } else {
      video.src = url;
    }
    const length = window ? (window.toMs - window.fromMs) / 1000 : 0;
    // Only seek when the file is the whole recording, not a cut of the window.
    const whole = () => window && Number.isFinite(video.duration) && video.duration > length + 1.5;
    const onMeta = () => { if (whole()) video.currentTime = window!.fromMs / 1000; };
    const onTime = () => {
      if (whole() && video.currentTime >= window!.toMs / 1000) video.currentTime = window!.fromMs / 1000;
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("timeupdate", onTime);
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("timeupdate", onTime);
      destroy?.();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, window?.fromMs, window?.toMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <video ref={ref} controls playsInline autoPlay muted poster={poster ?? undefined}
      className={cn("w-full rounded-xl bg-black", className)} data-testid="library-preview-video" />
  );
}
