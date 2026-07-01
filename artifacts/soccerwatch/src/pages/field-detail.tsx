import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useRoute } from "wouter";
import {
  useGetBunnyCollections,
  useGetBunnyCollectionVideos,
  BunnyVideo,
} from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Play, Pause, X, SkipBack, SkipForward } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import Hls from "hls.js";

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

  // Use the cached collections list to get name/metadata without an extra endpoint
  const { data: collections } = useGetBunnyCollections();
  const collection = collections?.find((c) => c.guid === guid);

  const { data: videos, isLoading: videosLoading } = useGetBunnyCollectionVideos(guid);

  const words = collection ? splitName(collection.name) : [];
  const [activeVideo, setActiveVideo] = useState<BunnyVideo | null>(null);

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm"
      >
        <Link
          href="/fields"
          className="w-10 h-10 flex items-center justify-center -ms-2 rounded-full hover:bg-muted text-foreground"
        >
          <ChevronLeft className="w-6 h-6 rtl:hidden" />
          <ChevronRight className="w-6 h-6 ltr:hidden" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">
            {collection?.name ?? t.fieldDetail.loading}
          </h1>
          <p className="text-xs text-muted-foreground">
            {videosLoading ? "…" : `${videos?.length ?? 0} videos`}
          </p>
        </div>
      </motion.header>

      {/* Field Hero */}
      <motion.div
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.5, ease: "easeOut" as const } }}
        className="relative h-44 overflow-hidden shrink-0"
      >
        {collection?.previewImageUrl ? (
          <img
            src={collection.previewImageUrl}
            alt={collection.name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/80" />

        {words.length > 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-4">
            {words.map((word, wi) => (
              <span
                key={wi}
                className="text-white font-black leading-none tracking-tight drop-shadow-lg text-center"
                style={{ fontSize: `clamp(1.4rem, ${Math.min(6, 12 / word.length)}vw + 0.5rem, 3rem)` }}
              >
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

      {/* Video Grid */}
      <div className="flex-1 overflow-y-auto pb-24">
        {videosLoading ? (
          <div className="p-4 grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="aspect-video bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        ) : !videos || videos.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
            className="flex flex-col items-center justify-center py-20 px-6 text-center"
          >
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Play className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">{t.fieldDetail.noRecordingsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.fieldDetail.noRecordingsDesc}</p>
          </motion.div>
        ) : (
          <div className="p-4 grid grid-cols-2 gap-3">
            {videos.map((video, i) => (
              <VideoCard
                key={video.guid}
                video={video}
                index={i}
                onPlay={() => setActiveVideo(video)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fullscreen player overlay */}
      <AnimatePresence>
        {activeVideo && (
          <VideoPlayer video={activeVideo} onClose={() => setActiveVideo(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function VideoCard({
  video,
  index,
  onPlay,
}: {
  video: BunnyVideo;
  index: number;
  onPlay: () => void;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9, y: 12 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        transition: { delay: index * 0.06, duration: 0.3, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.94 }}
      onClick={onPlay}
      className="relative aspect-video rounded-xl overflow-hidden bg-zinc-900 shadow group text-start"
    >
      <img
        src={video.thumbnailUrl}
        alt={video.title}
        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
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

  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [videoWidth, setVideoWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    el.muted = false;

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onCanPlay() { setIsReady(true); }

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("canplay", onCanPlay);

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(video.playbackUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          el.dispatchEvent(new Event("error"));
        }
      });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = video.playbackUrl;
      el.addEventListener("canplay", () => el.play().catch(() => {}), { once: true });
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("canplay", onCanPlay);
    };
  }, [video.playbackUrl]);

  // Once video metadata loads, compute exact pixel width so the container overflows
  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    const scrollEl = scrollRef.current;
    if (!scrollEl || !v.videoWidth || !v.videoHeight) return;
    const containerH = scrollEl.clientHeight;
    const ar = v.videoWidth / v.videoHeight;
    const w = Math.round(containerH * ar);
    setVideoWidth(w);
    // Re-center after width is known
    requestAnimationFrame(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    });
  }

  // Fallback center on open (before metadata loads)
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const t = setTimeout(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const seek = (delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
    >
      {/* Top controls */}
      <div className="absolute top-safe pt-4 px-4 w-full flex items-center justify-between z-10 pointer-events-none">
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white pointer-events-auto"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* 16:9 viewport with horizontally scrollable wide video (no visible scrollbar) */}
      <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
        <div
          ref={scrollRef}
          className="w-full overflow-x-auto overflow-y-hidden touch-pan-x no-scrollbar relative"
          style={{ aspectRatio: "16/9" }}
        >
          <video
            ref={videoRef}
            className="h-full max-w-none pointer-events-none"
            style={{ width: videoWidth ?? "auto", aspectRatio: videoWidth ? undefined : "3840/1080" }}
            playsInline
            loop
            onLoadedMetadata={onLoadedMetadata}
          />
          {/* Transparent overlay catches taps for play/pause without blocking scroll */}
          <button
            onClick={togglePlay}
            className="absolute inset-0 z-10"
            aria-label={isPlaying ? "Pause" : "Play"}
          />
        </div>
      </div>

      {/* Playback controls */}
      <div className="shrink-0 px-4 py-3 bg-black flex items-center justify-center gap-6">
        <button
          onClick={() => seek(-5)}
          className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white active:bg-white/20 transition-colors"
          aria-label="Back 5 seconds"
        >
          <SkipBack className="w-5 h-5" />
        </button>

        <button
          onClick={togglePlay}
          className="w-14 h-14 rounded-full bg-white flex items-center justify-center text-black active:scale-95 transition-transform"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
        </button>

        <button
          onClick={() => seek(5)}
          className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white active:bg-white/20 transition-colors"
          aria-label="Forward 5 seconds"
        >
          <SkipForward className="w-5 h-5" />
        </button>
      </div>

      {/* Bottom info */}
      <div className="shrink-0 px-4 pb-safe pb-3 bg-black">
        <p className="text-white font-bold text-sm leading-tight">{video.title}</p>
        {(video.views ?? 0) > 0 && (
          <p className="text-white/60 text-xs mt-0.5">{(video.views ?? 0).toLocaleString()} views</p>
        )}
      </div>
    </motion.div>
  );
}
