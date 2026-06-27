import { useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { useGetClip, useToggleLike, useSaveClip, useUnsaveClip, getGetClipQueryKey, getListSavedClipsQueryKey, getListClipsQueryKey, Clip } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, ChevronLeft, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const FALLBACK_VIDEO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

export default function Player() {
  const [, params] = useRoute("/player/:id");
  const clipId = parseInt(params?.id || "0", 10);
  
  const { data: clip, isLoading } = useGetClip(clipId, { query: { enabled: !!clipId, queryKey: getGetClipQueryKey(clipId) } });

  if (isLoading) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white h-[100dvh]">Loading clip...</div>;
  }

  if (!clip) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white h-[100dvh]">Clip not found.</div>;
  }

  return <PlayerScreen clip={clip} />;
}

function PlayerScreen({ clip }: { clip: Clip }) {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();
  const { toast } = useToast();
  
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const toggleLikeMutation = useToggleLike();
  const saveClipMutation = useSaveClip();
  const unsaveClipMutation = useUnsaveClip();

  const handleToggleLike = () => {
    if (isGuest) {
      toast({ title: "Sign in to like", description: "Create an account to interact." });
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
      toast({ title: "Sign in to save", description: "Create an account to build your highlight reel." });
      return;
    }
    
    if (clip.isSaved) {
      unsaveClipMutation.mutate(
        { data: { clipId: clip.id } },
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
        { data: { clipId: clip.id } },
        {
          onSuccess: () => {
            queryClient.setQueryData(getGetClipQueryKey(clip.id), (old: Clip | undefined) => 
              old ? { ...old, isSaved: true } : old
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
            toast({ title: "Saved to My Clips", className: "bg-primary text-white border-none" });
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
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden" onClick={togglePlay}>
      <div className="absolute inset-0 field-pattern opacity-30" />
      
      <video
        ref={videoRef}
        src={clip.videoUrl || FALLBACK_VIDEO}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        autoPlay
        loop
        muted={isMuted}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/90 pointer-events-none" />

      {/* Top Nav */}
      <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-auto z-10">
        <Link href="~" className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white backdrop-blur-md">
          <ChevronLeft className="w-6 h-6 ml-[-2px]" />
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
          <h2 className="text-2xl font-bold text-white mb-1 shadow-black drop-shadow-md">{clip.fieldName || "Local Pitch"}</h2>
          <p className="text-white/80 text-sm shadow-black drop-shadow-md">{clip.court || "Court 1"} • {clip.date || "Recent"}</p>
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
            {clip.isSaved ? "Saved" : "Save to My Clips"}
          </button>

          <button className="flex-1 bg-white/10 hover:bg-white/20 border border-white/20 backdrop-blur-md rounded-xl py-3.5 flex items-center justify-center gap-2 transition-colors active:scale-95">
            <Share className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
