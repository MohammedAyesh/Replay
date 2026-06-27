import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { useLocation } from "wouter";
import { loadOSSVideos, OSSVideoEntry } from "@/lib/fc";
import {
  ChevronLeft,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Scissors,
  Check,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ─── local clip storage ───────────────────────────────────────────────────────
export interface LocalClip {
  id: string;
  camera: string;
  date: string;
  filename: string;
  videoUrl: string;
  startTime: number;
  endTime: number;
  savedAt: string;
}

function saveLocalClip(clip: LocalClip) {
  const raw = localStorage.getItem("local_clips");
  const list: LocalClip[] = raw ? JSON.parse(raw) : [];
  list.unshift(clip);
  localStorage.setItem("local_clips", JSON.stringify(list));
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─── entry point ─────────────────────────────────────────────────────────────
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

// ─── slideshow + player ───────────────────────────────────────────────────────
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
  const { toast } = useToast();

  const [current, setCurrent] = useState(startIndex);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [clipMode, setClipMode] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  const activeVideo = () => videoRefs.current[current];

  // ── controls visibility ──────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  useEffect(() => { resetHideTimer(); }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // ── scroll sync ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ left: current * el.clientWidth, behavior: "smooth" });
  }, [current]);

  // ── play / pause / mute sync ─────────────────────────────────────────────
  useEffect(() => {
    videoRefs.current.forEach((v, i) => {
      if (!v) return;
      if (i === current) {
        v.muted = isMuted;
        if (isPlaying) v.play().catch(() => {});
        else v.pause();
      } else {
        v.pause();
        v.currentTime = 0;
      }
    });
  }, [current, isMuted, isPlaying]);

  // ── time tracking ────────────────────────────────────────────────────────
  useEffect(() => {
    const v = activeVideo();
    if (!v) return;

    const onTime = () => {
      setCurrentTime(v.currentTime);
      // loop within clip if clip mode
      if (clipMode && v.currentTime >= clipEnd) {
        v.currentTime = clipStart;
      }
    };
    const onMeta = () => {
      setDuration(v.duration || 0);
      setCurrentTime(v.currentTime);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    if (v.readyState >= 1) { setDuration(v.duration || 0); setCurrentTime(v.currentTime); }

    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [current, clipMode, clipEnd, clipStart]);

  // ── scroll → current index ───────────────────────────────────────────────
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== current) {
      setCurrent(idx);
      setClipMode(false);
      setCurrentTime(0);
      setDuration(0);
    }
  }, [current]);

  // ── actions ──────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = activeVideo();
    if (!v) return;
    if (isPlaying) { v.pause(); } else { v.play().catch(() => {}); }
    resetHideTimer();
  };

  const seek = (val: number) => {
    const v = activeVideo();
    if (v && isFinite(val)) { v.currentTime = val; setCurrentTime(val); }
    resetHideTimer();
  };

  const enterClipMode = () => {
    const v = activeVideo();
    if (!v) return;
    v.pause();
    const dur = v.duration || 0;
    setClipStart(0);
    setClipEnd(dur > 0 ? dur : 0);
    setClipMode(true);
    resetHideTimer();
  };

  const saveClip = () => {
    const v = videos[current];
    const clip: LocalClip = {
      id: `${Date.now()}`,
      camera,
      date: v.date,
      filename: v.filename,
      videoUrl: v.url,
      startTime: clipStart,
      endTime: clipEnd,
      savedAt: new Date().toISOString(),
    };
    saveLocalClip(clip);
    setClipMode(false);
    const v2 = activeVideo();
    if (v2) v2.play().catch(() => {});
    toast({
      title: "Clip saved!",
      description: `${fmt(clipStart)} → ${fmt(clipEnd)} · ${fmt(clipEnd - clipStart)} long`,
      className: "bg-primary text-white border-none",
    });
  };

  const v = videos[current];
  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div
      className="relative w-full h-[100dvh] bg-black overflow-hidden"
      onClick={() => { if (!clipMode) resetHideTimer(); }}
    >
      {/* ── video carousel ── */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="w-full h-full flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
        style={{ scrollBehavior: "auto" }}
      >
        {videos.map((entry, i) => (
          <div
            key={entry.filename + i}
            className="w-full h-full shrink-0 snap-center"
            style={{ minWidth: "100%" }}
          >
            <video
              ref={(el) => { videoRefs.current[i] = el; }}
              src={entry.url}
              className="w-full h-full object-cover"
              playsInline
              loop={!clipMode}
              muted={isMuted}
              autoPlay={i === startIndex}
            />
          </div>
        ))}
      </div>

      {/* ── gradient overlays ── */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/80" />

      {/* ── top bar (always visible) ── */}
      <div className="absolute top-0 pt-safe px-4 pt-4 w-full flex justify-between items-start z-20">
        <button
          onClick={(e) => { e.stopPropagation(); onBack(); }}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          <ChevronLeft className="w-6 h-6 ml-[-2px]" />
        </button>

        {videos.length > 1 && (
          <div className="flex items-center gap-1.5 mt-2">
            {videos.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setCurrent(i); }}
                className={`rounded-full transition-all ${
                  i === current ? "w-5 h-2 bg-white" : "w-2 h-2 bg-white/40"
                }`}
              />
            ))}
          </div>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); setIsMuted((m) => !m); resetHideTimer(); }}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* ── CLIP MODE overlay ── */}
      {clipMode ? (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 px-4 pb-safe pb-6 pt-5 bg-gradient-to-t from-black via-black/95 to-transparent"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-white/50 text-xs font-medium uppercase tracking-widest text-center mb-4">
            Trim clip
          </p>

          {/* Trim bar */}
          <TrimBar
            duration={duration}
            clipStart={clipStart}
            clipEnd={clipEnd}
            currentTime={currentTime}
            onStartChange={(s) => { setClipStart(s); seek(s); }}
            onEndChange={(e) => { setClipEnd(e); seek(e); }}
          />

          {/* Time labels */}
          <div className="flex justify-between mt-3 mb-5">
            <span className="text-white text-sm font-mono font-bold">{fmt(clipStart)}</span>
            <span className="text-white/50 text-xs mt-0.5">
              clip · {fmt(clipEnd - clipStart)}
            </span>
            <span className="text-white text-sm font-mono font-bold">{fmt(clipEnd)}</span>
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              onClick={() => setClipMode(false)}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl bg-white/10 text-white border border-white/20 font-semibold text-sm active:scale-95 transition-transform"
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
            <button
              onClick={saveClip}
              className="flex-[2] flex items-center justify-center gap-2 py-3.5 rounded-xl bg-primary text-white font-semibold text-sm active:scale-95 transition-transform shadow-lg"
            >
              <Check className="w-4 h-4" />
              Save Clip
            </button>
          </div>
        </div>
      ) : (
        /* ── NORMAL controls overlay ── */
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-300 ${
            showControls ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Info */}
          <div className="px-5 mb-3">
            <span className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase mb-1.5 inline-block">
              {camera}
            </span>
            <p className="text-white font-bold text-base drop-shadow-md">
              {v.time || v.filename}
            </p>
            <p className="text-white/50 text-xs">{v.date} · {current + 1} / {videos.length}</p>
          </div>

          {/* Scrubber */}
          <div className="px-5 mb-3">
            <div className="flex items-center gap-3">
              <span className="text-white/60 text-xs font-mono w-9 text-right shrink-0">{fmt(currentTime)}</span>
              <div className="flex-1 relative">
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.1}
                  value={currentTime}
                  onChange={(e) => seek(parseFloat(e.target.value))}
                  className="w-full h-1 accent-primary appearance-none bg-white/25 rounded-full cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, #22c55e ${progress * 100}%, rgba(255,255,255,0.25) ${progress * 100}%)`,
                  }}
                />
              </div>
              <span className="text-white/60 text-xs font-mono w-9 shrink-0">{fmt(duration)}</span>
            </div>
          </div>

          {/* Action row */}
          <div className="px-5 pb-safe pb-6 flex items-center justify-between">
            {/* Spacer */}
            <div className="w-12" />

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              className="w-14 h-14 rounded-full bg-white flex items-center justify-center shadow-xl active:scale-95 transition-transform"
            >
              {isPlaying
                ? <Pause className="w-6 h-6 text-black fill-black" />
                : <Play className="w-6 h-6 text-black fill-black ml-0.5" />
              }
            </button>

            {/* Clip button */}
            <button
              onClick={enterClipMode}
              className="w-12 h-12 rounded-full bg-white/15 border border-white/30 backdrop-blur-md flex items-center justify-center active:scale-95 transition-transform"
            >
              <Scissors className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dual-handle trim bar ─────────────────────────────────────────────────────
