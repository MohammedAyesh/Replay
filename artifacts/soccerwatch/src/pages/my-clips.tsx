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
import { cn } from "@/lib/utils";
import { applyFrameToVideo, frameToVideoStyle, interpolateFrame } from "@/lib/cropFrame";

/** How long to wait for the branding intro to actually start before skipping it. */
const INTRO_START_TIMEOUT_MS = 4000;

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

/** Format seconds as m:ss for the clip-relative timeline (never the full recording). */
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
   * Two-phase playback: play the academy's branding intro (if this clip has
   * one) before the real clip. Skipped entirely for local blobs — those are
   * either the server-rendered export (which already has the intro baked in)
   * or a client-exported fallback (a separate, smaller gap not handled here).
   */
  const [phase, setPhase] = useState<"intro" | "main">(clip.introVideoUrl ? "intro" : "main");
  useEffect(() => {
    setPhase(clip.introVideoUrl ? "intro" : "main");
  }, [clip.id, clip.introVideoUrl]);
  useEffect(() => {
    if (isLocal) setPhase("main");
  }, [isLocal]);
  /**
   * Local blobs are already trimmed+cropped (they start at t=0 and run to clipDuration).
   * localTimingOverride tracks this: when set, use these fractions instead of clip.startTime/endTime
   * for seek and stop logic so we play from 0 → 1 of the blob, not some fraction of recording duration.
   */
  const [localTimingOverride, setLocalTimingOverride] = useState<{ start: number; end: number } | null>(null);
  /**
   * Clip-relative timeline (seconds since the clip's own start, not the
   * underlying recording's absolute time). progressSec is always in
   * [0, clipDurationSec] regardless of where the clip sits inside the
   * source video or local blob.
   */
  const [progressSec, setProgressSec] = useState(0);
  const [clipDurationSec, setClipDurationSec] = useState(0);
  /** True while the user is dragging the scrub handle — suppresses timeupdate overwrites. */
  const seekDraggingRef = useRef(false);
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

  /* Intro playback — the academy's branding intro, before the real clip. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || phase !== "intro" || !clip.introVideoUrl || isLocal) return;

    let cancelled = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.src = clip.introVideoUrl;

    // A broken or unreachable intro must never trap the viewer — fall
    // through to the real clip on any failure, same as a normal finish.
    function advanceToMain() {
      if (cancelled) return;
      setPhase("main");
    }

    video.addEventListener("ended", advanceToMain);
    video.addEventListener("error", advanceToMain);
    video.addEventListener("stalled", advanceToMain);
    video.addEventListener("abort", advanceToMain);

    // Watchdog. The "error" event covers a source the browser rejects outright,
    // but not every way an intro can fail to start — a 401, a hung origin or an
    // autoplay block can leave the element sitting on a black first frame with
    // no event at all, and the real clip is gated behind this phase. If nothing
    // is actually playing shortly after we ask, move on.
    const watchdog = setTimeout(() => {
      if (!cancelled && (video.readyState < 2 || video.paused)) advanceToMain();
    }, INTRO_START_TIMEOUT_MS);

    video.play().then(() => setIsPlaying(true)).catch(() => {
      // Autoplay refused, or the source is unplayable. Either way the clip
      // itself must not be held back by the branding.
      advanceToMain();
    });

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      video.removeEventListener("ended", advanceToMain);
      video.removeEventListener("error", advanceToMain);
      video.removeEventListener("stalled", advanceToMain);
      video.removeEventListener("abort", advanceToMain);
    };
  }, [phase, clip.id, clip.introVideoUrl, isLocal]);

  /* HLS init — only if no local copy and the intro (if any) has finished */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip.playbackUrl || isLocal || phase !== "main") return;

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
  }, [clip.playbackUrl, clip.startTime, phase, isLocal]);

  /**
   * Pan loop. Writes the interpolated crop frame straight to the video element's
   * style (no React state), so the container — which has the clip's output aspect
   * ratio and a black background — shows real black bars wherever the frame
   * extends past the source.
   *
   * Local blobs are skipped entirely: they were already trimmed, cropped and
   * letterboxed by the server render, so re-applying the crop would double it.
   */
  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      if (!video || keyframes.length === 0 || isLocal) {
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
      const t = Math.max(0, Math.min(1, (video.currentTime - sSec) / cDur));
      applyFrameToVideo(video, interpolateFrame(keyframes, t));

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
   * Track clip-relative timeline position for the scrub bar.
   * durationSec/progressSec are always scoped to the clip itself
   * (0 → clip length), never the underlying recording's full length —
   * this is what makes the clip feel like its own self-contained video
   * with a normal timeline, rather than a fragment of the source match.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      const dur = video.duration || 0;
      if (dur === 0) return;
      const sSec = isFinite(lStart) ? lStart * dur : 0;
      const eSec = isFinite(lEnd) ? lEnd * dur : dur;
      const cDur = Math.max(0, eSec - sSec);
      setClipDurationSec(cDur);
      if (!seekDraggingRef.current) {
        setProgressSec(Math.max(0, Math.min(cDur, video.currentTime - sSec)));
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onTimeUpdate);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onTimeUpdate);
    };
  }, [lStart, lEnd, isLocal]);

  /** Scrub bar handlers — drag position stays purely local (progressSec) until release. */
  const handleScrubStart = useCallback(() => {
    seekDraggingRef.current = true;
  }, []);

  const handleScrubChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setProgressSec(parseFloat(e.target.value));
  }, []);

  const handleScrubEnd = useCallback(
    (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      seekDraggingRef.current = false;
      if (!video) return;
      const dur = video.duration || 0;
      if (dur === 0) return;
      const sSec = isFinite(lStart) ? lStart * dur : 0;
      const eSec = isFinite(lEnd) ? lEnd * dur : dur;
      const val = parseFloat(e.currentTarget.value);
      // Clamp to the clip's own bounds — this is the fix for the player.tsx bug
      // where scrubbing could escape into the rest of the underlying recording.
      const clamped = Math.max(0, Math.min(eSec - sSec, val));
      video.currentTime = sSec + clamped;
      setProgressSec(clamped);
    },
    [lStart, lEnd]
  );

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
   * Deliver the server-rendered MP4 to the device via a native anchor download.
   *
   * The old approach fetched the entire file as a JS Blob before handing it to
   * the browser. A rendered clip is easily 200–600 MB; buffering that in the JS
   * heap OOM-killed the tab on mobile and silently failed on slower connections.
   *
   * A hidden <a download> lets the browser stream the bytes straight to disk
   * through its own download manager — no JS memory involved, no timeout risk.
   * The server already sets Content-Disposition: attachment so the browser saves
   * rather than plays the file. Cookies are sent automatically by navigation, so
   * session auth still works without credentials: "include".
   */
  const deliverViaProxy = useCallback(() => {
    const filename = `${clip.title || "clip"}.mp4`;
    const a = document.createElement("a");
    a.href = `/api/user-clips/${clip.id}/download`;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast({ title: t.export.done, description: "Your download has started." });
    onDownloaded?.();
  }, [clip, toast, t, onDownloaded]);

  const handleExport = useCallback(async () => {
    if (exportState === "polling") return;

    // Already exported — re-deliver without re-rendering.
    // This sits before the try/catch below, so an offline tap or an expired
    // Bunny asset used to surface as an unhandled rejection: no toast, no
    // spinner, nothing at all happened.
    if (exportState === "ready" && exportedUrl) {
      try {
        await deliverViaProxy();
      } catch {
        toast({ title: t.export.error, description: t.export.errorDesc, variant: "destructive" });
      }
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

      // status === "pending" — poll until done.
      //
      // The server renders at most MAX_CONCURRENT_RENDERS clips at a time and
      // queues the rest, and a single -preset slow -crf 16 pass on the shared
      // VPS can take several minutes on its own. The old 3-minute budget meant
      // a queued export reported "Export failed" to the user while it was still
      // waiting its turn, and then completed anyway.
      const maxAttempts = 600; // 20 minutes at 2 s
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

      throw new Error("Export timed out");
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
          {/*
            Container carries the clip's OUTPUT aspect ratio with a black
            background. The video is positioned inside it by the pan loop, so
            any area the frame doesn't cover renders as a real black bar.
          */}
          <div
            ref={scrollRef}
            dir="ltr"
            className={cn(
              "relative overflow-hidden bg-black",
              clip.aspectRatio === "9:16" ? "h-full aspect-[9/16]" : "h-full w-full max-h-full aspect-video"
            )}
          >
            <video
              ref={videoRef}
              className="pointer-events-none"
              style={isLocal
                ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }
                : frameToVideoStyle(interpolateFrame(keyframes, 0))}
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
            : "w-full px-4 pb-safe pt-3 flex flex-col gap-2 pointer-events-auto shrink-0"
          }
          style={landscape ? undefined : { background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)", paddingTop: "3rem" }}
        >
          {/* Timeline — scoped to the clip's own duration, not the source recording's */}
          <div className="flex items-center gap-2 w-full" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] text-white/70 tabular-nums min-w-[30px] drop-shadow">
              {formatTime(progressSec)}
            </span>
            <div className="flex-1 relative h-6 flex items-center">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 bg-white/25 rounded-full" />
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 bg-primary rounded-full pointer-events-none"
                style={{ width: `${clipDurationSec > 0 ? (progressSec / clipDurationSec) * 100 : 0}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow pointer-events-none"
                style={{
                  left: `${clipDurationSec > 0 ? (progressSec / clipDurationSec) * 100 : 0}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
              <input
                type="range"
                min={0}
                max={clipDurationSec || 1}
                step={0.05}
                value={progressSec}
                onMouseDown={handleScrubStart}
                onTouchStart={handleScrubStart}
                onChange={handleScrubChange}
                onMouseUp={handleScrubEnd}
                onTouchEnd={handleScrubEnd}
                className="w-full h-full appearance-none cursor-pointer relative z-10 opacity-0"
                aria-label="Clip position"
              />
            </div>
            <span className="text-[11px] text-white/70 tabular-nums min-w-[30px] text-right drop-shadow">
              {formatTime(clipDurationSec)}
            </span>
          </div>

          <div className={`flex items-end gap-3 ${landscape ? "flex-col w-full" : ""}`}>
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
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="sticky top-0 z-10 shrink-0 bg-background px-4 pb-3 pt-4"
      >
        <h1 className="mb-4 px-0 font-display text-2xl font-bold text-foreground">{t.myClips.title}</h1>

        {/* Tabs */}
        <div className="-mx-1 flex rounded-full border border-border bg-card p-1">
          <button
            onClick={() => setTab("saved")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2.5 text-sm font-semibold transition-colors ${
              tab === "saved"
                ? "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--primary)/0.18)]"
                : "text-muted-foreground"
            }`}
          >
            {t.myClips.tabSaved}
            {savedCount > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                tab === "saved" ? "bg-black/10 text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>
                {savedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab("created")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2.5 text-sm font-semibold transition-colors ${
              tab === "created"
                ? "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--primary)/0.18)]"
                : "text-muted-foreground"
            }`}
          >
            <Scissors className="w-3.5 h-3.5" />
            {t.myClips.tabCreated}
            {createdCount > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                tab === "created" ? "bg-black/10 text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>
                {createdCount}
              </span>
            )}
          </button>
        </div>
      </motion.div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-28">
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
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
            className="h-[86px] animate-pulse rounded-[18px] border border-border bg-card"
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
        className="py-20 text-center"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 18, delay: 0.1 } }}
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted"
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
    <div className="flex flex-col gap-3">
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
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let thumbnailObjectUrl: string | null = null;
    const sourceObjectUrl = createLocalBlobUrl(record);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.removeEventListener("loadeddata", renderFrame);
      video.removeEventListener("error", handleError);
      video.removeAttribute("src");
      video.load();
      revokeLocalBlobUrl(sourceObjectUrl);
      if (thumbnailObjectUrl) URL.revokeObjectURL(thumbnailObjectUrl);
    };

    const handleError = () => {
      if (!cancelled) setThumbnailUrl(null);
    };

    const renderFrame = () => {
      if (cancelled || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const nextThumbnailUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(nextThumbnailUrl);
          return;
        }
        thumbnailObjectUrl = nextThumbnailUrl;
        setThumbnailUrl(nextThumbnailUrl);
      }, "image/jpeg", 0.82);
    };

    video.addEventListener("loadeddata", renderFrame);
    video.addEventListener("error", handleError);
    video.src = sourceObjectUrl;
    video.load();

    return cleanup;
  }, [record]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{
        opacity: 1, scale: 1, y: 0,
        transition: { delay: index * 0.07, duration: 0.4, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.97 }}
      className="relative overflow-hidden rounded-[18px] border border-border bg-card"
    >
      <button
        onClick={() => onPlay(record)}
        className="flex w-full items-center gap-3 p-2 text-start"
      >
        <div className="group relative h-[70px] w-[112px] shrink-0 overflow-hidden rounded-xl">
          <div className="absolute inset-0 field-pattern bg-card" />

          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={record.title}
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <div className="absolute inset-0 group-hover:bg-white/5 transition-colors duration-200" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white">
              <Play className="ms-0.5 h-3.5 w-3.5 fill-current" />
            </span>
          </div>

        </div>
        <div className="min-w-0 flex-1 pe-7">
          <h3 className="line-clamp-2 text-sm font-bold leading-tight text-foreground">{record.title}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">{new Date(record.downloadedAt).toLocaleDateString()}</p>
          <span className="mt-1 inline-flex rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            Saved
          </span>
        </div>
      </button>

      {/* Delete button */}
      <button
        onClick={() => setShowDelete(true)}
        className="absolute end-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg bg-muted/80 transition-opacity active:opacity-70"
        title="Remove from saved"
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </button>

      {/* Delete confirmation */}
      <AnimatePresence>
        {showDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/80"
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
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
            className="h-[86px] animate-pulse rounded-[18px] border border-border bg-card"
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
        className="py-20 text-center"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 18, delay: 0.1 } }}
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted"
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
    <div className="flex flex-col gap-3">
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
      className="group relative flex min-h-[86px] items-center gap-3 overflow-hidden rounded-[18px] border border-border bg-card p-2 shadow-sm"
    >
      <div className="relative h-[70px] w-[112px] shrink-0 overflow-hidden rounded-xl">
        {clip.thumbnailUrl ? (
          <img
            src={clip.thumbnailUrl}
            alt={clip.title}
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern bg-card" />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute inset-0 transition-colors duration-200 group-hover:bg-white/5" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white">
            <Play className="ms-0.5 h-3.5 w-3.5 fill-current" />
          </span>
        </div>
        {/* Live clip overlay — no playback URL yet */}
        {!clip.playbackUrl && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-black/70">
            <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">Live recording</span>
            <span className="px-3 text-center text-[9px] text-white/50">Playback available once the recording uploads</span>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 pe-7 text-start">
        <h3 className="line-clamp-2 text-sm font-bold leading-tight text-foreground">{clip.title}</h3>
        <p className="mt-1 text-[10px] font-medium text-primary">
          {new Date(clip.createdAt).toLocaleDateString()}
        </p>
        {isPrivate ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            <Lock className="h-2.5 w-2.5" />
            Private
          </span>
        ) : (
          <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            <Scissors className="h-2.5 w-2.5" />
            {durationHint}
          </span>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowDelete(true); }}
        className="absolute end-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg bg-muted/80 transition-opacity active:opacity-70"
        aria-label="Delete clip"
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </button>

      {/* Delete confirmation overlay */}
      <AnimatePresence>
        {showDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/80"
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

    </motion.div>
  );
}
