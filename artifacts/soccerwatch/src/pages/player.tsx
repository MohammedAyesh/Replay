import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { usePinchZoom } from "@/hooks/use-pinch-zoom";
import { Link, useRoute } from "wouter";
import Hls from "hls.js";
import { useGetClip, useToggleLike, useSaveClip, useUnsaveClip, getGetClipQueryKey, getListSavedClipsQueryKey, getListClipsQueryKey, getGetFeedQueryKey, getGetAccountStatsQueryKey, Clip, FeedClip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, ChevronLeft, ChevronRight, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import {
  DEFAULT_SRC_ASPECT,
  OUT_ASPECT,
  applyFrameToVideo,
  frameToVideoStyle,
  interpolateFrame,
  normalizePath,
} from "@/lib/cropFrame";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Player() {
  const [, params] = useRoute("/player/:id");
  const clipId = parseInt(params?.id || "0", 10);

  const { data: clip, isLoading } = useGetClip(clipId, { query: { enabled: !!clipId, queryKey: getGetClipQueryKey(clipId) } });

  const { t } = useTranslation();

  if (isLoading) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white h-[100dvh]">{t.player.loading}</div>;
  }

  if (!clip) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white h-[100dvh]">{t.player.notFound}</div>;
  }

  return <PlayerScreen clip={clip} />;
}

