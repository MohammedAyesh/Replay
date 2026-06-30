import { useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import Hls from "hls.js";
import { useGetClip, useToggleLike, useSaveClip, useUnsaveClip, getGetClipQueryKey, getListSavedClipsQueryKey, getListClipsQueryKey, Clip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, ChevronLeft, ChevronRight, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";

const FALLBACK_VIDEO = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

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

    if (src.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
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
    };
  }, [clip.id, clip.bunnyPlaybackUrl, clip.videoUrl]);

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
        <div className="mb-6">
          <div className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase inline-block mb-2 shadow-sm">
            {clip.momentLabel}
          </div>
          <h2 className="text-2xl font-bold text-white mb-1 shadow-black drop-shadow-md">{clip.fieldName || t.player.localPitch}</h2>
          <p className="text-white/80 text-sm shadow-black drop-shadow-md">{clip.court || t.player.court1} • {clip.date || t.player.recent}</p>
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
