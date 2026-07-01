import { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "wouter";
import {
  useListSavedClips,
  useListUserClips,
  useDeleteUserClip,
  getListSavedClipsQueryKey,
  getListUserClipsQueryKey,
  Clip,
  UserClip,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, Video, Scissors, Trash2, X, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import Hls from "hls.js";

function getBunnyThumbnailUrl(clip: Clip): string | null {
  if (clip.bunnyPlaybackUrl) {
    return clip.bunnyPlaybackUrl.replace("/playlist.m3u8", "/thumbnail.jpg");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Interpolate scroll position from cropPath keyframes               */
/* ------------------------------------------------------------------ */

type KF = { t: number; x: number; y: number; w: number; h: number };

function lerp(a: number, b: number, p: number) {
  return a + (b - a) * p;
}

function interpolateX(keyframes: KF[], t: number): number {
  if (keyframes.length === 0) return 0.5;
  if (keyframes.length === 1) return keyframes[0].x;
  if (t <= keyframes[0].t) return keyframes[0].x;
  if (t >= keyframes[keyframes.length - 1].t) return keyframes[keyframes.length - 1].x;

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return lerp(a.x, b.x, p);
    }
  }
  return keyframes[keyframes.length - 1].x;
}

/* ------------------------------------------------------------------ */
/*  Player overlay for user-created clips                               */
/* ------------------------------------------------------------------ */

function UserClipPlayer({ clip, onClose }: { clip: UserClip; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const rafRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const keyframes = clip.cropPath ?? [];
  // startTime/endTime are 0–1 fractions of total video duration

  /* HLS init */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip.playbackUrl) return;

    function onLoaded() {
      if (!video) return;
      const dur = video.duration || 0;
      if (dur > 0) {
        video.currentTime = clip.startTime * dur;
        video.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(clip.playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onLoaded);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = clip.playbackUrl;
      video.addEventListener("loadedmetadata", onLoaded, { once: true });
      video.play().catch(() => {});
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [clip.playbackUrl, clip.startTime]);

  /* Scroll interpolation loop — reads duration live from the element */
  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      const scrollEl = scrollRef.current;
      if (!video || !scrollEl || keyframes.length === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const dur = video.duration || 0;
      if (dur === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const sSec = clip.startTime * dur;
      const eSec = clip.endTime * dur;
      const cDur = Math.max(0.1, eSec - sSec);
      const now = video.currentTime;
      const t = Math.max(0, Math.min(1, (now - sSec) / cDur));
      const x = interpolateX(keyframes, t);
      const totalW = scrollEl.scrollWidth;
      const viewW = scrollEl.clientWidth;
      const maxScroll = Math.max(0, totalW - viewW);
      scrollEl.scrollLeft = x * totalW - (viewW / 2) + (viewW * (keyframes[0]?.w ?? 1) / 2);
      scrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, scrollEl.scrollLeft));

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [keyframes, clip.startTime, clip.endTime]);

  /* Auto-stop when clip window ends — read duration live from the element */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const dur = video.duration || 0;
      if (dur === 0) return;
      const sSec = clip.startTime * dur;
      const eSec = clip.endTime * dur;
      if (video.currentTime >= eSec) {
        video.pause();
        setIsPlaying(false);
        video.currentTime = sSec;
      }
    };
    const id = setInterval(onTime, 100);
    return () => clearInterval(id);
  }, [clip.startTime, clip.endTime]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration || 0;
    if (dur === 0) return;
    const sSec = clip.startTime * dur;
    const eSec = clip.endTime * dur;
    if (video.paused) {
      if (video.currentTime >= eSec) video.currentTime = sSec;
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [clip.startTime, clip.endTime]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
    >
      {/* Top bar */}
      <div className="absolute top-safe pt-4 px-4 w-full flex items-center justify-between z-20 pointer-events-none">
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white pointer-events-auto"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="w-10" />
      </div>

      {/* Scrollable video viewport */}
      <div className="flex-1 flex items-center justify-center w-full overflow-hidden">
        <div
          ref={scrollRef}
          className="w-full overflow-x-auto overflow-y-hidden touch-pan-x no-scrollbar relative"
          style={{ aspectRatio: "16/9" }}
        >
          <video
            ref={videoRef}
            className="h-full max-w-none pointer-events-none"
            style={{ aspectRatio: "3840/1080" }}
            playsInline
            loop={false}
            muted={false}
          />
          <button
            onClick={togglePlay}
            className="absolute inset-0 z-10"
            aria-label={isPlaying ? "Pause" : "Play"}
          />
        </div>
      </div>

      {/* Bottom info */}
      <div className="shrink-0 px-4 pb-safe pb-3 bg-black flex items-center justify-between">
        <div>
          <p className="text-white font-bold text-sm">{clip.title}</p>
          <p className="text-white/50 text-xs">
            {(clip.endTime - clip.startTime).toFixed(3)} × video duration
          </p>
        </div>
        <button
          onClick={togglePlay}
          className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-black active:scale-95 transition-transform"
        >
          {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                           */
/* ------------------------------------------------------------------ */

type Tab = "saved" | "created";

export default function MyClips() {
  const { isGuest } = useAuth();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("saved");
  const [activeClip, setActiveClip] = useState<UserClip | null>(null);

  const { data: savedClips, isLoading: savedLoading } = useListSavedClips({
    query: { enabled: !isGuest, queryKey: getListSavedClipsQueryKey() },
  });

  const { data: userClips, isLoading: userClipsLoading } = useListUserClips({
    query: { enabled: !isGuest, queryKey: getListUserClipsQueryKey() },
  });

  if (isGuest) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }}
        className="flex-1 bg-background flex flex-col h-full overflow-hidden items-center justify-center p-6 text-center"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 280, damping: 18, delay: 0.1 } }}
          className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4"
        >
          <Bookmark className="w-8 h-8 text-muted-foreground" />
        </motion.div>
        <h2 className="text-xl font-bold mb-2">{t.myClips.signInTitle}</h2>
        <p className="text-muted-foreground mb-6">{t.myClips.signInDesc}</p>
        <Link href="/">
          <Button className="w-full max-w-[200px] bg-primary text-white">{t.myClips.signInButton}</Button>
        </Link>
      </motion.div>
    );
  }

  const savedCount = savedClips?.length ?? 0;
  const createdCount = userClips?.length ?? 0;

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 pt-6 pb-0 bg-white border-b sticky top-0 z-10 shadow-sm"
      >
        <h1 className="text-2xl font-bold text-foreground px-0 mb-3">{t.myClips.title}</h1>

        {/* Tabs */}
        <div className="flex gap-0 -mx-4">
          <button
            onClick={() => setTab("saved")}
            className={`flex-1 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === "saved"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground"
            }`}
          >
            {t.myClips.tabSaved}
            {savedCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-muted text-muted-foreground rounded-full px-1.5 py-0.5">
                {savedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab("created")}
            className={`flex-1 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
              tab === "created"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground"
            }`}
          >
            <Scissors className="w-3.5 h-3.5" />
            {t.myClips.tabCreated}
            {createdCount > 0 && (
              <span className="text-[10px] bg-muted text-muted-foreground rounded-full px-1.5 py-0.5">
                {createdCount}
              </span>
            )}
          </button>
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 py-6 pb-24">
        <AnimatePresence mode="wait">
          {tab === "saved" ? (
            <motion.div
              key="saved"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
            >
              <SavedTab clips={savedClips} isLoading={savedLoading} />
            </motion.div>
          ) : (
            <motion.div
              key="created"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              <CreatedTab clips={userClips} isLoading={userClipsLoading} onPlay={setActiveClip} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Inline player overlay */}
      <AnimatePresence>
        {activeClip && (
          <UserClipPlayer clip={activeClip} onClose={() => setActiveClip(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Saved tab                                                           */
/* ------------------------------------------------------------------ */

function SavedTab({ clips, isLoading }: { clips: Clip[] | undefined; isLoading: boolean }) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
            className="aspect-[3/4] bg-muted rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (!clips || clips.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }}
        className="text-center py-20"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 18, delay: 0.1 } }}
          className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4"
        >
          <Video className="w-8 h-8 text-muted-foreground" />
        </motion.div>
        <p className="text-muted-foreground">{t.myClips.noClipsYet}</p>
        <p className="text-sm text-muted-foreground mt-1">{t.myClips.noClipsDesc}</p>
        <Link href="/watch">
          <Button variant="outline" className="mt-6">{t.myClips.goToWatch}</Button>
        </Link>
      </motion.div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {clips.map((clip, i) => (
        <SavedClipCard key={clip.id} clip={clip} index={i} />
      ))}
    </div>
  );
}

function SavedClipCard({ clip, index }: { clip: Clip; index: number }) {
  const thumbnailUrl = getBunnyThumbnailUrl(clip);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{
        opacity: 1, scale: 1, y: 0,
        transition: { delay: index * 0.07, duration: 0.4, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.95 }}
    >
      <Link href={`/player/${clip.id}`}>
        <div className="relative aspect-[3/4] rounded-xl overflow-hidden shadow-sm group cursor-pointer">
          <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />

          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={clip.momentLabel}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <div className="absolute inset-0 group-hover:bg-white/5 transition-colors duration-200" />

          <div className="absolute top-2 start-2 bg-primary text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm">
            {clip.momentLabel}
          </div>

          <div className="absolute bottom-2 start-2 end-2">
            <h3 className="text-white font-bold text-sm leading-tight mb-0.5 line-clamp-2">
              {clip.fieldName}
            </h3>
            <p className="text-primary text-[10px] font-medium">
              {clip.court} • {clip.date}
            </p>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Created tab                                                         */
/* ------------------------------------------------------------------ */

function CreatedTab({
  clips,
  isLoading,
  onPlay,
}: {
  clips: UserClip[] | undefined;
  isLoading: boolean;
  onPlay: (clip: UserClip) => void;
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
            className="aspect-[3/4] bg-muted rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (!clips || clips.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }}
        className="text-center py-20"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 18, delay: 0.1 } }}
          className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4"
        >
          <Scissors className="w-8 h-8 text-muted-foreground" />
        </motion.div>
        <p className="text-muted-foreground font-medium">{t.myClips.noCreatedYet}</p>
        <p className="text-sm text-muted-foreground mt-1">{t.myClips.noCreatedDesc}</p>
        <Link href="/fields">
          <Button variant="outline" className="mt-6">{t.myClips.goToFields}</Button>
        </Link>
      </motion.div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {clips.map((clip, i) => (
        <UserClipCard key={clip.id} clip={clip} index={i} onPlay={onPlay} />
      ))}
    </div>
  );
}

