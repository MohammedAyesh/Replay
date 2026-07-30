import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Radio, RotateCcw } from "lucide-react";

const LIVE_PLAYBACK_BASE = "/api/live";

/** Non-recoverable: the only error that should survive a successful fragment. */
const FATAL_ERROR = "This camera is currently unavailable.";

const CAMERAS = [
  { id: "camera1", label: "Camera 1" },
  { id: "camera2", label: "Camera 2" },
];

function HlsPlayer({ url, label }: { url: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState({ start: 0, end: 0, position: 0 });

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    setReady(false);
    setError(null);
    setTimeline({ start: 0, end: 0, position: 0 });

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        // Keep a little further behind the live edge so short network
        // hiccups do not immediately stall playback.
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        // Was 1800. Both cameras autoplay on this page, so half a match at
        // ~2 Mbps each held roughly 450 MB per SourceBuffer — enough for mobile
        // to reclaim the tab or for hls.js to start thrashing on
        // QuotaExceededError. A live viewer never scrubs back that far anyway.
        backBufferLength: 90,
      });
      hls.loadSource(url);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        el.play().catch(() => {});
      });
      // Recoverable errors set a banner that nothing ever cleared, so a single
      // WiFi hiccup left "Reconnecting…" pinned over a healthy stream for the
      // rest of the session. Clear it as soon as playback actually resumes.
      const clearTransientError = () => setError((e) => (e === FATAL_ERROR ? e : null));
      hls.on(Hls.Events.FRAG_BUFFERED, clearTransientError);
      el.addEventListener("playing", clearTransientError);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setError("Live connection interrupted. Reconnecting…");
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          setError("Recovering video…");
          hls.recoverMediaError();
        } else {
          setError(FATAL_ERROR);
          hls.destroy();
        }
      });
      return () => {
        el.removeEventListener("playing", clearTransientError);
        hls.destroy();
      };
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
      const onMetadata = () => {
        setReady(true);
        el.play().catch(() => {});
      };
      const onError = () => setError("This camera is currently unavailable.");
      el.addEventListener("loadedmetadata", onMetadata);
      el.addEventListener("error", onError);
      return () => {
        el.removeEventListener("loadedmetadata", onMetadata);
        el.removeEventListener("error", onError);
        el.removeAttribute("src");
        el.load();
      };
    }
    return undefined;
  }, [url]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const updateTimeline = () => {
      if (!el.seekable.length) return;
      const start = el.seekable.start(0);
      const end = el.seekable.end(el.seekable.length - 1);
      setTimeline({ start, end, position: el.currentTime });
    };
    updateTimeline();
    const timer = window.setInterval(updateTimeline, 1000);
    el.addEventListener("timeupdate", updateTimeline);
    return () => {
      window.clearInterval(timer);
      el.removeEventListener("timeupdate", updateTimeline);
    };
  }, [url, ready]);

  const hasDvrWindow = timeline.end - timeline.start > 3;
  const isLive = hasDvrWindow && timeline.end - timeline.position < 8;
  const goLive = () => {
    const el = videoRef.current;
    if (!el || !el.seekable.length) return;
    el.currentTime = el.seekable.end(el.seekable.length - 1) - 1;
    el.play().catch(() => {});
  };

  return (
    <div className="relative rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800">
      <div className="absolute top-3 start-3 z-10 flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur-sm text-xs font-semibold text-white">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          {label}
        </span>
        {ready && (
          <span className="px-2 py-1 rounded-full bg-black/70 text-[10px] font-semibold text-white">
            {isLive ? "LIVE" : "REPLAY"}
          </span>
        )}
      </div>

      <video
        ref={videoRef}
        className="w-full aspect-video bg-black"
        playsInline
        muted
        controls
      />

      {hasDvrWindow && (
        <div className="bg-zinc-950 px-3 py-2 space-y-1.5">
          <input
            aria-label={`${label} timeline`}
            type="range"
            min={timeline.start}
            max={timeline.end}
            step="0.1"
            value={Math.min(Math.max(timeline.position, timeline.start), timeline.end)}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (videoRef.current) videoRef.current.currentTime = next;
              setTimeline((current) => ({ ...current, position: next }));
            }}
            className="w-full accent-red-500"
          />
          <div className="flex items-center justify-between text-[10px] text-zinc-400">
            <span>{isLive ? "Live edge" : "Rewound in available window"}</span>
            {!isLive && (
              <button
                type="button"
                onClick={goLive}
                className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 font-semibold"
              >
                <RotateCcw className="w-3 h-3" />
                Go live
              </button>
            )}
          </div>
        </div>
      )}

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
          <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-12 flex justify-center px-3">
          <span className="rounded-lg bg-black/80 px-3 py-2 text-xs text-white">
            {error}
          </span>
        </div>
      )}
    </div>
  );
}

export default function Live() {
  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-5 h-5 text-red-500" />
          <h1 className="text-white text-xl font-bold">Live</h1>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-4">
        {CAMERAS.map((cam) => (
          <HlsPlayer
            key={cam.id}
            url={`${LIVE_PLAYBACK_BASE}/${cam.id}/index.m3u8`}
            label={cam.label}
          />
        ))}
      </div>
    </div>
  );
}
