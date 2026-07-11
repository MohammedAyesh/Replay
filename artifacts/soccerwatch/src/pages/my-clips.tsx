import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import {
  useListUserClips,
  useDeleteUserClip,
  useUpdateUserClip,
  getListUserClipsQueryKey,
  UserClip,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, Video, Scissors, Trash2, X, Play, Pause, Download, Maximize, Minimize, Lock, Globe, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import Hls from "hls.js";
import { exportClip, canExportVideo, triggerDownload } from "@/lib/exportClip";
import { saveLocalClip, getLocalClip, listLocalClips, deleteLocalClip, createLocalBlobUrl, revokeLocalBlobUrl, type LocalClipRecord } from "@/lib/localClips";

function localThumbnailUrl(record: LocalClipRecord): string | null {
  if (record.playbackUrl) {
    return record.playbackUrl.replace("/playlist.m3u8", "/thumbnail.jpg");
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

type ExportState = "idle" | "exporting" | "done" | "error";

function UserClipPlayer({ clip, onClose, onDownloaded }: { clip: UserClip; onClose: () => void; onDownloaded?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const rafRef = useRef<number>(0);
  const localUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportProgress, setExportProgress] = useState(0);
  const [isLocal, setIsLocal] = useState(false);
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const keyframes = clip.cropPath ?? [];
  // startTime/endTime are 0–1 fractions of total video duration

  /* Check IndexedDB for local copy on mount */
  useEffect(() => {
    let cancelled = false;
    async function checkLocal() {
      const local = await getLocalClip(clip.id);
      if (cancelled || !local) return;
      const url = createLocalBlobUrl(local);
      localUrlRef.current = url;
      setIsLocal(true);
      const video = videoRef.current;
      if (video) {
        if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
        video.pause();
        video.src = url;
        video.addEventListener("loadedmetadata", () => {
          const dur = video.duration || 0;
          if (dur > 0) {
            video.currentTime = clip.startTime * dur;
            video.play().then(() => setIsPlaying(true)).catch(() => {});
          }
        }, { once: true });
      }
    }
    checkLocal();
    return () => {
      cancelled = true;
      if (localUrlRef.current) {
        revokeLocalBlobUrl(localUrlRef.current);
        localUrlRef.current = null;
      }
    };
  }, [clip.id, clip.startTime]);

  /* HLS init — only if no local copy */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip.playbackUrl || isLocal) return;

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
      // Local 9:16 clips are already cropped — no panning needed
      if (!video || !scrollEl || keyframes.length === 0 || (isLocal && clip.aspectRatio === "9:16")) {
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
      const kfW = keyframes[0]?.w ?? 1;
      const cropCenterPx = (x + kfW / 2) * totalW;
      scrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, cropCenterPx - viewW / 2));

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [keyframes, clip.startTime, clip.endTime, isLocal, clip.aspectRatio]);

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

  const handleExport = useCallback(async () => {
    if (exportState === "exporting") return;

    if (!clip.playbackUrl) {
      toast({ title: t.export.noUrl, variant: "destructive" });
      return;
    }

    const supportsCapture = canExportVideo();

    setExportState("exporting");
    setExportProgress(0);

    try {
      const result = await exportClip({
        playbackUrl: clip.playbackUrl,
        startTime: clip.startTime,
        endTime: clip.endTime,
        cropPath: clip.cropPath ?? [],
        title: clip.title,
        aspectRatio: clip.aspectRatio,
        onProgress: (p) => setExportProgress(Math.round(p * 100)),
        returnBlob: true,
      });

      if (result && typeof result === "object" && "blob" in result) {
        const ext = result.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
        const filename = `${clip.title || "clip"}.${ext}`;
        const record = {
          clipId: clip.id,
          userId: user?.id ?? 0,
          title: clip.title,
          blob: result.blob,
          mimeType: result.mimeType,
          startTime: clip.startTime,
          endTime: clip.endTime,
          cropPath: (clip.cropPath ?? []).map((k) => ({ t: k.t, x: k.x, y: k.y, w: k.w, h: k.h })),
          aspectRatio: clip.aspectRatio ?? "16:9",
          downloadedAt: new Date().toISOString(),
          playbackUrl: clip.playbackUrl,
        };

        // 1. Save to local IndexedDB gallery
        await saveLocalClip(record);

        // 2. Save file to device gallery/downloads
        const file = new File([result.blob], filename, { type: result.mimeType });
        const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
        if (nav.canShare?.({ files: [file] })) {
          try { await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ files: [file], title: clip.title }); } catch { /* user dismissed */ }
        } else {
          triggerDownload(result.blob, filename);
        }

        // 3. Notify parent so Saved tab refreshes
        onDownloaded?.();

        setIsLocal(true);
        // Immediately switch video to local Blob URL so it plays cropped 9:16
        const localUrl = createLocalBlobUrl(record);
        localUrlRef.current = localUrl;
        const video = videoRef.current;
        if (video) {
          if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
          video.pause();
          video.src = localUrl;
          video.addEventListener("loadedmetadata", () => {
            const dur = video.duration || 0;
            if (dur > 0) {
              video.currentTime = clip.startTime * dur;
              video.play().then(() => setIsPlaying(true)).catch(() => {});
            }
          }, { once: true });
        }
      }

      setExportState("done");
      toast({ title: "Saved to gallery", description: "Clip saved to your device and appears in Saved." });

      setTimeout(() => setExportState("idle"), 3000);
    } catch {
      setExportState("error");
      toast({
        title: t.export.error,
        description: t.export.errorDesc,
        variant: "destructive",
      });
      setTimeout(() => setExportState("idle"), 3000);
    }
  }, [clip, exportState, t, toast, user?.id]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
      {/* Scrollable panoramic video — portrait for 9:16, landscape for 16:9 */}
      <div className={`absolute inset-0 flex items-center bg-black ${clip.aspectRatio === "9:16" ? "justify-center" : ""}`}>
        <div
          ref={scrollRef}
          dir="ltr"
          className={clip.aspectRatio === "9:16"
            ? "h-full aspect-[9/16] overflow-x-auto overflow-y-hidden no-scrollbar relative"
            : "w-full aspect-[16/9] overflow-x-auto overflow-y-hidden touch-pan-x no-scrollbar relative"}
        >
          <video
            ref={videoRef}
            className={isLocal && clip.aspectRatio === "9:16" ? "h-full w-full object-cover pointer-events-none" : "h-full max-w-none pointer-events-none"}
            style={isLocal && clip.aspectRatio === "9:16" ? { aspectRatio: "9/16" } : { aspectRatio: "3840/1080" }}
            playsInline
            loop={false}
            muted={false}
          />
          {/* Tap to play/pause */}
          <button
            onClick={togglePlay}
            className="absolute inset-0 z-10"
            aria-label={isPlaying ? "Pause" : "Play"}
          />
        </div>
      </div>

      {/* Top close button */}
      <div className="absolute top-safe pt-4 px-4 w-full flex items-center justify-between z-20 pointer-events-none">
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white pointer-events-auto active:scale-95 transition-transform"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="w-10" />
      </div>

      {/* Bottom controls — floating overlay, not a separate bar */}
      <div className="absolute bottom-safe left-0 right-0 z-20 px-4 pb-3 flex items-end gap-3 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)", paddingTop: "3rem" }}>
        <div className="flex-1 min-w-0 pb-1 pointer-events-auto">
          <p className="text-white font-bold text-sm truncate drop-shadow">{clip.title}</p>
          <p className="text-white/70 text-xs drop-shadow">
            {clip.aspectRatio ?? "16:9"} · {new Date(clip.createdAt).toLocaleDateString()}
          </p>
        </div>

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={exportState === "exporting"}
          className={`flex items-center gap-1.5 px-3 h-10 rounded-full text-sm font-semibold transition-all active:scale-95 shrink-0 pointer-events-auto ${
            exportState === "exporting"
              ? "bg-white/20 text-white/60 cursor-not-allowed"
              : exportState === "done"
              ? "bg-green-500 text-white"
              : exportState === "error"
              ? "bg-red-500/80 text-white"
              : "bg-white/15 text-white hover:bg-white/25"
          }`}
          aria-label={t.export.button}
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>
            {exportState === "exporting"
              ? t.export.exporting(exportProgress)
              : t.export.button}
          </span>
        </button>

        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          className="w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 active:scale-95 transition-all shrink-0 pointer-events-auto"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </button>

        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-black active:scale-95 transition-transform shrink-0 pointer-events-auto"
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
  const { isGuest, user } = useAuth();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("saved");
  const [activeClip, setActiveClip] = useState<UserClip | null>(null);
  const [publishClip, setPublishClip] = useState<UserClip | null>(null);
  const [localClips, setLocalClips] = useState<LocalClipRecord[]>([]);
  const [localLoading, setLocalLoading] = useState(true);

  const loadLocalClips = useCallback(async () => {
    if (!user?.id) return;
    try {
      const clips = await listLocalClips(user.id);
      setLocalClips(clips.sort((a, b) => new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime()));
    } catch { /* ignore */ }
    setLocalLoading(false);
  }, [user?.id]);

  useEffect(() => {
    if (!isGuest) loadLocalClips();
    else setLocalLoading(false);
  }, [isGuest, loadLocalClips]);

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

  const savedCount = localClips.length;
  const createdCount = userClips?.length ?? 0;

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 pt-6 pb-0 bg-background sticky top-0 z-10"
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
              <SavedTab
                clips={localClips}
                isLoading={localLoading}
                onPlay={(r) => setActiveClip(localToUserClip(r))}
                onDelete={async (clipId) => {
                  await deleteLocalClip(clipId);
                  loadLocalClips();
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="created"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
            >
              <CreatedTab
                clips={userClips}
                isLoading={userClipsLoading}
                onPlay={setActiveClip}
                onPublish={setPublishClip}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Inline player overlay */}
      <AnimatePresence>
        {activeClip && (
          <UserClipPlayer
            clip={activeClip}
            onClose={() => setActiveClip(null)}
            onDownloaded={loadLocalClips}
          />
        )}
      </AnimatePresence>

      {/* Publish panel */}
      <AnimatePresence>
        {publishClip && (
          <PublishPanel clip={publishClip} onClose={() => setPublishClip(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function localToUserClip(r: LocalClipRecord): UserClip {
  return {
    id: r.clipId,
    title: r.title,
    startTime: r.startTime,
    endTime: r.endTime,
    cropPath: r.cropPath as unknown as UserClip["cropPath"],
    playbackUrl: r.playbackUrl,
    thumbnailUrl: localThumbnailUrl(r),
    createdAt: r.downloadedAt,
    aspectRatio: r.aspectRatio as UserClip["aspectRatio"],
  } as unknown as UserClip;
}

/* ------------------------------------------------------------------ */
/*  Saved tab — local IndexedDB clips (downloaded to device)           */
/* ------------------------------------------------------------------ */

function SavedTab({
  clips,
  isLoading,
  onPlay,
  onDelete,
}: {
  clips: LocalClipRecord[];
  isLoading: boolean;
  onPlay: (r: LocalClipRecord) => void;
  onDelete: (clipId: number) => void;
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

  if (clips.length === 0) {
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
          <Download className="w-8 h-8 text-muted-foreground" />
        </motion.div>
        <p className="text-muted-foreground">{t.myClips.noClipsYet}</p>
        <p className="text-sm text-muted-foreground mt-1">Download clips from the Watch feed to see them here.</p>
        <Link href="/watch">
          <Button variant="ghost" className="mt-6 text-primary font-semibold">{t.myClips.goToWatch}</Button>
        </Link>
      </motion.div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {clips.map((record, i) => (
        <LocalClipCard key={record.clipId} record={record} index={i} onPlay={onPlay} onDelete={onDelete} />
      ))}
    </div>
  );
}

function LocalClipCard({
  record,
  index,
  onPlay,
  onDelete,
}: {
  record: LocalClipRecord;
  index: number;
  onPlay: (r: LocalClipRecord) => void;
  onDelete: (clipId: number) => void;
}) {
  const thumbnailUrl = localThumbnailUrl(record);
  const [showDelete, setShowDelete] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{
        opacity: 1, scale: 1, y: 0,
        transition: { delay: index * 0.07, duration: 0.4, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.97 }}
      className="relative"
    >
      <button
        onClick={() => onPlay(record)}
        className="w-full text-left"
      >
        <div className="relative aspect-[3/4] rounded-xl overflow-hidden group cursor-pointer">
          <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />

          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={record.title}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <div className="absolute inset-0 group-hover:bg-white/5 transition-colors duration-200" />

          <div className="absolute top-2 start-2 bg-primary/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
            <Download className="w-2.5 h-2.5" />
            Saved
          </div>

          <div className="absolute bottom-2 start-2 end-8">
            <h3 className="text-white font-bold text-sm leading-tight line-clamp-2">{record.title}</h3>
            <p className="text-white/50 text-[10px] mt-0.5">
              {new Date(record.downloadedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </button>

      {/* Delete button */}
      <button
        onClick={() => setShowDelete(true)}
        className="absolute bottom-3 end-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center active:opacity-70 transition-opacity z-10"
        title="Remove from saved"
      >
        <Trash2 className="w-3 h-3 text-white/80" />
      </button>

      {/* Delete confirmation */}
      <AnimatePresence>
        {showDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 rounded-xl bg-black/80 flex flex-col items-center justify-center gap-2 z-20"
          >
            <p className="text-white text-xs font-semibold text-center px-2">Remove from saved?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDelete(false)}
                className="px-3 py-1.5 rounded-lg bg-white/20 text-white text-xs font-medium"
              >Cancel</button>
              <button
                onClick={() => { setShowDelete(false); onDelete(record.clipId); }}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-semibold"
              >Remove</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
  onPublish,
}: {
  clips: UserClip[] | undefined;
  isLoading: boolean;
  onPlay: (clip: UserClip) => void;
  onPublish: (clip: UserClip) => void;
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
        <UserClipCard key={clip.id} clip={clip} index={i} onPlay={onPlay} onPublish={onPublish} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Publish panel — bottom sheet                                        */
/* ------------------------------------------------------------------ */

function PublishPanel({ clip, onClose }: { clip: UserClip; onClose: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [visibility, setVisibility] = useState<"public" | "followers">("public");
  const [thumbnailTime, setThumbnailTime] = useState(clip.thumbnailTime ?? 0);
  const [duration, setDuration] = useState(0);
  const [isPublishing, setIsPublishing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateUserClip = useUpdateUserClip();

  useEffect(() => {
    if (!clip.playbackUrl) return;
    const video = videoRef.current;
    if (!video) return;

    const onReady = () => {
      const dur = video.duration || 0;
      setDuration(dur);
      const t = clip.thumbnailTime != null ? clip.thumbnailTime : clip.startTime * dur;
      video.currentTime = t;
      setThumbnailTime(t);
    };

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(clip.playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = clip.playbackUrl;
      video.addEventListener("loadedmetadata", onReady, { once: true });
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.playbackUrl]);

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    setThumbnailTime(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    try {
      await updateUserClip.mutateAsync({
        id: clip.id,
        data: { title: title.trim() || clip.title, visibility, thumbnailTime },
      });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
      toast({ title: "Clip published!", className: "bg-primary text-white border-none" });
      onClose();
    } catch {
      toast({ title: "Failed to publish", variant: "destructive" });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        className="w-full bg-zinc-900 rounded-t-2xl px-4 pt-4 pb-safe"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-4" />

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-lg">Publish Clip</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Thumbnail frame picker */}
        <div className="mb-4">
          <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-2">Thumbnail Frame</p>
          <div className="relative aspect-video rounded-xl overflow-hidden bg-black mb-2">
            <video
              ref={videoRef}
              muted
              playsInline
              preload="metadata"
              className="w-full h-full object-cover"
            />
            {!clip.playbackUrl && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-white/40 text-xs">No preview available</p>
              </div>
            )}
          </div>
          {duration > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-white/40 text-[10px] tabular-nums">
                {Math.floor(thumbnailTime / 60)}:{String(Math.floor(thumbnailTime % 60)).padStart(2, "0")}
              </span>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.25}
                value={thumbnailTime}
                onChange={handleScrub}
                className="flex-1 accent-primary h-1"
              />
              <span className="text-white/40 text-[10px] tabular-nums">
                {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}
              </span>
            </div>
          )}
        </div>

        {/* Title */}
        <div className="mb-4">
          <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-2">Title</p>
          <input
            className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-white/40 outline-none focus:border-primary transition-colors"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Clip title"
          />
        </div>

        {/* Visibility */}
        <div className="mb-5">
          <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-2">Visibility</p>
          <div className="grid grid-cols-2 gap-2">
            {([["public", "Public", Globe], ["followers", "Followers", Users]] as const).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition-colors ${
                  visibility === v
                    ? "bg-primary border-primary text-white"
                    : "bg-white/10 border-white/20 text-white/60"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pb-3">
          <button
            onClick={onClose}
            className="flex-1 bg-white/10 border border-white/20 rounded-xl py-3 text-white text-sm font-semibold active:scale-95 transition-transform"
          >
            Keep Private
          </button>
          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="flex-[2] bg-primary rounded-xl py-3 text-white text-sm font-bold active:scale-95 transition-transform disabled:opacity-60"
          >
            {isPublishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Individual clip card in Created grid                               */
/* ------------------------------------------------------------------ */

function UserClipCard({
  clip,
  index,
  onPlay,
  onPublish,
}: {
  clip: UserClip;
  index: number;
  onPlay: (clip: UserClip) => void;
  onPublish: (clip: UserClip) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteUserClip = useDeleteUserClip();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const startPct = (clip.startTime * 100).toFixed(0);
  const endPct = (clip.endTime * 100).toFixed(0);
  const durationHint = `${startPct}%–${endPct}%`;
  const isPrivate = clip.visibility === "private";

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

      {/* Top-left badge: lock for private, scissors for public */}
      {isPrivate ? (
        <div className="absolute top-2 start-2 bg-black/60 text-amber-400 text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
          <Lock className="w-2.5 h-2.5" />
          Private
        </div>
      ) : (
        <div className="absolute top-2 start-2 bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
          <Scissors className="w-2.5 h-2.5" />
          {durationHint}
        </div>
      )}

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
        <h3 className="text-white font-bold text-sm leading-tight mb-1 line-clamp-1">
          {clip.title}
        </h3>
        {isPrivate ? (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPublish(clip); }}
            className="w-full bg-primary/90 backdrop-blur-sm text-white text-[11px] font-bold py-1.5 rounded-lg active:scale-95 transition-transform"
          >
            Publish →
          </button>
        ) : (
          <p className="text-primary text-[10px] font-medium">
            {new Date(clip.createdAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </motion.div>
  );
}