function UserClipCard({
  clip,
  index,
  onPlay,
}: {
  clip: UserClip;
  index: number;
  onPlay: (clip: UserClip) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteUserClip = useDeleteUserClip();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const startPct = (clip.startTime * 100).toFixed(0);
  const endPct = (clip.endTime * 100).toFixed(0);
  const durationHint = `${startPct}%–${endPct}%`;

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    try {
      await deleteUserClip.mutateAsync({ id: clip.id });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
    } catch {
      toast({ title: "Failed to delete clip", variant: "destructive" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{
        opacity: 1, scale: 1, y: 0,
        transition: { delay: index * 0.07, duration: 0.4, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.95 }}
      onClick={() => onPlay(clip)}
      className="relative aspect-[3/4] rounded-xl overflow-hidden shadow-sm group cursor-pointer"
    >
      {clip.thumbnailUrl ? (
        <img
          src={clip.thumbnailUrl}
          alt={clip.title}
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
      <div className="absolute inset-0 group-hover:bg-white/5 transition-colors duration-200" />

      {/* Scissors badge */}
      <div className="absolute top-2 start-2 bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
        <Scissors className="w-2.5 h-2.5" />
        {durationHint}
      </div>

      {/* Delete button */}
      <button
        onClick={handleDelete}
        className={`absolute top-2 end-2 w-6 h-6 rounded-full flex items-center justify-center transition-colors z-10 ${
          confirmDelete
            ? "bg-destructive text-white"
            : "bg-black/40 text-white/70 hover:bg-black/60"
        }`}
        aria-label="Delete clip"
      >
        <Trash2 className="w-3 h-3" />
      </button>

      <div className="absolute bottom-2 start-2 end-2">
        <h3 className="text-white font-bold text-sm leading-tight mb-0.5 line-clamp-2">
          {clip.title}
        </h3>
        <p className="text-primary text-[10px] font-medium">
          {new Date(clip.createdAt).toLocaleDateString()}
        </p>
      </div>
    </motion.div>
  );
}
