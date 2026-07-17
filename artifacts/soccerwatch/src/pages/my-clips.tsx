import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import {
  useListUserClips,
  useDeleteUserClip,
  getListUserClipsQueryKey,
  UserClip,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, Video, Scissors, Trash2, X, Play, Pause, Download, Maximize, Minimize, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
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

type ExportState = "idle" | "polling" | "ready" | "error";

function isLandscape() {
  return window.innerWidth > window.innerHeight;
}

function UserClipPlayer({ clip, onClose, onDownloaded }: { clip: UserClip; onClose: () => void; onDownloaded?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const rafRef = useRef<number>(0);
  const localUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [landscape, setLandscape] = useState(() => isLandscape());
  const [exportState, setExportState] = useState<ExportState>(
    clip.exportStatus === "done" ? "ready" : "idle"
  );
  const [exportedUrl, setExportedUrl] = useState<string | null>(clip.exportedUrl ?? null);
  /** Set to false on unmount to abort the polling loop. */
  const pollingRef = useRef(false);
  const [isLocal, setIsLocal] = useState(false);
  /**
   * Local blobs are already trimmed+cropped (they start at t=0 and run to clipDuration).
   * localTimingOverride tracks this: when set, use these fractions instead of clip.startTime/endTime
   * for seek and stop logic so we play from 0 → 1 of the blob, not some fraction of recording duration.
   */
  const [localTimingOverride, setLocalTimingOverride] = useState<{ start: number; end: number } | null>(null);
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { setFullscreenVideo } = useFullscreenVideo();
  const keyframes = clip.cropPath ?? [];

  // Notify layout that a fullscreen video is active — suppresses orientation lock
  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  // Effective timing: use override for local blobs, raw clip fractions for HLS
  const lStart = isLocal ? (localTimingOverride?.start ?? 0) : clip.startTime;
  const lEnd   = isLocal ? (localTimingOverride?.end   ?? 1) : clip.endTime;

  /* Check IndexedDB for local copy on mount */
  useEffect(() => {
    let cancelled = false;
    let cleanupListeners: (() => void) | null = null;
    async function checkLocal() {
      const local = await getLocalClip(clip.id);
      if (cancelled || !local) return;
      const url = createLocalBlobUrl(local);
      localUrlRef.current = url;
      // Local blobs are trimmed clips — always play from 0 to end
      setLocalTimingOverride({ start: 0, end: 1 });
      setIsLocal(true);
      const video = videoRef.current;
      if (video) {
        if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
        video.pause();
        video.src = url;
        let didSeek = false;
        const seekLocal = () => {
          const dur = video.duration || 0;
          if (didSeek || !(dur > 0 && isFinite(dur))) return;
          didSeek = true;
          video.currentTime = 0;
          video.play().then(() => setIsPlaying(true)).catch(() => {});
        };
        video.addEventListener("loadedmetadata", seekLocal);
        video.addEventListener("durationchange", seekLocal);
        cleanupListeners = () => {
          video.removeEventListener("loadedmetadata", seekLocal);
          video.removeEventListener("durationchange", seekLocal);
        };
      }
    }
    checkLocal();
    return () => {
      cancelled = true;
      cleanupListeners?.();
      if (localUrlRef.current) {
        revokeLocalBlobUrl(localUrlRef.current);
        localUrlRef.current = null;
      }
    };
  }, [clip.id]);

  /* HLS init — only if no local copy */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip.playbackUrl || isLocal) return;

    let didSeek = false;
    function seekToStartAndPlay() {
      if (!video || didSeek) return;
      const dur = video.duration || 0;
      if (!(dur > 0 && isFinite(dur) && isFinite(clip.startTime))) return;
      didSeek = true;
      video.currentTime = clip.startTime * dur;
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    }

    video.addEventListener("loadedmetadata", seekToStartAndPlay);
    video.addEventListener("durationchange", seekToStartAndPlay);

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(clip.playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, seekToStartAndPlay);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = clip.playbackUrl;
    }

    return () => {
      video.removeEventListener("loadedmetadata", seekToStartAndPlay);
      video.removeEventListener("durationchange", seekToStartAndPlay);
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

      const sSec = isFinite(lStart) ? lStart * dur : 0;
      const eSec = isFinite(lEnd) ? lEnd * dur : dur;
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
  }, [keyframes, lStart, lEnd, isLocal, clip.aspectRatio]);

  /* Auto-stop when clip window ends — read duration live from the element */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const dur = video.duration || 0;
      if (dur === 0) return;
      const sSec = isFinite(lStart) ? lStart * dur : 0;
      const eSec = isFinite(lEnd) ? lEnd * dur : dur;
      if (video.currentTime >= eSec) {
        video.pause();
        setIsPlaying(false);
        video.currentTime = sSec;
      }
    };
    const id = setInterval(onTime, 100);
    return () => clearInterval(id);
  }, [lStart, lEnd]);

  /**
   * Enter fullscreen.
   * iOS Safari / Chrome iOS only support webkitEnterFullscreen on the
   * <video> element, and it MUST come from a user gesture (tap).
   * The standard Fullscreen API works on Android / Desktop.
   */
  const tryEnterFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      const iosFull = (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen;
      if (iosFull) {
        try { iosFull.call(video); } catch { /* iOS requires user gesture */ }
      }
      return;
    }
    if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen === "function") {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const tryExitFullscreen = useCallback(() => {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      const video = videoRef.current;
      const iosExit = video && (video as HTMLVideoElement & { webkitExitFullscreen?: () => void }).webkitExitFullscreen;
      if (iosExit) { try { iosExit.call(video); } catch {} }
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration || 0;
    if (dur === 0) return;
    const sSec = isFinite(lStart) ? lStart * dur : 0;
    const eSec = isFinite(lEnd) ? lEnd * dur : dur;
    if (video.paused) {
      if (video.currentTime >= eSec) video.currentTime = sSec;
      // iOS: entering fullscreen requires a user gesture — tap qualifies
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIOS && isLandscape()) tryEnterFullscreen();
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [lStart, lEnd, tryEnterFullscreen]);

  /* Stop polling when the player closes */
  useEffect(() => () => { pollingRef.current = false; }, []);

  /* Fullscreen toggle */
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      tryEnterFullscreen();
    } else {
      tryExitFullscreen();
    }
  }, [tryEnterFullscreen, tryExitFullscreen]);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  /* Track orientation so controls can reflow */
  useEffect(() => {
    const update = () => setLandscape(isLandscape());
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("orientationchange", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  /**
   * Deliver a blob (client-side fallback path) — saves to IDB and triggers
   * share sheet or file download.
   */
  const deliverBlob = useCallback(async (blob: Blob, mimeType: string) => {
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const filename = `${clip.title || "clip"}.${ext}`;
    const record: Parameters<typeof saveLocalClip>[0] = {
      clipId: clip.id,
      userId: user?.id ?? 0,
      title: clip.title,
      blob,
      mimeType,
      startTime: 0,
      endTime: 1,
      cropPath: (clip.cropPath ?? []).map((k) => ({ t: k.t, x: k.x, y: k.y, w: k.w, h: k.h })),
      aspectRatio: clip.aspectRatio ?? "16:9",
      downloadedAt: new Date().toISOString(),
      playbackUrl: clip.playbackUrl ?? null,
    };
    await saveLocalClip(record);
    const file = new File([blob], filename, { type: mimeType });
    const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try { await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ files: [file], title: clip.title }); }
      catch { /* dismissed */ }
    } else {
      triggerDownload(blob, filename);
    }
    onDownloaded?.();
    setLocalTimingOverride({ start: 0, end: 1 });
    setIsLocal(true);
    const localUrl = createLocalBlobUrl(record);
    localUrlRef.current = localUrl;
    const video = videoRef.current;
    if (video) {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.pause();
      video.src = localUrl;
      video.addEventListener("loadedmetadata", () => {
        video.currentTime = 0;
        video.play().then(() => setIsPlaying(true)).catch(() => {});
      }, { once: true });
    }
  }, [clip, user?.id, onDownloaded]);

  /**
   * Fetch the server-rendered MP4 through our proxy and deliver to the device.
   * The proxy avoids CORS issues and sets proper Content-Disposition headers.
   */
  const deliverViaProxy = useCallback(async () => {
    const filename = `${clip.title || "clip"}.mp4`;
    const res = await fetch(`/api/user-clips/${clip.id}/download`, { credentials: "include" });
    if (!res.ok) throw new Error("Proxy download failed");
    const blob = await res.blob();

    // Save to local IndexedDB so it appears in the Saved tab
    await saveLocalClip({
      clipId: clip.id,
      userId: user?.id ?? 0,
      title: clip.title,
      blob,
      mimeType: "video/mp4",
      startTime: clip.startTime,
      endTime: clip.endTime,
      cropPath: (clip.cropPath ?? []).map((k) => ({ t: k.t, x: k.x, y: k.y, w: k.w, h: k.h })),
      aspectRatio: clip.aspectRatio ?? "16:9",
      downloadedAt: new Date().toISOString(),
      playbackUrl: clip.playbackUrl ?? null,
    });
    onDownloaded?.();

    const file = new File([blob], filename, { type: "video/mp4" });
    const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try { await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ files: [file], title: clip.title }); }
      catch { /* dismissed */ }
    } else {
      triggerDownload(blob, filename);
    }
    toast({ title: "Saved!", description: "Clip saved to your device." });
  }, [clip, user?.id, toast, onDownloaded]);

  const handleExport = useCallback(async () => {
    if (exportState === "polling") return;

    // Already exported — re-deliver without re-rendering
    if (exportState === "ready" && exportedUrl) {
      await deliverViaProxy();
      return;
    }

    if (!clip.playbackUrl) {
      toast({ title: t.export.noUrl, variant: "destructive" });
      return;
    }

    setExportState("polling");
    pollingRef.current = true;

    try {
      const startRes = await fetch(`/api/user-clips/${clip.id}/export`, {
        method: "POST",
        credentials: "include",
      });

      if (!startRes.ok) {
        // Bunny storage not configured — fall back to client-side capture
        const result = await exportClip({
          playbackUrl: clip.playbackUrl,
          startTime: clip.startTime,
          endTime: clip.endTime,
          cropPath: clip.cropPath ?? [],
          title: clip.title,
          aspectRatio: clip.aspectRatio,
          returnBlob: true,
        });
        if (result && typeof result === "object" && "blob" in result) {
          await deliverBlob(result.blob, result.mimeType);
          pollingRef.current = false;
          setExportState("ready");
        } else {
          throw new Error("Client-side export produced no output");
        }
        return;
      }

      const startData = await startRes.json() as { status: string; url?: string };

      if (startData.status === "done" && startData.url) {
        // Was already exported before — deliver right away
        setExportedUrl(startData.url);
        pollingRef.current = false;
        setExportState("ready");
        await deliverViaProxy();
        return;
      }

      // status === "pending" — poll until done (max 3 minutes)
      const maxAttempts = 90;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        if (!pollingRef.current) return; // player closed

        const statusRes = await fetch(`/api/user-clips/${clip.id}/export-status`, { credentials: "include" });
        if (!statusRes.ok) throw new Error("Status check failed");
        const status = await statusRes.json() as { status: string; url?: string };

        if (status.status === "done" && status.url) {
          setExportedUrl(status.url);
          pollingRef.current = false;
          setExportState("ready");
          await deliverViaProxy();
          return;
        }
        if (status.status === "error") throw new Error("Server render failed");
        // still pending — keep polling
      }

      throw new Error("Export timed out after 3 minutes");
    } catch {
      pollingRef.current = false;
      setExportState("error");
      toast({ title: t.export.error, description: t.export.errorDesc, variant: "destructive" });
      setTimeout(() => setExportState("idle"), 4000);
    }
  }, [clip, exportState, exportedUrl, t, toast, deliverBlob, deliverViaProxy]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
      <div className={`w-full flex ${landscape ? "flex-row" : "flex-col"}`} style={{ height: "100dvh" }}>
        {/* Video area */}
        <div className={`flex items-center bg-black min-h-0 ${landscape ? "flex-1 h-full" : "flex-1 w-full relative"} ${clip.aspectRatio === "9:16" ? "justify-center" : ""}`}>
          <div
            ref={scrollRef}
            dir="ltr"
            className={clip.aspectRatio === "9:16"
              ? "h-full aspect-[9/16] overflow-x-auto overflow-y-hidden no-scrollbar relative"
              : "h-full overflow-x-auto overflow-y-hidden touch-pan-x no-scrollbar relative"}
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

          {/* Floating close — always top-left of video */}
          <div className={`absolute ${landscape ? "top-3 left-3" : "top-safe pt-3 px-3"} z-30 pointer-events-none`}>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white pointer-events-auto active:scale-95 transition-transform"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Controls panel — bottom bar in portrait, side rail in landscape */}
        <div
          className={landscape
            ? "w-[220px] h-full flex flex-col justify-end gap-3 px-4 py-4 bg-black/90 backdrop-blur-md z-20 pointer-events-auto shrink-0"
            : "w-full px-4 pb-safe pt-3 flex items-end gap-3 pointer-events-auto shrink-0"
          }
          style={landscape ? undefined : { background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)", paddingTop: "3rem" }}
        >
          <div className={`${landscape ? "mb-auto" : "flex-1 min-w-0 pb-1"}`}>
            <p className="text-white font-bold text-sm truncate drop-shadow">{clip.title}</p>
            <p className="text-white/70 text-xs drop-shadow">
              {clip.aspectRatio ?? "16:9"} · {new Date(clip.createdAt).toLocaleDateString()}
            </p>
          </div>

          <div className={`flex items-center gap-3 ${landscape ? "flex-col w-full" : ""}`}>
            {/* Export button */}
            <button
              onClick={handleExport}
              disabled={exportState === "polling"}
              className={`flex items-center justify-center gap-1.5 px-3 h-10 rounded-full text-sm font-semibold transition-all active:scale-95 shrink-0 pointer-events-auto ${
                exportState === "polling"
                  ? "bg-white/20 text-white/60 cursor-not-allowed"
                  : exportState === "ready"
                  ? "bg-green-500 text-white"
                  : exportState === "error"
                  ? "bg-red-500/80 text-white"
                  : "bg-white/15 text-white hover:bg-white/25"
              } ${landscape ? "w-full" : ""}`}
              aria-label={t.export.button}
            >
              {exportState === "polling"
                ? <span className="w-4 h-4 shrink-0 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                : <Download className="w-4 h-4 shrink-0" />}
              <span>
                {exportState === "polling"
                  ? "Processing…"
                  : exportState === "ready"
                  ? "Download"
                  : exportState === "error"
                  ? t.export.error
                  : t.export.button}
              </span>
            </button>

            {/* Fullscreen toggle */}
            <button
              onClick={toggleFullscreen}
              className={`w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 active:scale-95 transition-all shrink-0 pointer-events-auto ${landscape ? "" : ""}`}
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
        </div>
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
        <Link href="/home">
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

/* ------------------------------------------------------------------ */
/*  Individual clip card in Created grid                               */
/* ------------------------------------------------------------------ */

function UserClipCard({
  clip,
  index,
  onPlay,
}: {
  clip: UserClip;
  index: number;
  onPlay: (clip: UserClip) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteUserClip = useDeleteUserClip();
  const [showDelete, setShowDelete] = useState(false);

  const startPct = (clip.startTime * 100).toFixed(0);
  const endPct = (clip.endTime * 100).toFixed(0);
  const durationHint = `${startPct}%–${endPct}%`;
  const isPrivate = clip.visibility === "private";

  const handleDelete = async () => {
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
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowDelete(true); }}
        className="absolute bottom-3 end-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center active:opacity-70 transition-opacity z-10"
        aria-label="Delete clip"
      >
        <Trash2 className="w-3 h-3 text-white/80" />
      </button>

      {/* Delete confirmation overlay */}
      <AnimatePresence>
        {showDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 rounded-xl bg-black/80 flex flex-col items-center justify-center gap-2 z-20"
          >
            <p className="text-white text-xs font-semibold text-center px-2">Delete clip?</p>
            <div className="flex gap-2">
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowDelete(false); }}
                className="px-3 py-1.5 rounded-lg bg-white/20 text-white text-xs font-medium"
              >Cancel</button>
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowDelete(false); handleDelete(); }}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-semibold"
              >Delete</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute bottom-2 start-2 end-2">
        <h3 className="text-white font-bold text-sm leading-tight mb-1 line-clamp-1">
          {clip.title}
        </h3>
        <p className="text-primary text-[10px] font-medium">
          {new Date(clip.createdAt).toLocaleDateString()}
        </p>
      </div>
    </motion.div>
  );
}
