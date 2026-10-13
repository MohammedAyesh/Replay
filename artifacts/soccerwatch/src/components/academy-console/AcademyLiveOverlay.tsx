import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { X } from "lucide-react";

type LiveStatus = {
  status: "upcoming" | "live" | "not_live" | "ended" | "no_booking";
  playlistPath: string | null;
  message: string;
  panAvailable: false;
};

export function AcademyLiveOverlay({
  statusUrl,
  title,
  onClose,
}: {
  statusUrl: string;
  title: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch(statusUrl, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to watch this session." : "This live session is unavailable.");
        const result = await response.json() as LiveStatus;
        if (active) {
          setStatus(result);
          setError(null);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Live status unavailable.");
      } finally {
        if (active) timer = setTimeout(check, 8_000);
      }
    };
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [statusUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const src = status?.status === "live" ? status.playlistPath : null;
    if (!video || !src) return;
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 20 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => undefined); });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      void video.play().catch(() => undefined);
    } else {
      setError("This browser cannot play HLS video.");
    }
    return () => {
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [status?.playlistPath, status?.status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-3 sm:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <section className="relative w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-[#101519] text-white shadow-2xl">
        <header className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold sm:text-base">{title}</h2>
            <p className="mt-0.5 text-xs text-white/65" aria-live="polite">{error ?? status?.message ?? "Checking live session…"}</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/10" aria-label="Close live player">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="relative aspect-video bg-black">
          {status?.status === "live" && status.playlistPath
            ? <video ref={videoRef} className="h-full w-full" controls autoPlay playsInline />
            : <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">{error ?? status?.message ?? "Checking live session…"}</div>}
        </div>
      </section>
    </div>
  );
}