function PlayerScreen({ clip }: { clip: Clip }) {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();
  const { toast } = useToast();

  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * Auto-detected highlight clips are always 16:9. Legacy keyframes are
   * rewritten to zoom-1 frames so they centre-crop rather than stretch.
   */
  const framePath = useMemo(
    () => normalizePath(clip.cropPath ?? [], DEFAULT_SRC_ASPECT, OUT_ASPECT["16:9"]),
    [clip.cropPath]
  );
  const hlsRef = useRef<Hls | null>(null);
  const seekDraggingRef = useRef(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const { isZoomed } = usePinchZoom(zoomRef);

  const clipStartSec = useRef<number>(0);
  const clipEndSec = useRef<number>(Infinity);
  const durationRef = useRef<number>(0);

  const toggleLikeMutation = useToggleLike();
  const saveClipMutation = useSaveClip();
  const unsaveClipMutation = useUnsaveClip();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    video.pause();
    video.removeAttribute("src");
    video.load();

    // No stock-footage fallback: playing an unrelated demo stream under this
    // clip's trim and crop misrepresents it as the user's own recording.
    const src = clip.bunnyPlaybackUrl ?? clip.videoUrl;
    if (!src) return;

    let didSeek = false;
    function seekToStartAndPlay() {
      if (!video || didSeek) return;
      const dur = video.duration || 0;
      if (!(dur > 0 && isFinite(dur))) return;
      didSeek = true;
      durationRef.current = dur;
      setDuration(dur);
      clipStartSec.current = isFinite(clip.startTime) ? clip.startTime * dur : 0;
      clipEndSec.current = isFinite(clip.endTime) ? clip.endTime * dur : dur;
      video.currentTime = clipStartSec.current;
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    }

    function handleLoadedMetadata() {
      if (!video) return;
      durationRef.current = video.duration || 0;
      setDuration(durationRef.current);
      clipStartSec.current = isFinite(clip.startTime) ? clip.startTime * durationRef.current : 0;
      clipEndSec.current = isFinite(clip.endTime) ? clip.endTime * durationRef.current : durationRef.current;
      if (framePath.length > 0) applyFrameToVideo(video, interpolateFrame(framePath, 0));
      seekToStartAndPlay();
    }

    function handleTimeUpdate() {
      if (!video || !durationRef.current) return;
      if (video.currentTime >= clipEndSec.current) {
        video.currentTime = clipStartSec.current;
      }
      if (!seekDraggingRef.current) {
        setCurrentTime(video.currentTime);
      }
      if (framePath.length > 0) {
        const clipDuration = clipEndSec.current - clipStartSec.current;
        const t = clipDuration > 0
          ? (video.currentTime - clipStartSec.current) / clipDuration
          : 0;
        applyFrameToVideo(video, interpolateFrame(framePath, Math.max(0, Math.min(1, t))));
      }
    }

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("durationchange", seekToStartAndPlay);
    video.addEventListener("timeupdate", handleTimeUpdate);

    if (src.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, seekToStartAndPlay);
        // Without this, a fatal error (dropped connection, CDN hiccup, media
        // decode fault) leaves hls.js detached and the player permanently
        // frozen with no feedback. Recover from the recoverable classes and
        // surface the rest so the UI can show an error state.
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              if (hlsRef.current === hls) hlsRef.current = null;
              video.dispatchEvent(new Event("error"));
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      }
    } else {
      video.src = src;
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("durationchange", seekToStartAndPlay);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.style.transform = "";
    };
  }, [clip.id, clip.bunnyPlaybackUrl, clip.videoUrl, clip.startTime, clip.endTime, framePath]);

  const { t } = useTranslation();

  const handleToggleLike = () => {
    if (isGuest) {
      toast({ title: t.player.signInToLike, description: t.player.signInToLikeDesc });
      return;
    }
    toggleLikeMutation.mutate(
      { id: clip.id },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetClipQueryKey(clip.id), (old: Clip | undefined) =>
            old ? { ...old, isLiked: data.liked, likeCount: data.likeCount } : old
          );
          queryClient.setQueryData(getGetFeedQueryKey(), (old: FeedClip[] | undefined) =>
            old?.map((c) => c.id === clip.id ? { ...c, isLiked: data.liked, likeCount: data.likeCount } : c)
          );
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
        }
      }
    );
  };

  const handleToggleSave = () => {
    if (isGuest) {
      toast({ title: t.player.signInToSave, description: t.player.signInToSaveDesc });
      return;
    }

    if (clip.isSaved) {
      unsaveClipMutation.mutate(
        { clipId: clip.id },
        {
          onSuccess: () => {
            queryClient.setQueryData(getGetClipQueryKey(clip.id), (old: Clip | undefined) =>
              old ? { ...old, isSaved: false } : old
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
          }
        }
      );
    } else {
      saveClipMutation.mutate(
        { clipId: clip.id },
        {
          onSuccess: () => {
            queryClient.setQueryData(getGetClipQueryKey(clip.id), (old: Clip | undefined) =>
              old ? { ...old, isSaved: true } : old
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
            toast({ title: t.player.savedToMyClips, className: "bg-primary text-white border-none" });
          }
        }
      );
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handleSeekStart = useCallback(() => {
    seekDraggingRef.current = true;
  }, []);

  const handleSeekMove = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
  }, []);

  const handleSeekEnd = useCallback((e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const target = e.currentTarget;
    const val = parseFloat(target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = val;
    }
    seekDraggingRef.current = false;
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden" onClick={isZoomed ? undefined : togglePlay}>
      <div className="absolute inset-0 field-pattern opacity-30" />

      <div ref={zoomRef} className="absolute inset-0">
        {/* 16:9 container with a black backdrop so uncovered frame area
            renders as a real black bar, matching the export. */}
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div className="relative w-full aspect-video overflow-hidden bg-black">
            <video
              ref={videoRef}
              className="pointer-events-none"
              style={frameToVideoStyle(interpolateFrame(framePath, 0))}
              playsInline
              loop
              muted={isMuted}
            />
          </div>
        </div>
      </div>

      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/90 pointer-events-none" />

      {/* Top Nav */}
      <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-auto z-10">
        <Link href="~" className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md">
          <ChevronLeft className="w-6 h-6 ms-[-2px] rtl:hidden" />
          <ChevronRight className="w-6 h-6 me-[-2px] ltr:hidden" />
        </Link>
        <button
          onClick={toggleMute}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Bottom Info & Action Bar */}
      <div className="absolute bottom-safe w-full px-6 pb-6 pointer-events-auto z-10">
        <div className="mb-2">
          <div className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase inline-block mb-2 shadow-sm">
            {clip.momentLabel}
          </div>
          <h2 className="text-2xl font-bold text-white mb-1 shadow-black drop-shadow-md">{clip.fieldName || t.player.localPitch}</h2>
          <p className="text-white/80 text-sm shadow-black drop-shadow-md">{clip.court || t.player.court1} • {clip.date || t.player.recent}</p>
        </div>

        {/* Seek Bar */}
        <div className="mb-4 select-none" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/80 font-semibold tabular-nums min-w-[38px]">
              {formatTime(currentTime)}
            </span>
            <div className="flex-1 relative h-8 flex items-center">
              {/* Track background */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 bg-white/25 rounded-full" />
              {/* Filled progress */}
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-2 bg-primary rounded-full pointer-events-none"
                style={{ width: `${progress}%` }}
              />
              {/* Thumb at progress end */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-5 h-5 bg-white rounded-full shadow-lg ring-2 ring-white/30 pointer-events-none transition-transform"
                style={{ left: `${progress}%`, transform: `translate(-50%, -50%)` }}
              />
              <input
                type="range"
                min={0}
                max={duration || 1}
                step={0.1}
                value={currentTime}
                onMouseDown={handleSeekStart}
                onTouchStart={handleSeekStart}
                onChange={handleSeekMove}
                onMouseUp={handleSeekEnd}
                onTouchEnd={handleSeekEnd}
                className="w-full h-full appearance-none cursor-pointer relative z-10 opacity-0"
              />
            </div>
            <span className="text-xs text-white/80 font-semibold tabular-nums min-w-[38px] text-right">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleToggleLike}
            className="flex-1 bg-white/10 hover:bg-white/20 border border-white/20 backdrop-blur-md rounded-xl py-3.5 flex items-center justify-center gap-2 transition-colors active:scale-95"
          >
            <Heart className={cn("w-5 h-5", clip.isLiked ? "fill-destructive text-destructive" : "text-white")} />
            <span className="text-white font-semibold text-sm">{clip.likeCount}</span>
          </button>

          <button
            onClick={handleToggleSave}
            className={cn(
              "flex-[2] rounded-xl py-3.5 flex items-center justify-center gap-2 transition-colors font-semibold text-sm active:scale-95",
              clip.isSaved
                ? "bg-primary text-white border-primary"
                : "bg-white/10 text-white border border-white/20 backdrop-blur-md hover:bg-white/20"
            )}
          >
            <Bookmark className={cn("w-5 h-5", clip.isSaved ? "fill-white" : "")} />
            {clip.isSaved ? t.player.saved : t.player.saveToMyClips}
          </button>

          <button className="flex-1 bg-white/10 hover:bg-white/20 border border-white/20 backdrop-blur-md rounded-xl py-3.5 flex items-center justify-center gap-2 transition-colors active:scale-95">
            <Share className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
