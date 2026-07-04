import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useRoute } from "wouter";
import {
  useGetBunnyCollections,
  useGetBunnyCollectionVideos,
  useCreateUserClip,
  getListUserClipsQueryKey,
  BunnyVideo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Play, Pause, X, SkipBack, SkipForward, Circle, Square, CheckCircle2, Maximize, Minimize } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import Hls from "hls.js";

type CropKeyframe = { t: number; x: number; y: number; w: number; h: number };
type ClipMode = "idle" | "recording" | "review";
type AspectRatio = "16:9" | "9:16";

function splitName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:id");
  const guid = params?.id ?? "";
  const { t } = useTranslation();

  const { data: collections } = useGetBunnyCollections();
  const collection = collections?.find((c) => c.guid === guid);
  const { data: videos, isLoading: videosLoading } = useGetBunnyCollectionVideos(guid);
  const words = collection ? splitName(collection.name) : [];
  const [activeVideo, setActiveVideo] = useState<BunnyVideo | null>(null);

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm"
      >
        <Link href="/fields" className="w-10 h-10 flex items-center justify-center -ms-2 rounded-full hover:bg-muted text-foreground">
          <ChevronLeft className="w-6 h-6 rtl:hidden" />
          <ChevronRight className="w-6 h-6 ltr:hidden" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{collection?.name ?? t.fieldDetail.loading}</h1>
          <p className="text-xs text-muted-foreground">
            {videosLoading ? "…" : `${videos?.length ?? 0} videos`}
          </p>
        </div>
      </motion.header>

      <motion.div
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.5, ease: "easeOut" as const } }}
        className="relative h-44 overflow-hidden shrink-0"
      >
        {collection?.previewImageUrl ? (
          <img src={collection.previewImageUrl} alt={collection.name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/80" />
        {words.length > 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-4">
            {words.map((word, wi) => (
              <span key={wi} className="text-white font-black leading-none tracking-tight drop-shadow-lg text-center"
                style={{ fontSize: `clamp(1.4rem, ${Math.min(6, 12 / word.length)}vw + 0.5rem, 3rem)` }}>
                {word}
              </span>
            ))}
          </div>
        )}
        {collection && (
          <div className="absolute bottom-3 start-0 end-0 flex flex-col items-center">
            <p className="text-white/60 text-[10px]">
              {collection.videoCount} {collection.videoCount === 1 ? "video" : "videos"}
            </p>
          </div>
        )}
      </motion.div>

      <div className="flex-1 overflow-y-auto pb-24">
        {videosLoading ? (
          <div className="p-4 grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="aspect-video bg-muted rounded-xl animate-pulse" />)}
          </div>
        ) : !videos || videos.length === 0 ? (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
            className="flex flex-col items-center justify-center py-20 px-6 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Play className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">{t.fieldDetail.noRecordingsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.fieldDetail.noRecordingsDesc}</p>
          </motion.div>
        ) : (
          <div className="p-4 grid grid-cols-2 gap-3">
            {videos.map((video, i) => (
              <VideoCard key={video.guid} video={video} index={i} onPlay={() => setActiveVideo(video)} />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {activeVideo && <VideoPlayer video={activeVideo} onClose={() => setActiveVideo(null)} />}
      </AnimatePresence>
    </div>
  );
}

function VideoCard({ video, index, onPlay }: { video: BunnyVideo; index: number; onPlay: () => void }) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: { delay: index * 0.06, duration: 0.3, ease: "easeOut" as const } }}
      whileTap={{ scale: 0.94 }}
      onClick={onPlay}
      className="relative aspect-video rounded-xl overflow-hidden bg-zinc-900 shadow group text-start"
    >
      <img src={video.thumbnailUrl} alt={video.title}
        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
          <Play className="w-5 h-5 text-white fill-white" />
        </div>
      </div>
      {(video.duration ?? 0) > 0 && (
        <span className="absolute bottom-1.5 end-2 text-[10px] font-bold text-white bg-black/60 px-1.5 py-0.5 rounded">
          {formatDuration(video.duration ?? 0)}
        </span>
      )}
      <p className="absolute bottom-1.5 start-2 end-10 text-[10px] text-white/80 font-medium truncate leading-tight">
        {video.title}
      </p>
    </motion.button>
  );
}

function VideoPlayer({ video, onClose }: { video: BunnyVideo; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const { isGuest } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const seekDraggingRef = useRef(false);
  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [clipIsPublic, setClipIsPublic] = useState(true);
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("16:9");
  const selectedRatioRef = useRef<AspectRatio>("16:9");

  // Stable refs so callbacks always see current values
  const clipStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  /* Fullscreen toggle */
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onDurationChange() { if (el) setDuration(el.duration || 0); }
    function onTimeUpdate() { if (el && !seekDraggingRef.current) setCurrentTime(el.currentTime); }

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("timeupdate", onTimeUpdate);

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(video.playbackUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) el.dispatchEvent(new Event("error")); });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = video.playbackUrl;
      el.addEventListener("canplay", () => el.play().catch(() => {}), { once: true });
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [video.playbackUrl]);

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    const scrollEl = scrollRef.current;
    if (!scrollEl || !v.videoWidth || !v.videoHeight) return;
    const containerH = scrollEl.clientHeight;
    const ar = v.videoWidth / v.videoHeight;
    const w = Math.round(containerH * ar);
    // Store computed width so scroll fractions are accurate
    scrollEl.dataset.videoWidth = String(w);
    setDuration(v.duration || 0);
    requestAnimationFrame(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    });
  }

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const timer = setTimeout(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.paused ? el.play().catch(() => {}) : el.pause();
  };

  const seek = (delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };

  const startRecording = () => {
    if (isGuest) {
      toast({ title: t.clipping.signInToClip, description: t.clipping.signInToClipDesc });
      return;
    }
    const el = videoRef.current;
    if (!el) return;

    el.play().catch(() => {});
    clipStartRef.current = el.currentTime;
    recordingRef.current.keyframes = [];
    setRecElapsed(0);

    const sampleFrame = () => {
      const videoEl = videoRef.current;
      const scrollEl = scrollRef.current;
      if (!videoEl || !scrollEl) return;
      const totalW = scrollEl.scrollWidth;
      const containerW = scrollEl.clientWidth;
      const containerH = scrollEl.clientHeight;
      const relT = videoEl.currentTime - clipStartRef.current;

      let x: number, w: number;
      if (selectedRatioRef.current === "9:16") {
        const cropPxW = containerH * 9 / 16;
        x = totalW > 0 ? (scrollEl.scrollLeft + (containerW - cropPxW) / 2) / totalW : 0;
        w = totalW > 0 ? cropPxW / totalW : 81 / 256;
      } else {
        x = totalW > 0 ? scrollEl.scrollLeft / totalW : 0;
        w = totalW > 0 ? containerW / totalW : 1;
      }

      recordingRef.current.keyframes.push({ t: relT, x, y: 0, w, h: 1 });
    };

    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);

    // Elapsed counter for UI display
    elapsedRef.current = setInterval(() => {
      const videoEl = videoRef.current;
      if (videoEl) setRecElapsed(videoEl.currentTime - clipStartRef.current);
    }, 100);

    setClipMode("recording");
  };

  const stopRecording = () => {
    if (recordingRef.current.interval) {
      clearInterval(recordingRef.current.interval);
      recordingRef.current.interval = null;
    }
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }

    const el = videoRef.current;
    const scrollEl = scrollRef.current;
    const endT = el?.currentTime ?? clipStartRef.current;

    // Capture final frame
    if (el && scrollEl) {
      const totalW = scrollEl.scrollWidth;
      const containerW = scrollEl.clientWidth;
      const containerH = scrollEl.clientHeight;
      let x: number, w: number;
      if (selectedRatioRef.current === "9:16") {
        const cropPxW = containerH * 9 / 16;
        x = totalW > 0 ? (scrollEl.scrollLeft + (containerW - cropPxW) / 2) / totalW : 0;
        w = totalW > 0 ? cropPxW / totalW : 81 / 256;
      } else {
        x = totalW > 0 ? scrollEl.scrollLeft / totalW : 0;
        w = totalW > 0 ? containerW / totalW : 1;
      }
      recordingRef.current.keyframes.push({ t: endT - clipStartRef.current, x, y: 0, w, h: 1 });
    }

    el?.pause();
    setClipEndTime(endT);
    setClipTitle(video.title);
    setClipMode("review");
  };

  const discardClip = () => {
    recordingRef.current.keyframes = [];
    setClipMode("idle");
    setClipTitle("");
    setClipIsPublic(true);
    setRecElapsed(0);
    setSelectedRatio("16:9");
    selectedRatioRef.current = "16:9";
  };

  const saveClip = async () => {
    const el = videoRef.current;
    const totalDuration = el?.duration || duration || 1;
    const startT = clipStartRef.current;
    const endT = clipEndTime;
    const clipDuration = Math.max(0.1, endT - startT);

    let keyframes = recordingRef.current.keyframes.map((kf) => ({
      ...kf,
      t: Math.max(0, Math.min(1, kf.t / clipDuration)),
    }));

    if (keyframes.length === 0) {
      const scrollEl = scrollRef.current;
      const totalW = scrollEl?.scrollWidth ?? 1;
      const containerW = scrollEl?.clientWidth ?? totalW;
      const x = scrollEl ? scrollEl.scrollLeft / totalW : 0;
      const w = scrollEl ? containerW / totalW : 1;
      keyframes = [{ t: 0, x, y: 0, w, h: 1 }, { t: 1, x, y: 0, w, h: 1 }];
    } else if (keyframes.length === 1) {
      keyframes = [{ ...keyframes[0], t: 0 }, { ...keyframes[0], t: 1 }];
    }

    setIsSavingClip(true);
    try {
      await createUserClip.mutateAsync({
        data: {
          videoId: video.guid,
          title: clipTitle.trim() || video.title,
          startTime: totalDuration > 0 ? startT / totalDuration : 0,
          endTime: totalDuration > 0 ? endT / totalDuration : 1,
          cropPath: keyframes,
          isPublic: clipIsPublic,
          aspectRatio: selectedRatioRef.current,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
      toast({ title: t.clipping.saved, description: t.clipping.savedDesc, className: "bg-primary text-white border-none" });
      setClipMode("idle");
      setClipTitle("");
      recordingRef.current.keyframes = [];
    } catch {
      toast({ title: t.clipping.error, variant: "destructive" });
    } finally {
      setIsSavingClip(false);
    }
  };

  const clipSeconds = Math.max(0, clipEndTime - clipStartRef.current);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
      {/* Letterboxed 16:9 scrollable video — black bars top & bottom */}
      <div className="absolute inset-0 flex items-center bg-black">
        <div
          ref={scrollRef}
          className="w-full aspect-[16/9] overflow-x-auto overflow-y-hidden touch-pan-x no-scrollbar relative"
        >
          {/* Crop ratio overlay — visible in idle and recording modes */}
          {(clipMode === "idle" || clipMode === "recording") && (
            <div className="absolute inset-0 z-10 pointer-events-none">
              {selectedRatio === "9:16" ? (
                <>
                  <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: "34.18%" }} />
                  <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: "34.18%" }} />
                  <div
                    className={`absolute inset-y-0 border-2 transition-colors ${clipMode === "recording" ? "border-red-500" : "border-white/80"}`}
                    style={{ left: "34.18%", width: "31.64%" }}
                  />
                </>
              ) : (
                <div
                  className={`absolute inset-0 border-2 transition-colors ${clipMode === "recording" ? "border-red-500/70" : "border-white/30"}`}
                />
              )}
            </div>
          )}

          <video
            ref={videoRef}
            className="h-full max-w-none pointer-events-none"
            style={{ aspectRatio: "3840/1080" }}
            playsInline
            loop
            onLoadedMetadata={onLoadedMetadata}
          />

          {clipMode !== "recording" && (
            <button onClick={togglePlay} className="absolute inset-0 z-10" aria-label={isPlaying ? "Pause" : "Play"} />
          )}
        </div>
      </div>

      {/* X close button — fixed to guarantee it sits above everything */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="fixed top-safe left-4 mt-4 z-[100] w-14 h-14 rounded-full bg-black/80 backdrop-blur-md flex items-center justify-center text-white active:scale-95 transition-transform shadow-xl border border-white/20"
        aria-label="Close video"
      >
        <X className="w-7 h-7" />
      </button>

      {/* Recording badge */}
      <AnimatePresence>
        {clipMode === "recording" && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute top-safe left-1/2 -translate-x-1/2 mt-4 z-50 flex items-center gap-2 bg-black/70 backdrop-blur-md rounded-full px-3 py-1.5 pointer-events-none"
          >
            <motion.div
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ repeat: Infinity, duration: 1, ease: "easeInOut" }}
              className="w-2.5 h-2.5 rounded-full bg-red-500"
            />
            <span className="text-white text-xs font-bold tracking-wider">{t.clipping.recBadge}</span>
            <span className="text-white/70 text-xs tabular-nums">{recElapsed.toFixed(1)}s</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pan hint overlay during recording */}
      <AnimatePresence>
        {clipMode === "recording" && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.3 } }}
            exit={{ opacity: 0 }}
            className="absolute top-safe mt-16 inset-x-0 flex justify-center z-10 pointer-events-none"
          >
            <span className="bg-black/50 backdrop-blur-sm text-white/90 text-xs font-medium px-3 py-1.5 rounded-full">
              {t.clipping.panHint}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Idle controls — floating overlay at bottom */}
      {clipMode === "idle" && (
        <div
          className="absolute bottom-safe left-0 right-0 z-20 px-4 pb-3 flex flex-col gap-3"
          style={{ background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)", paddingTop: "3rem" }}
        >
          {/* Title + views */}
          <div className="px-1">
            <p className="text-white font-bold text-sm leading-tight drop-shadow">{video.title}</p>
            {(video.views ?? 0) > 0 && (
              <p className="text-white/60 text-xs mt-0.5 drop-shadow">{(video.views ?? 0).toLocaleString()} views</p>
            )}
          </div>

          {/* Seek Bar */}
          <div className="px-1 select-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="text-xs text-white/80 font-semibold tabular-nums min-w-[38px]">
                {formatDuration(currentTime)}
              </span>
              <div className="flex-1 relative h-8 flex items-center">
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 bg-white/25 rounded-full" />
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-2 bg-primary rounded-full pointer-events-none"
                  style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-5 h-5 bg-white rounded-full shadow-lg ring-2 ring-white/30 pointer-events-none transition-transform"
                  style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, transform: `translate(-50%, -50%)` }}
                />
                <input
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.1}
                  value={currentTime}
                  onMouseDown={() => { seekDraggingRef.current = true; }}
                  onTouchStart={() => { seekDraggingRef.current = true; }}
                  onChange={(e) => setCurrentTime(parseFloat(e.target.value))}
                  onMouseUp={(e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    if (videoRef.current) videoRef.current.currentTime = val;
                    seekDraggingRef.current = false;
                  }}
                  onTouchEnd={(e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    if (videoRef.current) videoRef.current.currentTime = val;
                    seekDraggingRef.current = false;
                  }}
                  className="w-full h-full appearance-none cursor-pointer relative z-10 opacity-0"
                />
              </div>
              <span className="text-xs text-white/80 font-semibold tabular-nums min-w-[38px] text-right">
                {formatDuration(duration)}
              </span>
            </div>
          </div>

          {/* Aspect ratio picker */}
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="text-white/50 text-xs font-medium">Crop</span>
            <div className="flex rounded-lg overflow-hidden border border-white/20 text-xs font-bold">
              {(["16:9", "9:16"] as AspectRatio[]).map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => { setSelectedRatio(ratio); selectedRatioRef.current = ratio; }}
                  className={`px-3 py-1.5 transition-colors ${selectedRatio === ratio ? "bg-white text-black" : "bg-white/10 text-white/60"}`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>

          {/* Button row */}
          <div className="flex items-center justify-center gap-4">
            <button onClick={() => seek(-5)}
              className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white active:bg-white/20 transition-colors"
              aria-label="Back 5s">
              <SkipBack className="w-5 h-5" />
            </button>
            <button onClick={togglePlay}
              className="w-14 h-14 rounded-full bg-white flex items-center justify-center text-black active:scale-95 transition-transform"
              aria-label={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
            </button>
            <button onClick={() => seek(5)}
              className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white active:bg-white/20 transition-colors"
              aria-label="Forward 5s">
              <SkipForward className="w-5 h-5" />
            </button>
            <button onClick={startRecording}
              className="w-12 h-12 rounded-full bg-red-600 flex items-center justify-center text-white active:scale-95 transition-transform shadow-lg shadow-red-900/50"
              aria-label={t.clipping.record}>
              <Circle className="w-5 h-5 fill-white text-white" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 active:scale-95 transition-all"
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      {/* Recording controls */}
      {clipMode === "recording" && (
        <div className="absolute bottom-safe left-0 right-0 z-20 px-4 pb-5 flex items-center justify-center">
          <motion.button
            onClick={stopRecording}
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ repeat: Infinity, duration: 1.5 }}
            className="w-20 h-20 rounded-full bg-red-600 flex flex-col items-center justify-center text-white shadow-xl shadow-red-900/60 active:scale-95"
            aria-label={t.clipping.stopRecording}
          >
            <Square className="w-7 h-7 fill-white text-white" />
            <span className="text-[10px] font-bold mt-1 tracking-wide">{t.clipping.stopRecording}</span>
          </motion.button>
        </div>
      )}

      {/* Review panel */}
      <AnimatePresence>
        {clipMode === "review" && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", damping: 26, stiffness: 300 }}
            className="absolute bottom-0 left-0 right-0 z-30 bg-zinc-900/96 backdrop-blur-md px-4 pt-5 pb-safe"
          >
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
              <span className="text-white font-bold text-sm">{t.clipping.reviewTitle}</span>
              <span className="ml-auto text-white/50 text-xs">{t.clipping.clipDuration(clipSeconds)}</span>
            </div>

            <input
              className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-white/40 outline-none focus:border-primary mb-3"
              placeholder={t.clipping.titlePlaceholder}
              value={clipTitle}
              onChange={(e) => setClipTitle(e.target.value)}
              maxLength={80}
              autoFocus
            />

            <div className="flex items-center gap-3 mb-4">
              <span className="text-white/60 text-xs">Visibility</span>
              <div className="flex rounded-lg overflow-hidden border border-white/20 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setClipIsPublic(true)}
                  className={`px-3 py-1.5 transition-colors ${clipIsPublic ? "bg-primary text-white" : "bg-white/10 text-white/60"}`}
                >
                  Public
                </button>
                <button
                  type="button"
                  onClick={() => setClipIsPublic(false)}
                  className={`px-3 py-1.5 transition-colors ${!clipIsPublic ? "bg-primary text-white" : "bg-white/10 text-white/60"}`}
                >
                  Followers only
                </button>
              </div>
            </div>

            <div className="flex gap-2 pb-3">
              <button
                onClick={discardClip}
                disabled={isSavingClip}
                className="flex-1 bg-white/10 border border-white/20 rounded-xl py-3 text-white text-sm font-semibold active:scale-95 transition-transform disabled:opacity-50"
              >
                {t.clipping.discard}
              </button>
              <button
                onClick={saveClip}
                disabled={isSavingClip}
                className="flex-[2] bg-primary rounded-xl py-3 text-white text-sm font-bold active:scale-95 transition-transform disabled:opacity-50"
              >
                {isSavingClip ? t.clipping.saving : t.clipping.save}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
