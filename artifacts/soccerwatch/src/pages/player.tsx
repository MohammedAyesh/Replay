import { useEffect, useRef, useState, useCallback } from "react";
import { Link, useRoute } from "wouter";
import Hls from "hls.js";
import { useGetClip, useToggleLike, useSaveClip, useUnsaveClip, getGetClipQueryKey, getListSavedClipsQueryKey, getListClipsQueryKey, Clip, CropKeyframe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, ChevronLeft, ChevronRight, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";

const FALLBACK_VIDEO = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function interpolateCropPath(cropPath: CropKeyframe[], t: number): CropKeyframe {
  if (cropPath.length === 0) return { t, x: 0, y: 0, w: 1, h: 1 };
  if (cropPath.length === 1) return cropPath[0];
  const first = cropPath[0];
  const last = cropPath[cropPath.length - 1];
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  const nextIdx = cropPath.findIndex((kf) => kf.t > t);
  const prevIdx = nextIdx - 1;
  const kf0 = cropPath[prevIdx];
  const kf1 = cropPath[nextIdx];
  const alpha = (t - kf0.t) / (kf1.t - kf0.t);
  return {
    t,
    x: kf0.x + (kf1.x - kf0.x) * alpha,
    y: kf0.y + (kf1.y - kf0.y) * alpha,
    w: kf0.w + (kf1.w - kf0.w) * alpha,
    h: kf0.h + (kf1.h - kf0.h) * alpha,
  };
}

function cropToTransform(kf: CropKeyframe): string {
  if (!kf || kf.w <= 0) return "";
  const cx = kf.x + kf.w / 2;
  const cy = kf.y + kf.h / 2;
  const scale = 1 / kf.w;
  const tx = (0.5 - cx) / kf.w * 100;
  const ty = (0.5 - cy) / kf.w * 100;
  return `translateX(${tx}%) translateY(${ty}%) scale(${scale})`;
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
  const hlsRef = useRef<Hls | null>(null);
  const seekDraggingRef = useRef(false);

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

    const src = clip.bunnyPlaybackUrl ?? clip.videoUrl ?? FALLBACK_VIDEO;

    function handleLoadedMetadata() {
      if (!video) return;
      durationRef.current = video.duration || 0;
      setDuration(durationRef.current);
      clipStartSec.current = clip.startTime * durationRef.current;
      clipEndSec.current = clip.endTime * durationRef.current;
      if (clip.cropPath.length > 0) {
        const kf = interpolateCropPath(clip.cropPath, 0);
        video.style.transform = cropToTransform(kf);
        video.style.transition = "transform 0.1s linear";
      }
    }

    function handleTimeUpdate() {
      if (!video || !durationRef.current) return;
      if (video.currentTime >= clipEndSec.current) {
        video.currentTime = clipStartSec.current;
      }
      if (!seekDraggingRef.current) {
        setCurrentTime(video.currentTime);
      }
      if (clip.cropPath.length > 0) {
        const clipDuration = clipEndSec.current - clipStartSec.current;
        const t = clipDuration > 0
          ? (video.currentTime - clipStartSec.current) / clipDuration
          : 0;
        const kf = interpolateCropPath(clip.cropPath, Math.max(0, Math.min(1, t)));
        video.style.transform = cropToTransform(kf);
      }
    }

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("timeupdate", handleTimeUpdate);

    if (src.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          durationRef.current = video.duration || 0;
          const startSec = clip.startTime * durationRef.current;
          video.currentTime = startSec;
          video.play().then(() => setIsPlaying(true)).catch(() => {});
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    } else {
      video.src = src;
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.style.transform = "";
      video.style.transition = "";
    };
  }, [clip.id, clip.bunnyPlaybackUrl, clip.videoUrl, clip.startTime, clip.endTime, clip.cropPath]);

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
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
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
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden" onClick={togglePlay}>
      <div className="absolute inset-0 field-pattern opacity-30" />

      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        loop
        muted={isMuted}
      />

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
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-white/70 font-medium tabular-nums min-w-[32px]">
              {formatTime(currentTime)}
            </span>
            <div className="flex-1 relative h-6 flex items-center">
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
                className="w-full h-1.5 appearance-none bg-white/20 rounded-full cursor-pointer relative z-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer"
              />
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 bg-primary rounded-full pointer-events-none"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[11px] text-white/70 font-medium tabular-nums min-w-[32px] text-right">
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
