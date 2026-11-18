import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2, RefreshCw, Video } from "lucide-react";
import { useKitCopy } from "@/i18n/kit-strings";
import { kitPreviewState, kitPreviewUrl, startKitPreview, type KitPreview } from "@/lib/kits-api";

/**
 * Portable cameras (Labs): the camera's low-quality live picture (1536×432), from anywhere.
 * vps1 connects straight to the camera when it can, or through Reolink's own cloud when
 * the kit is on a phone hotspot. Starting takes 10–40 s; the player's playlist refreshes
 * keep it running and vps1 stops it a minute after this closes.
 */
export function KitLivePreview({ kitId, className }: { kitId: number; className?: string }) {
  const c = useKitCopy();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState<KitPreview>({ state: "starting", via: null, message: null });
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);

  // 1. Ask vps1 to start it, then wait for "ready".
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setInfo({ state: "starting", via: null, message: null });
    setPlaying(false);
    const started = Date.now();
    const poll = (p: Promise<KitPreview>) => p.then((s) => {
      if (!alive) return;
      setInfo(s);
      if (s.state === "starting" || (s.state === "stopped" && Date.now() - started < 5_000)) {
        if (Date.now() - started > 120_000) { setInfo({ ...s, state: "failed" }); return; }
        timer = setTimeout(() => poll(kitPreviewState(kitId)), 2_000);
      }
    }).catch(() => alive && setInfo({ state: "failed", via: null, message: null }));
    poll(startKitPreview(kitId));
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [kitId, attempt]);

  // 2. Play it.
  useEffect(() => {
    const video = videoRef.current;
    if (info.state !== "ready" || !video) return;
    const url = kitPreviewUrl(kitId);
    let hls: Hls | null = null;
    const onPlaying = () => setPlaying(true);
    video.addEventListener("playing", onPlaying);
    if (Hls.isSupported()) {
      hls = new Hls({
        liveSyncDurationCount: 2,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls?.recoverMediaError(); return; }
        setInfo((s) => ({ ...s, state: "failed" }));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    }
    void video.play().catch(() => undefined);
    return () => {
      video.removeEventListener("playing", onPlaying);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [info.state, kitId]);

  const p = c.preview;
  const waiting = info.state === "starting" || (info.state === "ready" && !playing);
  const failed = info.state === "failed" || info.state === "stopped";
  return (
    <div className={className}>
      <div className="relative overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: "1536 / 432" }}>
        <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-cover" />
        {waiting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-raised/80 px-4 text-center text-xs text-muted-text">
            <Loader2 className="h-5 w-5 animate-spin" />
            {info.via === "cloud" ? p.connectingCloud : p.connecting}
          </div>
        )}
        {(failed || info.state === "unsupported") && (
          <div className="absolute inset-0 flex items-center justify-center bg-raised px-4 text-center text-xs text-muted-text">
            <Video className="me-2 h-4 w-4 shrink-0" />{info.state === "unsupported" ? p.unsupported : p.failed}
          </div>
        )}
        {info.state === "ready" && playing && (
          <span className="absolute end-2 top-1.5 rounded-full bg-[#FF5A3C] px-2 py-0.5 text-[10px] font-bold text-white">LIVE</span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-text">
        <span>{info.via === "cloud" ? p.viaCloud : p.lowQuality}</span>
        {failed && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="inline-flex items-center gap-1 font-semibold text-text">
            <RefreshCw className="h-3.5 w-3.5" />{p.retry}
          </button>
        )}
      </div>
    </div>
  );
}
