import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { loadOSSVideos, OSSVideoEntry } from "@/lib/fc";
import { ChevronLeft, Volume2, VolumeX } from "lucide-react";

export default function OSSPlayer() {
  const [, navigate] = useLocation();
  const state = loadOSSVideos();

  useEffect(() => {
    if (!state) navigate("/fields");
  }, []);

  if (!state || state.videos.length === 0) return null;

  return (
    <Slideshow
      videos={state.videos}
      startIndex={state.startIndex}
      camera={state.camera}
      onBack={() => navigate("~")}
    />
  );
}

function Slideshow({
  videos,
  startIndex,
  camera,
  onBack,
}: {
  videos: OSSVideoEntry[];
  startIndex: number;
  camera: string;
  onBack: () => void;
}) {
  const [current, setCurrent] = useState(startIndex);
  const [isMuted, setIsMuted] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);

  // Sync scroll position when `current` changes programmatically
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ left: current * el.clientWidth, behavior: "smooth" });
  }, [current]);

  // Pause all videos except the current one and play the current
  useEffect(() => {
    videoRefs.current.forEach((v, i) => {
      if (!v) return;
      if (i === current) {
        v.muted = isMuted;
        v.play().catch(() => {});
      } else {
        v.pause();
        v.currentTime = 0;
      }
    });
  }, [current, isMuted]);

  // Sync mute on current video when isMuted changes
  useEffect(() => {
    const v = videoRefs.current[current];
    if (v) v.muted = isMuted;
  }, [isMuted, current]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== current) setCurrent(idx);
  }, [current]);

  const v = videos[current];

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden">
      {/* Horizontal scroll-snap strip */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="w-full h-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
        style={{ scrollBehavior: "auto" }}
      >
        {videos.map((entry, i) => (
          <div
            key={entry.filename + i}
            className="w-full h-full shrink-0 snap-center relative"
            style={{ minWidth: "100%" }}
          >
            <video
              ref={(el) => { videoRefs.current[i] = el; }}
              src={entry.url}
              className="w-full h-full object-cover"
              playsInline
              loop
              muted={isMuted}
              autoPlay={i === startIndex}
            />
          </div>
        ))}
      </div>

      {/* Gradient overlays */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/75" />

      {/* Top bar */}
      <div className="absolute top-0 pt-safe px-4 pt-4 w-full flex justify-between items-start z-10">
        <button
          onClick={onBack}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          <ChevronLeft className="w-6 h-6 ml-[-2px]" />
        </button>

        {/* Dot indicators */}
        {videos.length > 1 && (
          <div className="flex items-center gap-1.5 mt-2">
            {videos.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`rounded-full transition-all ${
                  i === current
                    ? "w-5 h-2 bg-white"
                    : "w-2 h-2 bg-white/40"
                }`}
              />
            ))}
          </div>
        )}

        <button
          onClick={() => setIsMuted((m) => !m)}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 pb-safe w-full px-5 pb-8 z-10">
        <span className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase mb-2 inline-block">
          {camera}
        </span>
        <p className="text-white font-bold text-lg drop-shadow-md">
          {v.time ? v.time : v.filename}
        </p>
        <p className="text-white/60 text-sm mt-0.5">
          {v.date} &nbsp;·&nbsp; {current + 1} / {videos.length}
        </p>
      </div>
    </div>
  );
}