function TrimBar({
  duration,
  clipStart,
  clipEnd,
  currentTime,
  onStartChange,
  onEndChange,
}: {
  duration: number;
  clipStart: number;
  clipEnd: number;
  currentTime: number;
  onStartChange: (v: number) => void;
  onEndChange: (v: number) => void;
}) {
  const d = duration || 1;
  const startPct = (clipStart / d) * 100;
  const endPct = (clipEnd / d) * 100;
  const playPct = (currentTime / d) * 100;

  return (
    <div className="relative h-12 rounded-xl bg-white/10 overflow-hidden">
      {/* Selected region */}
      <div
        className="absolute top-0 bottom-0 bg-primary/40 border-t-2 border-b-2 border-primary"
        style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
      />

      {/* Playhead */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white/80"
        style={{ left: `${playPct}%` }}
      />

      {/* Start handle (range input, z-index managed) */}
      <input
        type="range"
        min={0}
        max={d}
        step={0.1}
        value={clipStart}
        onChange={(e) => {
          const val = Math.min(parseFloat(e.target.value), clipEnd - 1);
          onStartChange(val);
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        style={{ zIndex: clipStart > d * 0.9 ? 5 : 3 }}
      />

      {/* End handle (range input) */}
      <input
        type="range"
        min={0}
        max={d}
        step={0.1}
        value={clipEnd}
        onChange={(e) => {
          const val = Math.max(parseFloat(e.target.value), clipStart + 1);
          onEndChange(val);
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        style={{ zIndex: 4 }}
      />

      {/* Start handle visual */}
      <div
        className="absolute top-0 bottom-0 w-4 bg-primary rounded-l-md flex items-center justify-center pointer-events-none"
        style={{ left: `${startPct}%`, transform: "translateX(-100%)" }}
      >
        <div className="w-0.5 h-5 bg-white/60 rounded-full" />
      </div>

      {/* End handle visual */}
      <div
        className="absolute top-0 bottom-0 w-4 bg-primary rounded-r-md flex items-center justify-center pointer-events-none"
        style={{ left: `${endPct}%` }}
      >
        <div className="w-0.5 h-5 bg-white/60 rounded-full" />
      </div>
    </div>
  );
}
