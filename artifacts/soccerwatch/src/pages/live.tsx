import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Radio } from "lucide-react";

const LIVE_PLAYBACK_BASE = "https://replayjo.b-cdn.net";

const CAMERAS = [
  { id: "camera1", label: "Camera 1" },
  { id: "camera2", label: "Camera 2" },
];

function HlsPlayer({ url, label }: { url: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    setReady(false);

    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(url);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        el.play().catch(() => {});
      });
      return () => hls.destroy();
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
      el.addEventListener("loadedmetadata", () => {
        setReady(true);
        el.play().catch(() => {});
      });
    }
  }, [url]);

  return (
    <div className="relative rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800">
      <div className="absolute top-3 start-3 z-10 flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur-sm text-xs font-semibold text-white">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          {label}
        </span>
      </div>

      <video
        ref={videoRef}
        className="w-full aspect-video bg-black"
        playsInline
        muted
        controls
      />

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
          <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
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
